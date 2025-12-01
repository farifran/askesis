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
    invalidateDaySummaryCache,
    getActiveHabitsForDate,
    AppState,
    getHabitDailyInfoForDate,
    HabitDailyInfo // Required for correlation helper
} from './state';
import { ui } from './ui';
import { 
    renderApp, renderHabits, openEditModal, 
    closeModal, showConfirmationModal, showUndoToast, renderAINotificationState, renderHabitCardState,
    renderCalendarDayPartial, setupManageModal, removeHabitFromCache
} from './render';
import { t, getHabitDisplayInfo } from './i18n';
import { 
    toUTCIsoDateString, parseUTCIsoDate, generateUUID, 
    getTodayUTCIso, addDays, getDateTimeFormat
} from './utils';
import { apiFetch } from './api';
import { STOIC_QUOTES } from './quotes';

// --- HELPERS ---

// NEW [2025-02-15]: Calculates conditional probability of failure.
// "If TriggerHabit fails, how often does TargetHabit fail?"
function calculateCorrelation(
    triggerHabitId: string, 
    targetHabitId: string, 
    dailyData: Record<string, Record<string, HabitDailyInfo>>, 
    daysToCheck: string[]
): number {
    let triggerFailures = 0;
    let jointFailures = 0;

    for (const date of daysToCheck) {
        const dayData = dailyData[date];
        if (!dayData) continue;

        const triggerInstances = dayData[triggerHabitId]?.instances || {};
        const triggerHasInstances = Object.keys(triggerInstances).length > 0;

        // Skip days where the trigger habit wasn't tracked/scheduled
        if (!triggerHasInstances) continue;

        // Check if trigger failed (Absence of 'completed' status in any slot)
        const triggerCompleted = Object.values(triggerInstances).some(i => i.status === 'completed');

        if (!triggerCompleted) {
            triggerFailures++;
            
            const targetInstances = dayData[targetHabitId]?.instances || {};
            const targetHasInstances = Object.keys(targetInstances).length > 0;
            
            // Check if target also failed (and was tracked)
            if (targetHasInstances) {
                const targetCompleted = Object.values(targetInstances).some(i => i.status === 'completed');
                
                if (!targetCompleted) {
                    jointFailures++;
                }
            }
        }
    }

    return triggerFailures > 0 ? (jointFailures / triggerFailures) : 0;
}

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

/**
 * HELPER: Remove a specific time from the schedule starting from a specific date (Future Scope).
 * This logic replaces the "From Now On" branch of _requestFutureScheduleChange.
 */
function _removeTimeFromSchedule(habit: Habit, effectiveDate: string, timeToRemove: TimeOfDay) {
    let targetScheduleIndex = habit.scheduleHistory.findIndex(s => {
            const startOk = s.startDate <= effectiveDate;
            const endOk = !s.endDate || s.endDate > effectiveDate;
            return startOk && endOk;
    });

    if (targetScheduleIndex === -1) {
        targetScheduleIndex = habit.scheduleHistory.length - 1;
    }

    const activeSchedule = habit.scheduleHistory[targetScheduleIndex];
    
    // Helper to filter times
    const filterTimes = (times: TimeOfDay[]) => times.filter(t => t !== timeToRemove);

    // Se a mudança é no mesmo dia de início, apenas atualiza
    if (activeSchedule.startDate === effectiveDate) {
        activeSchedule.times = filterTimes(activeSchedule.times);
        if (activeSchedule.times.length === 0) {
                // Se removeu todos os horários, encerra o hábito
                endHabit(habit.id, effectiveDate);
                return;
        }
    } else {
        // Split do agendamento
        activeSchedule.endDate = effectiveDate;
        
        const newTimes = filterTimes(activeSchedule.times);
        if (newTimes.length > 0) {
            const newSchedule: HabitSchedule = {
                ...activeSchedule,
                startDate: effectiveDate,
                endDate: undefined,
                times: newTimes,
            };
            delete (newSchedule as any).endDate;
            habit.scheduleHistory.push(newSchedule);
        } else {
            // If no times left, we are effectively ending the habit, which assumes
            // the user intended to delete the whole habit from this point on.
            // Since activeSchedule.endDate is already set, we just finish.
        }
    }

    // CLEANUP OVERRIDES [2025-02-15]: If we are removing a time "From Now On",
    // we should check if there was a "Just Today" override that might conflict or be redundant.
    const dailyInfo = state.dailyData[effectiveDate]?.[habit.id];
    if (dailyInfo && dailyInfo.dailySchedule) {
        // Remove the time from the daily override as well to be consistent
        dailyInfo.dailySchedule = dailyInfo.dailySchedule.filter(t => t !== timeToRemove);
        if (dailyInfo.dailySchedule.length === 0 && activeSchedule.times.length === 0) {
            // Clean up empty daily schedule
            delete dailyInfo.dailySchedule;
        }
    }
    
    // Remove instance data for that time
    if (dailyInfo && dailyInfo.instances[timeToRemove]) {
        delete dailyInfo.instances[timeToRemove];
    }

    // Cache cleanup
    removeHabitFromCache(habit.id); // Ensure DOM element is recreated clean
    state.uiDirtyState.habitListStructure = true;
    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderApp();
}

// Kept for Drag & Drop functionality (Move Habit)
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
        return newTimes.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
    };

    const justTodayAction = () => {
        const dailyInfo = ensureHabitDailyInfo(effectiveDate, habit.id);
        const originalSchedule = getEffectiveScheduleForHabitOnDate(habit, effectiveDate);
        dailyInfo.dailySchedule = scheduleModifier(originalSchedule);
        
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
    
    // For "From Now On" moves, we reuse the logic structure but with Add + Remove
    const fromNowOnAction = () => {
        // This is complex because it's a move (Remove + Add), not just Remove.
        // We will keep the original implementation logic here for Move.
        let targetScheduleIndex = habit.scheduleHistory.findIndex(s => {
             const startOk = s.startDate <= effectiveDate;
             const endOk = !s.endDate || s.endDate > effectiveDate;
             return startOk && endOk;
        });

        if (targetScheduleIndex === -1) {
            targetScheduleIndex = habit.scheduleHistory.length - 1;
        }

        const activeSchedule = habit.scheduleHistory[targetScheduleIndex];
        
        const applyChangeToTimes = (times: TimeOfDay[]): TimeOfDay[] => {
            const newTimes = times.filter(t => t !== fromTime);
            if (toTime) {
                newTimes.push(toTime);
            }
            return newTimes.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
        };
        
        if (activeSchedule.startDate === effectiveDate) {
            activeSchedule.times = applyChangeToTimes(activeSchedule.times);
            if (activeSchedule.times.length === 0) {
                 endHabit(habit.id, effectiveDate);
                 return;
            }
        } else {
            activeSchedule.endDate = effectiveDate;
            const newTimes = applyChangeToTimes(activeSchedule.times);
            if (newTimes.length > 0) {
                const newSchedule: HabitSchedule = {
                    ...activeSchedule,
                    startDate: effectiveDate,
                    endDate: undefined,
                    times: newTimes,
                };
                delete (newSchedule as any).endDate;
                habit.scheduleHistory.push(newSchedule);
            }
        }

        if (state.dailyData[effectiveDate]?.[habit.id]?.dailySchedule) {
             const dailyInfo = ensureHabitDailyInfo(effectiveDate, habit.id);
             if (dailyInfo.dailySchedule) {
                dailyInfo.dailySchedule = scheduleModifier(dailyInfo.dailySchedule);
             }
        }
        
        const dailyInfo = state.dailyData[effectiveDate]?.[habit.id];
        if (dailyInfo) {
            const instanceData = dailyInfo.instances[fromTime];
            if (instanceData) {
                if (toTime) {
                    dailyInfo.instances[toTime] = instanceData;
                }
                delete dailyInfo.instances[fromTime];
            }
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
    
    // UX UPDATE [2025-02-17]: Simplificação radical do fluxo de exclusão via Swipe.
    // O botão principal agora remove apenas o horário (slot) específico daqui para frente.
    
    const bodyText = t('confirmRemoveTime', { habitName: name, time: t(`filter${time}`) });
    
    showConfirmationModal(
        bodyText,
        () => {
            // Ação Principal: Remover este horário específico de agora em diante.
            _removeTimeFromSchedule(habit, date, time);
        },
        {
            title: t('modalRemoveTimeTitle'),
            confirmText: t('deleteButton'), // "Apagar"
            confirmButtonStyle: 'danger'
        }
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
            const dailyInfo = state.dailyData[targetDate]?.[habit.id];
            if (dailyInfo && dailyInfo.dailySchedule !== undefined) {
                delete dailyInfo.dailySchedule;
            }

            // Atualiza propriedades visuais globais
            habit.icon = formData.icon;
            habit.color = formData.color;
            habit.goal = formData.goal;
            
            // Lógica de agendamento
            const currentSchedule = getScheduleForDate(habit, targetDate) 
                || habit.scheduleHistory[habit.scheduleHistory.length - 1];
                
            const hasScheduleChanges = 
                JSON.stringify(currentSchedule.times.sort()) !== JSON.stringify(formData.times.sort()) ||
                JSON.stringify(currentSchedule.frequency) !== JSON.stringify(formData.frequency) ||
                currentSchedule.name !== formData.name;

            if (hasScheduleChanges) {
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
                        nameKey: formData.nameKey,
                        subtitleKey: formData.subtitleKey,
                        scheduleAnchor: targetDate // Reancora para cálculo de frequência
                    };
                    habit.scheduleHistory.push(newSchedule);
                    // Ordena histórico
                    habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
                }
                clearScheduleCache();
            } else {
                currentSchedule.name = formData.name;
                currentSchedule.nameKey = formData.nameKey;
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
    
    // Encerra ao final do dia ANTERIOR se a intenção é não fazer mais a partir de hoje
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
        t('confirmPermanentDelete', { habitName: name }),
        () => {
            state.habits = state.habits.filter(h => h.id !== habitId);
            
            // Remove do cache de elementos também para evitar reuso acidental
            removeHabitFromCache(habitId);

            state.uiDirtyState.habitListStructure = true;
            clearActiveHabitsCache();
            invalidateChartCache();
            saveState();
            
            // Re-render modal list
            setupManageModal();
            renderApp();
        },
        {
            title: t('modalDeleteHabitTitle'),
            confirmText: t('deleteButton'),
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
const PROMPT_HEADERS = {
    pt: {
        projection: "O Horizonte (Praemeditatio)",
        insight: "O Diagnóstico Filosófico",
        system_low: "O Protocolo de Ação (Algoritmo)",
        system_high: "O Desafio da Excelência",
        action_low: "Micro-Ação (Mise-en-place)",
        action_high: "Micro-Ação (O Próximo Nível)",
        socratic: "A Questão Cortante",
        connection: "A Voz dos Antigos"
    },
    en: {
        projection: "The Horizon (Praemeditatio)",
        insight: "Philosophical Diagnosis",
        system_low: "Action Protocol (Algorithm)",
        system_high: "The Challenge of Excellence",
        action_low: "Micro-Action (Mise-en-place)",
        action_high: "Micro-Action (The Next Level)",
        socratic: "The Cutting Question",
        connection: "Voice of the Ancients"
    },
    es: {
        projection: "El Horizonte (Praemeditatio)",
        insight: "Diagnóstico Filosófico",
        system_low: "Protocolo de Acción (Algoritmo)",
        system_high: "El Desafío de la Excelencia",
        action_low: "Micro-Acción (Mise-en-place)",
        action_high: "Micro-Acción (El Siguiente Nivel)",
        socratic: "La Cuestión Cortante",
        connection: "La Voz de los Antiguos"
    }
};

// IMPLEMENTATION INTENTION TEMPLATES
const IMPLEMENTATION_TEMPLATES = {
    pt: "Quando [GATILHO], eu farei [AÇÃO].",
    en: "When [TRIGGER], I will [ACTION].",
    es: "Cuando [DESENCADENANTE], haré [ACCIÓN]."
};

// GOAL REDUCTION TEMPLATES
const RECALIBRATION_TEMPLATES = {
    pt: "Nova Meta: [NÚMERO] [UNIDADE] por dia.",
    en: "New Goal: [NUMBER] [UNIT] per day.",
    es: "Nueva Meta: [NÚMERO] [UNIDAD] por día."
};

// TIME-SPECIFIC ANCHOR EXAMPLES
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
    const semanticLog: string[] = [];
    const dateList: string[] = [];
    
    // Stats per Habit
    const statsMap = new Map<string, { 
        scheduled: number, 
        completed: number, 
        snoozed: number, 
        missed: number, // Explicitly track simple failures
        notesCount: number, 
        habit: Habit,
        extraMiles: number, 
        bounces: number,
        accumulatedValue: number, 
        valueCount: number 
    }>();
    
    // Stats per Time of Day
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
    let redFlagDay = ""; 
    let sparklineHabitId: string | null = null;
    
    const dayFormatter = getDateTimeFormat(state.activeLanguageCode, { weekday: 'short' });
    
    const activeHabitsCount = state.habits.filter(h => !h.graduatedOn && !h.scheduleHistory[h.scheduleHistory.length-1].endDate).length;

    while (currentDate <= today) {
        const dateISO = toUTCIsoDateString(currentDate);
        dateList.push(dateISO);
        
        const activeHabits = getActiveHabitsForDate(dateISO);
        const dailyInfo = getHabitDailyInfoForDate(dateISO);
        
        let dayScheduled = 0;
        let dayCompleted = 0;
        
        const dayOfWeek = currentDate.getUTCDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        if (activeHabits.length > 0) {
            // Setup habit stats
            activeHabits.forEach(({ habit }) => {
                if (!statsMap.has(habit.id)) {
                    statsMap.set(habit.id, { 
                        scheduled: 0, completed: 0, snoozed: 0, missed: 0, notesCount: 0, 
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
                        else stats.missed++; 
                        
                        previousDayStatus[habit.id] = status; 
                    }

                    let symbol = '❌';
                    if (status === 'completed') symbol = '✅';
                    if (status === 'snoozed') symbol = '⏸️';
                    
                    let valStr = '';
                    if (actual > 0 && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
                        valStr = ` ${actual}/${target}`;
                    }
                    
                    let noteStr = '';
                    if (hasNote) {
                        noteStr = ` "${instance!.note}"`;
                    }
                    
                    dayEntriesStrings.push(`${name}(${symbol}${valStr}${noteStr})`);
                });
            });

            const dayName = dayFormatter.format(currentDate);
            semanticLog.push(`${dateISO.substring(5)} (${dayName}): ${dayEntriesStrings.join(', ')}`);

            // Bad Day Logic
            if (dayScheduled > 0) {
                const successRate = dayCompleted / dayScheduled;
                if (successRate < 0.5) {
                     redFlagDay = `${dayName} (${dateISO.substring(5)})`;
                }
                
                if (successRate < 0.5) {
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
    let nemesisId = "";
    let highestSnoozeRate = -1;
    let highestMissRate = -1;
    let realityGapWarning = "";
    
    statsMap.forEach((data, id) => {
        const { name } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
        const rate = data.scheduled > 0 ? (data.completed / data.scheduled) : 0;
        const snoozeRate = data.scheduled > 0 ? (data.snoozed / data.scheduled) : 0;
        const missRate = data.scheduled > 0 ? (data.missed / data.scheduled) : 0;
        
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

        if ((snoozeRate + missRate) > (highestSnoozeRate + highestMissRate) && data.scheduled > 3) { 
            highestSnoozeRate = snoozeRate;
            highestMissRate = missRate;
            nemesisName = name;
            nemesisId = id;
        }

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
    
    // --- ADVANCED ANALYSIS: CORRELATION & FRICTION ---
    let correlationInfo = "No clear dependencies found.";
    let frictionDiagnosis = "";

    if (nemesisId) {
        // Friction Type Diagnosis
        if (highestSnoozeRate > 0.2) {
            frictionDiagnosis = `DIAGNOSIS: The user struggles with **Internal Resistance** (Fear/Procrastination) on '${nemesisName}'. They see the task but delay it (Snooze). ADVICE: Lower the emotional barrier. The goal is too scary.`;
        } else if (highestMissRate > 0.2) {
            frictionDiagnosis = `DIAGNOSIS: The user struggles with **Neglect/Visibility** on '${nemesisName}'. They forget or run out of time (Miss). ADVICE: Increase visibility or change the trigger time. The prompt is too weak.`;
        }

        // Domino Effect Analysis
        let dominoEffectFound = false;
        statsMap.forEach((data, otherId) => {
            if (otherId !== nemesisId && data.scheduled > 3) {
                const correlation = calculateCorrelation(nemesisId, otherId, state.dailyData, dateList);
                if (correlation > 0.75) {
                    const { name: otherName } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
                    correlationInfo = `**CRITICAL CHAIN REACTION DETECTED:** When the user fails '${nemesisName}', there is a ${Math.round(correlation * 100)}% chance they will ALSO fail '${otherName}'. Fix '${nemesisName}' to save the day.`;
                    dominoEffectFound = true;
                }
            }
        });
        
        if (!dominoEffectFound) {
            correlationInfo = "Failures appear isolated. No strong domino effect detected.";
        }
    }

    if (!statsSummary) {
        statsSummary = "No active habits tracked yet.";
    }

    const nemesisInfo = nemesisName 
        ? `The Nemesis: **${nemesisName}**. ${frictionDiagnosis}` 
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

    const firstHalfRate = trendStats.firstHalf.scheduled > 0 ? Math.round((trendStats.firstHalf.completed / trendStats.firstHalf.scheduled) * 100) : 0;
    const secondHalfRate = trendStats.secondHalf.scheduled > 0 ? Math.round((trendStats.secondHalf.completed / trendStats.secondHalf.scheduled) * 100) : 0;
    const trendDiff = secondHalfRate - firstHalfRate;
    const trendDescription = trendDiff > 5 ? "RISING MOMENTUM 🚀" : (trendDiff < -5 ? "LOSING MOMENTUM 📉" : "STABLE ➖");
    
    const culpritEntry = Object.entries(failedHabitsOnBadDays).sort((a, b) => b[1] - a[1])[0];
    const culpritInfo = culpritEntry ? `Habit most often associated with 'Bad Days': **${culpritEntry[0]}**` : "None.";

    const noteDensity = totalLogs > 0 ? Math.round((totalNotes / totalLogs) * 100) : 0;
    
    const globalRate = (firstHalfRate + secondHalfRate) / 2;

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

    // REFACTOR [2025-02-16]: Projection is no longer hardcoded text.
    let historicalDepth = "Short (New)";
    if (highestStreakValue > 66) historicalDepth = "Deep (Consolidated)";
    else if (highestStreakValue > 21) historicalDepth = "Medium (Forming)";

    const projectionMetrics = `
    - Current Consistency: ${Math.round(globalRate)}%
    - Momentum (Last 7 Days vs Previous): ${trendDiff > 0 ? '+' : ''}${Math.round(trendDiff)}%
    - History Depth: ${historicalDepth}
    - Streak Risk: ${highestStreakValue > 10 ? "High Stakes" : "Low Stakes"}
    `;

    // --- SMART QUOTE SELECTION ---
    let quoteFilterFn = (q: any) => true; // Default to all
    let quoteReason = "General Wisdom"; 

    const isBurnout = activeHabitsCount > 6 && trendDiff < 0;
    const isDrifter = globalRate < 50 && trendDiff <= 0;

    if (isBurnout) {
        quoteFilterFn = (q) => q.tags.includes('simplicity') || q.tags.includes('rest') || q.tags.includes('essentialism');
        quoteReason = "simplifying your routine to prevent burnout (Essentialism)";
    } else if (highestSnoozeRate > 0.15) {
        quoteFilterFn = (q) => q.tags.includes('action') || q.tags.includes('time');
        quoteReason = "overcoming the inertia of procrastination";
    } else if (realityGapWarning.length > 0) {
        quoteFilterFn = (q) => q.tags.includes('control') || q.tags.includes('reality');
        quoteReason = "aligning ambition with reality";
    } else if (seasonalPhase.includes("WINTER") || seasonalPhase.includes("AUTUMN")) {
        quoteFilterFn = (q) => q.tags.includes('resilience') || q.tags.includes('suffering');
        quoteReason = "finding strength in adversity";
    } else if (seasonalPhase.includes("SUMMER")) {
        quoteFilterFn = (q) => q.tags.includes('nature') || q.tags.includes('humility');
        quoteReason = "maintaining humility in success";
    } else if (isDrifter) {
        quoteFilterFn = (q) => q.tags.includes('discipline') || q.tags.includes('focus');
        quoteReason = "building the foundation of discipline";
    } else if (lowestPerfRate < 0.6) {
        if (lowestPerfTime === 'Morning') {
            quoteFilterFn = (q) => q.tags.includes('time') || q.tags.includes('action') || q.tags.includes('morning');
            quoteReason = "conquering the morning resistance";
        } else if (lowestPerfTime === 'Evening') {
            quoteFilterFn = (q) => q.tags.includes('reflection') || q.tags.includes('evening') || q.tags.includes('gratitude');
            quoteReason = "closing the day with purpose";
        }
    } else if (redFlagDay) {
        quoteFilterFn = (q) => q.tags.includes('acceptance') || q.tags.includes('fate');
        quoteReason = "accepting the chaos of a bad day (Amor Fati)";
    } else if (totalLogs < 20) {
        quoteFilterFn = (q) => q.tags.includes('courage') || q.tags.includes('preparation');
        quoteReason = "finding the courage to begin";
    }

    const quotePool = STOIC_QUOTES.filter(quoteFilterFn);
    const finalPool = quotePool.length > 0 ? quotePool : STOIC_QUOTES;
    
    const selectedQuote = finalPool[Math.floor(Math.random() * finalPool.length)];
    const quoteText = selectedQuote[langCode as 'pt'|'en'|'es'] || selectedQuote['en'];
    const quoteAuthor = t(selectedQuote.author);

    // --- DYNAMIC INSTRUCTION INJECTION ---
    let systemInstructionText = "Suggest a specific 'Implementation Intention' to reduce friction (Mise-en-place).";
    
    let actionInstructionText = `One tiny, 'Gateway Habit' (less than 2 min). A physical movement that initiates the flow. Link it to a PRECISE BIOLOGICAL/MECHANICAL ANCHOR (e.g. 'Feet hit floor', 'Turn off shower', 'Close laptop') suitable for the user's struggle time (${lowestPerfTime}). Avoid time-based anchors (e.g. 'At 8am'). Time Horizon: NOW or TONIGHT. Never Tomorrow.`;
    
    if (lowestPerfTime === 'Morning' && lowestPerfRate < 0.6) {
        actionInstructionText += " TIMING RULE: Since the failure happens in the Morning, the Trigger MUST happen the **Night Before** (Preparation) OR **Immediately upon Waking** (if prep is impossible).";
    }
    
    let socraticInstruction = "Ask about FRICTION (What stands in the way? Is it fatigue or fear?).";
    
    if (highestSnoozeRate > 0.2) {
        actionInstructionText += " **DIAGNOSIS: High Resistance (Snoozing).** The user has Ability but lacks Motivation/Courage. The Action must be 'Stupidly Small' to bypass the amygdala (e.g., 'Put on one shoe'). Lower the threat level.";
    } else if (highestMissRate > 0.2) {
        actionInstructionText += " **DIAGNOSIS: Low Visibility (Missing).** The user lacks a Prompt or Ability (Time). The Action must be a 'Forced Encounter' (e.g., placing the book on the pillow). Improve the Trigger.";
    }

    // DEEPENING ANALYSIS [2025-02-15]: "Domino Effect" Detection.
    let patternInstruction = `Use the Semantic Log. ${correlationInfo} Scan for other subtle links. Does a specific success trigger a streak?`;
    
    // DEEPENING ANALYSIS [2025-02-15]: Benefit Reinforcement Logic.
    let teleologyInstruction = "";
    if (nemesisName) {
        teleologyInstruction = `**CRITICAL:** The user is struggling with '${nemesisName}'. In the 'Hidden Virtue' section, do NOT scold. Instead, SELL THE BENEFIT. Explain the deep, philosophical, or psychological reward of '${nemesisName}' that the user is missing out on. Frame it as the specific antidote to their current struggle. e.g., If drifting, the benefit is Anchoring. If anxious, the benefit is Clarity.`;
    } else {
        teleologyInstruction = `The user is consistent. In the 'Hidden Virtue' section, reinforce the COMPOUND INTEREST of their 'Keystone Habit' (${highestStreakHabitName || 'consistency'}). Explain what character trait they are forging by not quitting.`;
    }

    let tweaksExamples = `
    Examples of System Tweaks (Low Friction):
    - Bad: "Read more." -> Good: "When I drink coffee, I will open the book."
    - Bad: "Workout." -> Good: "When I wake up, I will put on gym shoes."
    `;

    let headerSystem = headers.system_low;
    let headerAction = headers.action_low;
    
    let insightPlaceholder = "[A surgical analysis of the current state. Don't just list data; interpret the CAUSE of the friction or the SOURCE of the flow. Use Stoic physics: Cause and Effect.]";
    let actionPlaceholder = "[One tiny 'Gateway Habit' step (< 2 min). Focus on MISE-EN-PLACE (Preparation) linked to an ANCHOR.]";


    // FOCUS LOGIC & SPARKLINE GENERATION
    let focusTarget = "Sustainability & Burnout Prevention (Maintenance)";
    
    if (highestStreakHabitName) {
         focusTarget = `'Keystone Habit' (${highestStreakHabitName})`;
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
    
    if (realityGapWarning.length > 0) {
        focusTarget = "the Reality Gap (Goal Reduction) - Source of the problem";
        systemInstructionText = "Your 'System Tweak' MUST be a direct command to reduce the numeric goal to match reality. Do NOT use the 'When/Then' template. Just stating the new goal is enough.";
        implTemplate = recalibrationTemplate;
        actionInstructionText = "Commit to the new, smaller number immediately. The action is 'Mental Acceptance'.";
    }
    
    if (redFlagDay) focusTarget = `The Collapse on ${redFlagDay} - Analyze why this specific day failed.`;
    
    if (isBurnout) {
        focusTarget = "BURNOUT RISK (Too many habits, dropping trend). Priority: Simplicity.";
        systemInstructionText = "Suggest PAUSING or ARCHIVING one habit to save the others. The system is overloaded.";
        actionInstructionText = "A specific action to Rest or Simplify. e.g. 'Delete one task from to-do list'.";
    }

    let sparkline = "";
    if (sparklineHabitId) {
        const habit = state.habits.find(h => h.id === sparklineHabitId);
        if (habit) {
            const days: string[] = [];
            for (let i = 6; i >= 0; i--) {
                const d = addDays(today, -i);
                const dISO = toUTCIsoDateString(d);
                const daily = state.dailyData[dISO]?.[sparklineHabitId]?.instances || {};
                
                const schedule = getEffectiveScheduleForHabitOnDate(habit, dISO);
                if (schedule.length === 0) {
                     days.push('▪️');
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
    let logContent = semanticLog.join('\n');

    // --- COLD START / ONBOARDING MODE ---
    if (totalLogs < 5) {
        seasonalPhase = "THE BEGINNING (Day 1)";
        focusTarget = "Building the Foundation (Start Small)";
        systemInstructionText = "Suggest a very small, almost ridiculous starting step to build momentum.";
        socraticInstruction = "Ask what is the smallest version of this habit they can do even on their worst day.";
        patternInstruction = "Do NOT look for trends yet. Validate the courage of the first step.";
        insightPlaceholder = "[Welcome them to the Stoic path. Validate the difficulty of starting. Focus on the courage to begin.]";
        taskDescription = "Write a welcoming and foundational Stoic mentorship letter for a beginner.";
        sparkline = ""; 
        logContent = "(Insufficient data for pattern recognition - Focus solely on the virtue of starting.)";
    } else if (globalRate > 80 || seasonalPhase.includes("SUMMER")) {
        systemInstructionText = "Suggest a method to increase difficulty (Progressive Overload) or efficiency. Challenge them.";
        
        actionInstructionText = "A specific experimental step to Challenge Limits, Teach Others, or Vary the Context (Anti-fragility). Link to an Anchor.";
        
        socraticInstruction = "Use 'Eternal Recurrence' (Amor Fati). Ask: 'Would you be willing to live this exact week again for eternity?'";
        
        if (highestStreakValue > 30) {
            socraticInstruction = "Deconstruct the fear of losing the streak. Ask: 'Does the value lie in the number (external) or the character you are building (internal)?'";
        }
        
        tweaksExamples = `
        Examples of System Tweaks (High Performance):
        - Bad: "Keep going." -> Good: "When I finish the set, I will add 5 minutes."
        - Bad: "Good job." -> Good: "When I master this, I will teach it to someone else."
        `;

        headerSystem = headers.system_high;
        headerAction = headers.action_high;
        insightPlaceholder = "[Synthesize the victory. Analyze what makes their consistency possible and where the next plateau lies. 2-3 sentences. NO LISTS.]";
        actionPlaceholder = "[A specific constraint or added difficulty to test their mastery (Progressive Overload).]";
    }

    const forbiddenWhyMap = {
        pt: '"Por que"',
        en: '"Why"',
        es: '"Por qué"'
    };
    const forbiddenWhy = forbiddenWhyMap[langCode as 'pt'|'en'|'es'] || '"Why"';
    
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
        - **Friction Diagnosis:** ${nemesisInfo}
        - **Chain Reaction (Domino):** ${correlationInfo}
        - **Red Flag Day (Collapse):** ${redFlagDay || "None"}
        - **Struggling Time:** ${lowestPerfTime}

        ### 2. THE STRATEGY
        - **Bio-rhythm:** \n${temporalSummary}
        - **Reality Check (Math Calculated):** \n${realityGapWarning || "Goals are realistic."}
        - **Metrics:** Extra Miles: ${totalExtraMiles}. Bounce Backs: ${totalBounces}.

        ### 3. THE PHILOSOPHY
        - **Season:** ${seasonalPhase}
        - **Trajectory Metrics:** \n${projectionMetrics}
        - **Selected Wisdom:** "${quoteText}" - ${quoteAuthor}
        - **Wisdom Intent:** Chosen to address: ${quoteReason}

        ### SEMANTIC LOG (The User's Week):
        (Legend: ✅=Success, ❌=Pending/Fail, ⏸️=Snoozed, "Text"=User Note. Ordered by time of day.)
        ${logContent}

        INSTRUCTIONS:
        1. **BENEVOLENT DETACHMENT:** Do NOT praise ("Good job") or scold ("Do better"). Be an observant mirror. Firm but warm. Do NOT write "Based on the data". Speak naturally, like a mentor writing a letter. Use PARAGRAPHS, NOT LISTS for text sections. NO GREETINGS. NO SIGNATURES. Start directly with the Title.
        2. **BE SOCRATIC:** ${socraticInstruction}
           - **CONSTRAINT:** One single, piercing sentence. DO NOT use the word ${forbiddenWhy} (or its translations). AVOID YES/NO questions (e.g. "Are you commited?"). Force deep processing.
        3. **PATTERN RECOGNITION:** ${patternInstruction}
        4. **THE TELEOLOGY (THE REWARD):** ${teleologyInstruction}
        5. **THE PROTOCOL (SYSTEM):** 
           - ${systemInstructionText}
           - **SYNTAX:** Use EXACTLY this template: "${implTemplate}" (REMOVE BRACKETS when filling). (Output ONLY the sentence, no intro/outro)
           - **FOCUS:** Focus on the PRIMARY FOCUS defined above. ZERO COST.
           - **CONSTRAINT:** ACTION must be a single, binary event (e.g. 'open book', 'put on shoes'). Forbidden verbs: try, attempt, focus, aim, should.
        6. **CONNECT WISDOM:** Use the provided quote ("${quoteText}"). Do NOT explain the quote itself. Use the quote's concept to illuminate the user's specific struggle/victory.
        7. **INTERPRET LOG:** 
           - ✅ = Success.
           - ⏸️ = **Resistance** (User saw it but delayed). REMEDY: Lower the bar. 
           - **NOTE HANDLING:** If a "Note" is present with ⏸️ or ❌, analyze the sentiment. If it's Internal (Lazy, Bored), treat as Resistance (Action required). If it's External (Sick, Emergency), treat as Amor Fati (Acceptance).
           - ❌ = **Neglect** (User forgot). REMEDY: Increase Visibility / Better Trigger.
           - ▪️ = **Rest/No Schedule** (Not a failure).
           - **NUMBERS (e.g. 5/10):** Partial Success. If Actual < Target, acknowledge effort but note the gap.
        8. **THE TRIGGER (PHYSICS):** ${actionInstructionText}

        OUTPUT STRUCTURE (Markdown in ${targetLang}):

        ### 🏛️ [Title: Format "On [Concept]" or Abstract Noun. NO CHEESY TITLES.]

        **🔮 ${headers.projection}**
        [Analyze the 'Trajectory Metrics'. Don't just predict a date. Extrapolate the current curve: Is it leading to Entropy (Chaos) or Ataraxia (Order)? Be brutally honest but encouraging.]

        **📊 ${headers.insight}**
        ${insightPlaceholder}

        **💎 [Title about the Virtue/Benefit of the Struggle]**
        [The 'Teleology' section. Explain the deep benefit of the struggling habit. Why is this specific pain necessary for the user's growth right now?]

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
        
        // Notification logic: Do not open modal automatically.
        state.hasSeenAIResult = false;

    } catch (error) {
        console.error("AI Analysis failed", error);
        state.aiState = 'error';
        state.lastAIResult = t('aiErrorGeneric');
        state.lastAIError = error instanceof Error ? error.message : String(error);
        state.hasSeenAIResult = false; 
    } finally {
        renderAINotificationState();
        saveState();
    }
}

export function handleHabitDrop(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
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