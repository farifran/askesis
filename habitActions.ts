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
    HabitTemplate,
    HabitSchedule,
    getScheduleForDate,
    PREDEFINED_HABITS,
    getSmartGoalForHabit,
    invalidateStreakCache,
} from './state';
import {
    renderHabits,
    showUndoToast,
    showConfirmationModal,
    closeModal,
    openEditModal,
    setupManageModal,
    showInlineNotice,
    renderCalendar,
} from './render';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { ui } from './ui';
import { renderChart } from './chart';

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

    invalidateStreakCache(originalHabit.id, changeDateISO);
    saveState();
    document.dispatchEvent(new CustomEvent('habitsChanged'));
    renderHabits();
    renderCalendar();
    renderChart();
    setupManageModal();
}

export function addHabit(habitTemplate: HabitTemplate, startDate: string): Habit {
    const isCustom = 'name' in habitTemplate;
    const firstSchedule: HabitSchedule = {
        startDate: startDate,
        scheduleAnchor: startDate,
        name: isCustom ? habitTemplate.name : undefined,
        subtitle: isCustom ? habitTemplate.subtitle : undefined,
        nameKey: !isCustom ? habitTemplate.nameKey : undefined,
        subtitleKey: !isCustom ? habitTemplate.subtitleKey : undefined,
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
    document.dispatchEvent(new CustomEvent('habitsChanged'));
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
    invalidateStreakCache(habitId, state.selectedDate);

    if (newStatus === 'completed') {
        const streak = calculateHabitStreak(habitId, state.selectedDate);
        if (streak === STREAK_SEMI_CONSOLIDATED && !state.notificationsShown.includes(habitId)) {
            state.pending21DayHabitIds.push(habitId);
        } else if (streak === STREAK_CONSOLIDATED && !state.notificationsShown.includes(habitId)) {
            state.pendingConsolidationHabitIds.push(habitId);
        }
    }

    saveState();
    renderHabits();
    renderCalendar();
    renderChart();
}

export function updateGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;

    const sanitizedGoal = Math.max(1, newGoal);
    
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.goalOverride = sanitizedGoal;

    saveState();
    // renderHabits() e renderCalendar() foram removidos para permitir que a animação da UI seja executada.
    // A UI agora é atualizada manualmente no listener de eventos.
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
            
            let wasChanged = false; // Flag to see if this habit was modified at all
            scheduleForDay.forEach(time => {
                const dayInstanceData = ensureHabitInstanceData(date, habit.id, time);
                if (dayInstanceData.status !== status) {
                    dayInstanceData.status = status;
                    wasChanged = true;
                }
            });

            if (wasChanged) {
                changedHabits.add(habit);
            }
        }
    });

    if (changedHabits.size > 0) {
        changedHabits.forEach(habit => invalidateStreakCache(habit.id, date));
        
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
        renderCalendar();
        renderChart();
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
        invalidateStreakCache(habit.id, endDate);
        saveState();
        document.dispatchEvent(new CustomEvent('habitsChanged'));
        renderHabits();
        renderCalendar();
        renderChart();
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
    const timeName = getTimeOfDayName(timeToRemove);
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
                 const endDate = lastSchedule.endDate;
                 delete lastSchedule.endDate;
                 invalidateStreakCache(habit.id, endDate);
            }
            state.lastEnded = null;
            if (state.undoTimeout) clearTimeout(state.undoTimeout);
            ui.undoToast.classList.remove('visible');
            saveState();
            document.dispatchEvent(new CustomEvent('habitsChanged'));
            renderHabits();
            renderCalendar();
            renderChart();
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
        document.dispatchEvent(new CustomEvent('habitsChanged'));
        renderHabits();
        renderChart();
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
        document.dispatchEvent(new CustomEvent('habitsChanged'));
        renderHabits();
        renderCalendar();
        renderChart();
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
    renderHabits(); // A nota pode influenciar a renderização (ex: classe 'has-note')
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
    
    await Promise.all(clearingPromises);
    location.reload();
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    closeModal(ui.manageModal);
    openEditModal(habit, 'manage');
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const form = ui.editHabitForm;
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice');
    const habitName = nameInput.value.trim();

    if (!habitName) {
        if (noticeEl) showInlineNotice(noticeEl, t('noticeNameCannotBeEmpty'));
        nameInput.focus();
        return;
    }

    const { isNew, habitId, originalData, formData } = state.editingHabit;

    const isDuplicate = state.habits.some(h => {
        if (h.id === habitId) return false;
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        if (lastSchedule.endDate || h.graduatedOn) return false;
        const currentDisplayName = getHabitDisplayInfo(h).name;
        return currentDisplayName.toLowerCase() === habitName.toLowerCase();
    });

    if (isDuplicate) {
        if (noticeEl) showInlineNotice(noticeEl, t('noticeDuplicateHabitWithName'));
        nameInput.focus();
        return;
    }
    
    const selectedTimes = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="habit-time"]:checked'))
                               .map(cb => cb.value as TimeOfDay);
    if (selectedTimes.length === 0) {
        if (noticeEl) showInlineNotice(noticeEl, t('errorSelectTime'));
        return;
    }

    const currentFrequency = formData.frequency;

    const finalizeCreation = (template: HabitTemplate, startDate: string) => {
        if ('nameKey' in template) {
            const existingEndedHabit = state.habits.find(h => {
                const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
                return lastSchedule.nameKey === template.nameKey && !!lastSchedule.endDate;
            });

            if (existingEndedHabit) {
                const newSchedule: HabitSchedule = {
                    startDate: startDate,
                    scheduleAnchor: startDate,
                    nameKey: template.nameKey,
                    subtitleKey: template.subtitleKey,
                    times: template.times,
                    frequency: template.frequency,
                };
                existingEndedHabit.scheduleHistory.push(newSchedule);
                
                saveState();
                document.dispatchEvent(new CustomEvent('habitsChanged'));
                renderHabits();
                renderChart();
                setupManageModal();
                closeModal(ui.editHabitModal);
                state.editingHabit = null;
                return;
            }
        }
        
        addHabit(template, startDate);
        renderHabits();
        renderChart();
        setupManageModal();
        closeModal(ui.editHabitModal);
        state.editingHabit = null;
    };

    if (isNew) {
        const todayISO = getTodayUTCIso();
        const prospectiveStartDate = state.selectedDate;

        let newHabitTemplate: HabitTemplate;

        if ('nameKey' in formData) { // Based on a predefined habit template
            const originalName = t(formData.nameKey);
            if (habitName !== originalName) {
                // Name was changed, create as a new custom habit
                newHabitTemplate = {
                    name: habitName,
                    subtitle: t('customHabitSubtitle'),
                    icon: formData.icon,
                    color: formData.color,
                    times: selectedTimes,
                    goal: formData.goal,
                    frequency: currentFrequency,
                };
            } else {
                // Name was NOT changed, create as a predefined habit
                newHabitTemplate = {
                    ...formData,
                    times: selectedTimes,
                    frequency: currentFrequency,
                };
            }
        } else { // This is a fully custom habit from the "create custom" button
            newHabitTemplate = {
                ...formData,
                name: habitName,
                times: selectedTimes,
                frequency: currentFrequency,
            };
        }

        if (parseUTCIsoDate(prospectiveStartDate) < parseUTCIsoDate(todayISO)) {
            const dateFormatted = parseUTCIsoDate(prospectiveStartDate).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
            const habitDisplayName = 'nameKey' in newHabitTemplate ? t(newHabitTemplate.nameKey) : newHabitTemplate.name;
            const confirmationText = t('confirmNewHabitPastDate', { habitName: `<strong>${habitDisplayName}</strong>`, date: `<strong>${dateFormatted}</strong>` });
            showConfirmationModal(confirmationText, () => finalizeCreation(newHabitTemplate, prospectiveStartDate));
        } else {
            finalizeCreation(newHabitTemplate, prospectiveStartDate);
        }
    } else { // Editing
        if (!originalData) return;

        const lastSchedule = originalData.scheduleHistory[originalData.scheduleHistory.length - 1];

        const hasNameChanged = getHabitDisplayInfo(originalData).name !== habitName;
        const hasTimesChanged = lastSchedule.times.length !== selectedTimes.length || !lastSchedule.times.every(t => selectedTimes.includes(t));
        const hasFrequencyChanged = lastSchedule.frequency.type !== currentFrequency.type || lastSchedule.frequency.interval !== currentFrequency.interval;
        
        if (!hasNameChanged && !hasTimesChanged && !hasFrequencyChanged) {
            // Se nada mudou, apenas fecha o modal
            closeModal(ui.editHabitModal);
            state.editingHabit = null;
            return;
        }

        const changeDateISO = state.selectedDate;
        const dateFormatted = parseUTCIsoDate(changeDateISO).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });
        
        const confirmationText = t('confirmScheduleChange', { habitName: `<strong>${habitName}</strong>`, date: dateFormatted });
        
        showConfirmationModal(
            confirmationText,
            () => {
                updateHabitSchedule(originalData, changeDateISO, { name: habitName, times: selectedTimes, frequency: currentFrequency });
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
    const oldTimeName = getTimeOfDayName(oldTime);
    const newTimeName = getTimeOfDayName(newTime);
    
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

        invalidateStreakCache(habitId, state.selectedDate);
        saveState();
        document.dispatchEvent(new CustomEvent('habitsChanged'));
        renderHabits();
        renderChart();
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

export function reorderHabit(draggedId: string, targetId: string, position: 'before' | 'after') {
    const fromIndex = state.habits.findIndex(h => h.id === draggedId);
    let toIndex = state.habits.findIndex(h => h.id === targetId);

    if (fromIndex === -1 || toIndex === -1) return;

    // Remove o item de sua posição original
    const [movedItem] = state.habits.splice(fromIndex, 1);

    // Se o item foi movido de antes do alvo, o índice do alvo terá mudado
    if (fromIndex < toIndex) {
        toIndex--;
    }

    // Calcula o novo ponto de inserção
    const insertAtIndex = position === 'before' ? toIndex : toIndex + 1;
    
    // Insere o item na nova posição
    state.habits.splice(insertAtIndex, 0, movedItem);

    saveState();
    renderHabits();
}