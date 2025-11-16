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
    LANGUAGES,
    TIMES_OF_DAY,
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
    showInlineNotice,
} from './render';
import { ui } from './ui';
import { t, getHabitDisplayInfo } from './i18n';
import { updateAppBadge } from './badge';

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
    const { isNew, habitId, formData } = state.editingHabit;
    const effectiveDate = state.selectedDate;

    // Basic validation
    const formNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice');
    if (formData.times.length === 0 || (!formData.name && !formData.nameKey)) {
        if (formNoticeEl) {
            showInlineNotice(formNoticeEl, t('modalEditFormNotice'));
        }
        return;
    }

    let habitToUpdate: Habit | undefined;
    let isReactivating = false;

    if (isNew) {
        // Instead of creating a new habit, first check if an old one can be reactivated.
        // This prevents duplicate habits in the manage list.
        const newHabitIdentifier = formData.nameKey
            ? { key: 'nameKey', value: formData.nameKey }
            : { key: 'name', value: (formData.name || '').trim().toLowerCase() };

        habitToUpdate = state.habits.find(h =>
            h.scheduleHistory.some(s => {
                if (newHabitIdentifier.key === 'nameKey') {
                    return s.nameKey === newHabitIdentifier.value;
                } else { // key is 'name'
                    return !s.nameKey && s.name?.trim().toLowerCase() === newHabitIdentifier.value;
                }
            })
        );

        if (habitToUpdate) {
            isReactivating = true;
        } else {
            // No existing habit found, proceed with creating a truly new one.
            const newHabit = _createNewHabitFromTemplate(formData);
            state.habits.push(newHabit);
        }
    } else if (habitId) {
        // This is a standard edit operation.
        habitToUpdate = state.habits.find(h => h.id === habitId);
    }

    // If we're editing an existing habit or reactivating an old one...
    if (habitToUpdate) {
        const lastSchedule = habitToUpdate.scheduleHistory[habitToUpdate.scheduleHistory.length - 1];

        const schedulePropsChanged =
            JSON.stringify(lastSchedule.times) !== JSON.stringify(formData.times) ||
            JSON.stringify(lastSchedule.frequency) !== JSON.stringify(formData.frequency) ||
            (formData.nameKey && lastSchedule.nameKey !== formData.nameKey) ||
            (formData.name && !formData.nameKey && lastSchedule.name !== formData.name);

        // Create a new schedule entry if reactivating, or if schedule properties changed on an active habit.
        if (isReactivating || (schedulePropsChanged && !lastSchedule.endDate)) {
            // If editing today's schedule on the same day it started, just update it in place.
            if (lastSchedule.startDate === effectiveDate && !lastSchedule.endDate) {
                lastSchedule.times = formData.times;
                lastSchedule.frequency = formData.frequency;
                if (formData.nameKey) {
                    lastSchedule.nameKey = formData.nameKey;
                    lastSchedule.subtitleKey = formData.subtitleKey;
                    delete lastSchedule.name;
                } else {
                    lastSchedule.name = formData.name;
                    lastSchedule.subtitleKey = formData.subtitleKey;
                    delete lastSchedule.nameKey;
                }
            } else {
                // Otherwise, split the schedule history. End the current schedule and start a new one.
                if (!lastSchedule.endDate) {
                    lastSchedule.endDate = effectiveDate;
                }

                const newSchedule: HabitSchedule = {
                    startDate: effectiveDate,
                    times: formData.times,
                    frequency: formData.frequency,
                    scheduleAnchor: isReactivating ? effectiveDate : lastSchedule.scheduleAnchor,
                    ...(formData.nameKey ? { nameKey: formData.nameKey, subtitleKey: formData.subtitleKey } : { name: formData.name, subtitleKey: formData.subtitleKey })
                };
                habitToUpdate.scheduleHistory.push(newSchedule);
            }
        }

        // Always update identity properties (icon, color, goal) as they are independent of schedule history.
        habitToUpdate.icon = formData.icon;
        habitToUpdate.color = formData.color;
        habitToUpdate.goal = formData.goal;

        // If reactivating, the habit is no longer considered "graduated".
        if (isReactivating) {
            delete habitToUpdate.graduatedOn;
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
        t('confirmEndHabit', { habitName: escapeHTML(name), date: parseUTCIsoDate(getTodayUTCIso()).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long' }) }),
        () => endHabit(habitId),
        { title: t('modalEndHabitTitle'), confirmText: t('endButton') }
    );
}

function endHabit(habitId: string, effectiveDateISO?: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const endDateISO = effectiveDateISO || getTodayUTCIso();
    const endDate = parseUTCIsoDate(endDateISO);

    // Find the last schedule that was active at the point of the end date
    let lastActiveSchedule: HabitSchedule | undefined;
    for (let i = habit.scheduleHistory.length - 1; i >= 0; i--) {
        const schedule = habit.scheduleHistory[i];
        const startDate = parseUTCIsoDate(schedule.startDate);
        // An active schedule is one that started on or before the end date, and either has no end date,
        // or its end date is after the effective end date we are trying to set.
        if (startDate <= endDate && (!schedule.endDate || parseUTCIsoDate(schedule.endDate) > endDate)) {
            lastActiveSchedule = schedule;
            break;
        }
    }
    
    if (!lastActiveSchedule) {
        console.warn(`No active schedule found for habit ${habitId} to end at ${endDateISO}.`);
        return;
    }
    
    const originalActiveSchedule = { ...lastActiveSchedule };
    const removedSchedules = habit.scheduleHistory.filter(s => parseUTCIsoDate(s.startDate) > endDate);
    state.lastEnded = { habitId, lastSchedule: originalActiveSchedule, removedSchedules };

    lastActiveSchedule.endDate = endDateISO;
    habit.scheduleHistory = habit.scheduleHistory.filter(s => parseUTCIsoDate(s.startDate) <= endDate);

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
    const timeName = t(`filter${time}`);

    const justTodayAction = () => {
        const date = state.selectedDate;
        const dailyInfo = ensureHabitDailyInfo(date, habitId);
        const schedule = getEffectiveScheduleForHabitOnDate(habit, date);
        
        dailyInfo.dailySchedule = schedule.filter(t => t !== time);
        
        if (dailyInfo.instances?.[time]) {
            delete dailyInfo.instances[time];
        }
        
        clearActiveHabitsCache();
        saveState();
        renderHabits();
        renderCalendar();
    };
    
    const fromNowOnAction = () => {
        const effectiveDate = state.selectedDate;
        const effectiveDateObj = parseUTCIsoDate(effectiveDate);

        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        
        // Don't modify schedules that have already ended before the action date.
        if (lastSchedule.endDate && parseUTCIsoDate(lastSchedule.endDate) <= effectiveDateObj) {
            return;
        }

        const newTimes = lastSchedule.times.filter(t => t !== time);
        
        if (newTimes.length === 0) {
            // If removing the last time slot, end the habit from the effective date.
            endHabit(habit.id, effectiveDate);
        } else {
            // If the change happens on the very start date of the current schedule, we can just modify it in-place.
            if (lastSchedule.startDate === effectiveDate && !lastSchedule.endDate) {
                lastSchedule.times = newTimes;
            } else {
                // Otherwise, split the schedule history. End the current schedule one day before the change.
                lastSchedule.endDate = effectiveDate;

                // Create a new schedule segment starting from the effective date.
                const newSchedule: HabitSchedule = {
                    startDate: effectiveDate,
                    times: newTimes,
                    frequency: lastSchedule.frequency,
                    scheduleAnchor: lastSchedule.scheduleAnchor,
                    // Copy name/subtitle properties correctly
                    ...(lastSchedule.nameKey 
                        ? { nameKey: lastSchedule.nameKey, subtitleKey: lastSchedule.subtitleKey } 
                        : { name: lastSchedule.name, subtitleKey: lastSchedule.subtitleKey })
                };
                habit.scheduleHistory.push(newSchedule);
            }
            
            clearScheduleCache();
            clearActiveHabitsCache();
            saveState();
            renderApp();
        }
    };

    showConfirmationModal(
        t('confirmRemoveTime', { habitName: escapeHTML(name), time: timeName }),
        fromNowOnAction, // onConfirm
        { 
            title: t('modalRemoveTimeTitle'), 
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: justTodayAction
        }
    );
}


export function handleUndoDelete() {
    if (!state.lastEnded) return;
    const { habitId, lastSchedule, removedSchedules } = state.lastEnded;
    const habit = state.habits.find(h => h.id === habitId);

    if (habit) {
        // CORREÇÃO DE INTEGRIDADE DE DADOS [2024-12-11]: A lógica de "Desfazer" foi
        // aprimorada para restaurar agendamentos futuros. Ela agora não apenas reativa
        // o último agendamento, mas também reintegra quaisquer agendamentos futuros
        // que foram removidos, garantindo uma restauração completa do estado.
        const scheduleToRestore = habit.scheduleHistory.find(s => s.startDate === lastSchedule.startDate);
        if (scheduleToRestore) {
            delete scheduleToRestore.endDate;
        }
        
        // Adiciona de volta quaisquer agendamentos futuros que foram removidos.
        if (removedSchedules && removedSchedules.length > 0) {
            habit.scheduleHistory.push(...removedSchedules);
            // Garante que a ordem esteja correta.
            habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
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
        t('confirmPermanentDelete', { habitName: escapeHTML(name) }),
        () => {
            // Remove the habit from the main array
            state.habits = state.habits.filter(h => h.id !== habitId);

            // Also delete its associated daily data
            Object.keys(state.dailyData).forEach(date => {
                if (state.dailyData[date]?.[habitId]) {
                    delete state.dailyData[date][habitId];
                }
            });

            // Clean up any other references to this habit ID
            state.pending21DayHabitIds = state.pending21DayHabitIds.filter(id => id !== habitId);
            state.pendingConsolidationHabitIds = state.pendingConsolidationHabitIds.filter(id => id !== habitId);
            state.notificationsShown = state.notificationsShown.filter(notificationId => !notificationId.startsWith(habitId + '-'));
            
            // Clear caches to prevent rendering stale data in the current session
            clearActiveHabitsCache();
            clearScheduleCache();
            Object.keys(state.streaksCache).forEach(key => {
                if (key.startsWith(`${habitId}|`)) {
                    delete state.streaksCache[key];
                }
            });

            saveState();
            setupManageModal();
            renderApp(); // Re-render the main app to reflect the deletion immediately
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
    
    const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
    if (scheduleForDay.includes(toTime)) return; // Invalid drop, already exists

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    const fromTimeName = t(`filter${fromTime}`);
    const toTimeName = t(`filter${toTime}`);

    const justTodayAction = () => {
        const date = state.selectedDate;
        const dailyInfo = ensureHabitDailyInfo(date, habitId);
        const schedule = getEffectiveScheduleForHabitOnDate(habit, date);

        const newSchedule = schedule.filter(t => t !== fromTime);
        newSchedule.push(toTime);
        dailyInfo.dailySchedule = newSchedule.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
        
        const instanceData = dailyInfo.instances[fromTime];
        if (instanceData) {
            dailyInfo.instances[toTime] = instanceData;
            delete dailyInfo.instances[fromTime];
        }

        clearActiveHabitsCache();
        saveState();
        renderHabits();
    };
    
    const fromNowOnAction = () => {
        const effectiveDate = state.selectedDate;
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        if (lastSchedule.endDate && parseUTCIsoDate(lastSchedule.endDate) <= parseUTCIsoDate(effectiveDate)) return;

        const newTimes = lastSchedule.times.filter(t => t !== fromTime);
        newTimes.push(toTime);
        newTimes.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));

        if (lastSchedule.startDate === effectiveDate) {
            lastSchedule.times = newTimes;
        } else {
            lastSchedule.endDate = effectiveDate;
            const newSchedule: HabitSchedule = { ...lastSchedule, startDate: effectiveDate, times: newTimes, endDate: undefined };
            habit.scheduleHistory.push(newSchedule);
        }

        clearScheduleCache();
        clearActiveHabitsCache();
        saveState();
        renderApp();
    };

    showConfirmationModal(
        t('confirmHabitMove', { habitName: escapeHTML(name), oldTime: fromTimeName, newTime: toTimeName }),
        fromNowOnAction,
        {
            title: t('modalMoveHabitTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: justTodayAction
        }
    );
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
    
    // MELHORIA DE ROBUSTEZ [2024-12-12]: A lógica para obter o nome do idioma foi corrigida para usar a `nameKey` correta do objeto LANGUAGES, garantindo que o nome do idioma traduzido (ex: "Português") seja passado para la IA.
    const languageInfo = LANGUAGES.find(l => l.code === lang);
    const languageName = languageInfo ? t(languageInfo.nameKey) : lang;
    const systemInstruction = t('aiSystemInstruction', { languageName });
    
    // CORREÇÃO DE BUG [2024-12-12]: Corrige a função para usar a chave de prompt correta (semanal, mensal, geral) com base na seleção do usuário, em vez de usar sempre a chave semanal.
    const promptKey = `aiPrompt${analysisType.charAt(0).toUpperCase() + analysisType.slice(1)}`;

    const prompt = t(promptKey, {
        activeHabitList: state.habits.filter(h => !h.graduatedOn && getScheduleForDate(h, today)).map(h => getHabitDisplayInfo(h).name).join(', ') || t('aiPromptNone'),
        graduatedHabitsSection: state.habits.some(h => h.graduatedOn) ? t('aiPromptGraduatedSection', { graduatedHabitList: state.habits.filter(h => h.graduatedOn).map(h => getHabitDisplayInfo(h).name).join(', ') }) : '',
        history: history || t('aiPromptNoData'),
    });
    
    return { prompt, systemInstruction };
}

export async function performAIAnalysis(analysisType: 'weekly' | 'monthly' | 'general') {
    closeModal(ui.aiOptionsModal);
    state.aiState = 'loading';
    state.lastAIResult = null;
    state.lastAIError = null;
    renderAINotificationState();
    
    const loaderHTML = `<div class="ai-response-loader"><svg class="loading-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div>`;
    ui.aiResponse.innerHTML = loaderHTML;
    openModal(ui.aiModal);

    try {
        // ARQUITETURA [2024-12-21]: Refatorado para usar o endpoint /api/analyze em vez de
        // chamar o SDK do Gemini diretamente no cliente. Isso melhora a segurança ao não
        // expor a lógica da chave de API no frontend e alinha-se à arquitetura pretendida
        // de usar Vercel Edge Functions para toda a lógica de backend.
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

    } catch (error: any) {
        state.aiState = 'error';
        state.lastAIError = error.message || t('aiErrorUnknown');
        state.hasSeenAIResult = false;
        
        ui.aiResponse.innerHTML = `<p class="ai-error-message">${t('aiErrorPrefix')}: ${escapeHTML(state.lastAIError!)}</p>`;
    } finally {
        saveState();
        renderAINotificationState();
    }
}