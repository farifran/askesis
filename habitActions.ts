import {
    state,
    Habit,
    Frequency,
    saveState,
    ensureHabitInstanceData,
    getNextStatus,
    getSmartGoalForHabit,
    getTodayUTCIso,
    STATE_STORAGE_KEY,
    addDays,
    calculateHabitStreak,
    STREAK_SEMI_CONSOLIDATED,
    STREAK_CONSOLIDATED,
    shouldHabitAppearOnDate,
    PredefinedHabit,
    // FIX: Corrected typo from toUTCIsoString to toUTCIsoDateString to match export.
    toUTCIsoDateString,
    parseUTCIsoDate,
    PREDEFINED_HABITS,
    TimeOfDay,
    TIMES_OF_DAY,
} from './state';
import { ui } from './ui';
import {
    renderHabits,
    updateHabitCardDOM,
    updateCalendarDayDOM,
    showConfirmationModal,
    closeModal,
    setupManageModal,
    showUndoToast,
    showInlineNotice,
    addHabitToDOM,
    removeHabitFromDOM,
    updateGroupPlaceholder,
    renderAINotificationState,
    formatGoalForDisplay,
    openEditModal,
    renderCalendar,
    renderApp,
    updateHeaderTitle,
} from './render';
import { isCurrentlySwiping } from './swipeHandler';
import { t, getHabitDisplayInfo } from './i18n';

function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: number | null = null;
    return function(this: ThisParameterType<T>, ...args: Parameters<T>): void {
        const context = this;
        if (timeout !== null) clearTimeout(timeout);
        timeout = window.setTimeout(() => {
            timeout = null;
            func.apply(context, args);
        }, wait);
    };
}

const debouncedSaveState = debounce(saveState, 500);
const goalColorTimeouts = new Map<HTMLElement, number>();

// --- DUPLICATE CHECKING LOGIC ---
export function isDuplicateHabit(name: string, habitIdToExclude: string | null = null): boolean {
    return state.habits.some(habit =>
        (habitIdToExclude === null || habit.id !== habitIdToExclude) &&
        !habit.endedOn &&
        !habit.graduatedOn &&
        getHabitDisplayInfo(habit).name.toLowerCase() === name.toLowerCase()
    );
}


function updateAffectedCalendarDays(baseDateISO: string) {
    updateCalendarDayDOM(baseDateISO);
    for (let i = 1; i <= 3; i++) {
        const baseDate = parseUTCIsoDate(baseDateISO);
        const affectedDate = addDays(baseDate, i);
        // FIX: Corrected typo from toUTCIsoString to toUTCIsoDateString to match export.
        const affectedDateISO = toUTCIsoDateString(affectedDate);
        updateCalendarDayDOM(affectedDateISO);
    }
}

function checkAndTriggerConsolidationNotifications(habitId: string, dateISO: string) {
    const streak = calculateHabitStreak(habitId, dateISO);
    const alreadyShown = state.notificationsShown.includes(habitId);
    let wasPromoted = false;

    const alreadyPendingConsolidation = state.pendingConsolidationHabitIds.includes(habitId);
    if (streak >= STREAK_CONSOLIDATED && !alreadyPendingConsolidation) {
        state.pendingConsolidationHabitIds.push(habitId);
        wasPromoted = true;
        if (!alreadyShown) state.notificationsShown.push(habitId);
        const semiPendingIndex = state.pending21DayHabitIds.indexOf(habitId);
        if (semiPendingIndex > -1) state.pending21DayHabitIds.splice(semiPendingIndex, 1);
    }
    
    const alreadyPendingSemi = state.pending21DayHabitIds.includes(habitId);
    if (!wasPromoted && streak >= STREAK_SEMI_CONSOLIDATED && !alreadyShown && !alreadyPendingSemi) {
        state.pending21DayHabitIds.push(habitId);
    }
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay) {
    if (isCurrentlySwiping()) return;

    const cacheKey = `${habitId}|${state.selectedDate}`;
    delete state.streaksCache[cacheKey];

    const habitInstanceData = ensureHabitInstanceData(state.selectedDate, habitId, time);
    const oldStatus = habitInstanceData.status;
    habitInstanceData.status = getNextStatus(habitInstanceData.status);
    const newStatus = habitInstanceData.status;

    if (newStatus === 'completed' && oldStatus !== 'completed') {
        checkAndTriggerConsolidationNotifications(habitId, state.selectedDate);
    } else if (newStatus !== 'completed' && oldStatus === 'completed') {
        const pendingSemiIndex = state.pending21DayHabitIds.indexOf(habitId);
        if (pendingSemiIndex > -1) state.pending21DayHabitIds.splice(pendingSemiIndex, 1);
        const pendingConsolidatedIndex = state.pendingConsolidationHabitIds.indexOf(habitId);
        if (pendingConsolidatedIndex > -1) state.pendingConsolidationHabitIds.splice(pendingConsolidatedIndex, 1);
    }

    debouncedSaveState();
    updateHabitCardDOM(habitId, time);
    updateAffectedCalendarDays(state.selectedDate);
    renderAINotificationState();
}


export function completeAllHabitsForDate(dateISO: string) {
    let changed = false;
    const dateObj = parseUTCIsoDate(dateISO);
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, dateObj));
    const dailyInfoByHabit = state.dailyData[dateISO] || {};

    activeHabitsOnDate.forEach(habit => {
        const habitDailyInfo = dailyInfoByHabit[habit.id];
        const scheduleForDay = habitDailyInfo?.dailySchedule || habit.times;
        
        scheduleForDay.forEach(time => {
            const dayHabitData = ensureHabitInstanceData(dateISO, habit.id, time);
            if (dayHabitData.status !== 'completed') {
                dayHabitData.status = 'completed';
                changed = true;
            }
        });
        if (changed) {
            checkAndTriggerConsolidationNotifications(habit.id, dateISO);
        }
    });

    if (changed) {
        debouncedSaveState();
        renderHabits();
        updateAffectedCalendarDays(dateISO);
        renderAINotificationState();
    }
}

export function snoozeAllHabitsForDate(dateISO: string) {
    let changed = false;
    const dateObj = parseUTCIsoDate(dateISO);
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, dateObj));
    const dailyInfoByHabit = state.dailyData[dateISO] || {};

    activeHabitsOnDate.forEach(habit => {
        const habitDailyInfo = dailyInfoByHabit[habit.id];
        const scheduleForDay = habitDailyInfo?.dailySchedule || habit.times;

        scheduleForDay.forEach(time => {
            const dayHabitData = ensureHabitInstanceData(dateISO, habit.id, time);
            if (dayHabitData.status !== 'snoozed') {
                dayHabitData.status = 'snoozed';
                changed = true;
            }
        });
    });

    if (changed) {
        debouncedSaveState();
        renderHabits();
        updateAffectedCalendarDays(dateISO);
    }
}

export function updateGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;
    
    const habitInstanceData = ensureHabitInstanceData(date, habitId, time);
    habitInstanceData.goalOverride = newGoal;
    
    debouncedSaveState();
    updateHabitCardDOM(habitId, time);
    updateAffectedCalendarDays(date);
}

export function handleGoalControlClick(habitId: string, time: TimeOfDay, action: 'increment' | 'decrement') {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
    const currentGoal = ensureHabitInstanceData(state.selectedDate, habitId, time).goalOverride ?? smartGoal;
    
    let newGoal: number;
    if (action === 'increment') newGoal = currentGoal + (currentGoal > 4 ? 5 : 1);
    else newGoal = currentGoal - (currentGoal > 5 ? 5 : 1);
    newGoal = Math.max(1, newGoal);
    
    updateGoalOverride(habitId, state.selectedDate, time, newGoal);
    
    const goalValueEl = document.querySelector<HTMLElement>(`.habit-card[data-habit-id="${habitId}"][data-time="${time}"] .progress`);
    if (goalValueEl) {
        const timeoutId = goalColorTimeouts.get(goalValueEl);
        if (timeoutId) clearTimeout(timeoutId);
        goalValueEl.classList.remove('goal-increased', 'goal-decreased');
        void (goalValueEl as HTMLElement).offsetWidth; // Trigger reflow
        goalValueEl.classList.add(action === 'increment' ? 'goal-increased' : 'goal-decreased');
        const newTimeoutId = window.setTimeout(() => goalValueEl.classList.remove('goal-increased', 'goal-decreased'), 800);
        goalColorTimeouts.set(goalValueEl, newTimeoutId);
    }
}


export function createDefaultHabit() {
    const waterHabitTemplate = PREDEFINED_HABITS.find(h => h.nameKey === 'predefinedHabitWaterName');
    if (waterHabitTemplate) {
        const newHabit: Habit = {
            ...waterHabitTemplate,
            id: crypto.randomUUID(),
            createdOn: getTodayUTCIso(),
            scheduleAnchor: getTodayUTCIso(),
            name: '',
            subtitle: '',
            goal: { ...waterHabitTemplate.goal, unit: '' }
        };
        state.habits.push(newHabit);
        debouncedSaveState();
    }
}

export function requestHabitEnding(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        habit.endedOn = state.selectedDate;
        state.lastEnded = { habitId };
        debouncedSaveState();
        showUndoToast();
        renderApp();
        setupManageModal();
    }
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);

    // Se o hábito só tem um horário, a ação é de encerramento total.
    if (habit.times.length <= 1) {
        showConfirmationModal(
            t('confirmEndHabit', { habitName: name }),
            () => { requestHabitEnding(habitId); },
            () => {
                closeModal(ui.confirmModal);
                openEditModal(habit);
            }
        );
        return;
    }

    // Se tem múltiplos horários, a ação é de remover apenas este horário.
    const localizedTime = t(`filter${time}`);
    showConfirmationModal(
        t('confirmRemoveTime', { habitName: name, time: localizedTime }),
        () => {
            habit.times = habit.times.filter(t => t !== time);
            saveState();
            renderApp();
            setupManageModal();
        }
    );
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        const { name } = getHabitDisplayInfo(habit);
        showConfirmationModal(
            t('confirmEndHabit', { habitName: name }),
            () => {
                habit.endedOn = getTodayUTCIso();
                saveState();
                setupManageModal();
            }
        );
    }
}
export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        openEditModal(habit);
    }
}

export function handleUndoDelete() {
    if (state.lastEnded) {
        const habit = state.habits.find(h => h.id === state.lastEnded!.habitId);
        if (habit) {
            delete habit.endedOn;
            state.lastEnded = null;
            if (state.undoTimeout) clearTimeout(state.undoTimeout);
            ui.undoToast.classList.remove('visible');
            debouncedSaveState();
            renderApp();
            setupManageModal();
        }
    }
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);
    showConfirmationModal(t('confirmPermanentDelete', { habitName: name }), () => {
        state.habits = state.habits.filter(h => h.id !== habitId);
        Object.keys(state.dailyData).forEach(date => {
            delete state.dailyData[date][habitId];
        });
        saveState();
        removeHabitFromDOM(habitId);
    });
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        habit.graduatedOn = getTodayUTCIso();
        debouncedSaveState();
        setupManageModal();
        renderHabits();
    }
}

// Helpers for structural change detection
function frequenciesAreEqual(f1: Frequency, f2: Frequency): boolean {
    return f1.type === f2.type && f1.interval === f2.interval;
}
function timesAreEqual(t1: TimeOfDay[], t2: TimeOfDay[]): boolean {
    if (t1.length !== t2.length) return false;
    const sorted1 = [...t1].sort();
    const sorted2 = [...t2].sort();
    return sorted1.every((val, index) => val === sorted2[index]);
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const form = ui.editHabitForm;
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;
    const name = nameInput.value.trim();
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice');

    if (!name) {
        showInlineNotice(noticeEl!, t('noticeNameCannotBeEmpty'));
        return;
    }
    
    const selectedTimes = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="habit-time"]:checked'))
                               .map(cb => cb.value as TimeOfDay);

    if (selectedTimes.length === 0) {
        showInlineNotice(noticeEl!, t('noticeSelectAtLeastOneTime'));
        return;
    }

    const { habitData, isNew } = state.editingHabit;
    const habitIdToExclude = isNew ? null : (habitData as Habit).id;

    if (isDuplicateHabit(name, habitIdToExclude)) {
        showInlineNotice(noticeEl!, t('noticeDuplicateHabitWithName'));
        return;
    }

    if (isNew) {
        const newHabit: Habit = {
            ...(habitData as Omit<Habit, 'id' | 'createdOn' | 'times'>),
            id: crypto.randomUUID(),
            createdOn: state.selectedDate,
            scheduleAnchor: state.selectedDate,
            name,
            subtitle: t('customHabitSubtitle'),
            times: selectedTimes,
            goal: { ...habitData.goal, unit: t(habitData.goal.unitKey || 'unitCheck') }
        };
        state.habits.push(newHabit);
        addHabitToDOM(newHabit);
    } else {
        const habitToUpdate = state.habits.find(h => h.id === (habitData as Habit).id);
        if (habitToUpdate) {
            const newFrequency = habitData.frequency;
            const structuralChange = !timesAreEqual(habitToUpdate.times, selectedTimes) || !frequenciesAreEqual(habitToUpdate.frequency, newFrequency);

            if (structuralChange) {
                const dateObj = parseUTCIsoDate(state.selectedDate);
                const formattedDate = dateObj.toLocaleDateString(state.activeLanguageCode, { weekday: 'long', day: 'numeric', month: 'long' });
                showConfirmationModal(
                    t('confirmScheduleChange', { habitName: `<strong>${name}</strong>`, date: formattedDate }),
                    () => {
                        // End the old habit version
                        habitToUpdate.endedOn = state.selectedDate;

                        // Create the new habit version
                        const newHabitVersion: Habit = {
                            ...habitToUpdate,
                            id: crypto.randomUUID(),
                            createdOn: state.selectedDate,
                            scheduleAnchor: state.selectedDate,
                            name,
                            times: selectedTimes,
                            frequency: newFrequency,
                            previousVersionId: habitToUpdate.id,
                            endedOn: undefined,
                            graduatedOn: undefined, // Graduation doesn't carry over
                        };
                        state.habits.push(newHabitVersion);
                        
                        saveState();
                        renderApp();
                        setupManageModal();
                        closeModal(ui.editHabitModal);
                    }
                );
                return; // Wait for user confirmation
            } else {
                // No structural change, just update name
                habitToUpdate.name = name;
                renderHabits();
                setupManageModal();
            }
        }
    }
    
    debouncedSaveState();
    closeModal(ui.editHabitModal);
    state.editingHabit = null;
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    const noteText = ui.notesTextarea.value.trim();
    const habitInstanceData = ensureHabitInstanceData(date, habitId, time);
    habitInstanceData.note = noteText;
    
    debouncedSaveState();
    updateHabitCardDOM(habitId, time);
    closeModal(ui.notesModal);
    state.editingNoteFor = null;
}

export function handleHabitDrop(habitId: string, originalTime: TimeOfDay, newTime: TimeOfDay) {
    const date = state.selectedDate;
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Ensure daily data containers exist
    state.dailyData[date] ??= {};
    state.dailyData[date][habitId] ??= { instances: {} };
    
    const dailyInfo = state.dailyData[date][habitId];
    
    // Determine the current schedule for the day
    const currentSchedule = dailyInfo.dailySchedule || habit.times;

    if (originalTime === newTime || currentSchedule.includes(newTime)) {
        return; // Invalid drop, do nothing.
    }

    // Create the new schedule for the day
    const newSchedule = currentSchedule.filter(t => t !== originalTime);
    newSchedule.push(newTime);
    // Sort the schedule to maintain a consistent order (Manhã, Tarde, Noite)
    dailyInfo.dailySchedule = newSchedule.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));

    // Move the instance data if it exists
    const instanceData = dailyInfo.instances[originalTime];
    if (instanceData) {
        dailyInfo.instances[newTime] = instanceData;
        delete dailyInfo.instances[originalTime];
    }
    
    debouncedSaveState();
    renderHabits(); // Re-render to show the change
}


export function resetApplicationData() {
    localStorage.removeItem(STATE_STORAGE_KEY);
    state.habits = [];
    state.dailyData = {};
    state.notificationsShown = [];
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    createDefaultHabit();
    renderApp();
}