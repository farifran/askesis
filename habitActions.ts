/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { 
    state, Habit, HabitSchedule, TimeOfDay, Frequency, 
    saveState, getScheduleForDate, 
    clearActiveHabitsCache, clearScheduleCache, invalidateChartCache,
    ensureHabitDailyInfo, getEffectiveScheduleForHabitOnDate,
    PREDEFINED_HABITS, TIMES_OF_DAY, 
    ensureHabitInstanceData, getNextStatus, calculateHabitStreak,
    invalidateStreakCache,
    calculateDaySummary,
    invalidateDaySummaryCache,
    getActiveHabitsForDate,
    AppState,
    getHabitDailyInfoForDate
} from './state';
import { ui } from './ui';
import { 
    renderApp, renderHabits, renderCalendar, openEditModal, 
    closeModal, showConfirmationModal, showUndoToast, renderAINotificationState, renderHabitCardState,
    renderCalendarDayPartial, setupManageModal, openModal
} from './render';
import { t, getHabitDisplayInfo } from './i18n';
import { 
    toUTCIsoDateString, parseUTCIsoDate, generateUUID, 
    getTodayUTCIso, addDays, simpleMarkdownToHTML, getDateTimeFormat
} from './utils';
import { apiFetch } from './api';
import { STOIC_QUOTES } from './quotes';

// --- HELPERS ---

function _createDefaultSchedule(startDate: string): HabitSchedule {
    return {
        startDate,
        times: ['Morning'],
        frequency: { type: 'daily' },
        scheduleAnchor: startDate
    };
}

// --- ACTIONS ---

export function createDefaultHabit() {
    const defaultTemplate = PREDEFINED_HABITS.find(h => h.isDefault) || PREDEFINED_HABITS[0];
    const today = getTodayUTCIso();
    
    const newHabit: Habit = {
        id: generateUUID(),
        icon: defaultTemplate.icon,
        color: defaultTemplate.color,
        goal: defaultTemplate.goal,
        createdOn: today,
        scheduleHistory: [{
            startDate: today,
            nameKey: defaultTemplate.nameKey,
            subtitleKey: defaultTemplate.subtitleKey,
            times: defaultTemplate.times,
            frequency: defaultTemplate.frequency,
            scheduleAnchor: today
        }]
    };
    
    state.habits.push(newHabit);
    state.uiDirtyState.habitListStructure = true;
    saveState();
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const instanceData = ensureHabitInstanceData(date, habitId, time);
    const oldStatus = instanceData.status;
    const newStatus = getNextStatus(oldStatus);
    
    instanceData.status = newStatus;
    
    // Se completou, define o valor padrão se não houver override
    if (newStatus === 'completed' && instanceData.goalOverride === undefined) {
        // Opcional: definir um valor padrão aqui se necessário, 
        // mas o render já trata undefined usando getSmartGoalForHabit
    }

    invalidateStreakCache(habitId, date);
    invalidateChartCache(); // Status mudou, gráfico muda
    
    // Atualiza apenas o cartão específico e o resumo do dia
    renderHabitCardState(habitId, time);
    
    // Atualiza o dia no calendário (progresso)
    const dayItem = ui.calendarStrip.querySelector<HTMLElement>(`.day-item[data-date="${date}"]`);
    if (dayItem) {
        // Precisamos recalcular o summary e forçar update visual
        invalidateDaySummaryCache(date);
        
        renderCalendarDayPartial(date);
    }
    
    saveState();
    
    // Check for celebrations
    if (newStatus === 'completed') {
        const streak = calculateHabitStreak(habitId, date);
        if (streak === 21 && !state.pending21DayHabitIds.includes(habitId)) {
            state.pending21DayHabitIds.push(habitId);
            renderAINotificationState();
        } else if (streak === 66 && !state.pendingConsolidationHabitIds.includes(habitId)) {
            state.pendingConsolidationHabitIds.push(habitId);
            renderAINotificationState();
        }
    }
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
    const instanceData = ensureHabitInstanceData(date, habitId, time);
    instanceData.goalOverride = value;
    
    // Se alterou a meta, e estava pendente, talvez devesse completar?
    // Por enquanto, apenas salva o valor. O usuário clica para completar.
    
    invalidateChartCache();
    saveState();
}

export function completeAllHabitsForDate(date: string) {
    const activeHabits = getActiveHabitsForDate(date);
    
    let changed = false;
    activeHabits.forEach(({ habit, schedule }: { habit: Habit, schedule: TimeOfDay[] }) => {
        schedule.forEach((time: TimeOfDay) => {
            const instance = ensureHabitInstanceData(date, habit.id, time);
            if (instance.status !== 'completed') {
                instance.status = 'completed';
                changed = true;
                invalidateStreakCache(habit.id, date);
            }
        });
    });

    if (changed) {
        invalidateDaySummaryCache(date);
        invalidateChartCache();
        saveState();
        renderApp(); // Render completo é mais seguro para atualização em massa
    }
}

export function snoozeAllHabitsForDate(date: string) {
    const activeHabits = getActiveHabitsForDate(date);
    
    let changed = false;
    activeHabits.forEach(({ habit, schedule }: { habit: Habit, schedule: TimeOfDay[] }) => {
        schedule.forEach((time: TimeOfDay) => {
            const instance = ensureHabitInstanceData(date, habit.id, time);
            if (instance.status !== 'snoozed' && instance.status !== 'completed') {
                instance.status = 'snoozed';
                changed = true;
            }
        });
    });

    if (changed) {
        invalidateDaySummaryCache(date);
        invalidateChartCache();
        saveState();
        renderApp();
    }
}

export function handleUndoDelete() {
    if (!state.lastEnded) return;

    const { habitId, lastSchedule, removedSchedules } = state.lastEnded;
    const habit = state.habits.find(h => h.id === habitId);

    if (habit) {
        // Reverte a alteração no último agendamento
        // Localiza o agendamento correspondente (deve ser o último ou o que foi modificado)
        const scheduleToRestore = habit.scheduleHistory.find(s => 
            s.startDate === lastSchedule.startDate && s.scheduleAnchor === lastSchedule.scheduleAnchor
        );

        if (scheduleToRestore) {
            // Restaura propriedades
            scheduleToRestore.endDate = lastSchedule.endDate;
            scheduleToRestore.times = [...lastSchedule.times]; // Deep copy array
        } else {
            // Se não encontrou (foi removido completamente?), readiciona
            habit.scheduleHistory.push(lastSchedule);
            habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
        }
        
        // Re-adiciona agendamentos futuros que foram removidos
        if (removedSchedules && removedSchedules.length > 0) {
            habit.scheduleHistory.push(...removedSchedules);
            habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
        }

        // Limpa estado de graduação se foi uma ação de graduação desfeita
        if (habit.graduatedOn) {
            habit.graduatedOn = undefined;
        }

        clearScheduleCache();
        clearActiveHabitsCache();
        invalidateChartCache();
        
        state.uiDirtyState.habitListStructure = true;
        state.uiDirtyState.calendarVisuals = true;
        
        saveState();
        renderApp();
        
        // Remove toast e estado
        state.lastEnded = null;
        if (ui.undoToast.classList.contains('visible')) {
            ui.undoToast.classList.remove('visible');
        }
    }
}

function _requestFutureScheduleChange(
    habit: Habit,
    effectiveDate: string,
    confirmationText: string,
    confirmationTitle: string,
    fromTime: TimeOfDay,
    toTime?: TimeOfDay
) {
    const scheduleModifier = (times: TimeOfDay[]): TimeOfDay[] => {
        const newTimes = times.filter(t => t !== fromTime);
        if (toTime) {
            newTimes.push(toTime);
        }
        // Mantém ordem
        return newTimes.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
    };

    const justTodayAction = () => {
        const dailyInfo = ensureHabitDailyInfo(effectiveDate, habit.id);
        const originalSchedule = getEffectiveScheduleForHabitOnDate(habit, effectiveDate);
        
        // Clona e modifica
        dailyInfo.dailySchedule = scheduleModifier(originalSchedule);
        
        // Move dados da instância se existirem
        const instanceData = dailyInfo.instances[fromTime];
        if (instanceData) {
            if (toTime) {
                dailyInfo.instances[toTime] = instanceData;
            }
            delete dailyInfo.instances[fromTime];
        }

        state.uiDirtyState.habitListStructure = true; 
        clearActiveHabitsCache();
        saveState();
        renderApp();
    };
    
    const fromNowOnAction = () => {
        // Encontra o agendamento ativo na data efetiva
        let targetScheduleIndex = habit.scheduleHistory.findIndex(s => {
             const startOk = s.startDate <= effectiveDate;
             const endOk = !s.endDate || s.endDate > effectiveDate; // endDate é exclusivo no split? Geralmente inclusivo no modelo, mas vamos checar.
             // Na lógica de `getScheduleForDate`: isBeforeEnd = !schedule.endDate || dateStr < schedule.endDate;
             // Então endDate é exclusivo.
             return startOk && endOk;
        });

        if (targetScheduleIndex === -1) {
            // Fallback para o último se não encontrado (edge case)
            targetScheduleIndex = habit.scheduleHistory.length - 1;
        }

        const activeSchedule = habit.scheduleHistory[targetScheduleIndex];
        
        // CORREÇÃO: Determina qual horário remover do agendamento PERMANENTE.
        // Se o usuário moveu o hábito "Apenas Hoje" (ex: Manhã -> Tarde), o horário atual (Tarde)
        // não existe no agendamento permanente (Manhã). Precisamos mapear de volta.
        let effectiveFromTime = fromTime;
        const dailyInfo = ensureHabitDailyInfo(effectiveDate, habit.id);

        // Se temos um override diário E o horário que estamos apagando NÃO está no permanente...
        if (dailyInfo.dailySchedule && !activeSchedule.times.includes(fromTime) && !toTime) {
             const permanentTimes = activeSchedule.times;
             const dailyTimes = dailyInfo.dailySchedule;
             
             // Encontra horários que estão no permanente mas NÃO no diário (o horário original que foi movido)
             const missingInDaily = permanentTimes.filter(t => !dailyTimes.includes(t));
             // Encontra horários que estão no diário mas NÃO no permanente (o horário temporário atual)
             const addedInDaily = dailyTimes.filter(t => !permanentTimes.includes(t));

             // Se houver uma correspondência 1:1 (um substituído por um), deduzimos que o usuário quer apagar o original.
             if (missingInDaily.length === 1 && addedInDaily.length === 1 && addedInDaily[0] === fromTime) {
                 effectiveFromTime = missingInDaily[0];
             }
        }

        // Helper local para aplicar a mudança usando o tempo efetivo correto
        const applyChangeToTimes = (times: TimeOfDay[]): TimeOfDay[] => {
            const newTimes = times.filter(t => t !== effectiveFromTime);
            if (toTime) {
                newTimes.push(toTime);
            }
            return newTimes.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
        };
        
        // Se a mudança é no mesmo dia de início, apenas atualiza
        if (activeSchedule.startDate === effectiveDate) {
            activeSchedule.times = applyChangeToTimes(activeSchedule.times);
            if (activeSchedule.times.length === 0) {
                 // Se removeu todos os horários, encerra o hábito
                 endHabit(habit.id, effectiveDate);
                 return;
            }
        } else {
            // Split do agendamento
            // Encerra o atual ontem
            // Cria novo hoje
            // Nota: endDate é exclusivo na lógica de display, então setamos para effectiveDate
            activeSchedule.endDate = effectiveDate;
            
            const newTimes = applyChangeToTimes(activeSchedule.times);
            if (newTimes.length > 0) {
                const newSchedule: HabitSchedule = {
                    ...activeSchedule,
                    startDate: effectiveDate,
                    endDate: undefined,
                    times: newTimes,
                    // Mantém chaves de nome/subtítulo originais
                };
                // Remove endDate do novo (copiado do antigo)
                delete (newSchedule as any).endDate;
                
                habit.scheduleHistory.push(newSchedule);
            } else {
                // Se não sobrou horários, efetivamente encerrou (o endHabit já trataria, mas aqui o activeSchedule já foi fechado acima)
            }
        }

        // CORREÇÃO [2025-02-15]: Preserva exceções "Apenas Hoje" ao mover.
        // Se o usuário excluiu um horário "Apenas Hoje" e agora está movendo outro horário "De Agora em Diante",
        // não devemos apagar o override do dia. Devemos atualizá-lo para refletir a mudança de horário.
        if (dailyInfo.dailySchedule) {
            dailyInfo.dailySchedule = scheduleModifier(dailyInfo.dailySchedule);
        }
        
        // Move dados de instância do dia se necessário
        const instanceData = dailyInfo.instances[fromTime];
        if (instanceData) {
            if (toTime) {
                dailyInfo.instances[toTime] = instanceData;
            }
            delete dailyInfo.instances[fromTime];
        }
        
        state.uiDirtyState.habitListStructure = true;
        clearScheduleCache();
        clearActiveHabitsCache();
        saveState();
        renderApp();
    };

    showConfirmationModal(
        confirmationText,
        fromNowOnAction,
        {
            title: confirmationTitle,
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: justTodayAction,
            hideCancel: true
        }
    );
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const date = state.selectedDate;
    const { name } = getHabitDisplayInfo(habit, date);
    
    _requestFutureScheduleChange(
        habit,
        date,
        t('confirmRemoveTime', { habitName: name, time: t(`filter${time}`) }),
        t('modalRemoveTimeTitle'),
        time
    );
}


export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const { isNew, habitId, formData, targetDate } = state.editingHabit;
    
    // Validação básica
    if (!formData.name && !formData.nameKey) {
        alert(t('noticeNameCannotBeEmpty'));
        return;
    }

    if (isNew) {
        const newHabit: Habit = {
            id: generateUUID(),
            icon: formData.icon,
            color: formData.color,
            goal: formData.goal,
            createdOn: targetDate, // Cria a partir da data que estava vendo
            scheduleHistory: [{
                startDate: targetDate,
                times: formData.times,
                frequency: formData.frequency,
                name: formData.name,
                nameKey: formData.nameKey,
                subtitleKey: formData.subtitleKey,
                scheduleAnchor: targetDate
            }]
        };
        state.habits.push(newHabit);
    } else {
        const habit = state.habits.find(h => h.id === habitId);
        if (habit) {
            // LOGIC FIX [2025-02-15]: Priority Clean-up.
            // When editing an existing habit for a specific date, we MUST remove any daily override
            // (like 'deleted just for today') to ensure the new edits (time/goal) are actually applied and visible.
            // The user's latest intent via the modal supercedes the previous "skip/delete" intent.
            const dailyInfo = state.dailyData[targetDate]?.[habit.id];
            if (dailyInfo && dailyInfo.dailySchedule !== undefined) {
                delete dailyInfo.dailySchedule;
            }

            // Atualiza propriedades visuais globais
            habit.icon = formData.icon;
            habit.color = formData.color;
            habit.goal = formData.goal; // Goal é global ou por schedule? No modelo Habit está global.
            
            // Lógica de agendamento
            // Verifica se houve mudança que requer novo agendamento
            const currentSchedule = getScheduleForDate(habit, targetDate) 
                || habit.scheduleHistory[habit.scheduleHistory.length - 1];
                
            const hasScheduleChanges = 
                JSON.stringify(currentSchedule.times.sort()) !== JSON.stringify(formData.times.sort()) ||
                JSON.stringify(currentSchedule.frequency) !== JSON.stringify(formData.frequency) ||
                currentSchedule.name !== formData.name;

            if (hasScheduleChanges) {
                // Se editando histórico (data passada) ou futuro, ou hoje.
                // Simplificação: Se a data alvo é o início do agendamento atual, atualiza in-place.
                if (currentSchedule.startDate === targetDate) {
                    currentSchedule.times = formData.times;
                    currentSchedule.frequency = formData.frequency;
                    currentSchedule.name = formData.name;
                    currentSchedule.nameKey = formData.nameKey;
                    currentSchedule.subtitleKey = formData.subtitleKey;
                } else {
                    // Fork schedule
                    currentSchedule.endDate = targetDate;
                    const newSchedule: HabitSchedule = {
                        startDate: targetDate,
                        times: formData.times,
                        frequency: formData.frequency,
                        name: formData.name,
                        nameKey: formData.nameKey, // Preserva ou limpa? Form data tem o novo estado.
                        subtitleKey: formData.subtitleKey,
                        scheduleAnchor: targetDate // Reancora para cálculo de frequência
                    };
                    habit.scheduleHistory.push(newSchedule);
                    // Ordena histórico
                    habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
                }
                clearScheduleCache();
            } else {
                // Mesmo sem mudança de agendamento, pode ter mudado nome/subtítulo se não for key-based
                currentSchedule.name = formData.name;
                currentSchedule.nameKey = formData.nameKey;
                // Cores e ícones já foram atualizados no objeto habit
            }
        }
    }

    state.editingHabit = null;
    state.uiDirtyState.habitListStructure = true;
    
    // Invalida caches globais
    clearActiveHabitsCache();
    invalidateChartCache();
    
    saveState();
    closeModal(ui.editHabitModal);
    renderApp();
}

export function endHabit(habitId: string, dateISO: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Localiza o agendamento ativo nesta data
    const activeSchedule = getScheduleForDate(habit, dateISO);
    if (!activeSchedule) return;

    // Salva estado para undo
    const removedSchedules = habit.scheduleHistory.filter(s => s.startDate > dateISO);
    
    state.lastEnded = {
        habitId,
        lastSchedule: JSON.parse(JSON.stringify(activeSchedule)), // Snapshot
        removedSchedules: JSON.parse(JSON.stringify(removedSchedules)) // Snapshot
    };

    // Remove agendamentos futuros
    habit.scheduleHistory = habit.scheduleHistory.filter(s => s.startDate <= dateISO);
    
    // Atualiza o agendamento atual para terminar ontem (se a ação é "encerrar A PARTIR de hoje", então hoje não tem mais)
    // OU se "encerrar NO DIA", então até o fim do dia?
    // Texto da UI: "End Habit" -> geralmente encerra imediatemente ou ao fim do dia.
    // Vamos assumir encerra ao final do dia ANTERIOR à data selecionada, se a intenção é "não fazer mais a partir de hoje".
    // Se a data é hoje, endDate = hoje? Não, endDate é exclusivo no nosso sistema (ver getScheduleForDate).
    // isBeforeEnd = !endDate || date < endDate.
    // Então se endDate = '2025-01-01', em '2025-01-01' o hábito NÃO aparece.
    // Logo, para encerrar a partir de dateISO, endDate = dateISO.
    activeSchedule.endDate = dateISO;

    clearScheduleCache();
    clearActiveHabitsCache();
    invalidateChartCache();
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    renderApp();
    showUndoToast();
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    
    // Encerra a partir de AMANHÃ se estivermos vendo hoje ou passado?
    // Ou a partir da data selecionada?
    // Geralmente "Encerrar hábito" é "Não quero mais fazer isso".
    // Vamos usar a data selecionada + 1 dia? Ou data selecionada?
    // Se eu estou em hoje e clico encerrar, não quero ver hoje?
    // Vamos usar state.selectedDate.
    
    showConfirmationModal(
        t('confirmEndHabitBody', { habitName: name }),
        () => {
            endHabit(habitId, state.selectedDate);
            closeModal(ui.manageModal);
        },
        {
            title: t('confirmEndHabitTitle'),
            confirmText: t('modalManageEndButton'),
            confirmButtonStyle: 'danger'
        }
    );
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmDeleteHabitBody', { habitName: name }),
        () => {
            state.habits = state.habits.filter(h => h.id !== habitId);
            // Limpa dados diários órfãos? Opcional, mas bom para limpeza.
            // Por performance e simplicidade, deixamos o lixo ou limpamos no saveState se quota excedida.
            
            state.uiDirtyState.habitListStructure = true;
            clearActiveHabitsCache();
            invalidateChartCache();
            saveState();
            
            // Re-render modal list
            setupManageModal();
            renderApp();
        },
        {
            title: t('confirmDeleteHabitTitle'),
            confirmText: t('modalManageDeleteButton'),
            confirmButtonStyle: 'danger'
        }
    );
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        closeModal(ui.manageModal);
        openEditModal(habit);
    }
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        const today = getTodayUTCIso();
        habit.graduatedOn = today;
        
        state.uiDirtyState.habitListStructure = true;
        saveState();
        
        // Re-render manage list if open
        if (ui.manageModal.classList.contains('visible')) {
            setupManageModal();
        }
        renderApp();
    }
}

export function resetApplicationData() {
    localStorage.clear();
    // Recarrega a página para reset limpo
    window.location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    const note = ui.notesTextarea.value.trim();

    const instanceData = ensureHabitInstanceData(date, habitId, time);
    instanceData.note = note;

    saveState();
    closeModal(ui.notesModal);
    
    // Atualiza UI
    renderHabitCardState(habitId, time);
}

// DEFINIÇÃO DE CABEÇALHOS PRE-TRADUZIDOS (PROMPT ENGINEERING)
// Isso evita alucinações da IA e garante que a UI exiba os títulos corretos.
const PROMPT_HEADERS = {
    pt: {
        archetype: "Arquétipo Comportamental",
        projection: "A Projeção do Oráculo",
        insight: "Análise Profunda",
        system_low: "Ajuste de Sistema (Reparo)",
        system_high: "Protocolo de Expansão (Desafio)",
        action_low: "Micro-Ação (Mise-en-place)",
        action_high: "Micro-Ação (O Próximo Nível)",
        
        socratic: "Reflexão Socrática",
        connection: "A Conexão Ancestral"
    },
    en: {
        archetype: "Behavioral Archetype",
        projection: "The Oracle's Projection",
        insight: "Deep Insight",
        system_low: "System Tweak (Repair)",
        system_high: "Expansion Protocol (Challenge)",
        action_low: "Micro-Action (Mise-en-place)",
        action_high: "Micro-Action (The Next Level)",
        
        socratic: "Socratic Reflection",
        connection: "The Ancient Connection"
    },
    es: {
        archetype: "Arquetipo de Comportamiento",
        projection: "La Proyección del Oráculo",
        insight: "Análisis Profundo",
        system_low: "Ajuste de Sistema (Reparación)",
        system_high: "Protocolo de Expansión (Desafío)",
        action_low: "Micro-Acción (Mise-en-place)",
        action_high: "Micro-Acción (El Siguiente Nivel)",
        
        socratic: "Reflexión Socrática",
        connection: "La Conexión Ancestral"
    }
};

// IMPLEMENTATION INTENTION TEMPLATES (Forcing Native Syntax)
const IMPLEMENTATION_TEMPLATES = {
    pt: "Quando [GATILHO], eu farei [AÇÃO].",
    en: "When [TRIGGER], I will [ACTION].",
    es: "Cuando [DESENCADENANTE], haré [ACCIÓN]."
};

// GOAL REDUCTION TEMPLATES [2025-02-09]: Used when Reality Gap is detected
const RECALIBRATION_TEMPLATES = {
    pt: "Nova Meta: [NÚMERO] [UNIDADE] por dia.",
    en: "New Goal: [NUMBER] [UNIT] per day.",
    es: "Nueva Meta: [NÚMERO] [UNIDAD] por día."
};

// TIME-SPECIFIC ANCHOR EXAMPLES (Contextual Relevance)
const TIME_ANCHORS = {
    Morning: {
        pt: "Ao acordar, Depois de escovar os dentes, Com o café",
        en: "Upon waking, After brushing teeth, With coffee",
        es: "Al despertar, Después de cepillarse, Con el café"
    },
    Afternoon: {
        pt: "Após o almoço, Ao fechar o laptop, Chegando em casa",
        en: "After lunch, Closing laptop, Arriving home",
        es: "Después del almuerzo, Al cerrar la laptop, Llegando a casa"
    },
    Evening: {
        pt: "Após o jantar, Colocando pijama, Antes de escovar os dentes",
        en: "After dinner, Putting on pajamas, Before brushing teeth",
        es: "Después de cenar, Poniéndose el pijama, Antes de cepillarse"
    }
};


export async function performAIAnalysis(analysisType: 'weekly' | 'monthly' | 'general') {
    closeModal(ui.aiOptionsModal);
    
    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    renderAINotificationState();

    const today = parseUTCIsoDate(getTodayUTCIso());
    let startDate: Date;
    let periodNameKey: string;
    let daysCount = 0;

    if (analysisType === 'weekly') {
        startDate = addDays(today, -7);
        periodNameKey = 'aiPeriodWeekly';
        daysCount = 7;
    } else if (analysisType === 'monthly') {
        startDate = addDays(today, -30);
        periodNameKey = 'aiPeriodMonthly';
        daysCount = 30;
    } else {
        startDate = addDays(today, -14); // General context
        periodNameKey = 'aiPeriodGeneral';
        daysCount = 14;
    }

    const periodName = t(periodNameKey);

    const langCode = state.activeLanguageCode || 'pt';
    const langMap: Record<string, string> = { 'pt': 'Portuguese', 'es': 'Spanish', 'en': 'English' };
    const targetLang = langMap[langCode];
    const headers = PROMPT_HEADERS[langCode as keyof typeof PROMPT_HEADERS] || PROMPT_HEADERS['pt'];
    
    // Default templates
    let implTemplate = IMPLEMENTATION_TEMPLATES[langCode as keyof typeof IMPLEMENTATION_TEMPLATES] || IMPLEMENTATION_TEMPLATES['en'];
    const recalibrationTemplate = RECALIBRATION_TEMPLATES[langCode as keyof typeof RECALIBRATION_TEMPLATES] || RECALIBRATION_TEMPLATES['en'];

    // Data Calculation structures
    // OPTIMIZATION: Use string array for semantic log instead of heavy object array
    const semanticLog: string[] = [];
    
    // Stats per Habit
    const statsMap = new Map<string, { 
        scheduled: number, 
        completed: number, 
        snoozed: number, 
        notesCount: number, 
        habit: Habit,
        extraMiles: number, 
        bounces: number,
        accumulatedValue: number, 
        valueCount: number 
    }>();
    
    // Stats per Time of Day (Chronobiology)
    const timeOfDayStats = {
        Morning: { scheduled: 0, completed: 0 },
        Afternoon: { scheduled: 0, completed: 0 },
        Evening: { scheduled: 0, completed: 0 }
    };

    // Trend Analysis
    const midPoint = Math.floor(daysCount / 2);
    const trendStats = {
        firstHalf: { scheduled: 0, completed: 0 },
        secondHalf: { scheduled: 0, completed: 0 }
    };

    // Contextual Variance
    const contextStats = {
        weekday: { scheduled: 0, completed: 0 },
        weekend: { scheduled: 0, completed: 0 }
    };

    // Bad Day Analysis
    const failedHabitsOnBadDays: Record<string, number> = {};
    const previousDayStatus: Record<string, string> = {}; 

    let totalLogs = 0;
    let totalNotes = 0;

    let currentDate = startDate;
    let dayIndex = 0;
    let redFlagDay = ""; // Specific day of collapse
    let sparklineHabitId: string | null = null;
    
    // OPTIMIZATION [2025-02-09]: Instantiate formatters outside loop
    const dayFormatter = getDateTimeFormat(state.activeLanguageCode, { weekday: 'short' });
    
    // [2025-02-14] New Metric: Active Habits Count for Burnout Detection
    const activeHabitsCount = state.habits.filter(h => !h.graduatedOn && !h.scheduleHistory[h.scheduleHistory.length-1].endDate).length;

    while (currentDate <= today) {
        const dateISO = toUTCIsoDateString(currentDate);
        const activeHabits = getActiveHabitsForDate(dateISO);
        const dailyInfo = getHabitDailyInfoForDate(dateISO);
        
        let dayScheduled = 0;
        let dayCompleted = 0;
        let dayLog = ""; // Build string for semantic log
        
        // 0 = Sunday, 6 = Saturday
        const dayOfWeek = currentDate.getUTCDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        if (activeHabits.length > 0) {
            // Setup habit stats
            activeHabits.forEach(({ habit }) => {
                if (!statsMap.has(habit.id)) {
                    statsMap.set(habit.id, { 
                        scheduled: 0, completed: 0, snoozed: 0, notesCount: 0, 
                        habit, extraMiles: 0, bounces: 0,
                        accumulatedValue: 0, valueCount: 0
                    });
                }
            });

            const dayEntriesStrings: string[] = [];

            // Get aggregate status
            activeHabits.forEach(({ habit, schedule }) => {
                const stats = statsMap.get(habit.id)!;
                const { name } = getHabitDisplayInfo(habit, dateISO);

                schedule.forEach(time => {
                    const instance = dailyInfo[habit.id]?.instances?.[time];
                    const status = instance?.status || 'pending';
                    const hasNote = instance?.note && instance.note.trim().length > 0;
                    
                    // Update Habit Stats
                    totalLogs++;
                    stats.scheduled++;
                    dayScheduled++;
                    
                    if (isWeekend) contextStats.weekend.scheduled++;
                    else contextStats.weekday.scheduled++;

                    if (hasNote) {
                        totalNotes++;
                        stats.notesCount++;
                    }
                    
                    timeOfDayStats[time].scheduled++;

                    if (dayIndex < midPoint) {
                        trendStats.firstHalf.scheduled++;
                    } else {
                        trendStats.secondHalf.scheduled++;
                    }

                    const target = habit.goal.total || 0;
                    const actual = instance?.goalOverride ?? (status === 'completed' ? target : 0);
                    
                    if (status === 'completed' && actual > target && target > 0) {
                        stats.extraMiles++;
                    }
                    
                    if (actual > 0) {
                        stats.accumulatedValue += actual;
                        stats.valueCount++;
                    }

                    if (status === 'completed') {
                        stats.completed++;
                        dayCompleted++;
                        timeOfDayStats[time].completed++;
                        if (dayIndex < midPoint) trendStats.firstHalf.completed++;
                        else trendStats.secondHalf.completed++;
                        
                        if (isWeekend) contextStats.weekend.completed++;
                        else contextStats.weekday.completed++;

                        if (previousDayStatus[habit.id] && previousDayStatus[habit.id] !== 'completed') {
                            stats.bounces++;
                        }
                        previousDayStatus[habit.id] = 'completed';
                    }
                    else {
                        if (status === 'snoozed') stats.snoozed++;
                        previousDayStatus[habit.id] = status; 
                        
                        // Track failures for bad day analysis
                        if (status !== 'snoozed') {
                             // Only pending counts as "failure" for this metric? Or both?
                             // Let's count pending as strict failure for the "bad day" culprit.
                        }
                    }

                    // SEMANTIC LOG BUILDING (Token efficient)
                    // Symbol mapping: Completed=✅, Snoozed=⏸️, Pending=❌
                    let symbol = '❌';
                    if (status === 'completed') symbol = '✅';
                    if (status === 'snoozed') symbol = '⏸️';
                    
                    let valStr = '';
                    if (actual > 0 && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
                        valStr = ` ${actual}/${target}`;
                    }
                    
                    // Include note text if present for deeper context
                    let noteStr = '';
                    if (hasNote) {
                        noteStr = ` "${instance!.note}"`;
                    }
                    
                    dayEntriesStrings.push(`${name}(${symbol}${valStr}${noteStr})`);
                });
            });

            // LOCALIZATION FIX: Use active language for weekday name
            const dayName = dayFormatter.format(currentDate);
            // TOKEN EFFICIENCY: Strip the year from the ISO date (YYYY-MM-DD -> MM-DD)
            dayLog = `${dateISO.substring(5)} (${dayName}): ${dayEntriesStrings.join(', ')}`;
            semanticLog.push(dayLog);

            // Bad Day Logic
            // RED FLAG DAY DETECTION: If > 50% failed/snoozed, mark this specific date for AI.
            if (dayScheduled > 0) {
                const successRate = dayCompleted / dayScheduled;
                // RECENCY BIAS FIX [2025-02-12]: We removed the check `!redFlagDay` to allow overwriting.
                // This ensures `redFlagDay` holds the MOST RECENT day of collapse.
                if (successRate < 0.5) {
                     redFlagDay = `${dayName} (${dateISO.substring(5)})`;
                }
                
                if (successRate < 0.5) {
                    // If it was a bad day, identify which habits were NOT completed
                    activeHabits.forEach(({ habit, schedule }) => {
                        const daily = dailyInfo[habit.id]?.instances;
                        schedule.forEach(time => {
                            const s = daily?.[time]?.status || 'pending';
                            if (s !== 'completed' && s !== 'snoozed') {
                                 failedHabitsOnBadDays[getHabitDisplayInfo(habit, dateISO).name] = (failedHabitsOnBadDays[getHabitDisplayInfo(habit, dateISO).name] || 0) + 1;
                            }
                        });
                    });
                }
            }
        } else {
             // LOG INTEGRITY FIX [2025-02-09]: Explicitly log days with no scheduled habits.
             // The symbol ▪️ allows the AI to distinguish "Rest Day" from "Failure".
             const dayName = dayFormatter.format(currentDate);
             semanticLog.push(`${dateISO.substring(5)} (${dayName}): ▪️ (No habits scheduled)`);
        }
        currentDate = addDays(currentDate, 1);
        dayIndex++;
    }

    // Build Statistics
    let statsSummary = "";
    const mysteryHabits: string[] = []; 
    let totalExtraMiles = 0;
    let totalBounces = 0;
    
    let highestStreakHabitName = "";
    let highestStreakValue = 0;
    let nemesisName = "";
    let highestSnoozeRate = -1;
    let realityGapWarning = "";
    
    statsMap.forEach((data, id) => {
        const { name } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
        const rate = data.scheduled > 0 ? (data.completed / data.scheduled) : 0;
        const snoozeRate = data.scheduled > 0 ? (data.snoozed / data.scheduled) : 0;
        const streak = calculateHabitStreak(id, toUTCIsoDateString(today));
        const noteInfo = data.notesCount > 0 ? `${data.notesCount} notes` : "NO NOTES";
        
        totalExtraMiles += data.extraMiles;
        totalBounces += data.bounces;

        statsSummary += `- **${name}**: ${Math.round(rate * 100)}% Success. Streak: ${streak}. (Snoozed: ${Math.round(snoozeRate * 100)}%). Notes: ${noteInfo}\n`;

        if (rate < 0.6 && data.notesCount === 0) {
            mysteryHabits.push(name);
        }
        
        if (streak > highestStreakValue) {
            highestStreakValue = streak;
            highestStreakHabitName = name;
        }

        if (snoozeRate > highestSnoozeRate && data.scheduled > 3) { 
            highestSnoozeRate = snoozeRate;
            nemesisName = name;
        }

        // CALCULATED REALITY GAP (Math done in code, not AI)
        if (data.habit.goal.type === 'pages' || data.habit.goal.type === 'minutes') {
            const target = data.habit.goal.total || 0;
            if (target > 0 && data.valueCount > 0) {
                const avgActual = data.accumulatedValue / data.valueCount;
                if (avgActual < target * 0.7) { 
                    const suggested = Math.floor(avgActual);
                    realityGapWarning += `Habit '${name}': Target ${target}, Avg Actual ${Math.round(avgActual)}. -> SUGGESTION: Lower goal to ${suggested}.\n`;
                }
            }
        }
    });
    
    if (!statsSummary) {
        statsSummary = "No active habits tracked yet.";
    }

    const nemesisInfo = nemesisName && highestSnoozeRate > 0.2 
        ? `The Nemesis: **${nemesisName}** (Snoozed ${Math.round(highestSnoozeRate * 100)}% of the time).` 
        : "No significant Nemesis.";

    let temporalSummary = "";
    let lowestPerfTime: TimeOfDay = 'Morning';
    let lowestPerfRate = 1.0;

    Object.entries(timeOfDayStats).forEach(([time, data]) => {
        const rate = data.scheduled > 0 ? Math.round((data.completed / data.scheduled) * 100) : 0;
        if (data.scheduled > 0) {
            temporalSummary += `- **${time}**: ${rate}% Success Rate (${data.completed}/${data.scheduled})\n`;
            
            // Find struggling time
            if ((data.completed / data.scheduled) < lowestPerfRate) {
                lowestPerfRate = data.completed / data.scheduled;
                lowestPerfTime = time as TimeOfDay;
            }
        }
    });

    // Determine anchors based on struggling time
    const timeAnchors = TIME_ANCHORS[lowestPerfTime][langCode as keyof typeof TIME_ANCHORS.Morning] || TIME_ANCHORS.Morning.en;


    const firstHalfRate = trendStats.firstHalf.scheduled > 0 ? Math.round((trendStats.firstHalf.completed / trendStats.firstHalf.scheduled) * 100) : 0;
    const secondHalfRate = trendStats.secondHalf.scheduled > 0 ? Math.round((trendStats.secondHalf.completed / trendStats.secondHalf.scheduled) * 100) : 0;
    const trendDiff = secondHalfRate - firstHalfRate;
    const trendDescription = trendDiff > 5 ? "RISING MOMENTUM 🚀" : (trendDiff < -5 ? "LOSING MOMENTUM 📉" : "STABLE ➖");
    
    const weekdayRate = contextStats.weekday.scheduled > 0 ? Math.round((contextStats.weekday.completed / contextStats.weekday.scheduled) * 100) : 0;
    const weekendRate = contextStats.weekend.scheduled > 0 ? Math.round((contextStats.weekend.completed / contextStats.weekend.scheduled) * 100) : 0;
    const contextDescription = `Weekday Success: ${weekdayRate}% vs Weekend Success: ${weekendRate}%`;

    const culpritEntry = Object.entries(failedHabitsOnBadDays).sort((a, b) => b[1] - a[1])[0];
    const culpritInfo = culpritEntry ? `Habit most often associated with 'Bad Days': **${culpritEntry[0]}**` : "None.";

    const noteDensity = totalLogs > 0 ? Math.round((totalNotes / totalLogs) * 100) : 0;
    
    const globalRate = (firstHalfRate + secondHalfRate) / 2;

    // Logic Refinement - Only complain about notes if performance is low
    let dataQualityWarning = "Good context.";
    if (globalRate < 80 && mysteryHabits.length > 0) {
         dataQualityWarning = `MISSING CONTEXT: User is failing at ${mysteryHabits.join(', ')} but has written ZERO notes.`;
    } else if (globalRate >= 80) {
         dataQualityWarning = "High performance; notes are optional.";
    }

    let seasonalPhase = "";
    if (globalRate > 85 && trendDiff >= -2) seasonalPhase = "SUMMER (Harvest/Flow) - High performance.";
    else if (globalRate < 50) seasonalPhase = "WINTER (The Citadel) - Low performance, focus on resilience.";
    else if (trendDiff > 5) seasonalPhase = "SPRING (Ascent) - Growing momentum.";
    else seasonalPhase = "AUTUMN (Turbulence) - Declining momentum.";

    let projectionInfo = "No active streaks.";
    
    // PROJECTION SUPPRESSION [2025-02-12]: If user is crashing (Winter/Low Rate), suppress dates.
    if (globalRate < 50) {
        projectionInfo = "Current trajectory is unstable. The path forward requires stabilizing ONE habit before projecting future milestones.";
    } else if (highestStreakValue > 0) {
        const nextMilestone = highestStreakValue < 21 ? 21 : (highestStreakValue < 66 ? 66 : (highestStreakValue < 100 ? 100 : 365));
        const daysRemaining = nextMilestone - highestStreakValue;
        const projectedDate = addDays(today, daysRemaining);
        // FIX [2025-02-08]: Date Localization Bug. Use activeLanguageCode instead of 'en-US'.
        const dateStr = getDateTimeFormat(state.activeLanguageCode, { month: 'long', day: 'numeric' }).format(projectedDate);
        projectionInfo = `Best Habit: ${highestStreakHabitName} (Streak: ${highestStreakValue}). Next milestone (${nextMilestone} days) on: ${dateStr}.`;
    }

    // --- ARCHETYPE CALCULATION (Deterministic Logic) ---
    let archetype = "The Drifter";
    let archetypeReason = "Patterns are inconsistent.";
    let identityStrategy = "Radical Simplification. Focus on ONE habit anchored to a biological trigger."; 

    if (globalRate >= 80) {
        archetype = "The Consistent Stoic";
        archetypeReason = `Global success rate is high (${globalRate}%).`;
        identityStrategy = "Normalize excellence. Warn against complacency. Vigilance is the price of mastery.";
    } else if (weekendRate > weekdayRate + 20) {
        archetype = "The Weekend Warrior";
        archetypeReason = `Weekend performance (${weekendRate}%) significantly exceeds weekdays (${weekdayRate}%).`;
        // STRATEGIC FIX [2025-02-09]: The Weekend Warrior needs load distribution, not just encouragement.
        identityStrategy = "Redistribute the load. Move one weekend habit to Tuesday/Thursday to bridge the gap.";
    } else if (weekdayRate > weekendRate + 20) {
        archetype = "The Grinder (Structure Dependent)";
        archetypeReason = `Weekday performance (${weekdayRate}%) significantly exceeds weekends (${weekendRate}%).`;
        identityStrategy = "Develop internal discipline independent of external structure.";
    } else if (highestSnoozeRate > 0.20) {
        archetype = "The Perfectionist (Avoidant)";
        archetypeReason = `High snooze rate detected on key habits.`;
        identityStrategy = "Teach that 'Done is better than perfect'. Encourage partial efforts.";
    } else if (totalExtraMiles > 5 && globalRate < 60) {
        archetype = "The Sprinter";
        archetypeReason = "High intensity bursts (Extra Miles) but lower consistency.";
        identityStrategy = "Shift focus from Intensity to Consistency. Lower the bar to raise the floor.";
    } else if (totalLogs < 20 && trendDiff > 0) {
        archetype = "The Starter";
        archetypeReason = "New journey with positive momentum.";
        identityStrategy = "Validate the start. Reinforce the new identity.";
    }
    
    // SHADOW WORK FIX [2025-02-09]: Add suffix for negative archetypes
    if (archetype === "The Drifter" || archetype === "The Weekend Warrior" || archetype === "The Sprinter") {
        archetype += " (Shadow State)";
    }

    // --- SMART QUOTE SELECTION (Contextual Filtering by TAGS) ---
    let quoteFilterFn = (q: any) => true; // Default to all
    let quoteReason = "General Wisdom"; 

    // NEW [2025-02-14]: Burnout / Overwhelm Detection
    const isBurnout = activeHabitsCount > 6 && trendDiff < 0;
    
    // NEW [2025-02-14]: Drifter / Lack of Focus Detection
    const isDrifter = archetype.includes("Drifter");

    if (isBurnout) {
        // PROBLEM: Too many habits, performance dropping.
        // REMEDY: Seneca/Cleanthes (Simplicity, Rest, Essentialism)
        quoteFilterFn = (q) => q.tags.includes('simplicity') || q.tags.includes('rest') || q.tags.includes('essentialism');
        quoteReason = "simplifying your routine to prevent burnout (Essentialism)";
    } else if (highestSnoozeRate > 0.15) {
        // PROBLEM: Procrastination / Delay
        // TAGS: Action, Time
        quoteFilterFn = (q) => q.tags.includes('action') || q.tags.includes('time');
        quoteReason = "overcoming the inertia of procrastination";
    } else if (realityGapWarning.length > 0) {
        // PROBLEM: Delusion / Unrealistic Goals
        // TAGS: Control, Reality
        quoteFilterFn = (q) => q.tags.includes('control') || q.tags.includes('reality');
        quoteReason = "aligning ambition with reality";
    } else if (seasonalPhase.includes("WINTER") || seasonalPhase.includes("AUTUMN")) {
        // PROBLEM: Hardship / Low Energy
        // TAGS: Resilience, Suffering
        quoteFilterFn = (q) => q.tags.includes('resilience') || q.tags.includes('suffering');
        quoteReason = "finding strength in adversity";
    } else if (seasonalPhase.includes("SUMMER")) {
        // PROBLEM: Success / Complacency / Arrogance
        // TAGS: Nature, Humility
        quoteFilterFn = (q) => q.tags.includes('nature') || q.tags.includes('humility');
        quoteReason = "maintaining humility in success";
    } else if (isDrifter) {
        // PROBLEM: Lack of Focus
        // TAGS: Discipline, Focus
        quoteFilterFn = (q) => q.tags.includes('discipline') || q.tags.includes('focus');
        quoteReason = "building the foundation of discipline";
    } else if (lowestPerfRate < 0.6) {
        // NEW [2025-02-14]: Chronobiological Targeting
        // If failing specifically in Morning or Evening, look for matching tags
        if (lowestPerfTime === 'Morning') {
            quoteFilterFn = (q) => q.tags.includes('time') || q.tags.includes('action') || q.tags.includes('morning'); // Fallback to time/action if no explicit morning tag yet
            quoteReason = "conquering the morning resistance";
        } else if (lowestPerfTime === 'Evening') {
            quoteFilterFn = (q) => q.tags.includes('reflection') || q.tags.includes('evening') || q.tags.includes('gratitude');
            quoteReason = "closing the day with purpose";
        }
    } else if (redFlagDay) {
        // PROBLEM: Specific Day Collapse
        // TAGS: Acceptance, Fate
        quoteFilterFn = (q) => q.tags.includes('acceptance') || q.tags.includes('fate');
        quoteReason = "accepting the chaos of a bad day (Amor Fati)";
    } else if (archetype.includes("Initiate") || archetype.includes("Starter")) {
        // PROBLEM: Fear of starting
        // TAGS: Courage, Preparation
        quoteFilterFn = (q) => q.tags.includes('courage') || q.tags.includes('preparation');
        quoteReason = "finding the courage to begin";
    }

    const quotePool = STOIC_QUOTES.filter(quoteFilterFn);
    // Fallback if filter is too strict (shouldn't happen given the broad categories)
    const finalPool = quotePool.length > 0 ? quotePool : STOIC_QUOTES;
    
    const selectedQuote = finalPool[Math.floor(Math.random() * finalPool.length)];
    const quoteText = selectedQuote[langCode as 'pt'|'en'|'es'] || selectedQuote['en'];
    const quoteAuthor = t(selectedQuote.author);

    // --- DYNAMIC INSTRUCTION INJECTION (Prompt Engineering) ---
    // Instead of complex IF/ELSE inside the prompt text, we inject the specific instruction
    // based on the user's state (Winter vs Summer). This reduces token usage and cognitive load on the AI.
    let systemInstructionText = "Suggest a specific 'Implementation Intention' to reduce friction (Mise-en-place).";
    
    // REFINE [2025-02-09]: 'Gateway Habit' terminology for low performance
    // BEHAVIORAL UPDATE [2025-02-09]: Require Biological/Mechanical Anchors.
    // CRITICAL UPDATE [2025-02-12]: Moved TIMING RULE here to make it dynamic.
    let actionInstructionText = `One tiny, 'Gateway Habit' (less than 2 min). A physical movement that initiates the flow. Link it to a PRECISE BIOLOGICAL/MECHANICAL ANCHOR (e.g. 'Feet hit floor', 'Turn off shower', 'Close laptop') suitable for the user's struggle time (${lowestPerfTime}). Avoid time-based anchors (e.g. 'At 8am'). Time Horizon: NOW or TONIGHT. Never Tomorrow.`;
    
    // If we have morning failure, enforce the Night Before rule.
    if (lowestPerfTime === 'Morning' && lowestPerfRate < 0.6) {
        actionInstructionText += " TIMING RULE: Since the failure happens in the Morning, the Trigger MUST happen the **Night Before** (Preparation) OR **Immediately upon Waking** (if prep is impossible).";
    }
    
    let socraticInstruction = "Ask about FRICTION (What stands in the way? Is it fatigue or fear?).";
    let patternInstruction = "Use the Semantic Log. Scan the **LAST 3 DAYS** specifically (Recency Bias). Identify the **'Turning Point'** (the specific day/moment where the streak broke or the victory was secured). Mention it explicitly. Scan Vertically (Habit Consistency) and Horizontally (Day Collapse).";
    
    let tweaksExamples = `
    Examples of System Tweaks (Low Friction):
    - Bad: "Read more." -> Good: "When I drink coffee, I will open the book."
    - Bad: "Workout." -> Good: "When I wake up, I will put on gym shoes."
    `;

    let headerSystem = headers.system_low;
    let headerAction = headers.action_low;
    
    let insightPlaceholder = "[Synthesize the struggle or victory regarding the PRIMARY FOCUS. USE MENTAL CONTRASTING: Compare current reality vs desired identity. 2-3 sentences. WRITE AS A PARAGRAPH. NO LISTS.]";
    let actionPlaceholder = "[One tiny 'Gateway Habit' step (< 2 min). Focus on MISE-EN-PLACE (Preparation) linked to an ANCHOR.]";


    // FOCUS LOGIC & SPARKLINE GENERATION
    let focusTarget = "Sustainability & Burnout Prevention (Maintenance)";
    
    if (highestStreakHabitName) {
         focusTarget = `'Keystone Habit' (${highestStreakHabitName})`;
         // Find ID of highest streak habit for sparkline
         for (const [id, data] of statsMap.entries()) {
             const { name } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
             if (name === highestStreakHabitName) sparklineHabitId = id;
         }
    }
    if (nemesisName) {
        focusTarget = `'Nemesis' (${nemesisName}) - Source of the problem`;
        for (const [id, data] of statsMap.entries()) {
             const { name } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
             if (name === nemesisName) sparklineHabitId = id;
        }
    }
    
    // FIX [2025-02-09]: Reality Gap Overrides
    if (realityGapWarning.length > 0) {
        focusTarget = "the Reality Gap (Goal Reduction) - Source of the problem";
        // Override system instruction for Reality Gap
        systemInstructionText = "Your 'System Tweak' MUST be a direct command to reduce the numeric goal to match reality. Do NOT use the 'When/Then' template. Just stating the new goal is enough.";
        implTemplate = recalibrationTemplate; // Use "New Goal: X" instead of "When X..."
        // Override the time restriction for Reality Gap (since it's a goal change, not a trigger)
        actionInstructionText = "Commit to the new, smaller number immediately. The action is 'Mental Acceptance'.";
    }
    
    // NEW [2025-02-09]: Prioritize the Red Flag Day (Day Collapse)
    if (redFlagDay) focusTarget = `The Collapse on ${redFlagDay} - Analyze why this specific day failed.`;
    
    // NEW [2025-02-14]: Prioritize Burnout if detected
    if (isBurnout) {
        focusTarget = "BURNOUT RISK (Too many habits, dropping trend). Priority: Simplicity.";
        systemInstructionText = "Suggest PAUSING or ARCHIVING one habit to save the others. The system is overloaded.";
        actionInstructionText = "A specific action to Rest or Simplify. e.g. 'Delete one task from to-do list'.";
    }

    // SPARKLINE GENERATOR (Visual Pattern)
    let sparkline = "";
    if (sparklineHabitId) {
        const habit = state.habits.find(h => h.id === sparklineHabitId);
        if (habit) {
            const days: string[] = [];
            // Last 7 days
            for (let i = 6; i >= 0; i--) {
                const d = addDays(today, -i);
                const dISO = toUTCIsoDateString(d);
                const daily = state.dailyData[dISO]?.[sparklineHabitId]?.instances || {};
                
                const schedule = getEffectiveScheduleForHabitOnDate(habit, dISO);
                if (schedule.length === 0) {
                     days.push('▪️'); // No schedule
                     continue;
                }
                
                let dayStatus = '❌';
                let hasCompleted = false;
                let hasSnoozed = false;
                
                for (const time of schedule) {
                    const s = daily[time]?.status;
                    if (s === 'completed') hasCompleted = true;
                    if (s === 'snoozed') hasSnoozed = true;
                }
                
                if (hasCompleted) dayStatus = '✅';
                else if (hasSnoozed) dayStatus = '⏸️';
                
                days.push(dayStatus);
            }
            sparkline = days.join(' ');
        }
    }


    let taskDescription = `Write a structured, soulful Stoic mentorship reflection based on the user's evidence (${periodName})`;
    
    // MASKING DATA FOR COLD START (Prevent Hallucination)
    let logContent = semanticLog.join('\n');

    // --- COLD START / ONBOARDING MODE ---
    // Detects new users with very little data to prevent hallucinated pattern recognition.
    if (totalLogs < 5) {
        seasonalPhase = "THE BEGINNING (Day 1)";
        archetype = "The Initiate";
        archetypeReason = "Just started the journey.";
        focusTarget = "Building the Foundation (Start Small)";
        systemInstructionText = "Suggest a very small, almost ridiculous starting step to build momentum.";
        socraticInstruction = "Ask what is the smallest version of this habit they can do even on their worst day.";
        patternInstruction = "Do NOT look for trends yet. Validate the courage of the first step.";
        insightPlaceholder = "[Welcome them to the Stoic path. Validate the difficulty of starting. Focus on the courage to begin.]";
        taskDescription = "Write a welcoming and foundational Stoic mentorship letter for a beginner.";
        sparkline = ""; // No sparkline for beginners
        // MASKING: Clear the log to stop AI from reading non-existent patterns
        logContent = "(Insufficient data for pattern recognition - Focus solely on the virtue of starting.)";
    } else if (globalRate > 80 || seasonalPhase.includes("SUMMER")) {
        systemInstructionText = "Suggest a method to increase difficulty (Progressive Overload) or efficiency. Challenge them.";
        
        // REFINE [2025-02-09]: High Performance Action Instruction
        actionInstructionText = "A specific experimental step to Challenge Limits, Teach Others, or Vary the Context (Anti-fragility). Link to an Anchor.";
        
        socraticInstruction = "Use 'Eternal Recurrence' (Amor Fati). Ask: 'Would you be willing to live this exact week again for eternity?'";
        
        // NEW [2025-02-09]: High Streak Anxiety Logic
        if (highestStreakValue > 30) {
            socraticInstruction = "Deconstruct the fear of losing the streak. Ask: 'Does the value lie in the number (external) or the character you are building (internal)?'";
        }
        
        tweaksExamples = `
        Examples of System Tweaks (High Performance):
        - Bad: "Keep going." -> Good: "When I finish the set, I will add 5 minutes."
        - Bad: "Good job." -> Good: "When I master this, I will teach it to someone else."
        `;

        // SWITCH TO HIGH PERF HEADERS & PLACEHOLDERS
        headerSystem = headers.system_high;
        headerAction = headers.action_high;
        insightPlaceholder = "[Synthesize the victory. Analyze what makes their consistency possible and where the next plateau lies. 2-3 sentences. NO LISTS.]";
        actionPlaceholder = "[A specific constraint or added difficulty to test their mastery (Progressive Overload).]";
    }

    // LANGUAGE SPECIFIC FORBIDDEN WORDS
    const forbiddenWhyMap = {
        pt: '"Por que"',
        en: '"Why"',
        es: '"Por qué"'
    };
    const forbiddenWhy = forbiddenWhyMap[langCode as 'pt'|'en'|'es'] || '"Why"';
    
    // CURRENT DATE FOR CONTEXT
    const currentDateStr = toUTCIsoDateString(today);


    const prompt = `
        ### THE COMPASS (Primary Focus):
        PRIMARY FOCUS: ${focusTarget}
        PATTERN: ${sparkline}
        REFERENCE DATE (TODAY): ${currentDateStr}
        (The Title, Insight, and System Tweak MUST revolve around this focus.)

        ### 1. THE CONTEXT (Data)
        - **Stats:** \n${statsSummary}
        - **Gaps:** Note Density: ${noteDensity}%. ${dataQualityWarning}
        - **Trend:** Momentum: ${trendDescription}. Keystone Failure: ${culpritInfo}
        - **Friction:** ${nemesisInfo}
        - **Red Flag Day (Collapse):** ${redFlagDay || "None"}
        - **Struggling Time:** ${lowestPerfTime}

        ### 2. THE STRATEGY
        - **Bio-rhythm:** \n${temporalSummary}
        - **Reality Check (Math Calculated):** \n${realityGapWarning || "Goals are realistic."}
        - **Metrics:** Extra Miles: ${totalExtraMiles}. Bounce Backs: ${totalBounces}.

        ### 3. THE PHILOSOPHY
        - **Season:** ${seasonalPhase}
        - **Projection:** ${projectionInfo}
        - **Identity (Calculated):** ${archetype} (${archetypeReason})
        - **Identity Strategy:** ${identityStrategy}
        - **Selected Wisdom:** "${quoteText}" - ${quoteAuthor}
        - **Wisdom Intent:** Chosen to address: ${quoteReason}

        ### SEMANTIC LOG (The User's Week):
        (Legend: ✅=Success, ❌=Pending/Fail, ⏸️=Snoozed, "Text"=User Note. Ordered by time of day.)
        ${logContent}

        INSTRUCTIONS:
        1. **BENEVOLENT DETACHMENT:** Do NOT praise ("Good job") or scold ("Do better"). Be an observant mirror. Firm but warm. Do NOT write "Based on the data". Speak naturally, like a mentor writing a letter. Use PARAGRAPHS, NOT LISTS for text sections. NO GREETINGS. NO SIGNATURES. Start directly with the Title.
        2. **BE SOCRATIC:** ${socraticInstruction}
           - **CONSTRAINT:** One single, piercing sentence. DO NOT use the word ${forbiddenWhy} (or its translations). AVOID YES/NO questions (e.g. "Are you commited?"). Force deep processing.
        3. **PATTERN RECOGNITION:** ${patternInstruction} STRICT DATA FIDELITY: Do not invent streaks or failures not shown in the Semantic Log.
        4. **THE PROTOCOL (SYSTEM):** 
           - ${systemInstructionText}
           - **SYNTAX:** Use EXACTLY this template: "${implTemplate}" (REMOVE BRACKETS when filling). (Output ONLY the sentence, no intro/outro)
           - **FOCUS:** Focus on the PRIMARY FOCUS defined above. ZERO COST.
           - **CONSTRAINT:** ACTION must be a single, binary event (e.g. 'open book', 'put on shoes'). Forbidden verbs: try, attempt, focus, aim, should.
        5. **CONNECT WISDOM:** Use the provided quote ("${quoteText}"). Do NOT explain the quote itself. Use the quote's concept to illuminate the user's specific struggle/victory.
        6. **INTERPRET LOG:** 
           - ✅ = Success.
           - ⏸️ = **Resistance** (User saw it but delayed). REMEDY: Lower the bar. 
           - **NOTE HANDLING:** If a "Note" is present with ⏸️ or ❌, analyze the sentiment. If it's Internal (Lazy, Bored), treat as Resistance (Action required). If it's External (Sick, Emergency), treat as Amor Fati (Acceptance).
           - ❌ = **Neglect** (User forgot). REMEDY: Increase Visibility / Better Trigger.
           - ▪️ = **Rest/No Schedule** (Not a failure).
           - **NUMBERS (e.g. 5/10):** Partial Success. If Actual < Target, acknowledge effort but note the gap.
        7. **THE TRIGGER (PHYSICS):** ${actionInstructionText}

        OUTPUT STRUCTURE (Markdown in ${targetLang}):

        ### 🏛️ [Title: Format "On [Concept]" or Abstract Noun. NO CHEESY TITLES.]

        **🆔 ${headers.archetype}**
        [Contextualize the '${archetype}' identity. Translate the identity term to ${targetLang} culturally. Apply Strategy: "${identityStrategy}". Do not name the strategy, embody it. 1 sentence.]

        **🔮 ${headers.projection}**
        [Frame the projection date as a logical consequence (Cause & Effect). "The path leads to..."]

        **📊 ${headers.insight}**
        ${insightPlaceholder}

        **⚙️ ${headerSystem}**
        [The Implementation Intention using the template: "${implTemplate}". Zero cost. The Rule. REMOVE BRACKETS.]

        **❓ ${headers.socratic}**
        [One deep, single-sentence question.]

        **🏛️ ${headers.connection}**
        [Quote provided above]
        [Connect the wisdom to the data.]

        **🎯 ${headerAction}**
        ${actionPlaceholder}
    `;

    try {
        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({
                prompt,
                systemInstruction: `You are Askesis AI, a wise Stoic companion. ${taskDescription}. You write "Stoic Letters" - dense, profound, and direct blocks of wisdom.
                
                STYLE: Epistolary (Letter-like), concise, grave but kind. Benevolent Detachment.
                FORBIDDEN: "Based on the data", "Here is the analysis", "According to the stats", "Why", "Amor Fati", "Mise-en-place". (Apply the concepts, do not name them).
                STRUCTURE: Do NOT use greetings ("Hello", "Dear User") or sign-offs ("Best regards"). Start directly with the Title.
                GOLDEN RULE: Never advise "trying harder" or "being more disciplined". Advise "changing the method" or "altering the environment".
                
                FOCUS:
                1. Identity (Who they are becoming).
                2. Environment (How to change the room, not the will).
                3. The Why (Deep understanding of patterns).
                4. Amor Fati (Accept failure as data, not sin).
                
                ${tweaksExamples}

                FORBIDDEN VERBS (Action): try, attempt, focus, aim, should, must, will try.
                REQUIRED VERBS: open, put, write, step, walk, turn off.
                TIME HORIZON: Actions must be doable NOW or TONIGHT. Never "Tomorrow".
                `
            })
        });

        if (!response.ok) throw new Error('AI request failed');

        const text = await response.text();
        state.lastAIResult = text;
        state.aiState = 'completed';
        
        ui.aiResponse.innerHTML = simpleMarkdownToHTML(text);
        openModal(ui.aiModal);

    } catch (error) {
        console.error("AI Analysis failed", error);
        state.aiState = 'error';
        state.lastAIResult = t('aiErrorGeneric');
        state.lastAIError = error instanceof Error ? error.message : String(error);
    } finally {
        renderAINotificationState();
        saveState();
    }
}

export function handleHabitDrop(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    // Pergunta: Mover só hoje ou para sempre?
    // Reutiliza _requestFutureScheduleChange
    const date = state.selectedDate;
    const { name } = getHabitDisplayInfo(habit, date);

    _requestFutureScheduleChange(
        habit,
        date,
        t('confirmHabitMove', { habitName: name, oldTime: t(`filter${fromTime}`), newTime: t(`filter${toTime}`) }),
        t('modalMoveHabitTitle'),
        fromTime,
        toTime
    );
}

export function reorderHabit(habitId: string, targetHabitId: string, position: 'before' | 'after') {
    const oldIndex = state.habits.findIndex(h => h.id === habitId);
    const targetIndex = state.habits.findIndex(h => h.id === targetHabitId);
    
    if (oldIndex === -1 || targetIndex === -1) return;

    // Remove
    const [habit] = state.habits.splice(oldIndex, 1);
    
    // Recalcula índice de destino após remoção
    let newIndex = state.habits.findIndex(h => h.id === targetHabitId);
    if (position === 'after') newIndex++;

    // Insere
    state.habits.splice(newIndex, 0, habit);

    state.uiDirtyState.habitListStructure = true;
    saveState();
    renderHabits();
}