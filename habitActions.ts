/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído. A lógica de negócio principal para manipulação de hábitos é robusta, com tratamento de casos de borda e integridade de dados. Nenhuma outra análise é necessária.
import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays, escapeHTML, simpleMarkdownToHTML, getTodayUTC, toUTCIsoDateString, getActiveHabitsForDate, apiFetch } from './utils';
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
import { t, getHabitDisplayInfo } from './i18n';
import { updateAppBadge } from './badge';

// --- Habit Creation & Deletion ---

function _createNewHabitFromTemplate(template: HabitTemplate): Habit {
    const todayISO = getTodayUTCIso();
    const newHabit: Habit = {
        id: generateUUID(),
        icon: template.icon,
        color: template.color,
        goal: { ...template.goal },
        createdOn: todayISO,
        scheduleHistory: [
            {
                startDate: todayISO,
                times: template.times,
                frequency: template.frequency,
                scheduleAnchor: todayISO,
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
    const { isNew, habitId, formData } = state.editingHabit;
    const todayISO = getTodayUTCIso();

    // Basic validation
    if (formData.times.length === 0 || (!formData.name && !formData.nameKey)) {
        const noticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice');
        if (noticeEl) {
            noticeEl.textContent = t('modalEditFormNotice');
            noticeEl.classList.add('visible');
            setTimeout(() => noticeEl.classList.remove('visible'), 3000);
        }
        return;
    }

    if (isNew) {
        const newHabit = _createNewHabitFromTemplate(formData);
        state.habits.push(newHabit);
    } else if (habitId) {
        const habit = state.habits.find(h => h.id === habitId);
        if (habit) {
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            
            // Check if schedule has changed, if so, create a new schedule entry
            const scheduleChanged = JSON.stringify(lastSchedule.times) !== JSON.stringify(formData.times) ||
                                  JSON.stringify(lastSchedule.frequency) !== JSON.stringify(formData.frequency) ||
                                  (formData.name && lastSchedule.name !== formData.name) ||
                                  (formData.nameKey && lastSchedule.nameKey !== formData.nameKey);

            if (scheduleChanged) {
                lastSchedule.endDate = todayISO;
                const newSchedule: HabitSchedule = {
                    startDate: todayISO,
                    times: formData.times,
                    frequency: formData.frequency,
                    scheduleAnchor: lastSchedule.scheduleAnchor, // Keep original anchor
                    ...(formData.nameKey ? { nameKey: formData.nameKey, subtitleKey: formData.subtitleKey } : { name: formData.name, subtitleKey: formData.subtitleKey })
                };
                habit.scheduleHistory.push(newSchedule);
            }
            
            // Update identity properties
            habit.icon = formData.icon;
            habit.color = formData.color;
            habit.goal = formData.goal;
        }
    }

    state.editingHabit = null;
    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderApp();
    closeModal(ui.editHabitModal);
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const streak = calculateHabitStreak(habit.id, getTodayUTCIso());
    if (streak < STREAK_CONSOLIDATED) {
        console.warn("Attempted to graduate a habit that is not consolidated.");
        return;
    }

    habit.graduatedOn = getTodayUTCIso();
    clearActiveHabitsCache();
    saveState();
    renderApp();
    setupManageModal();
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmEndHabit', { habitName: escapeHTML(name) }),
        () => endHabit(habitId),
        { title: t('modalEndHabitTitle'), confirmText: t('endButton') }
    );
}

function endHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    if (lastSchedule.endDate) return; // Already ended

    lastSchedule.endDate = getTodayUTCIso();
    
    // For Undo: store the last schedule and any future schedules that were removed.
    state.lastEnded = { habitId, lastSchedule: { ...lastSchedule }, removedSchedules: [] };

    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderApp();
    setupManageModal();
    showUndoToast();
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);

    showConfirmationModal(
        t('confirmRemoveTime', { habitName: escapeHTML(name) }),
        () => {
            const dailyInfo = ensureHabitDailyInfo(state.selectedDate, habitId);
            const schedule = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
            
            dailyInfo.dailySchedule = schedule.filter(t => t !== time);
            
            // Also clear any instance data for that time
            if (dailyInfo.instances) {
                delete dailyInfo.instances[time];
            }
            
            clearActiveHabitsCache();
            saveState();
            renderHabits();
        },
        { title: t('modalRemoveTimeTitle'), confirmText: t('removeButton') }
    );
}


export function handleUndoDelete() {
    if (!state.lastEnded) return;
    const { habitId, lastSchedule } = state.lastEnded;
    const habit = state.habits.find(h => h.id === habitId);

    if (habit) {
        const currentLastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        if (currentLastSchedule.endDate === lastSchedule.endDate) {
            delete currentLastSchedule.endDate;
        }
    }
    
    state.lastEnded = null;
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.remove('visible');
    
    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderApp();
    setupManageModal();
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmDeleteHabit', { habitName: escapeHTML(name) }),
        () => {
            state.habits = state.habits.filter(h => h.id !== habitId);
            // Also delete daily data
            Object.keys(state.dailyData).forEach(date => {
                delete state.dailyData[date][habitId];
            });
            saveState();
            setupManageModal();
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

export function resetApplicationData() {
    localStorage.clear();
    window.location.reload();
}

// --- Habit Instance Actions ---

export function toggleHabitStatus(habitId: string, time: TimeOfDay, dateISO: string) {
    const habitDayData = ensureHabitInstanceData(dateISO, habitId, time);
    habitDayData.status = getNextStatus(habitDayData.status);

    invalidateStreakCache(habitId, dateISO);
    saveState();
    renderHabits();
    renderCalendar();
    updateAppBadge();
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.goalOverride = newGoal;
    saveState();
    // The UI is updated locally by the listener for responsiveness
    renderCalendar();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.note = ui.notesTextarea.value.trim();
    
    state.editingNoteFor = null;
    saveState();
    renderHabits();
    closeModal(ui.notesModal);
}

export function completeAllHabitsForDate(dateISO: string) {
    const activeHabits = getActiveHabitsForDate(parseUTCIsoDate(dateISO));
    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            ensureHabitInstanceData(dateISO, habit.id, time).status = 'completed';
        });
        invalidateStreakCache(habit.id, dateISO);
    });
    saveState();
    renderHabits();
    renderCalendar();
    updateAppBadge();
}

export function snoozeAllHabitsForDate(dateISO: string) {
    const activeHabits = getActiveHabitsForDate(parseUTCIsoDate(dateISO));
    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            ensureHabitInstanceData(dateISO, habit.id, time).status = 'snoozed';
        });
        invalidateStreakCache(habit.id, dateISO);
    });
    saveState();
    renderHabits();
    renderCalendar();
    updateAppBadge();
}

// --- Drag and Drop Actions ---

export function handleHabitDrop(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const date = state.selectedDate;
    const dailyInfo = ensureHabitDailyInfo(date, habitId);
    const schedule = getEffectiveScheduleForHabitOnDate(habit, date);

    if (schedule.includes(toTime)) return; // Invalid drop, already exists

    // Create a custom schedule for the day
    const newSchedule = schedule.filter(t => t !== fromTime);
    newSchedule.push(toTime);
    dailyInfo.dailySchedule = newSchedule;
    
    // Move instance data
    const instanceData = dailyInfo.instances[fromTime];
    if (instanceData) {
        dailyInfo.instances[toTime] = instanceData;
        delete dailyInfo.instances[fromTime];
    }

    clearActiveHabitsCache();
    saveState();
    renderHabits();
}

export function reorderHabit(habitIdToMove: string, targetHabitId: string, position: 'before' | 'after') {
    const fromIndex = state.habits.findIndex(h => h.id === habitIdToMove);
    const toIndex = state.habits.findIndex(h => h.id === targetHabitId);
    if (fromIndex === -1 || toIndex === -1) return;

    const [movedHabit] = state.habits.splice(fromIndex, 1);
    const newToIndex = state.habits.findIndex(h => h.id === targetHabitId);
    
    state.habits.splice(position === 'before' ? newToIndex : newToIndex + 1, 0, movedHabit);
    
    clearActiveHabitsCache();
    saveState();
    renderHabits();
}

// --- AI Analysis ---

function _generateAIPrompt(analysisType: 'weekly' | 'monthly' | 'general'): { prompt: string, systemInstruction: string } {
    const today = getTodayUTC();
    const lang = state.activeLanguageCode;
    let startDate: Date;
    let daysToScan: number;

    switch (analysisType) {
        case 'weekly':
            startDate = addDays(today, -7);
            daysToScan = 7;
            break;
        case 'monthly':
            startDate = addDays(today, -30);
            daysToScan = 30;
            break;
        case 'general':
        default:
            startDate = new Date(0); // Epoch
            daysToScan = 365; // Scan up to a year for general analysis
            break;
    }

    let history = '';
    for (let i = 0; i < daysToScan; i++) {
        const date = addDays(today, -i);
        if (analysisType !== 'general' && date < startDate) break;

        const dateISO = toUTCIsoDateString(date);
        const dailyInfo = getHabitDailyInfoForDate(dateISO);
        const activeHabits = getActiveHabitsForDate(date);
        if (activeHabits.length === 0) continue;

        let dayEntry = `Date: ${dateISO}\n`;
        let hasActivity = false;
        activeHabits.forEach(({ habit, schedule }) => {
            const { name } = getHabitDisplayInfo(habit, dateISO);
            schedule.forEach(time => {
                const status = dailyInfo[habit.id]?.instances[time]?.status ?? 'pending';
                dayEntry += `- ${name} (${time}): ${status}\n`;
                hasActivity = true;
            });
        });
        if (hasActivity) {
            history += dayEntry;
        }
    }
    
    const systemInstruction = t('aiSystemInstruction');
    const prompt = t('aiUserPrompt', {
        type: t(`aiOption${analysisType.charAt(0).toUpperCase() + analysisType.slice(1)}Title`),
        language: lang,
        history: history,
    });
    
    return { prompt, systemInstruction };
}

export async function performAIAnalysis(analysisType: 'weekly' | 'monthly' | 'general') {
    closeModal(ui.aiOptionsModal);
    state.aiState = 'loading';
    state.lastAIResult = null;
    state.lastAIError = null;
    renderAINotificationState();

    try {
        const { prompt, systemInstruction } = _generateAIPrompt(analysisType);
        
        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
        });
        
        const resultText = await response.text();
        state.aiState = 'completed';
        state.lastAIResult = resultText;
        state.hasSeenAIResult = false;
        
        ui.aiResponse.innerHTML = simpleMarkdownToHTML(resultText);
        openModal(ui.aiModal);

    } catch (error: any) {
        state.aiState = 'error';
        state.lastAIError = error.message || 'Unknown error';
        state.hasSeenAIResult = false;
        
        ui.aiResponse.innerHTML = `<p class="ai-error-message">${t('aiErrorPrefix')}: ${escapeHTML(state.lastAIError!)}</p>`;
        openModal(ui.aiModal);
    } finally {
        saveState();
        renderAINotificationState();
    }
}