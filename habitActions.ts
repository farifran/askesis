/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays } from './utils';
import {
    state,
    saveState,
    Habit,
    TimeOfDay,
    HabitStatus,
    getNextStatus,
    ensureHabitInstanceData,
    shouldHabitAppearOnDate,
    STREAK_SEMI_CONSOLIDATED,
    STREAK_CONSOLIDATED,
    calculateHabitStreak,
    TIMES_OF_DAY,
    Frequency,
    PredefinedHabit,
    HabitSchedule,
    getScheduleForDate,
    // FIX: Import PREDEFINED_HABITS to be used in createDefaultHabit.
    PREDEFINED_HABITS,
} from './state';
import {
    renderHabits,
    updateHabitCardDOM,
    updateCalendarDayDOM,
    showUndoToast,
    showConfirmationModal,
    closeModal,
    addHabitToDOM,
    openEditModal,
    setupManageModal,
    showInlineNotice,
    renderCalendar,
    removeHabitFromDOM,
} from './render';
import { t, getHabitDisplayInfo } from './i18n';
import { ui } from './ui';

function updateHabitSchedule(
    originalHabit: Habit,
    changeDateISO: string,
    updates: Partial<Pick<HabitSchedule, 'name' | 'times' | 'frequency'>>
): void {
    const lastSchedule = originalHabit.scheduleHistory[originalHabit.scheduleHistory.length - 1];

    const newSchedule: HabitSchedule = {
        startDate: changeDateISO,
        scheduleAnchor: changeDateISO,
        name: updates.name ?? lastSchedule.name,
        subtitle: lastSchedule.subtitle,
        nameKey: lastSchedule.nameKey,
        subtitleKey: lastSchedule.subtitleKey,
        times: updates.times ?? lastSchedule.times,
        frequency: updates.frequency ?? lastSchedule.frequency,
    };
    
    lastSchedule.endDate = changeDateISO;
    originalHabit.scheduleHistory.push(newSchedule);

    const changeDate = parseUTCIsoDate(changeDateISO);
    Object.keys(state.dailyData).forEach(dateStr => {
        const currentDate = parseUTCIsoDate(dateStr);
        if (currentDate >= changeDate && state.dailyData[dateStr][originalHabit.id]) {
            const dataToClean = state.dailyData[dateStr][originalHabit.id]!;
            
            if (updates.times) {
                const newTimesSet = new Set(updates.times);
                for (const time in dataToClean.instances) {
                    if (!newTimesSet.has(time as TimeOfDay)) {
                        delete dataToClean.instances[time as TimeOfDay];
                    }
                }
            }
            if (dataToClean.dailySchedule) {
                delete dataToClean.dailySchedule;
            }
        }
    });

    saveState();
    renderHabits();
    renderCalendar();
    setupManageModal();
}

export function addHabit(habitTemplate: PredefinedHabit | any, startDate: string): Habit {
    const firstSchedule: HabitSchedule = {
        startDate: startDate,
        scheduleAnchor: startDate,
        name: habitTemplate.name,
        subtitle: habitTemplate.subtitle,
        nameKey: habitTemplate.nameKey,
        subtitleKey: habitTemplate.subtitleKey,
        times: habitTemplate.times,
        frequency: habitTemplate.frequency,
    };

    const newHabit: Habit = {
        id: generateUUID(),
        createdOn: startDate,
        icon: habitTemplate.icon,
        color: habitTemplate.color,
        goal: habitTemplate.goal,
        scheduleHistory: [firstSchedule],
    };
    state.habits.push(newHabit);
    saveState();
    return newHabit;
}

export function createDefaultHabit() {
    const waterHabitTemplate = PREDEFINED_HABITS.find(h => h.nameKey === 'predefinedHabitWaterName');
    if (waterHabitTemplate) {
        addHabit(waterHabitTemplate, getTodayUTCIso());
    }
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const dayInstanceData = ensureHabitInstanceData(state.selectedDate, habitId, time);
    const oldStatus = dayInstanceData.status;
    const newStatus = getNextStatus(oldStatus);
    dayInstanceData.status = newStatus;

    if (newStatus === 'completed') {
        const streak = calculateHabitStreak(habitId, state.selectedDate);
        if (streak === STREAK_SEMI_CONSOLIDATED && !state.notificationsShown.includes(habitId)) {
            state.pending21DayHabitIds.push(habitId);
        } else if (streak === STREAK_CONSOLIDATED && !state.notificationsShown.includes(habitId)) {
            state.pendingConsolidationHabitIds.push(habitId);
        }
    }

    saveState();
    updateHabitCardDOM(habitId, time);
    updateCalendarDayDOM(state.selectedDate);
}

const GOAL_STEP = 5;

export function updateGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;

    const sanitizedGoal = Math.max(1, newGoal);
    
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.goalOverride = sanitizedGoal;

    saveState();
    updateHabitCardDOM(habitId, time);
}

export function handleGoalControlClick(habitId: string, time: TimeOfDay, action: 'increment' | 'decrement') {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;
    
    const dayInstanceData = state.dailyData[state.selectedDate]?.[habitId]?.instances[time];
    const currentGoal = dayInstanceData?.goalOverride ?? habit.goal.total ?? 0;
    
    let newGoal;
    if (action === 'increment') {
        newGoal = currentGoal + GOAL_STEP;
    } else {
        newGoal = Math.max(1, currentGoal - GOAL_STEP);
    }

    updateGoalOverride(habitId, state.selectedDate, time, newGoal);
}

function setAllHabitsStatusForDate(date: string, status: HabitStatus) {
    const dateObj = parseUTCIsoDate(date);
    let changedHabits = new Set<Habit>();
    state.habits.forEach(habit => {
        if (shouldHabitAppearOnDate(habit, dateObj)) {
            const habitDailyInfo = state.dailyData[date]?.[habit.id];
            const activeSchedule = getScheduleForDate(habit, dateObj);
            if (!activeSchedule) return;

            const scheduleForDay = habitDailyInfo?.dailySchedule || activeSchedule.times;
            
            scheduleForDay.forEach(time => {
                const dayInstanceData = ensureHabitInstanceData(date, habit.id, time);
                if (dayInstanceData.status !== status) {
                    dayInstanceData.status = status;
                    changedHabits.add(habit);
                }
            });
        }
    });

    if (changedHabits.size > 0) {
        state.streaksCache = {};
        if (status === 'completed') {
            changedHabits.forEach(habit => {
                const streak = calculateHabitStreak(habit.id, date);
                if (streak === STREAK_SEMI_CONSOLIDATED && !state.notificationsShown.includes(habit.id)) {
                    state.pending21DayHabitIds.push(habit.id);
                } else if (streak === STREAK_CONSOLIDATED && !state.notificationsShown.includes(habit.id)) {
                    state.pendingConsolidationHabitIds.push(habit.id);
                }
            });
        }
        
        saveState();
        renderHabits();
        updateCalendarDayDOM(date);
    }
}

export function completeAllHabitsForDate(date: string) {
    setAllHabitsStatusForDate(date, 'completed');
}

export function snoozeAllHabitsForDate(date: string) {
    setAllHabitsStatusForDate(date, 'snoozed');
}

function endHabit(habit: Habit, endDate: string) {
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    if (lastSchedule && !lastSchedule.endDate) {
        lastSchedule.endDate = endDate;
        state.lastEnded = { habitId: habit.id, lastSchedule: JSON.parse(JSON.stringify(lastSchedule)) };
        saveState();
        renderHabits();
        renderCalendar();
        showUndoToast();
        setupManageModal();
    }
}

function requestHabitEnding(habitId: string, date: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const dateFormatted = parseUTCIsoDate(date).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const confirmationText = t('confirmEndHabit', { 
        habitName: `<strong>${name}</strong>`,
        date: `<strong>${dateFormatted}</strong>`
    });

    showConfirmationModal(confirmationText, () => endHabit(habit, date), {
        onEdit: () => openEditModal(habit),
        title: t('modalEndHabitTitle'),
        confirmText: t('buttonEndHabit'),
        editText: t('buttonEditHabit'),
    });
}

export function requestHabitTimeRemoval(habitId: string, timeToRemove: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    if (lastSchedule.times.length <= 1) {
        requestHabitEnding(habitId, state.selectedDate);
        return;
    }

    const { name } = getHabitDisplayInfo(habit);
    const timeName = t(`filter${timeToRemove}`);
    const dateFormatted = parseUTCIsoDate(state.selectedDate).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });

    const confirmationText = t('confirmRemoveTime', {
        habitName: `<strong>${name}</strong>`,
        time: `<strong>${timeName}</strong>`,
        date: dateFormatted,
    });

    showConfirmationModal(
        confirmationText,
        () => {
            const newTimes = lastSchedule.times.filter(t => t !== timeToRemove);
            updateHabitSchedule(habit, state.selectedDate, { times: newTimes });
        },
        {
            onEdit: () => openEditModal(habit),
            title: t('modalRemoveTimeTitle'),
            confirmText: t('buttonRemoveTime'),
            editText: t('buttonEditHabit'),
        }
    );
}


export function handleUndoDelete() {
    if (state.lastEnded) {
        const habit = state.habits.find(h => h.id === state.lastEnded!.habitId);
        if (habit) {
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            // Only undo if the last schedule matches the one we stored
            if (lastSchedule.endDate === state.lastEnded.lastSchedule.endDate) {
                 delete lastSchedule.endDate;
            }
            state.lastEnded = null;
            if (state.undoTimeout) clearTimeout(state.undoTimeout);
            ui.undoToast.classList.remove('visible');
            saveState();
            renderHabits();
            renderCalendar();
            setupManageModal();
        }
    }
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);
    const dateFormatted = parseUTCIsoDate(getTodayUTCIso()).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const confirmationText = t('confirmEndHabit', { 
        habitName: `<strong>${name}</strong>`,
        date: `<strong>${dateFormatted}</strong>` 
    });
    showConfirmationModal(confirmationText, () => endHabit(habit, getTodayUTCIso()));
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const confirmationText = t('confirmPermanentDelete', { habitName: `<strong>${name}</strong>` });

    showConfirmationModal(confirmationText, () => {
        state.habits = state.habits.filter(h => h.id !== habitId);
        Object.keys(state.dailyData).forEach(date => {
            if (state.dailyData[date][habitId]) {
                delete state.dailyData[date][habitId];
            }
        });

        saveState();
        removeHabitFromDOM(habitId);
        setupManageModal();
    });
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);
    const confirmationText = t('confirmGraduateHabit', { habitName: `<strong>${name}</strong>` });

    showConfirmationModal(confirmationText, () => {
        habit.graduatedOn = getTodayUTCIso();
        saveState();
        renderHabits();
        renderCalendar();
        setupManageModal();
    });
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;

    const { habitId, date, time } = state.editingNoteFor;
    const noteText = ui.notesTextarea.value;
    
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.note = noteText.trim();
    
    saveState();
    updateHabitCardDOM(habitId, time);
    closeModal(ui.notesModal);
    state.editingNoteFor = null;
}

function clearAllCookies() {
    const cookies = document.cookie.split(";");
    for (const cookie of cookies) {
        const eqPos = cookie.indexOf("=");
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
        document.cookie = `${name.trim()}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }
}

export async function resetApplicationData() {
    localStorage.clear();
    sessionStorage.clear();
    clearAllCookies();

    const clearingPromises = [];
    if ('caches' in window) {
        clearingPromises.push(caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))));
    }
    if ('indexedDB' in window && (window.indexedDB as any).databases) {
        clearingPromises.push((window.indexedDB as any).databases().then((databases: IDBDatabaseInfo[]) =>
            Promise.all(databases.map(db => db.name ? window.indexedDB.deleteDatabase(db.name) : Promise.resolve()))
        ));
    }
    if ('serviceWorker' in navigator) {
        clearingPromises.push(navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(reg => reg.unregister()))));
    }
    await Promise.all(clearingPromises);
    location.reload();
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    closeModal(ui.manageModal);
    openEditModal(habit);
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const form = ui.editHabitForm;
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice');
    const habitName = nameInput.value.trim();

    if (!habitName && !nameInput.readOnly) {
        nameInput.focus();
        return;
    }

    const { isNew, habitId, originalData, formData } = state.editingHabit;

    if (!nameInput.readOnly) {
        const isDuplicate = state.habits.some(h => {
            if (h.id === habitId) return false;
            const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
            if (lastSchedule.endDate || h.graduatedOn) return false;
            if (!lastSchedule.nameKey && lastSchedule.name) {
                return lastSchedule.name.toLowerCase() === habitName.toLowerCase();
            }
            return false;
        });
        if (isDuplicate) {
            if (noticeEl) showInlineNotice(noticeEl, t('noticeDuplicateHabitWithName'));
            nameInput.focus();
            return;
        }
    }
    
    const selectedTimes = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="habit-time"]:checked'))
                               .map(cb => cb.value as TimeOfDay);
    if (selectedTimes.length === 0) {
        if (noticeEl) showInlineNotice(noticeEl, t('errorSelectTime'));
        return;
    }

    const currentFrequency = formData.frequency;

    const finalizeCreation = (template: any, startDate: string) => {
        const newHabit = addHabit(template, startDate);
        addHabitToDOM(newHabit);
        closeModal(ui.editHabitModal);
        state.editingHabit = null;
    };

    if (isNew) {
        const todayISO = getTodayUTCIso();
        const prospectiveStartDate = state.selectedDate;

        // FIX: Cast to `any` to handle the union type of `formData` which can be a `PredefinedHabit` (with nameKey)
        // or a custom habit object (with name). This resolves subsequent TypeScript errors.
        const newHabitTemplate: any = { ...formData };
        if (!newHabitTemplate.nameKey) {
            newHabitTemplate.name = habitName;
        }
        newHabitTemplate.times = selectedTimes;
        newHabitTemplate.frequency = currentFrequency;

        if (parseUTCIsoDate(prospectiveStartDate) < parseUTCIsoDate(todayISO)) {
            const dateFormatted = parseUTCIsoDate(prospectiveStartDate).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
            const habitDisplayName = newHabitTemplate.nameKey ? t(newHabitTemplate.nameKey) : newHabitTemplate.name;
            const confirmationText = t('confirmNewHabitPastDate', { habitName: `<strong>${habitDisplayName}</strong>`, date: `<strong>${dateFormatted}</strong>` });
            showConfirmationModal(confirmationText, () => finalizeCreation(newHabitTemplate, prospectiveStartDate));
        } else {
            finalizeCreation(newHabitTemplate, prospectiveStartDate);
        }
    } else { // Editing
        if (!originalData) return;
        const lastSchedule = originalData.scheduleHistory[originalData.scheduleHistory.length - 1];

        const hasNameChanged = !lastSchedule.nameKey && getHabitDisplayInfo(originalData).name !== habitName;
        const hasTimesChanged = lastSchedule.times.length !== selectedTimes.length || !lastSchedule.times.every(t => selectedTimes.includes(t));
        const hasFrequencyChanged = lastSchedule.frequency.type !== currentFrequency.type || lastSchedule.frequency.interval !== currentFrequency.interval;
        
        if (!hasNameChanged && !hasTimesChanged && !hasFrequencyChanged) {
            closeModal(ui.editHabitModal);
            state.editingHabit = null;
            return;
        }

        const changeDateISO = state.selectedDate;
        const dateFormatted = parseUTCIsoDate(changeDateISO).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });
        const confirmHabitName = hasNameChanged ? habitName : getHabitDisplayInfo(originalData).name;
        const confirmationText = t('confirmScheduleChange', { habitName: `<strong>${confirmHabitName}</strong>`, date: dateFormatted });
        
        showConfirmationModal(
            confirmationText,
            () => {
                const newName = hasNameChanged ? habitName : lastSchedule.name;
                updateHabitSchedule(originalData, changeDateISO, { name: newName, times: selectedTimes, frequency: currentFrequency });
                closeModal(ui.editHabitModal);
                state.editingHabit = null;
            },
            { onEdit: () => closeModal(ui.confirmModal) }
        );
    }
}

export function handleHabitDrop(habitId: string, oldTime: TimeOfDay, newTime: TimeOfDay) {
    if (oldTime === newTime) return;

    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const oldTimeName = t(`filter${oldTime}`);
    const newTimeName = t(`filter${newTime}`);
    
    const confirmationText = t('confirmHabitMove', {
        habitName: `<strong>${name}</strong>`,
        oldTime: `<strong>${oldTimeName}</strong>`,
        newTime: `<strong>${newTimeName}</strong>`,
    });

    const onConfirmForToday = () => {
        const activeSchedule = getScheduleForDate(habit, state.selectedDate);
        if (!activeSchedule) return;

        const dailyInfo = state.dailyData[state.selectedDate]?.[habitId];
        const scheduleForDay = dailyInfo?.dailySchedule || activeSchedule.times;

        state.dailyData[state.selectedDate] ??= {};
        state.dailyData[state.selectedDate][habitId] ??= { instances: {} };

        const newSchedule = scheduleForDay.map(t => t === oldTime ? newTime : t);
        state.dailyData[state.selectedDate][habitId].dailySchedule = newSchedule;
        
        const instanceData = state.dailyData[state.selectedDate][habitId].instances[oldTime];
        if (instanceData) {
            state.dailyData[state.selectedDate][habitId].instances[newTime] = instanceData;
            delete state.dailyData[state.selectedDate][habitId].instances[oldTime];
        }

        saveState();
        renderHabits();
    };

    const onConfirmFromNowOn = () => {
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        const changeDateISO = state.selectedDate;
        const oldTimes = lastSchedule.times;
        const newTimes = oldTimes.map(t => t === oldTime ? newTime : t).sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
        updateHabitSchedule(habit, changeDateISO, { times: newTimes });
    };

    showConfirmationModal(confirmationText, onConfirmFromNowOn, {
        title: t('modalMoveHabitTitle'),
        onEdit: onConfirmForToday,
        confirmText: t('buttonFromNowOn'),
        editText: t('buttonJustToday'),
    });
}
