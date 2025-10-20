/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import {
    state,
    saveState,
    Habit,
    PREDEFINED_HABITS,
    getTodayUTCIso,
    TimeOfDay,
    HabitStatus,
    getNextStatus,
    ensureHabitInstanceData,
    shouldHabitAppearOnDate,
    STREAK_SEMI_CONSOLIDATED,
    STREAK_CONSOLIDATED,
    calculateHabitStreak,
    parseUTCIsoDate,
    STATE_STORAGE_KEY,
    TIMES_OF_DAY,
    addDays,
    Frequency
} from './state';
import {
    renderHabits,
    updateHabitCardDOM,
    updateCalendarDayDOM,
    showUndoToast,
    showConfirmationModal,
    closeModal,
    addHabitToDOM,
    removeHabitFromDOM,
    openEditModal,
    setupManageModal,
    showInlineNotice,
    // FIX: Imported `renderApp` to resolve a reference error.
    renderApp,
} from './render';
import { t, getHabitDisplayInfo } from './i18n';
import { ui } from './ui';

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Creates a new version of a habit when its schedule or name changes,
 * preserving the history of the original habit.
 * @param originalHabit The habit to be versioned.
 * @param changeDateISO The date (YYYY-MM-DD) from which the new version is active.
 * @param updates An object containing the new name, times, and/or frequency.
 */
function applyHabitVersioning(
    originalHabit: Habit,
    changeDateISO: string,
    updates: { name?: string, times: TimeOfDay[], frequency: Frequency }
): void {
    const changeDate = parseUTCIsoDate(changeDateISO);

    // 1. End the original habit's active period on the day of the change.
    originalHabit.endedOn = changeDateISO;

    // 2. Create the new habit version with updated properties.
    const newHabit: Habit = {
        id: generateUUID(),
        createdOn: changeDateISO,
        scheduleAnchor: changeDateISO,
        name: updates.name ?? originalHabit.name,
        nameKey: originalHabit.nameKey,
        subtitle: originalHabit.subtitle,
        subtitleKey: originalHabit.subtitleKey,
        icon: originalHabit.icon,
        color: originalHabit.color,
        goal: originalHabit.goal,
        times: updates.times,
        frequency: updates.frequency,
        previousVersionId: originalHabit.id,
        history: [...(originalHabit.history || []), { startDate: originalHabit.createdOn, endDate: changeDateISO }],
    };
    state.habits.push(newHabit);
    
    // 3. Migrate daily data from the change date onwards to prevent data loss.
    Object.keys(state.dailyData).forEach(dateStr => {
        const currentDate = parseUTCIsoDate(dateStr);
        if (currentDate >= changeDate && state.dailyData[dateStr][originalHabit.id]) {
            const dataToMove = state.dailyData[dateStr][originalHabit.id]!;
            
            // Clean up instances whose time slots are no longer in the new schedule.
            const newTimesSet = new Set(updates.times);
            for (const time in dataToMove.instances) {
                if (!newTimesSet.has(time as TimeOfDay)) {
                    delete dataToMove.instances[time as TimeOfDay];
                }
            }
            
            // A daily schedule override (from drag-and-drop) is based on the old schedule.
            // It's safer to remove it, letting the habit use its new default schedule.
            if (dataToMove.dailySchedule) {
                delete dataToMove.dailySchedule;
            }

            // Move the cleaned data to the new habit's ID.
            state.dailyData[dateStr][newHabit.id] = dataToMove;
            delete state.dailyData[dateStr][originalHabit.id];
        }
    });
    
    // 4. Save state and re-render the application to reflect the changes.
    saveState();
    renderApp();
    setupManageModal();
}

export function addHabit(habitTemplate: Omit<Habit, 'id' | 'createdOn'>, startDate: string): Habit {
    const newHabit: Habit = {
        id: generateUUID(),
        createdOn: startDate,
        ...habitTemplate,
        scheduleAnchor: startDate, // Anchor new habits to their creation date
    };
    state.habits.push(newHabit);
    saveState();
    return newHabit;
}

export function createDefaultHabit() {
    // Add the "Drink Water" habit by default
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

    // Check for streak milestones only when completing a habit
    if (newStatus === 'completed') {
        // We calculate the streak for the *current* day, as if it were completed.
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

    // Ensure the new goal is a positive number.
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
        newGoal = Math.max(1, currentGoal - GOAL_STEP); // Cannot go below 1
    }

    updateGoalOverride(habitId, state.selectedDate, time, newGoal);
}

function setAllHabitsStatusForDate(date: string, status: HabitStatus) {
    const dateObj = parseUTCIsoDate(date);
    let changedHabits = new Set<Habit>();
    state.habits.forEach(habit => {
        if (shouldHabitAppearOnDate(habit, dateObj)) {
            const habitDailyInfo = state.dailyData[date]?.[habit.id];
            const scheduleForDay = habitDailyInfo?.dailySchedule || habit.times;
            
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
        // Invalida o cache de sequências, pois as ações em massa o afetam.
        state.streaksCache = {};
        
        // Dispara verificações de consolidação apenas para os hábitos que foram alterados para 'completed'
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
        renderHabits(); // Re-render all habits for the day
        updateCalendarDayDOM(date);
    }
}

export function completeAllHabitsForDate(date: string) {
    setAllHabitsStatusForDate(date, 'completed');
}

export function snoozeAllHabitsForDate(date: string) {
    setAllHabitsStatusForDate(date, 'snoozed');
}

function endHabit(habitId: string, endDate: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        habit.endedOn = endDate;
        state.lastEnded = { habitId: habitId };
        saveState();
        renderApp(); // Re-render the full app view, including calendar
        showUndoToast();
        setupManageModal(); // Update list in manage modal
    }
}

function requestHabitEnding(habitId: string, date: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const dateFormatted = parseUTCIsoDate(date).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long' });
    const confirmationText = t('confirmEndHabit', { 
        habitName: `<strong>${name}</strong>`,
        date: `<strong>${dateFormatted}</strong>`
    });

    showConfirmationModal(confirmationText, () => endHabit(habitId, date), {
        onEdit: () => {
            openEditModal(habit);
        },
        title: t('modalEndHabitTitle'),
        confirmText: t('buttonEndHabit'),
        editText: t('buttonEditHabit'),
    });
}

export function requestHabitTimeRemoval(habitId: string, timeToRemove: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Caso especial: se este for o último horário do hábito,
    // removê-lo é equivalente a encerrar o hábito por completo.
    if (habit.times.length <= 1) {
        requestHabitEnding(habitId, state.selectedDate);
        return;
    }

    // Caso principal: o hábito tem outros horários, então apenas editamos o agendamento.
    const { name } = getHabitDisplayInfo(habit);
    const timeName = t(`filter${timeToRemove}`);
    const dateFormatted = parseUTCIsoDate(state.selectedDate).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long' });

    const confirmationText = t('confirmRemoveTime', {
        habitName: `<strong>${name}</strong>`,
        time: `<strong>${timeName}</strong>`,
        date: dateFormatted,
    });

    showConfirmationModal(
        confirmationText,
        () => {
            const newTimes = habit.times.filter(t => t !== timeToRemove);
            applyHabitVersioning(habit, state.selectedDate, {
                times: newTimes,
                frequency: habit.frequency,
                name: habit.name, // Preserva o nome original se for personalizado
            });
        },
        {
            onEdit: () => {
                openEditModal(habit);
            },
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
            habit.endedOn = undefined;
            state.lastEnded = null;
            if (state.undoTimeout) clearTimeout(state.undoTimeout);
            ui.undoToast.classList.remove('visible');
            saveState();
            renderApp(); // Re-render the full app view
            setupManageModal(); // Update list in manage modal
        }
    }
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);
    const dateFormatted = parseUTCIsoDate(getTodayUTCIso()).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long' });
    const confirmationText = t('confirmEndHabit', { 
        habitName: `<strong>${name}</strong>`,
        date: `<strong>${dateFormatted}</strong>` 
    });
    showConfirmationModal(confirmationText, () => {
        endHabit(habitId, getTodayUTCIso()); // Encerrar a partir do modal sempre encerra 'hoje'
    });
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const confirmationText = t('confirmPermanentDelete', { habitName: `<strong>${name}</strong>` });

    showConfirmationModal(confirmationText, () => {
        const habitNameToDelete = getHabitDisplayInfo(habit).name;
        const idsToDelete = new Set<string>();
        
        // Encontra todos os hábitos (todas as versões) com o mesmo nome para garantir a exclusão completa da linhagem.
        state.habits.forEach(h => {
            if (getHabitDisplayInfo(h).name === habitNameToDelete) {
                idsToDelete.add(h.id);
            }
        });

        // Filtra a lista de hábitos para remover os selecionados.
        state.habits = state.habits.filter(h => !idsToDelete.has(h.id));

        // Remove os dados diários associados a esses hábitos.
        Object.keys(state.dailyData).forEach(date => {
            idsToDelete.forEach(id => {
                if (state.dailyData[date][id]) {
                    delete state.dailyData[date][id];
                }
            });
        });

        saveState();
        renderApp(); // Re-render the main app view
        setupManageModal(); // Re-render the list in the manage modal.
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
        renderApp(); // Re-render the full app view
        setupManageModal(); // Update its state in manage modal
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

export function resetApplicationData() {
    // This function will delete all habits and their associated progress data.
    state.habits = [];
    state.dailyData = {};
    state.streaksCache = {};
    state.lastEnded = null;
    if (state.undoTimeout) {
        clearTimeout(state.undoTimeout);
    }
    state.undoTimeout = null;
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    state.notificationsShown = [];
    
    // Save the now-empty state. This will overwrite the existing state in localStorage.
    saveState(); 
    
    // Re-render the entire application to reflect the empty state.
    renderApp(); 
    
    // Also update the list within the manage modal (which is now closed, but will be correct next time it's opened).
    setupManageModal(); 
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

    const { isNew, habitData } = state.editingHabit;

    if (!nameInput.readOnly) {
        const habitIdBeingEdited = isNew ? null : (habitData as Habit).id;
        const isDuplicate = state.habits.some(h => {
            if (h.id === habitIdBeingEdited || h.endedOn || h.graduatedOn) {
                return false;
            }
            if (!h.nameKey && h.name) {
                return h.name.toLowerCase() === habitName.toLowerCase();
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

    const finalizeCreation = (template: Omit<Habit, 'id'|'createdOn'>, startDate: string) => {
        const newHabit = addHabit(template, startDate);
        addHabitToDOM(newHabit);
        closeModal(ui.editHabitModal);
        state.editingHabit = null;
    };

    if (isNew) {
        const todayISO = getTodayUTCIso();
        const prospectiveStartDate = state.selectedDate;

        const newHabitTemplate = { ...habitData };
        if (!habitData.nameKey) { // It's a custom habit
            newHabitTemplate.name = habitName;
        }
        newHabitTemplate.times = selectedTimes;
        newHabitTemplate.frequency = habitData.frequency;

        if (parseUTCIsoDate(prospectiveStartDate) < parseUTCIsoDate(todayISO)) {
            const dateFormatted = parseUTCIsoDate(prospectiveStartDate).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', year: 'numeric' });
            const habitDisplayName = newHabitTemplate.nameKey ? t(newHabitTemplate.nameKey) : newHabitTemplate.name;
            const confirmationText = t('confirmNewHabitPastDate', { habitName: `<strong>${habitDisplayName}</strong>`, date: `<strong>${dateFormatted}</strong>` });
            showConfirmationModal(confirmationText, () => finalizeCreation(newHabitTemplate, prospectiveStartDate));
        } else {
            finalizeCreation(newHabitTemplate, prospectiveStartDate);
        }

    } else {
        // Editing an existing habit
        const originalHabit = state.habits.find(h => h.id === (habitData as Habit).id);
        if (!originalHabit) return;

        const hasNameChanged = !originalHabit.nameKey && originalHabit.name !== habitName;
        const hasTimesChanged = originalHabit.times.length !== selectedTimes.length || !originalHabit.times.every(t => selectedTimes.includes(t));
        const hasFrequencyChanged = originalHabit.frequency.type !== habitData.frequency.type || originalHabit.frequency.interval !== habitData.frequency.interval;
        const hasScheduleChanged = hasTimesChanged || hasFrequencyChanged;

        if (!hasScheduleChanged && !hasNameChanged) {
            closeModal(ui.editHabitModal);
            state.editingHabit = null;
            return;
        }

        if (!hasScheduleChanged) { // Only name changed, no versioning needed
            originalHabit.name = habitName;
            saveState();
            renderHabits();
            setupManageModal();
            closeModal(ui.editHabitModal);
            state.editingHabit = null;
            return;
        }
        
        // Schedule has changed, requires versioning
        const changeDateISO = state.selectedDate;
        const dateFormatted = parseUTCIsoDate(changeDateISO).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long' });
        const confirmHabitName = hasNameChanged ? habitName : getHabitDisplayInfo(originalHabit).name;
        const confirmationText = t('confirmScheduleChange', { habitName: `<strong>${confirmHabitName}</strong>`, date: dateFormatted });
        
        showConfirmationModal(
            confirmationText,
            () => {
                applyHabitVersioning(originalHabit, changeDateISO, {
                    name: hasNameChanged ? habitName : originalHabit.name,
                    times: selectedTimes,
                    frequency: habitData.frequency,
                });
                closeModal(ui.editHabitModal);
                state.editingHabit = null;
            },
            {
                onEdit: () => {
                    // onEdit callback: just close the confirm modal, leaving the edit modal open
                    closeModal(ui.confirmModal);
                },
            }
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
        // This is the logic for a single-day override.
        // The validation that this is not a duplicate time is now handled in the drag-and-drop handler
        // before this function is ever called.
        const dailyInfo = state.dailyData[state.selectedDate]?.[habitId];
        const scheduleForDay = dailyInfo?.dailySchedule || habit.times;

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
        // This is the versioning logic
        const changeDateISO = state.selectedDate;
        const oldTimes = habit.times;
        const newTimes = oldTimes.map(t => t === oldTime ? newTime : t).sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));

        applyHabitVersioning(habit, changeDateISO, {
            times: newTimes,
            frequency: habit.frequency,
            name: habit.name
        });
    };

    showConfirmationModal(confirmationText, onConfirmFromNowOn, {
        title: t('modalMoveHabitTitle'),
        onEdit: onConfirmForToday,
        confirmText: t('buttonFromNowOn'),
        editText: t('buttonJustToday'),
    });
}