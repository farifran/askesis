/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays, escapeHTML, simpleMarkdownToHTML, getTodayUTC, toUTCIsoDateString } from './utils';
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
    HabitTemplate,
    HabitSchedule,
    getScheduleForDate,
    PREDEFINED_HABITS,
    invalidateStreakCache,
    getEffectiveScheduleForHabitOnDate,
    getHabitDailyInfoForDate,
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
    renderAINotificationState,
    openModal,
} from './render';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { ui } from './ui';
import { renderChart } from './chart';
import { updateAppBadge } from './badge';
import { analyzeHabitData } from './api';

/**
 * Commits the current state to storage and triggers a full UI re-render.
 * This is the centralized function for all state-mutating actions.
 */
function commitStateAndRender() {
    saveState();
    renderHabits();
    renderCalendar();
    renderChart();
    updateAppBadge();
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

/**
 * Atualiza o nome de um hábito em toda a sua história.
 * Esta é uma operação global, diferente das mudanças de agendamento.
 * @param habit O hábito a ser atualizado.
 * @param newName O novo nome para o hábito.
 */
function updateHabitDetails(habit: Habit, newName: string) {
    habit.scheduleHistory.forEach(schedule => {
        // Se era um hábito predefinido, agora se torna personalizado.
        schedule.nameKey = undefined;
        schedule.subtitleKey = undefined;
        schedule.name = newName;
        schedule.subtitle = t('customHabitSubtitle');
    });
}


function updateHabitSchedule(
    originalHabit: Habit,
    changeDateISO: string,
    updates: Partial<Pick<HabitSchedule, 'times' | 'frequency'>>
): void {
    const lastSchedule = originalHabit.scheduleHistory[originalHabit.scheduleHistory.length - 1];

    const newSchedule: HabitSchedule = {
        startDate: changeDateISO,
        scheduleAnchor: changeDateISO,
        name: lastSchedule.name,
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
        }
    });
}

function addHabit(template: HabitTemplate) {
    const newHabit: Habit = {
        id: generateUUID(),
        icon: template.icon,
        color: template.color,
        goal: template.goal,
        createdOn: state.selectedDate,
        scheduleHistory: [{
            startDate: state.selectedDate,
            scheduleAnchor: state.selectedDate,
            times: template.times,
            frequency: template.frequency,
            ...('nameKey' in template && template.nameKey ? { nameKey: template.nameKey, subtitleKey: template.subtitleKey } : { name: template.name, subtitle: template.subtitle })
        }],
    };
    state.habits.push(newHabit);
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const { isNew, habitId, originalData, formData } = state.editingHabit;
    const form = ui.editHabitForm;
    const nameInput = form.elements.namedItem('habit-name') as HTMLInputElement;
    const noticeEl = form.querySelector<HTMLElement>('.duplicate-habit-notice')!;
    const habitName = nameInput.value.trim();

    if (!habitName) {
        showInlineNotice(noticeEl, t('noticeNameCannotBeEmpty'));
        return;
    }

    const selectedTimes = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="habit-time"]:checked')).map(cb => cb.value as TimeOfDay);
    if (selectedTimes.length === 0) {
        showInlineNotice(noticeEl, t('noticeSelectAtLeastOneTime'));
        return;
    }

    formData.times = selectedTimes;

    const isDuplicate = state.habits.some(h => {
        const displayName = getHabitDisplayInfo(h).name;
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        const isActive = !lastSchedule.endDate && !h.graduatedOn;

        if (isNew) {
            return isActive && displayName.toLowerCase() === habitName.toLowerCase();
        } else {
            return isActive && h.id !== habitId && displayName.toLowerCase() === habitName.toLowerCase();
        }
    });

    if (isDuplicate) {
        showInlineNotice(noticeEl, t('noticeDuplicateHabitWithName'));
        return;
    }
    
    if (isNew) {
        const reusableHabit = state.habits.find(h => {
            const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
            const isEnded = !!lastSchedule.endDate || !!h.graduatedOn;
            const displayName = getHabitDisplayInfo(h).name;
            return isEnded && displayName.toLowerCase() === habitName.toLowerCase();
        });

        if (reusableHabit) {
            const newSchedule: HabitSchedule = {
                startDate: state.selectedDate,
                scheduleAnchor: state.selectedDate,
                times: formData.times,
                frequency: formData.frequency,
            };

            if ('nameKey' in formData && formData.nameKey) {
                newSchedule.nameKey = formData.nameKey;
                newSchedule.subtitleKey = formData.subtitleKey;
            } else {
                newSchedule.name = formData.name;
                newSchedule.subtitle = formData.subtitle;
            }
            
            reusableHabit.scheduleHistory.push(newSchedule);
            reusableHabit.icon = formData.icon;
            reusableHabit.color = formData.color;
            reusableHabit.goal = formData.goal;
            reusableHabit.graduatedOn = undefined;

            finishSave();
        } else {
            const isPastDate = parseUTCIsoDate(state.selectedDate) < parseUTCIsoDate(getTodayUTCIso());
            if (isPastDate) {
                showConfirmationModal(
                    t('confirmNewHabitPastDate', { habitName, date: state.selectedDate }),
                    () => {
                        addHabit(formData);
                        finishSave();
                    }
                );
            } else {
                addHabit(formData);
                finishSave();
            }
        }
    } else if (originalData) {
        const latestSchedule = originalData.scheduleHistory[originalData.scheduleHistory.length - 1];
        const nameChanged = getHabitDisplayInfo(originalData).name !== habitName;
        const timesChanged = JSON.stringify(latestSchedule.times.sort()) !== JSON.stringify(formData.times.sort());
        const freqChanged = JSON.stringify(latestSchedule.frequency) !== JSON.stringify(formData.frequency);
        const scheduleChanged = timesChanged || freqChanged;

        if (nameChanged) updateHabitDetails(originalData, habitName);
        if (scheduleChanged) {
            const isTodayOrFuture = parseUTCIsoDate(state.selectedDate) >= parseUTCIsoDate(getTodayUTCIso());
            if (isTodayOrFuture) {
                updateHabitSchedule(originalData, state.selectedDate, { times: formData.times, frequency: formData.frequency });
            } else {
                showConfirmationModal(
                    t('confirmScheduleChange', { habitName, date: state.selectedDate }),
                    () => {
                        updateHabitSchedule(originalData, state.selectedDate, { times: formData.times, frequency: formData.frequency });
                        finishSave();
                    },
                    {
                        title: t('modalEditTitle'),
                        confirmText: t('confirmButton'),
                        cancelText: t('cancelButton')
                    }
                );
                return;
            }
        }
        finishSave();
    }
}

function finishSave() {
    closeModal(ui.editHabitModal);
    state.editingHabit = null;
    commitStateAndRender();
}

export function createDefaultHabit() {
    const waterHabitTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (waterHabitTemplate) {
        addHabit(waterHabitTemplate);
    }
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay) {
    const dayData = ensureHabitInstanceData(state.selectedDate, habitId, time);
    dayData.status = getNextStatus(dayData.status);

    invalidateStreakCache(habitId, state.selectedDate);
    commitStateAndRender();

    const streak = calculateHabitStreak(habitId, state.selectedDate);
    if (streak === STREAK_SEMI_CONSOLIDATED) {
        if (!state.notificationsShown.includes(habitId) && !state.pending21DayHabitIds.includes(habitId)) {
            state.pending21DayHabitIds.push(habitId);
        }
    } else if (streak === STREAK_CONSOLIDATED) {
        if (!state.notificationsShown.includes(habitId) && !state.pendingConsolidationHabitIds.includes(habitId)) {
            state.pendingConsolidationHabitIds.push(habitId);
        }
    }
}

export function updateGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const dayData = ensureHabitInstanceData(date, habitId, time);
    dayData.goalOverride = newGoal;
    commitStateAndRender();
}

function endHabit(habit: Habit, dateISO: string) {
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    lastSchedule.endDate = dateISO;
    state.lastEnded = { habitId: habit.id, lastSchedule };

    invalidateStreakCache(habit.id, dateISO);
    commitStateAndRender();
    showUndoToast();
}

export function handleUndoDelete() {
    if (state.lastEnded) {
        const habit = state.habits.find(h => h.id === state.lastEnded?.habitId);
        if (habit) {
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            if (lastSchedule === state.lastEnded.lastSchedule) {
                delete lastSchedule.endDate;
                invalidateStreakCache(habit.id, lastSchedule.startDate);
            }
        }
        commitStateAndRender();
    }
    
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.remove('visible');
    state.lastEnded = null;
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const date = parseUTCIsoDate(getTodayUTCIso()).toLocaleDateString(state.activeLanguageCode, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

    showConfirmationModal(
        t('confirmEndHabit', { habitName: escapeHTML(name), date }),
        () => {
            endHabit(habit, getTodayUTCIso());
            setupManageModal();
        },
        { title: t('modalEndHabitTitle'), confirmText: t('buttonEndHabit') }
    );
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    showConfirmationModal(
        t('confirmPermanentDelete', { habitName: escapeHTML(name) }),
        () => {
            state.habits = state.habits.filter(h => h.id !== habitId);
            Object.keys(state.dailyData).forEach(date => {
                delete state.dailyData[date][habitId];
            });
            commitStateAndRender();
            setupManageModal();
        },
        { confirmText: t('modalManageResetButton'), title: t('aria_delete_permanent', { habitName: name }) }
    );
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        openEditModal(habit);
    }
}


function moveHabitSchedule(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay, permanent: boolean) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const changeDate = state.selectedDate;
    const changeDateObj = parseUTCIsoDate(changeDate);

    const dataToMove = state.dailyData[changeDate]?.[habitId]?.instances[fromTime];
    
    if (permanent) {
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        lastSchedule.endDate = changeDate;

        const newTimes = lastSchedule.times.filter(t => t !== fromTime);
        if (!newTimes.includes(toTime)) newTimes.push(toTime);

        const newSchedule: HabitSchedule = {
            ...lastSchedule,
            startDate: changeDate,
            scheduleAnchor: changeDate,
            endDate: undefined,
            times: newTimes,
        };
        habit.scheduleHistory.push(newSchedule);

    } else { // Just for today
        const dailyInfo = state.dailyData[changeDate]?.[habitId] ?? { instances: {} };
        const activeSchedule = getScheduleForDate(habit, changeDateObj);
        if (!activeSchedule) return;

        const originalTimes = dailyInfo.dailySchedule || activeSchedule.times;
        const newTimes = originalTimes.filter(t => t !== fromTime);
        if (!newTimes.includes(toTime)) newTimes.push(toTime);

        dailyInfo.dailySchedule = newTimes;
        
        if (!state.dailyData[changeDate]) state.dailyData[changeDate] = {};
        state.dailyData[changeDate][habitId] = dailyInfo;
    }
    
    if (dataToMove) {
        const toInstance = ensureHabitInstanceData(changeDate, habitId, toTime);
        Object.assign(toInstance, dataToMove);
        delete state.dailyData[changeDate][habitId].instances[fromTime];
    }
    commitStateAndRender();
}

export function handleHabitDrop(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const fromTimeName = getTimeOfDayName(fromTime);
    const toTimeName = getTimeOfDayName(toTime);

    showConfirmationModal(
        t('confirmHabitMove', { habitName: name, oldTime: fromTimeName, newTime: toTimeName }),
        () => moveHabitSchedule(habitId, fromTime, toTime, true),
        {
            title: t('modalMoveHabitTitle'),
            onEdit: () => moveHabitSchedule(habitId, fromTime, toTime, false),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
        }
    );
}

export function requestHabitTimeRemoval(habitId: string, timeToRemove: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);
    const date = parseUTCIsoDate(state.selectedDate).toLocaleDateString(state.activeLanguageCode, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    const timeName = getTimeOfDayName(timeToRemove);

    showConfirmationModal(
        t('confirmRemoveTime', { habitName: escapeHTML(name), time: timeName, date }),
        () => { // onConfirm: permanent change
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            const newTimes = lastSchedule.times.filter(t => t !== timeToRemove);

            if (newTimes.length === 0) { // If it's the last time, end the habit
                endHabit(habit, state.selectedDate);
            } else {
                updateHabitSchedule(habit, state.selectedDate, { times: newTimes });
                commitStateAndRender();
            }
        },
        {
            title: t('modalRemoveTimeTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: () => { // onEdit: temporary change
                const dailyInfo = state.dailyData[state.selectedDate]?.[habitId] ?? { instances: {} };
                const activeSchedule = getScheduleForDate(habit, state.selectedDate);
                if (!activeSchedule) return;

                const originalTimes = dailyInfo.dailySchedule || activeSchedule.times;
                const newTimes = originalTimes.filter(t => t !== timeToRemove);
                
                dailyInfo.dailySchedule = newTimes;

                if (!state.dailyData[state.selectedDate]) state.dailyData[state.selectedDate] = {};
                state.dailyData[state.selectedDate][habitId] = dailyInfo;

                delete state.dailyData[state.selectedDate]?.[habitId]?.instances?.[timeToRemove];
                
                commitStateAndRender();
            }
        }
    );
}

export function reorderHabit(draggedId: string, targetId: string, position: 'before' | 'after') {
    const habitIndex = state.habits.findIndex(h => h.id === draggedId);
    const targetIndex = state.habits.findIndex(h => h.id === targetId);
    if (habitIndex === -1 || targetIndex === -1) return;

    const [draggedHabit] = state.habits.splice(habitIndex, 1);
    const newTargetIndex = state.habits.findIndex(h => h.id === targetId);
    const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
    
    state.habits.splice(insertIndex, 0, draggedHabit);
    
    commitStateAndRender();
}

/**
 * Função auxiliar refatorada para atualizar em massa os status dos hábitos para uma data.
 * @param date A data (string ISO) para a qual os hábitos serão atualizados.
 * @param newStatus O novo status a ser aplicado.
 */
function bulkUpdateHabitsForDate(date: string, newStatus: 'completed' | 'snoozed') {
    const dateObj = parseUTCIsoDate(date);
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, dateObj));
    let changed = false;

    activeHabitsOnDate.forEach(habit => {
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, date);
        let habitSpecificChange = false;
        
        scheduleForDay.forEach(time => {
            const dayData = ensureHabitInstanceData(date, habit.id, time);
            let shouldUpdate = false;
            
            if (newStatus === 'completed' && dayData.status === 'pending') {
                shouldUpdate = true;
            } else if (newStatus === 'snoozed' && (dayData.status === 'pending' || dayData.status === 'completed')) {
                shouldUpdate = true;
            }
            
            if (shouldUpdate) {
                dayData.status = newStatus;
                changed = true;
                habitSpecificChange = true;
            }
        });

        if (habitSpecificChange) {
            invalidateStreakCache(habit.id, date);
        }
    });
    
    if (changed) {
        commitStateAndRender();
    }
}

export function completeAllHabitsForDate(date: string) {
    bulkUpdateHabitsForDate(date, 'completed');
}

export function snoozeAllHabitsForDate(date: string) {
    bulkUpdateHabitsForDate(date, 'snoozed');
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    const noteText = ui.notesTextarea.value.trim();
    const dayData = ensureHabitInstanceData(date, habitId, time);
    dayData.note = noteText;
    
    closeModal(ui.notesModal);
    state.editingNoteFor = null;
    commitStateAndRender();
}

export function resetApplicationData() {
    state.habits = [];
    state.dailyData = {};
    state.streaksCache = {};
    state.notificationsShown = [];
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    
    // Re-render the app with default state
    const waterHabitTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (waterHabitTemplate) {
        addHabit(waterHabitTemplate);
    }
    commitStateAndRender();
    closeModal(ui.manageModal);
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    showConfirmationModal(
        t('confirmGraduateHabit', { habitName: getHabitDisplayInfo(habit).name }),
        () => {
            habit.graduatedOn = getTodayUTCIso();
            commitStateAndRender();
            setupManageModal();
        },
        { title: t('modalStatusGraduated'), confirmText: t('aria_graduate', { habitName: '' }) }
    );
}


// --- Lógica de Construção de Prompt (Movida de api.ts) ---

const statusToSymbol: Record<HabitStatus, string> = {
    completed: '✅',
    snoozed: '➡️',
    pending: '⚪️'
};

const timeToKeyMap: Record<TimeOfDay, string> = {
    'Morning': 'filterMorning',
    'Afternoon': 'filterAfternoon',
    'Evening': 'filterEvening'
};

function generateDailyHabitSummary(date: Date): string | null {
    const isoDate = toUTCIsoDateString(date);
    const dailyInfoByHabit = getHabitDailyInfoForDate(isoDate);
    const habitsOnThisDay = state.habits.filter(h => shouldHabitAppearOnDate(h, date) && !h.graduatedOn);

    if (habitsOnThisDay.length === 0) return null;

    const dayEntries = habitsOnThisDay.map(habit => {
        const dailyInfo = dailyInfoByHabit[habit.id];
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, isoDate);
        if (scheduleForDay.length === 0) return '';
        
        const { name } = getHabitDisplayInfo(habit);
        const habitInstances = dailyInfo?.instances || {};

        const statusDetails = scheduleForDay.map(time => {
            const instance = habitInstances[time];
            const status: HabitStatus = instance?.status || 'pending';
            const note = instance?.note;
            
            let detail = statusToSymbol[status];
            if (scheduleForDay.length > 1) {
                detail = `${t(timeToKeyMap[time])}: ${detail}`;
            }

            if ((habit.goal.type === 'pages' || habit.goal.type === 'minutes') && instance?.status === 'completed' && instance.goalOverride !== undefined) {
                const unit = t(habit.goal.unitKey, { count: instance.goalOverride });
                detail += ` ${instance.goalOverride} ${unit}`;
            }

            if (note) {
                detail += ` ("${note}")`;
            }
            return detail;
        });
        
        return `- ${name}: ${statusDetails.join(', ')}`;
    }).filter(Boolean);

    if (dayEntries.length > 0) {
        return `${isoDate}:\n${dayEntries.join('\n')}`;
    }

    return null;
}

function buildAIPrompt(analysisType: 'weekly' | 'monthly' | 'general'): { prompt: string, systemInstruction: string } {
    let history = '';
    let promptTemplateKey = '';
    const daySummaries: string[] = [];
    const today = getTodayUTC();

    if (analysisType === 'weekly' || analysisType === 'monthly') {
        const daysToScan = analysisType === 'weekly' ? 7 : 30;
        promptTemplateKey = analysisType === 'weekly' ? 'aiPromptWeekly' : 'aiPromptMonthly';

        for (let i = 0; i < daysToScan; i++) {
            const date = addDays(today, -i);
            const summary = generateDailyHabitSummary(date);
            if (summary) {
                daySummaries.push(summary);
            }
        }
        history = daySummaries.join('\n\n');

    } else if (analysisType === 'general') {
        promptTemplateKey = 'aiPromptGeneral';
        
        let firstDateEver = today;
        if (state.habits.length > 0) {
            firstDateEver = state.habits.reduce((earliest, habit) => {
                const habitStartDate = parseUTCIsoDate(habit.createdOn);
                return habitStartDate < earliest ? habitStartDate : earliest;
            }, today);
        }
        
        const allSummaries: string[] = [];
        
        for (let d = firstDateEver; d <= today; d = addDays(d, 1)) {
            const summary = generateDailyHabitSummary(d);
            if (summary) {
                allSummaries.push(summary);
            }
        }
        
        const summaryByMonth: Record<string, string[]> = {};
        allSummaries.forEach(daySummary => {
            const dateStr = daySummary.substring(0, 10);
            const month = dateStr.substring(0, 7);
            if (!summaryByMonth[month]) {
                summaryByMonth[month] = [];
            }
            summaryByMonth[month].push(daySummary);
        });

        history = Object.entries(summaryByMonth)
            .map(([month, entries]) => `${t('aiPromptMonthHeader', { month })}:\n${entries.join('\n')}`)
            .join('\n\n');
    }

    if (!history.trim()) {
        history = t('aiPromptNoData');
    }

    const activeHabits = state.habits.filter(h => {
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        return !lastSchedule.endDate && !h.graduatedOn;
    });
    const graduatedHabits = state.habits.filter(h => h.graduatedOn);

    const activeHabitList = activeHabits.map(h => getHabitDisplayInfo(h).name).join(', ') || t('aiPromptNone');
    
    let graduatedHabitsSection = '';
    if (graduatedHabits.length > 0) {
        const graduatedHabitList = graduatedHabits.map(h => getHabitDisplayInfo(h).name).join(', ');
        graduatedHabitsSection = t('aiPromptGraduatedSection', { graduatedHabitList });
    }
    
    const languageName = {
        'pt': 'Português (Brasil)',
        'en': 'English',
        'es': 'Español'
    }[state.activeLanguageCode] || 'Português (Brasil)';

    const systemInstruction = t('aiSystemInstruction', { languageName });
    const prompt = t(promptTemplateKey, {
        activeHabitList,
        graduatedHabitsSection,
        history,
    });
    
    return { prompt, systemInstruction };
};


/**
 * Orquestra todo o processo de análise da IA, desde a UI até a atualização do estado.
 * @param analysisType O tipo de análise a ser realizada.
 */
export async function performAIAnalysis(analysisType: 'weekly' | 'monthly' | 'general') {
    state.aiState = 'loading';
    renderAINotificationState();
    ui.aiResponse.innerHTML = '<div class="spinner"></div>'; // Mostra um spinner
    closeModal(ui.aiOptionsModal);
    openModal(ui.aiModal);

    try {
        const { prompt, systemInstruction } = buildAIPrompt(analysisType);
        
        let fullText = '';
        await analyzeHabitData(prompt, systemInstruction, (chunk) => {
            fullText += chunk;
            ui.aiResponse.innerHTML = simpleMarkdownToHTML(fullText);
        });
        
        state.lastAIResult = fullText;
        state.lastAIError = null;
        state.aiState = 'completed';
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : t('aiErrorUnknown');
        const displayError = `${t('aiErrorPrefix') ? t('aiErrorPrefix') + ': ' : ''}${errorMessage}`;
        ui.aiResponse.innerHTML = `<p class="ai-error-message">${displayError}</p>`;
        state.lastAIResult = null;
        state.lastAIError = errorMessage;
        state.aiState = 'error';
    } finally {
        state.hasSeenAIResult = false;
        renderAINotificationState();
    }
}
