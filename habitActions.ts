
// ... (imports remain the same)
import { 
    state, 
    Habit, 
    HabitSchedule, 
    TimeOfDay, 
    ensureHabitDailyInfo, 
    ensureHabitInstanceData, 
    getNextStatus, 
    HabitStatus,
    clearScheduleCache,
    clearActiveHabitsCache,
    invalidateCachesForDateChange,
    getPersistableState
} from './state';
// ARCHITECTURE FIX: Import persistence logic from service layer.
import { saveState, clearLocalPersistence } from './services/persistence';
// ARCHITECTURE FIX: Import predefined habits from data layer, not state module.
import { PREDEFINED_HABITS } from './data/predefinedHabits';
import { getEffectiveScheduleForHabitOnDate, getActiveHabitsForDate, getScheduleForDate, isHabitNameDuplicate } from './services/selectors';
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
import { runWorkerTask } from './services/cloud';
import { apiFetch, clearKey } from './services/api';

// ... (helpers _finalizeScheduleUpdate and _requestFutureScheduleChange remain unchanged)

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
    // EVOLUTION [2025-03-16]: Update PWA Badge immediately after structural changes.
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

function _requestFutureScheduleChange(
    habitId: string, 
    targetDate: string, 
    updateFn: (schedule: HabitSchedule) => HabitSchedule
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

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
        currentSchedule.endDate = targetDate;

        const newSchedule = updateFn({ 
            ...currentSchedule, 
            startDate: targetDate, 
            endDate: undefined
        });
        
        habit.scheduleHistory.push(newSchedule);
        
        habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
    }
    
    _finalizeScheduleUpdate(true);
}

// ... (exported actions createDefaultHabit to requestHabitTimeRemoval remain unchanged)

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

    if (formData.name) {
        formData.name = formData.name.trim();
    }
    const displayName = formData.nameKey ? t(formData.nameKey) : formData.name;

    if (!displayName) {
        return; 
    }
    if (isHabitNameDuplicate(displayName, habitId)) {
        console.warn(`Save blocked due to duplicate name: "${displayName}"`);
        return;
    }
    
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

        const dailyInfo = ensureHabitDailyInfo(targetDate, habit.id);
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        const firstSchedule = habit.scheduleHistory[0];

        if (targetDate < firstSchedule.startDate) {
            firstSchedule.startDate = targetDate;
            firstSchedule.name = formData.name;
            firstSchedule.nameKey = formData.nameKey;
            firstSchedule.times = formData.times;
            firstSchedule.frequency = formData.frequency;
            firstSchedule.scheduleAnchor = targetDate;
            
            _finalizeScheduleUpdate(true);
        } else {
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
            // 1. Remove from Metadata
            state.habits = state.habits.filter(h => h.id !== habitId);
            
            // 2. Remove from Hot Storage
            Object.values(state.dailyData).forEach(day => {
                delete day[habitId];
            });

            // OPTIMIZATION: Determine the start year of the habit to avoid checking older archives.
            const earliestDate = habit.scheduleHistory[0]?.startDate || habit.createdOn;
            const startYear = parseInt(earliestDate.substring(0, 4), 10);

            // 3. Remove from Cold Storage (Archives) & Update Warm Cache
            for (const year in state.archives) {
                // Skip years before the habit existed
                if (parseInt(year, 10) < startYear) continue;

                try {
                    let yearData: any;
                    let isFromCache = false;

                    // Optimization: Check if already parsed in memory
                    if (state.unarchivedCache.has(year)) {
                        yearData = state.unarchivedCache.get(year);
                        isFromCache = true;
                    } else {
                        yearData = JSON.parse(state.archives[year]);
                    }

                    let yearWasModified = false;
                    
                    for (const date in yearData) {
                        if (yearData[date][habitId]) {
                            delete yearData[date][habitId];
                            yearWasModified = true;
                        }
                        if (Object.keys(yearData[date]).length === 0) {
                            delete yearData[date];
                            yearWasModified = true;
                        }
                    }

                    if (yearWasModified) {
                        // Update Cold Storage
                        if (Object.keys(yearData).length === 0) {
                            delete state.archives[year];
                            state.unarchivedCache.delete(year); // Clean empty cache entry
                        } else {
                            state.archives[year] = JSON.stringify(yearData);
                            // Update Warm Cache in-place if it existed
                            if (isFromCache) {
                                state.unarchivedCache.set(year, yearData);
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Error cleaning archive for year ${year}:`, e);
                }
            }
            
            // Note: We deliberately do NOT call state.unarchivedCache.clear() here anymore.
            // This preserves the loaded state of other years/habits, preventing a performance stutter.

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
    state.notificationsShown = [];
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    
    clearLocalPersistence();
    clearKey();
    
    location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;

    const { habitId, date, time } = state.editingNoteFor;
    const noteContent = ui.notesTextarea.value.trim();

    const instance = ensureHabitInstanceData(date, habitId, time);

    if ((instance.note || '') !== noteContent) {
        if (noteContent) {
            instance.note = noteContent;
        } else {
            delete instance.note;
        }

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
        
        const { loadState, saveState } = await import('./services/persistence');
        
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.habits && data.version) {
                loadState(data);
                saveState();
                document.dispatchEvent(new CustomEvent('render-app'));
                document.dispatchEvent(new CustomEvent('habitsChanged'));
                
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
    
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    
    document.dispatchEvent(new CustomEvent('render-app'));
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.goalOverride = value;
    
    invalidateCachesForDateChange(date, [habitId]);
    
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    
    document.dispatchEvent(new CustomEvent('render-app'));
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = getSafeDate(state.selectedDate); 
    const { name } = getHabitDisplayInfo(habit, targetDate);
    const timeName = getTimeOfDayName(time);
    
    const confirmDeletion = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
            scheduleToUpdate.times = [...scheduleToUpdate.times];

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
            confirmText: t('deleteButton'),
            confirmButtonStyle: 'danger' 
        }
    );
}

export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    // PERFORMANCE OPTIMIZATION [2025-03-16]: Pre-parse date to avoid parsing inside loop selectors.
    const dateObj = parseUTCIsoDate(dateISO);
    const activeHabits = getActiveHabitsForDate(dateISO, dateObj);
    
    let changed = false;
    const changedHabitIds = new Set<string>();
    
    activeHabits.forEach(({ habit, schedule }) => {
        const dailyInfo = ensureHabitDailyInfo(dateISO, habit.id);
        
        schedule.forEach(time => {
            dailyInfo.instances[time] ??= { status: 'pending' };
            const instance = dailyInfo.instances[time]!;
            
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
        
        document.dispatchEvent(new CustomEvent('habitsChanged'));
    }
    return changed;
}
