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

        // Limpa overrides diários que poderiam conflitar.
        // Importante fazer isso DEPOIS de analisar o dailyInfo acima.
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
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
        system: "Ajuste de Sistema (Ambiente)",
        socratic: "Reflexão Socrática",
        connection: "A Conexão Ancestral",
        action: "Micro-Ação (Mise-en-place)"
    },
    en: {
        archetype: "Behavioral Archetype",
        projection: "The Oracle's Projection",
        insight: "Deep Insight",
        system: "System Tweak (Environment)",
        socratic: "Socratic Reflection",
        connection: "The Ancient Connection",
        action: "Micro-Action (Mise-en-place)"
    },
    es: {
        archetype: "Arquetipo de Comportamiento",
        projection: "La Proyección del Oráculo",
        insight: "Análisis Profundo",
        system: "Ajuste de Sistema (Entorno)",
        socratic: "Reflexión Socrática",
        connection: "La Conexión Ancestral",
        action: "Micro-Acción (Mise-en-place)"
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
            const dayName = getDateTimeFormat(state.activeLanguageCode, { weekday: 'short' }).format(currentDate);
            // TOKEN EFFICIENCY: Strip the year from the ISO date (YYYY-MM-DD -> MM-DD)
            dayLog = `${dateISO.substring(5)} (${dayName}): ${dayEntriesStrings.join(', ')}`;
            semanticLog.push(dayLog);

            // Bad Day Logic
            if (dayScheduled > 0 && (dayCompleted / dayScheduled) < 0.5) {
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

    const nemesisInfo = nemesisName && highestSnoozeRate > 0.2 
        ? `The Nemesis: **${nemesisName}** (Snoozed ${Math.round(highestSnoozeRate * 100)}% of the time).` 
        : "No significant Nemesis.";

    let temporalSummary = "";
    Object.entries(timeOfDayStats).forEach(([time, data]) => {
        const rate = data.scheduled > 0 ? Math.round((data.completed / data.scheduled) * 100) : 0;
        if (data.scheduled > 0) {
            temporalSummary += `- **${time}**: ${rate}% Success Rate (${data.completed}/${data.scheduled})\n`;
        }
    });

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
    const dataQualityWarning = mysteryHabits.length > 0 
        ? `MISSING CONTEXT: User is failing at ${mysteryHabits.join(', ')} but has written ZERO notes.`
        : "Good context.";

    const globalRate = (firstHalfRate + secondHalfRate) / 2;
    let seasonalPhase = "";
    if (globalRate > 85 && trendDiff >= -2) seasonalPhase = "SUMMER (Harvest/Flow) - High performance.";
    else if (globalRate < 50) seasonalPhase = "WINTER (The Citadel) - Low performance, focus on resilience.";
    else if (trendDiff > 5) seasonalPhase = "SPRING (Ascent) - Growing momentum.";
    else seasonalPhase = "AUTUMN (Turbulence) - Declining momentum.";

    let projectionInfo = "No active streaks.";
    if (highestStreakValue > 0) {
        const nextMilestone = highestStreakValue < 21 ? 21 : (highestStreakValue < 66 ? 66 : (highestStreakValue < 100 ? 100 : 365));
        const daysRemaining = nextMilestone - highestStreakValue;
        const projectedDate = addDays(today, daysRemaining);
        // FIX [2025-02-08]: Date Localization Bug. Use activeLanguageCode instead of 'en-US'.
        const dateStr = getDateTimeFormat(state.activeLanguageCode, { month: 'long', day: 'numeric' }).format(projectedDate);
        projectionInfo = `Best Habit: ${highestStreakHabitName} (Streak: ${highestStreakValue}). Next milestone (${nextMilestone} days) on: ${dateStr}.`;
    }

    const prompt = `
        ROLE: Askesis AI (Stoic Mentor & Data Scientist).
        TASK: Analyze user data for the "${periodName}" and provide high-impact feedback in ${targetLang}.

        ### 1. THE ANALYST (Quant/Facts)
        - **Stats:** \n${statsSummary}
        - **Gaps:** Note Density: ${noteDensity}%. ${dataQualityWarning}
        - **Trend:** Momentum: ${trendDescription}. Keystone Failure: ${culpritInfo}
        - **Friction:** ${nemesisInfo}

        ### 2. THE STRATEGIST (Systems/Time)
        - **Bio-rhythm:** \n${temporalSummary}
        - **Reality Check (Math Calculated):** \n${realityGapWarning || "Goals are realistic."}
        - **Metrics:** Extra Miles: ${totalExtraMiles}. Bounce Backs: ${totalBounces}.

        ### 3. THE PHILOSOPHER (Identity/Future)
        - **Season:** ${seasonalPhase}
        - **Projection:** ${projectionInfo}
        - **Identity:** ${contextDescription} (Structure vs Freedom)

        ### ARCHETYPE LOGIC (Mental Mapping):
        - **The Consistent Stoic:** Global Rate > 80%.
        - **The Weekend Warrior:** Weekend > Weekday (+20% diff).
        - **The Grinder (Structure Dependent):** Weekday > Weekend (+20% diff).
        - **The Perfectionist:** High Snooze Rate (> 20%) OR High Extra Miles but Low Consistency.
        - **The Starter:** Streak < 7 but Rising Momentum.
        - **The Drifter:** Low Momentum, Random patterns.

        ### SEMANTIC LOG (Patterns):
        ${semanticLog.join('\n')}

        INSTRUCTIONS:
        1. **NO REPORTING:** Do NOT list the stats. Use them to form INSIGHTS.
        2. **BE SOCRATIC:** Ask a question that forces reflection.
        3. **SYSTEM TWEAKS:** Suggest ENVIRONMENTAL changes (e.g. "Place the book on pillow").
        4. **QUOTE:** Pick a quote from Seneca, Epictetus, or Aurelius that matches the *Season*.
        5. **SUCCESS HANDLING:** If performance is high (Summer/Spring), do NOT invent problems. Focus on Optimization (Progressive Overload).
        6. **INTERPRET LOG:** ✅=Success, ❌=Pending/Fail, ⏸️=Snoozed, "Text"=User Note.

        OUTPUT STRUCTURE (Markdown in ${targetLang}):

        ### 🏛️ [Stoic Title]

        **🆔 ${headers.archetype}**
        [Select the ONE matching Archetype from the LOGIC list above. Explain why in 1 sentence.]

        **🔮 ${headers.projection}**
        [Motivate them with the Projection date. 1-2 sentences.]

        **📊 ${headers.insight}**
        [Synthesize the data. Connect friction to reality gaps. 2-3 sentences.]

        **⚙️ ${headers.system}**
        [A specific architectural change to their routine. Focus on reducing friction.]

        **❓ ${headers.socratic}**
        [Ask ONE deep question about their pattern.]

        **🏛️ ${headers.connection}**
        [Quote]
        [Why this quote applies to their *specific* data.]

        **🎯 ${headers.action}**
        [One tiny step (< 2 min). Focus on MISE-EN-PLACE (Preparation/Environment).]
    `;

    try {
        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({
                prompt,
                systemInstruction: `You are Askesis AI. Answer in ${targetLang}. Start the response immediately with the Title. Do not write "Here is the analysis" or "Based on the data". Be concise, profound, and analytical. DO NOT repeat stats. Focus on behavioral psychology and Stoicism.
                
                Examples of System Tweaks:
                - Bad: "Read more."
                - Good: "Put the book on your pillow before leaving for work."
                - Bad: "Drink water."
                - Good: "Fill two bottles at night and place one on your desk."
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