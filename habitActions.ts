// ... (imports remain the same)
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
    getScheduleForDate,
    clearActiveHabitsCache,
    getActiveHabitsForDate,
    invalidateCachesForDateChange
} from './state';
import { 
    generateUUID, 
    getTodayUTCIso, 
    toUTCIsoDateString, 
    addDays, 
    parseUTCIsoDate,
    triggerHaptic,
    getSafeDate,
    getDateTimeFormat
} from './utils';
import { 
    closeModal, 
    openModal, 
    showConfirmationModal, 
    openEditModal, 
    renderAINotificationState,
    clearHabitDomCache,
    setupManageModal
} from './render';
import { ui } from './render/ui';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { runWorkerTask } from './cloud';
import { apiFetch } from './services/api';

// --- HELPERS ---

function _finalizeScheduleUpdate(affectsHistory: boolean = true) {
    if (affectsHistory) {
        clearScheduleCache();
        clearHabitDomCache();
    } else {
        clearActiveHabitsCache();
    }
    
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    
    saveState();
    
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

    habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
    
    let activeScheduleIndex = -1;
    for (let i = habit.scheduleHistory.length - 1; i >= 0; i--) {
        const s = habit.scheduleHistory[i];
        if (targetDate >= s.startDate && (!s.endDate || targetDate < s.endDate)) {
            activeScheduleIndex = i;
            break;
        }
    }

    if (activeScheduleIndex === -1) return;

    const currentSchedule = habit.scheduleHistory[activeScheduleIndex];

    if (currentSchedule.startDate === targetDate) {
        habit.scheduleHistory[activeScheduleIndex] = updateFn({ ...currentSchedule });
    } else {
        // BUGFIX [2025-03-10]: End Date Logic.
        // The check `!s.endDate || date < s.endDate` is strict (exclusive). 
        // To be valid UP TO targetDate (exclusive of targetDate), the endDate must be targetDate itself.
        currentSchedule.endDate = targetDate;

        const newSchedule = updateFn({ 
            ...currentSchedule, 
            startDate: targetDate, 
            endDate: undefined
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
        _finalizeScheduleUpdate(true);
    }
}

export function reorderHabit(movedHabitId: string, targetHabitId: string, position: 'before' | 'after', skipFinalize = false) {
    const movedIndex = state.habits.findIndex(h => h.id === movedHabitId);
    const targetIndex = state.habits.findIndex(h => h.id === targetHabitId);

    if (movedIndex === -1 || targetIndex === -1) return;

    const [movedHabit] = state.habits.splice(movedIndex, 1);
    
    const newTargetIndex = (movedIndex < targetIndex) ? targetIndex - 1 : targetIndex;
    
    const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
    state.habits.splice(insertIndex, 0, movedHabit);

    if (!skipFinalize) {
        _finalizeScheduleUpdate(false);
    }
}

export function handleHabitDrop(
    habitId: string, 
    fromTime: TimeOfDay, 
    toTime: TimeOfDay,
    reorderInfo?: { id: string, pos: 'before' | 'after' }
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = getSafeDate(state.selectedDate);

    const applyJustToday = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
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
            if (reorderTargetHabit) {
                reorderHabit(habitId, reorderInfo.id, reorderInfo.pos, true);
            }
        }
        
        _finalizeScheduleUpdate(false);
    };

    const applyFromNowOn = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        
        const currentOverride = dailyInfo.dailySchedule ? [...dailyInfo.dailySchedule] : null;

        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        if (reorderInfo) {
            reorderHabit(habitId, reorderInfo.id, reorderInfo.pos, true);
        }

        _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
            // FIX: Clone the array to prevent shared reference bugs
            scheduleToUpdate.times = [...scheduleToUpdate.times];

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
    
    if (!formData.name && !formData.nameKey) return; 
    
    if (isNew) {
        const newHabit: Habit = {
            id: generateUUID(),
            createdOn: targetDate,
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

        habit.icon = formData.icon;
        habit.color = formData.color;
        habit.goal = formData.goal;

        // FIX [2025-03-09]: CRITICAL FIX FOR RESTORING HABITS IN PAST.
        // Clean up any 'Just Today' removal overrides that might be hiding the habit on this specific date.
        const dailyInfo = ensureHabitDailyInfo(targetDate, habit.id);
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        // Sort history to find the start
        habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
        const firstSchedule = habit.scheduleHistory[0];

        // LOGIC FIX [2025-03-09]: Backfill Logic.
        // If the target date is BEFORE the habit's current start date, we extend the
        // first schedule backwards. This "overwrites" the past by making the habit active
        // from the new earlier date onwards.
        if (targetDate < firstSchedule.startDate) {
            firstSchedule.startDate = targetDate;
            
            // Also apply the edits to this extended schedule
            firstSchedule.name = formData.name;
            firstSchedule.nameKey = formData.nameKey;
            firstSchedule.times = formData.times;
            firstSchedule.frequency = formData.frequency;
            
            // Update anchor if needed to ensure frequency calculation starts from new start date
            firstSchedule.scheduleAnchor = targetDate;
            
            _finalizeScheduleUpdate(true);
        } else {
            // Standard behavior: Modify future or split history
            _requestFutureScheduleChange(habit.id, targetDate, (schedule) => {
                schedule.name = formData.name;
                schedule.nameKey = formData.nameKey;
                schedule.times = formData.times;
                schedule.frequency = formData.frequency;
                return schedule;
            });
        }
    }

    closeModal(ui.editHabitModal);
    state.editingHabit = null;
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const targetDate = getSafeDate(state.selectedDate);
    const { name } = getHabitDisplayInfo(habit, targetDate);
    
    const dateObj = parseUTCIsoDate(targetDate);
    const formattedDate = getDateTimeFormat(state.activeLanguageCode, {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC'
    }).format(dateObj);
    
    showConfirmationModal(
        t('confirmEndHabit', { habitName: name, date: formattedDate }),
        () => {
            _requestFutureScheduleChange(habitId, targetDate, (schedule) => {
                schedule.endDate = targetDate;
                return schedule;
            });
            
            state.lastEnded = { habitId, originalHabit: JSON.parse(JSON.stringify(habit)) };
            
            closeModal(ui.manageModal);
        },
        { confirmButtonStyle: 'danger', confirmText: t('endButton') }
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
            Object.values(state.dailyData).forEach(day => {
                delete day[habitId];
            });
            
            _finalizeScheduleUpdate(true);
            
            if (ui.manageModal.classList.contains('visible')) {
                closeModal(ui.manageModal);
            }
        },
        { confirmButtonStyle: 'danger', confirmText: t('deleteButton') }
    );
}

export function requestHabitRestoration(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmRestoreHabit', { habitName: name }),
        () => {
            const habitToRestore = state.habits.find(h => h.id === habitId);
            if (!habitToRestore) return;

            habitToRestore.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
            
            const lastSchedule = habitToRestore.scheduleHistory[habitToRestore.scheduleHistory.length - 1];
            if (lastSchedule.endDate) {
                delete lastSchedule.endDate;
            }

            _finalizeScheduleUpdate(true);
            
            setupManageModal();
        },
        { 
            confirmText: t('restoreButton'),
            title: t('modalRestoreHabitTitle')
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
    if (!habit) return;

    const targetDate = getSafeDate(state.selectedDate);
    habit.graduatedOn = targetDate;
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

    const instance = ensureHabitInstanceData(date, habitId, time);

    // OTIMIZAÇÃO: Apenas salva e renderiza se a nota realmente mudou.
    if ((instance.note || '') !== noteContent) {
        if (noteContent) {
            instance.note = noteContent;
        } else {
            delete instance.note;
        }

        // A mudança de uma nota afeta o ícone de nota no cartão, que é uma mudança estrutural/visual.
        state.uiDirtyState.habitListStructure = true;
        saveState();
        document.dispatchEvent(new CustomEvent('render-app'));
    }

    closeModal(ui.notesModal);
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
        PREDEFINED_HABITS.forEach(h => {
            translations[h.nameKey] = t(h.nameKey);
        });

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
    
    if (habit.goal.type === 'check') {
        if (newStatus === 'completed') {
            instance.goalOverride = 1;
        } else if (newStatus === 'pending') {
            instance.goalOverride = undefined;
        }
    }
    
    invalidateCachesForDateChange(date, [habitId]);
    
    // Set dirty flags to ensure the full re-render cycle updates the UI
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    
    document.dispatchEvent(new CustomEvent('render-app'));
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.goalOverride = value;
    
    const habit = state.habits.find(h => h.id === habitId);
    
    if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
        const target = habit.goal.total || 0;
        if (value >= target && instance.status !== 'completed') {
            instance.status = 'completed';
        } else if (value < target && instance.status === 'completed') {
            // CORRECTNESS FIX: If a user edits a completed goal to be below the target,
            // revert the status to pending to maintain logical consistency.
            instance.status = 'pending';
        }
    }
    
    invalidateCachesForDateChange(date, [habitId]);
    
    // Set dirty flags and trigger re-render
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    
    document.dispatchEvent(new CustomEvent('render-app'));
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = getSafeDate(state.selectedDate); // Force safe date capture here
    const { name } = getHabitDisplayInfo(habit, targetDate);
    const timeName = getTimeOfDayName(time);
    
    // UX REFINEMENT [2025-03-09]: Simplified flow.
    // User requested to remove "Just Today" option, favoring "Snooze" for temporary skips.
    // Now creates a permanent schedule split (From Now On).
    const confirmDeletion = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        
        // Clean up any local override to let the new history take over cleanly
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
            // FIX: Clone the array to prevent shared reference bugs
            scheduleToUpdate.times = [...scheduleToUpdate.times];

            // Remove the time from the schedule definition
            const index = scheduleToUpdate.times.indexOf(time);
            if (index > -1) {
                scheduleToUpdate.times.splice(index, 1);
            }
            return scheduleToUpdate;
        });
    };

    showConfirmationModal(
        t('confirmRemoveTimePermanent', { habitName: name, time: timeName }),
        confirmDeletion,
        {
            title: t('modalRemoveTimeTitle'), 
            confirmText: t('deleteButton'), // Use explicit "Delete" text
            confirmButtonStyle: 'danger' // Make it red/danger
        }
    );
}

export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    const activeHabits = getActiveHabitsForDate(dateISO);
    let changed = false;
    const changedHabitIds = new Set<string>();
    
    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instance = ensureHabitInstanceData(dateISO, habit.id, time);
            if (instance.status !== status) {
                instance.status = status;
                if (habit.goal.type === 'check') {
                    instance.goalOverride = status === 'completed' ? 1 : undefined;
                }
                changed = true;
                changedHabitIds.add(habit.id);
            }
        });
    });
    
    if (changed) {
        invalidateCachesForDateChange(dateISO, Array.from(changedHabitIds));
        
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        saveState();
    }
    return changed;
}