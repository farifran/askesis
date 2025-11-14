/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 0% concluído. Todos os arquivos precisam ser revisados. Quando um arquivo atingir 100%, não será mais necessário revisá-lo.
import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays, escapeHTML, simpleMarkdownToHTML, getTodayUTC, toUTCIsoDateString, getActiveHabitsForDate, apiFetch, getHabitStatusForSorting } from './utils';
import {
    state,
    saveState,
    Habit,
    TimeOfDay,
    HabitStatus,
    getNextStatus,
    ensureHabitInstanceData,
    STREAK_SEMI_CONSOLIDATED,
    STREAK_CONSOLIDATED,
    calculateHabitStreak,
    HabitTemplate,
    HabitSchedule,
    getScheduleForDate,
    PREDEFINED_HABITS,
    invalidateStreakCache,
    getHabitDailyInfoForDate,
    getCurrentGoalForInstance,
    clearScheduleCache,
    clearActiveHabitsCache,
    ensureHabitDailyInfo,
    getEffectiveScheduleForHabitOnDate,
    LANGUAGES,
} from './state';
// FIX: Import the missing `openModal` function to display the AI results modal.
import {
    renderHabits,
    showUndoToast,
    showConfirmationModal,
    closeModal,
    renderApp,
    renderCalendar,
    renderAINotificationState,
    setupManageModal,
    openEditModal,
    openModal,
} from './render';
import { ui } from './ui';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { updateAppBadge } from './api/badge';
// FIX: Import the missing 'renderChart' function to resolve reference errors.
import { renderChart } from './chart';

// --- Habit Creation & Deletion ---

function _createNewHabitFromTemplate(template: HabitTemplate): Habit {
    const startDate = state.selectedDate;
    const newHabit: Habit = {
        id: generateUUID(),
        icon: template.icon,
        color: template.color,
        goal: { ...template.goal },
        createdOn: startDate,
        scheduleHistory: [
            {
                startDate: startDate,
                times: template.times,
                frequency: template.frequency,
                scheduleAnchor: startDate,
                ...(template.nameKey ? { nameKey: template.nameKey, subtitleKey: template.subtitleKey } : { name: template.name, subtitleKey: template.subtitleKey })
            }
        ],
    };
    return newHabit;
}

export function createDefaultHabit() {
    const defaultHabitTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (defaultHabitTemplate) {
        const newHabit = _createNewHabitFromTemplate(defaultHabitTemplate);
        state.habits.push(newHabit);
    }
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const { isNew, habitId, formData, originalData } = state.editingHabit;
    const { name, nameKey, icon, color, times, goal, frequency } = formData;
    const selectedDate = state.selectedDate;

    // Sanity check
    if (times.length === 0) {
        // Show an error to the user maybe? For now, let's just prevent saving.
        console.error("Cannot save a habit with no scheduled times.");
        return;
    }
    
    const habitName = nameKey ? t(nameKey) : (name || '');
    const isDuplicate = state.habits.some(h => {
        if (h.id === habitId) return false; // Don't compare with self
        const { name } = getHabitDisplayInfo(h, selectedDate);
        return name.toLowerCase() === habitName.toLowerCase() && getHabitStatusForSorting(h) === 'active';
    });
    if (isDuplicate || habitName.trim().length === 0) {
        ui.editHabitSaveBtn.disabled = true;
        return;
    }
    
    if (isNew) {
        // Create new habit
        const newHabit = _createNewHabitFromTemplate(formData);
        state.habits.push(newHabit);
    } else if (habitId && originalData) {
        // Edit existing habit
        const habit = state.habits.find(h => h.id === habitId);
        if (!habit) return;

        habit.icon = icon;
        habit.color = color;
        habit.goal = { ...goal };
        
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];

        // Check if schedule has changed
        const scheduleChanged = JSON.stringify(lastSchedule.times) !== JSON.stringify(times) ||
                                JSON.stringify(lastSchedule.frequency) !== JSON.stringify(frequency) ||
                                (formData.nameKey ? lastSchedule.nameKey !== formData.nameKey : lastSchedule.name !== formData.name);
        
        if (scheduleChanged) {
            // End the current schedule and start a new one
            lastSchedule.endDate = toUTCIsoDateString(addDays(parseUTCIsoDate(selectedDate), -1));

            // FIX: Corrected shorthand property error and completed the object creation for new schedule.
            const newSchedule: HabitSchedule = {
                startDate: selectedDate,
                times: times,
                frequency: frequency,
                scheduleAnchor: selectedDate,
                ...(formData.nameKey ? { nameKey: formData.nameKey, subtitleKey: formData.subtitleKey } : { name: formData.name, subtitleKey: formData.subtitleKey })
            };
            habit.scheduleHistory.push(newSchedule);
            clearScheduleCache(); // Invalidate cache due to schedule change
        }
    }

    state.editingHabit = null;
    closeModal(ui.editHabitModal);
    renderApp();
    saveState();
}

// FIX: Export function to be used in habitCardListeners.ts
export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const habitInstance = ensureHabitInstanceData(date, habitId, time);
    habitInstance.status = getNextStatus(habitInstance.status);
    invalidateStreakCache(habitId, date);
    renderHabits();
    renderCalendar();
    renderChart();
    updateAppBadge();
    saveState();
}

// FIX: Export function to be used in habitCardListeners.ts
export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const habitInstance = ensureHabitInstanceData(date, habitId, time);
    habitInstance.goalOverride = newGoal;
    invalidateStreakCache(habitId, date);
    renderChart(); // Goal changes affect chart
    saveState();
}

// FIX: Export function to be used in dragAndDropHandler.ts
export function reorderHabit(draggedHabitId: string, targetHabitId: string, position: 'before' | 'after') {
    const draggedIndex = state.habits.findIndex(h => h.id === draggedHabitId);
    const targetIndex = state.habits.findIndex(h => h.id === targetHabitId);
    if (draggedIndex === -1 || targetIndex === -1) return;

    const [draggedHabit] = state.habits.splice(draggedIndex, 1);
    const newTargetIndex = state.habits.findIndex(h => h.id === targetHabitId);

    if (position === 'before') {
        state.habits.splice(newTargetIndex, 0, draggedHabit);
    } else {
        state.habits.splice(newTargetIndex + 1, 0, draggedHabit);
    }

    renderHabits();
    saveState();
}

// FIX: Export function to be used in dragAndDropHandler.ts
export function handleHabitDrop(habitId: string, oldTime: TimeOfDay, newTime: TimeOfDay) {
    const date = state.selectedDate;
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const dailyInfo = ensureHabitDailyInfo(date, habitId);
    const effectiveSchedule = getEffectiveScheduleForHabitOnDate(habit, date);

    const newSchedule = [...effectiveSchedule.filter(t => t !== oldTime), newTime];
    dailyInfo.dailySchedule = newSchedule;
    
    if (dailyInfo.instances[oldTime]) {
        dailyInfo.instances[newTime] = dailyInfo.instances[oldTime];
        delete dailyInfo.instances[oldTime];
    }
    
    clearActiveHabitsCache();
    renderHabits();
    saveState();
}

// FIX: Export function to be used in modalListeners.ts
export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    const habitInstance = ensureHabitInstanceData(date, habitId, time);
    habitInstance.note = ui.notesTextarea.value;
    
    closeModal(ui.notesModal);
    state.editingNoteFor = null;
    
    renderHabits(); // To update note icon
    saveState();
}

// FIX: Export function to be used in listeners.ts
export function completeAllHabitsForDate(dateISO: string) {
    const activeHabitsData = getActiveHabitsForDate(parseUTCIsoDate(dateISO));
    activeHabitsData.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instance = ensureHabitInstanceData(dateISO, habit.id, time);
            instance.status = 'completed';
        });
        invalidateStreakCache(habit.id, dateISO);
    });

    if (state.selectedDate === dateISO) {
        renderHabits();
    }
    renderCalendar();
    renderChart();
    updateAppBadge();
    saveState();
}

// FIX: Export function to be used in listeners.ts
export function snoozeAllHabitsForDate(dateISO: string) {
    const activeHabitsData = getActiveHabitsForDate(parseUTCIsoDate(dateISO));
    activeHabitsData.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instance = ensureHabitInstanceData(dateISO, habit.id, time);
            instance.status = 'snoozed';
        });
        invalidateStreakCache(habit.id, dateISO);
    });

    if (state.selectedDate === dateISO) {
        renderHabits();
    }
    renderCalendar();
    renderChart();
    updateAppBadge();
    saveState();
}

// FIX: Export function to be used in habitCardListeners.ts
export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    const timeName = getTimeOfDayName(time);

    showConfirmationModal(
        t('confirmHabitTimeRemoval', { habitName: escapeHTML(name), timeName: escapeHTML(timeName) }),
        () => {
            const date = state.selectedDate;
            const dailyInfo = ensureHabitDailyInfo(date, habitId);
            const effectiveSchedule = getEffectiveScheduleForHabitOnDate(habit, date);

            dailyInfo.dailySchedule = effectiveSchedule.filter(t => t !== time);
            
            clearActiveHabitsCache();
            renderHabits();
            saveState();
        },
        { confirmButtonStyle: 'danger' }
    );
}

// FIX: Export function to be used in modalListeners.ts
export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmEndHabit', { habitName: escapeHTML(name) }),
        () => {
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            if (lastSchedule && !lastSchedule.endDate) {
                lastSchedule.endDate = getTodayUTCIso();
                state.lastEnded = { habitId: habit.id, lastSchedule: { ...lastSchedule } };
                clearScheduleCache();
                clearActiveHabitsCache();
                showUndoToast();
                setupManageModal();
                renderApp();
                saveState();
            }
        },
        { confirmText: t('habitEnd'), confirmButtonStyle: 'danger' }
    );
}

// FIX: Export function to be used in modalListeners.ts
export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmDeleteHabitPermanent', { habitName: escapeHTML(name) }),
        () => {
            state.habits = state.habits.filter(h => h.id !== habitId);
            Object.keys(state.dailyData).forEach(date => {
                delete state.dailyData[date][habitId];
            });
            setupManageModal();
            renderApp();
            saveState();
        },
        { confirmText: t('deleteButton'), confirmButtonStyle: 'danger' }
    );
}

// FIX: Export function to be used in modalListeners.ts
export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    habit.graduatedOn = getTodayUTCIso();
    clearActiveHabitsCache();
    setupManageModal();
    renderApp();
    saveState();
}

// FIX: Export function to be used in listeners.ts
export function handleUndoDelete() {
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.remove('visible');

    if (state.lastEnded) {
        const habit = state.habits.find(h => h.id === state.lastEnded!.habitId);
        if (habit) {
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            if (lastSchedule.endDate === state.lastEnded.lastSchedule.endDate) {
                delete lastSchedule.endDate;
            }
        }
        state.lastEnded = null;
        clearScheduleCache();
        clearActiveHabitsCache();
        renderApp();
        saveState();
    }
}

// FIX: Export function to be used in modalListeners.ts
export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        closeModal(ui.manageModal);
        openEditModal(habit);
    }
}

// FIX: Export function to be used in modalListeners.ts
export function resetApplicationData() {
    state.habits = [];
    state.dailyData = {};
    state.streaksCache = {};
    state.scheduleCache = {};
    state.activeHabitsCache = {};
    state.lastEnded = null;
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    state.notificationsShown = [];
    state.aiState = 'idle';
    state.lastAIResult = null;
    state.lastAIError = null;

    localStorage.clear();
    window.location.reload();
}

// FIX: Export function to be used in modalListeners.ts
export async function performAIAnalysis(analysisType: 'weekly' | 'monthly' | 'general') {
    closeModal(ui.aiOptionsModal);
    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    renderAINotificationState();

    try {
        const today = parseUTCIsoDate(state.selectedDate);
        const daysToAnalyze = analysisType === 'weekly' ? 7 : (analysisType === 'monthly' ? 30 : 90);
        const startDate = addDays(today, -(daysToAnalyze - 1));

        let relevantData = "Habits and their completion data:\n";
        const habitsById: Record<string, { name: string; data: string[] }> = {};

        for (let i = 0; i < daysToAnalyze; i++) {
            const date = addDays(startDate, i);
            const dateISO = toUTCIsoDateString(date);
            const activeHabits = getActiveHabitsForDate(date);
            
            activeHabits.forEach(({ habit, schedule }) => {
                const { name } = getHabitDisplayInfo(habit, dateISO);
                if (!habitsById[habit.id]) {
                    habitsById[habit.id] = { name, data: [] };
                }
                const dailyInfo = getHabitDailyInfoForDate(dateISO);
                const instances = dailyInfo[habit.id]?.instances || {};
                const completed = schedule.filter(time => instances[time]?.status === 'completed').length;
                if (schedule.length > 0) {
                    habitsById[habit.id].data.push(`${dateISO}: ${completed}/${schedule.length}`);
                }
            });
        }

        for (const id in habitsById) {
            relevantData += `- ${habitsById[id].name}: ${habitsById[id].data.join(', ')}\n`;
        }

        const langName = LANGUAGES.find(l => l.code === state.activeLanguageCode)?.nameKey || 'langEnglish';

        const prompt = t(`aiPrompt${analysisType.charAt(0).toUpperCase() + analysisType.slice(1)}`, {
            data: relevantData,
            language: t(langName)
        });

        const systemInstruction = t('aiSystemInstruction');

        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
        });

        const resultText = await response.text();
        state.aiState = 'completed';
        state.lastAIResult = resultText;

    } catch (error) {
        console.error("AI Analysis failed:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.aiState = 'error';
        state.lastAIResult = t('aiErrorResult', { error: escapeHTML(errorMessage) });
        state.lastAIError = errorMessage;
    } finally {
        renderAINotificationState();
        saveState();
    }
}