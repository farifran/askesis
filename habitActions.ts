
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
    PREDEFINED_HABITS, 
    ensureHabitDailyInfo, 
    getEffectiveScheduleForHabitOnDate, 
    ensureHabitInstanceData, 
    getNextStatus, 
    getPersistableState, 
    loadState, 
    HabitStatus,
    clearScheduleCache,
    invalidateChartCache,
    invalidateStreakCache,
    getScheduleForDate,
    APP_VERSION,
    clearActiveHabitsCache,
    HabitDailyInfo,
    getActiveHabitsForDate
} from './state';
import { 
    generateUUID, 
    getTodayUTCIso, 
    toUTCIsoDateString, 
    addDays, 
    parseUTCIsoDate,
    triggerHaptic
} from './utils';
import { 
    closeModal, 
    openModal, 
    showConfirmationModal, 
    openEditModal, 
    renderAINotificationState,
    renderHabitCardState,
    renderCalendarDayPartial
} from './render';
import { ui } from './render/ui';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { runWorkerTask, setSyncStatus } from './cloud';
import { apiFetch } from './services/api';

// --- HELPERS ---

function _finalizeScheduleUpdate(affectsHistory: boolean = true) {
    if (affectsHistory) {
        clearScheduleCache();
    } else {
        clearActiveHabitsCache();
    }
    
    // FIX: Mark UI as dirty to force list re-rendering
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    
    saveState();
    
    // FIX: Use event dispatch to trigger render, breaking circular dependency with render.ts
    document.dispatchEvent(new CustomEvent('render-app'));
}

/**
 * Helper to safely modify a habit's schedule for future dates (splitting history).
 */
function _requestFutureScheduleChange(
    habitId: string, 
    targetDate: string, 
    updateFn: (schedule: HabitSchedule) => HabitSchedule
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Sort history to ensure we are looking at the timeline correctly
    habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
    
    let activeScheduleIndex = -1;
    for (let i = habit.scheduleHistory.length - 1; i >= 0; i--) {
        const s = habit.scheduleHistory[i];
        if (targetDate >= s.startDate && (!s.endDate || targetDate < s.endDate)) {
            activeScheduleIndex = i;
            break;
        }
    }

    if (activeScheduleIndex === -1) return; // Should not happen for active habits

    const currentSchedule = habit.scheduleHistory[activeScheduleIndex];

    // If we are modifying from the exact start date of the current schedule, just update it.
    if (currentSchedule.startDate === targetDate) {
        habit.scheduleHistory[activeScheduleIndex] = updateFn({ ...currentSchedule });
    } else {
        // Otherwise, split the schedule.
        // 1. End the current schedule yesterday.
        const yesterday = toUTCIsoDateString(addDays(parseUTCIsoDate(targetDate), -1));
        currentSchedule.endDate = yesterday;

        // 2. Create new schedule starting today
        const newSchedule = updateFn({ 
            ...currentSchedule, 
            startDate: targetDate, 
            endDate: undefined // New schedule is open-ended
        });
        
        habit.scheduleHistory.push(newSchedule);
    }
    
    _finalizeScheduleUpdate(true);
}

// --- EXPORTED ACTIONS ---

export function createDefaultHabit() {
    const defaultTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (defaultTemplate) {
        const newHabit: Habit = {
            id: generateUUID(),
            createdOn: getTodayUTCIso(),
            icon: defaultTemplate.icon,
            color: defaultTemplate.color,
            goal: defaultTemplate.goal,
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
        saveState();
    }
}

export function reorderHabit(movedHabitId: string, targetHabitId: string, position: 'before' | 'after') {
    const movedIndex = state.habits.findIndex(h => h.id === movedHabitId);
    const targetIndex = state.habits.findIndex(h => h.id === targetHabitId);

    if (movedIndex === -1 || targetIndex === -1) return;

    const [movedHabit] = state.habits.splice(movedIndex, 1);
    
    // Recalculate target index after removal
    const newTargetIndex = state.habits.findIndex(h => h.id === targetHabitId);
    
    const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
    state.habits.splice(insertIndex, 0, movedHabit);

    _finalizeScheduleUpdate(false); // Reordering doesn't change schedule logic, just display order
}

export function handleHabitDrop(
    habitId: string, 
    fromTime: TimeOfDay, 
    toTime: TimeOfDay,
    reorderInfo?: { id: string, pos: 'before' | 'after' }
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = state.selectedDate;

    // A. Logic "Just Today"
    const applyJustToday = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        // Use spread to copy array, as getEffectiveSchedule returns readonly ref in state.ts
        const currentSchedule = [...getEffectiveScheduleForHabitOnDate(habit, targetDate)];

        const fromIndex = currentSchedule.indexOf(fromTime);
        if (fromIndex > -1) {
            currentSchedule.splice(fromIndex, 1);
        }
        
        let toIndex = currentSchedule.indexOf(toTime);
        if (toIndex === -1) {
            currentSchedule.push(toTime);
        }

        dailyInfo.dailySchedule = currentSchedule;
        
        if (reorderInfo) {
            const reorderTargetHabit = state.habits.find(h => h.id === reorderInfo.id);
            if (reorderTargetHabit) reorderHabit(habitId, reorderInfo.id, reorderInfo.pos);
        }
        
        _finalizeScheduleUpdate(false); // Visual update mainly
    };

    // B. Logic "From Now On"
    const applyFromNowOn = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        
        // Capture current override if it exists
        const currentOverride = dailyInfo.dailySchedule ? [...dailyInfo.dailySchedule] : null;

        // Remove override for today so the new schedule takes effect visually
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
            if (currentOverride) {
                scheduleToUpdate.times = currentOverride;
            }

            const fromIndex = scheduleToUpdate.times.indexOf(fromTime);
            if (fromIndex > -1) {
                scheduleToUpdate.times.splice(fromIndex, 1);
            }
            if (!scheduleToUpdate.times.includes(toTime)) {
                scheduleToUpdate.times.push(toTime);
            }
            return scheduleToUpdate;
        });
        
        if (reorderInfo) {
            reorderHabit(habitId, reorderInfo.id, reorderInfo.pos);
        }
    };
    
    const timeNames = { oldTime: getTimeOfDayName(fromTime), newTime: getTimeOfDayName(toTime) };
    const habitName = getHabitDisplayInfo(habit, targetDate).name;

    showConfirmationModal(
        t('confirmHabitMove', { habitName, ...timeNames }),
        applyFromNowOn,
        {
            title: t('modalMoveHabitTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: applyJustToday
        }
    );
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const { isNew, habitId, formData, targetDate } = state.editingHabit;
    
    // Validation
    if (!formData.name && !formData.nameKey) return; 
    
    if (isNew) {
        const newHabit: Habit = {
            id: generateUUID(),
            createdOn: targetDate, // Use the date currently viewing
            icon: formData.icon,
            color: formData.color,
            goal: formData.goal,
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
        _finalizeScheduleUpdate(true);
    } else {
        const habit = state.habits.find(h => h.id === habitId);
        if (!habit) return;

        // Update properties that are not schedule-dependent (visuals/goals)
        habit.icon = formData.icon;
        habit.color = formData.color;
        habit.goal = formData.goal;

        // Handle Schedule Changes
        _requestFutureScheduleChange(habit.id, targetDate, (schedule) => {
            schedule.name = formData.name;
            schedule.nameKey = formData.nameKey;
            schedule.times = formData.times;
            schedule.frequency = formData.frequency;
            return schedule;
        });
    }

    closeModal(ui.editHabitModal);
    state.editingHabit = null;
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    
    showConfirmationModal(
        t('confirmEndHabit', { habitName: name }),
        () => {
            _requestFutureScheduleChange(habitId, state.selectedDate, (schedule) => {
                schedule.endDate = state.selectedDate; // Ends today
                return schedule;
            });
            
            // Undo capability logic could be added here
            state.lastEnded = { habitId, originalHabit: JSON.parse(JSON.stringify(habit)) };
            
            closeModal(ui.manageModal); // Close manager to show the change
        },
        { confirmButtonStyle: 'danger', confirmText: t('buttonEnd') }
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
            // Cleanup daily data
            Object.values(state.dailyData).forEach(day => {
                delete day[habitId];
            });
            // Cleanup archives (expensive but needed for consistency)
            // Ideally we'd use a worker for this cleanup if archives are huge.
            
            _finalizeScheduleUpdate(true);
            
            // Refresh modal list if it's open
            if (ui.manageModal.classList.contains('visible')) {
                closeModal(ui.manageModal);
            }
        },
        { confirmButtonStyle: 'danger', confirmText: t('buttonDelete') }
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
    if (!habit) return;

    habit.graduatedOn = state.selectedDate;
    _finalizeScheduleUpdate(true);
    closeModal(ui.manageModal);
    
    triggerHaptic('success');
}

export function resetApplicationData() {
    state.habits = [];
    state.dailyData = {};
    state.archives = {};
    state.lastEnded = null;
    state.notificationsShown = [];
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    
    localStorage.removeItem('habitTrackerState_v1');
    localStorage.removeItem('habitTrackerSyncKey');
    
    location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    
    const { habitId, date, time } = state.editingNoteFor;
    const noteContent = ui.notesTextarea.value.trim();
    
    ensureHabitDailyInfo(date, habitId);
    const instance = ensureHabitInstanceData(date, habitId, time);
    
    instance.note = noteContent;
    
    saveState();
    closeModal(ui.notesModal);
    
    renderHabitCardState(habitId, time); 
}

export async function performAIAnalysis(analysisType: 'monthly' | 'quarterly' | 'historical') {
    if (state.aiState === 'loading') return;

    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    renderAINotificationState();
    closeModal(ui.aiOptionsModal);

    try {
        const translations: any = {
            promptTemplate: t('aiPromptTemplate'),
            aiPromptGraduatedSection: t('aiPromptGraduatedSection'),
            aiPromptNoData: t('aiPromptNoData'),
            aiPromptNone: t('aiPromptNone'),
            aiSystemInstruction: t('aiSystemInstruction'),
        };
        // Add all predefined habit name keys to translations for the worker
        PREDEFINED_HABITS.forEach(h => {
            translations[h.nameKey] = t(h.nameKey);
        });

        // Use Worker to build the heavy prompt
        const { prompt, systemInstruction } = await runWorkerTask<{ prompt: string, systemInstruction: string }>(
            'build-ai-prompt',
            {
                analysisType,
                habits: state.habits,
                dailyData: state.dailyData,
                archives: state.archives,
                languageName: t(state.activeLanguageCode === 'pt' ? 'langPortuguese' : (state.activeLanguageCode === 'es' ? 'langSpanish' : 'langEnglish')),
                translations,
                todayISO: getTodayUTCIso()
            }
        );

        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
        });

        const text = await response.text();
        state.lastAIResult = text;
        state.aiState = 'completed';
    } catch (error) {
        console.error("AI Analysis failed", error);
        state.lastAIError = String(error);
        state.aiState = 'error';
        state.lastAIResult = t('aiErrorGeneric');
    } finally {
        saveState();
        renderAINotificationState();
    }
}

export function exportData() {
    const dataStr = JSON.stringify(getPersistableState(), null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `askesis-backup-${getTodayUTCIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

export function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.habits && data.version) {
                loadState(data);
                saveState();
                document.dispatchEvent(new CustomEvent('render-app'));
                closeModal(ui.manageModal);
                alert(t('importSuccess'));
            } else {
                alert(t('importInvalid'));
            }
        } catch (err) {
            console.error(err);
            alert(t('importError'));
        }
    };
    input.click();
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const instance = ensureHabitInstanceData(date, habitId, time);
    const oldStatus = instance.status;
    const newStatus = getNextStatus(oldStatus);
    
    instance.status = newStatus;
    
    // Handle automatic goal completion for check-type habits
    if (habit.goal.type === 'check') {
        if (newStatus === 'completed') {
            instance.goalOverride = 1;
        } else if (newStatus === 'pending') {
            instance.goalOverride = undefined;
        }
    }

    invalidateChartCache();
    saveState();
    
    // Surgical Updates
    renderHabitCardState(habitId, time);
    renderCalendarDayPartial(date);
    document.dispatchEvent(new CustomEvent('render-app'));
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.goalOverride = value;
    
    // Auto-complete if goal reached?
    const habit = state.habits.find(h => h.id === habitId);
    if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
        const target = habit.goal.total || 0;
        if (value >= target && instance.status !== 'completed') {
            instance.status = 'completed';
        }
    }
    
    invalidateChartCache();
    saveState();
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = state.selectedDate;
    const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
    
    // Get current schedule (either override or base)
    const currentSchedule = [...getEffectiveScheduleForHabitOnDate(habit, targetDate)];
    
    const index = currentSchedule.indexOf(time);
    if (index > -1) {
        currentSchedule.splice(index, 1);
        dailyInfo.dailySchedule = currentSchedule;
        
        _finalizeScheduleUpdate(false);
    }
}

export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    const activeHabits = getActiveHabitsForDate(dateISO);
    let changed = false;
    
    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instance = ensureHabitInstanceData(dateISO, habit.id, time);
            if (instance.status !== status) {
                instance.status = status;
                // Basic goal override for check habits
                if (habit.goal.type === 'check') {
                    instance.goalOverride = status === 'completed' ? 1 : undefined;
                }
                changed = true;
            }
        });
    });
    
    if (changed) {
        invalidateChartCache();
        saveState();
    }
    return changed;
}
