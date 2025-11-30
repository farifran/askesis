
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import {
    state,
    saveState,
    Habit,
    HabitSchedule,
    TimeOfDay,
    Frequency,
    getScheduleForDate,
    clearScheduleCache,
    clearActiveHabitsCache,
    invalidateChartCache,
    invalidateStreakCache,
    ensureHabitDailyInfo,
    PREDEFINED_HABITS,
    getEffectiveScheduleForHabitOnDate,
    STREAK_CONSOLIDATED,
    ensureHabitInstanceData,
    getNextStatus,
    getActiveHabitsForDate
} from './state';
import { ui } from './ui';
import {
    renderApp,
    closeModal,
    openEditModal,
    showConfirmationModal,
    showUndoToast,
    openModal,
    renderAINotificationState,
    renderHabitCardState,
    renderCalendarDayPartial,
    removeHabitFromCache
} from './render';
import { generateUUID, getTodayUTCIso, toUTCIsoDateString, triggerHaptic, addDays, parseUTCIsoDate, simpleMarkdownToHTML } from './utils';
import { t, getHabitDisplayInfo } from './i18n';
import { apiFetch } from './api';

export function createDefaultHabit() {
    const defaultTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (defaultTemplate) {
        const newHabit: Habit = {
            id: generateUUID(),
            icon: defaultTemplate.icon,
            color: defaultTemplate.color,
            goal: defaultTemplate.goal,
            createdOn: getTodayUTCIso(),
            scheduleHistory: [{
                startDate: getTodayUTCIso(),
                times: defaultTemplate.times,
                frequency: defaultTemplate.frequency,
                nameKey: defaultTemplate.nameKey,
                subtitleKey: defaultTemplate.subtitleKey,
                scheduleAnchor: getTodayUTCIso()
            }]
        };
        state.habits.push(newHabit);
    }
}

export function handleUndoDelete() {
    if (state.lastEnded) {
        const { habitId, lastSchedule, removedSchedules } = state.lastEnded;
        const habit = state.habits.find(h => h.id === habitId);
        
        if (habit) {
            // Restaura a funcionalidade removendo a data de término do último agendamento
            const scheduleToRestore = habit.scheduleHistory.find(s => 
                s.startDate === lastSchedule.startDate && s.scheduleAnchor === lastSchedule.scheduleAnchor
            );

            if (scheduleToRestore) {
                delete scheduleToRestore.endDate;
            }
            
            // Restaura agendamentos futuros removidos
            if (removedSchedules && removedSchedules.length > 0) {
                 habit.scheduleHistory.push(...removedSchedules);
                 habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
            }

            ui.undoToast.classList.remove('visible');
            state.lastEnded = null;
            if (state.undoTimeout) {
                clearTimeout(state.undoTimeout);
                state.undoTimeout = null;
            }
            
            clearScheduleCache();
            saveState();
            renderApp();
            triggerHaptic('success');
        }
    }
}

export function completeAllHabitsForDate(dateISO: string) {
    const activeHabits = getActiveHabitsForDate(dateISO);
    let changed = false;

    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instance = ensureHabitInstanceData(dateISO, habit.id, time);
            if (instance.status !== 'completed') {
                instance.status = 'completed';
                changed = true;
                // Invalida cache de streak pois o status mudou
                invalidateStreakCache(habit.id, dateISO);
            }
        });
    });

    if (changed) {
        saveState();
        invalidateChartCache();
        renderApp();
    }
}

export function snoozeAllHabitsForDate(dateISO: string) {
    const activeHabits = getActiveHabitsForDate(dateISO);
    let changed = false;

    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instance = ensureHabitInstanceData(dateISO, habit.id, time);
            if (instance.status !== 'snoozed') {
                instance.status = 'snoozed';
                changed = true;
                invalidateStreakCache(habit.id, dateISO);
            }
        });
    });

    if (changed) {
        saveState();
        invalidateChartCache();
        renderApp();
    }
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay, dateISO: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const dailyInfo = ensureHabitDailyInfo(dateISO, habitId);
    const currentStatus = dailyInfo.instances[time]?.status || 'pending';
    const nextStatus = getNextStatus(currentStatus);

    ensureHabitInstanceData(dateISO, habitId, time).status = nextStatus;

    if (nextStatus === 'pending') {
        if (dailyInfo.instances[time]?.goalOverride !== undefined) {
            delete dailyInfo.instances[time]!.goalOverride;
        }
    }

    invalidateStreakCache(habitId, dateISO);
    invalidateChartCache();
    saveState();
    
    renderHabitCardState(habitId, time);
    renderCalendarDayPartial(dateISO);
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const { isNew, habitId, formData, targetDate } = state.editingHabit;
    
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
            createdOn: targetDate,
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
            habit.icon = formData.icon;
            habit.color = formData.color;
            habit.goal = formData.goal;
            
            const currentSchedule = getScheduleForDate(habit, targetDate) 
                || habit.scheduleHistory[habit.scheduleHistory.length - 1];
                
            const hasScheduleChanges = 
                JSON.stringify(currentSchedule.times.sort()) !== JSON.stringify(formData.times.sort()) ||
                JSON.stringify(currentSchedule.frequency) !== JSON.stringify(formData.frequency) ||
                currentSchedule.name !== formData.name;

            if (hasScheduleChanges) {
                if (currentSchedule.startDate === targetDate) {
                    currentSchedule.times = formData.times;
                    currentSchedule.frequency = formData.frequency;
                    currentSchedule.name = formData.name;
                    currentSchedule.nameKey = formData.nameKey;
                    currentSchedule.subtitleKey = formData.subtitleKey;
                } else {
                    currentSchedule.endDate = targetDate;
                    const newSchedule: HabitSchedule = {
                        startDate: targetDate,
                        times: formData.times,
                        frequency: formData.frequency,
                        name: formData.name,
                        nameKey: formData.nameKey,
                        subtitleKey: formData.subtitleKey,
                        scheduleAnchor: targetDate
                    };
                    habit.scheduleHistory.push(newSchedule);
                    habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
                }
                clearScheduleCache();
            } else {
                currentSchedule.name = formData.name;
                currentSchedule.nameKey = formData.nameKey;
            }

            if (state.dailyData[targetDate]?.[habit.id]?.dailySchedule) {
                delete state.dailyData[targetDate][habit.id].dailySchedule;
            }
        }
    }

    state.editingHabit = null;
    state.uiDirtyState.habitListStructure = true;
    
    clearActiveHabitsCache();
    invalidateChartCache();
    
    saveState();
    closeModal(ui.editHabitModal);
    renderApp();
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const { name } = getHabitDisplayInfo(habit, state.selectedDate);

    showConfirmationModal(
        t('confirmEndHabit', { habitName: name }),
        () => {
            const today = getTodayUTCIso();
            // Define a data de término para ontem, para que o hábito deixe de aparecer hoje.
            const yesterday = toUTCIsoDateString(addDays(parseUTCIsoDate(today), -1));
            
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            
            state.lastEnded = {
                habitId: habit.id,
                lastSchedule: { ...lastSchedule },
                removedSchedules: []
            };

            lastSchedule.endDate = yesterday;
            
            clearScheduleCache();
            saveState();
            closeModal(ui.manageModal);
            renderApp();
            showUndoToast();
        },
        { 
            title: t('modalManageEnd'),
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
        t('confirmDeleteHabit', { habitName: name }),
        () => {
            state.habits = state.habits.filter(h => h.id !== habitId);
            
            Object.keys(state.dailyData).forEach(date => {
                if (state.dailyData[date][habitId]) {
                    delete state.dailyData[date][habitId];
                }
            });

            clearScheduleCache();
            removeHabitFromCache(habitId);

            saveState();
            closeModal(ui.manageModal);
            renderApp();
        },
        {
            title: t('modalManageDelete'),
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

export function resetApplicationData() {
    localStorage.clear();
    location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    const note = ui.notesTextarea.value.trim();
    
    ensureHabitInstanceData(date, habitId, time).note = note;
    
    state.editingNoteFor = null;
    saveState();
    closeModal(ui.notesModal);
    
    renderHabitCardState(habitId, time);
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    habit.graduatedOn = getTodayUTCIso();
    
    saveState();
    closeModal(ui.manageModal);
    renderApp();
    triggerHaptic('success');
}

export async function performAIAnalysis(type: 'weekly' | 'monthly' | 'general') {
    closeModal(ui.aiOptionsModal);
    state.aiState = 'loading';
    renderAINotificationState();
    
    try {
        const prompt = `Analyze the user's habit data. Type: ${type}. Habits: ${JSON.stringify(state.habits.map(h => h.goal))}.`; 
        const systemInstruction = "You are a stoic habit coach.";

        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction })
        });
        
        const text = await response.text();
        
        state.aiState = 'completed';
        state.lastAIResult = text;
        state.hasSeenAIResult = false;
        
        ui.aiResponse.innerHTML = simpleMarkdownToHTML(text);
        openModal(ui.aiModal);

    } catch (e) {
        state.aiState = 'error';
        state.lastAIError = "Failed to analyze data.";
        console.error(e);
    }
    renderAINotificationState();
    saveState();
}

export function handleHabitDrop(habitId: string, originalTime: TimeOfDay, newTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Se moveu para um grupo diferente, precisamos ajustar o agendamento
    // Isso é complexo se feito historicamente, então por simplicidade aplicamos ao dia atual via override.
    // Ou alteramos o agendamento daqui para frente?
    // Para simplificar UX de drag and drop, assumimos "Just for Today" override,
    // pois mudar o agendamento global via D&D pode ser agressivo.
    
    const date = state.selectedDate;
    const dailyInfo = ensureHabitDailyInfo(date, habitId);
    
    // Pega o agendamento atual efetivo
    const currentSchedule = getEffectiveScheduleForHabitOnDate(habit, date);
    
    // Remove o tempo original e adiciona o novo
    const newSchedule = currentSchedule.filter(t => t !== originalTime);
    if (!newSchedule.includes(newTime)) {
        newSchedule.push(newTime);
    }
    
    // Ordena para manter consistência: Morning -> Afternoon -> Evening
    const timeOrder = { 'Morning': 0, 'Afternoon': 1, 'Evening': 2 };
    newSchedule.sort((a, b) => timeOrder[a] - timeOrder[b]);

    dailyInfo.dailySchedule = newSchedule;
    
    // Move os dados da instância antiga para a nova se existirem
    if (dailyInfo.instances[originalTime]) {
        dailyInfo.instances[newTime] = dailyInfo.instances[originalTime];
        delete dailyInfo.instances[originalTime];
    }

    saveState();
    state.uiDirtyState.habitListStructure = true;
    renderApp();
}

export function reorderHabit(habitId: string, targetHabitId: string, position: 'before' | 'after') {
    const fromIndex = state.habits.findIndex(h => h.id === habitId);
    const toIndex = state.habits.findIndex(h => h.id === targetHabitId);
    
    if (fromIndex === -1 || toIndex === -1) return;
    
    const [movedHabit] = state.habits.splice(fromIndex, 1);
    const newIndex = position === 'before' ? toIndex : toIndex + 1;
    // Ajusta o índice se o elemento movido estava antes do alvo
    const adjustedIndex = (fromIndex < toIndex && position === 'before') ? newIndex - 1 : newIndex;
    
    state.habits.splice(adjustedIndex, 0, movedHabit);
    
    saveState();
    state.uiDirtyState.habitListStructure = true;
    renderApp();
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, val: number) {
    ensureHabitInstanceData(date, habitId, time).goalOverride = val;
    saveState();
    invalidateChartCache();
    renderHabitCardState(habitId, time);
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const date = state.selectedDate;
    const dailyInfo = ensureHabitDailyInfo(date, habitId);
    const effectiveSchedule = getEffectiveScheduleForHabitOnDate(habit, date);
    
    const newSchedule = effectiveSchedule.filter(t => t !== time);
    dailyInfo.dailySchedule = newSchedule;
    
    if (dailyInfo.instances[time]) {
        // Opcional: limpar dados da instância removida
        // delete dailyInfo.instances[time];
    }
    
    saveState();
    invalidateChartCache();
    state.uiDirtyState.habitListStructure = true;
    renderApp();
}
