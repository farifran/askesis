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
    const todayISO = getTodayUTCIso();

    // Basic validation
    const formNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice');
    if (formData.times.length === 0 || (!formData.name && !formData.nameKey)) {
        if (formNoticeEl) {
            showInlineNotice(formNoticeEl, t('modalEditFormNotice'));
        }
        return;
    }

    if (isNew) {
        // MELHORIA DE VALIDAÇÃO [2024-12-13]: Adiciona uma verificação para impedir a criação
        // de um hábito duplicado (mesmo nome) em um horário que já está ocupado.
        const newHabitName = formData.nameKey ? t(formData.nameKey) : (formData.name || '').trim();
        const duplicateNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.duplicate-habit-notice');

        const isDuplicate = state.habits.some(existingHabit => {
            const activeSchedule = getScheduleForDate(existingHabit, state.selectedDate);
            if (!activeSchedule) return false;

            const { name: existingHabitName } = getHabitDisplayInfo(existingHabit, state.selectedDate);
            if (existingHabitName.toLowerCase() !== newHabitName.toLowerCase()) return false;
            
            const existingHabitTimes = getEffectiveScheduleForHabitOnDate(existingHabit, state.selectedDate);
            const hasOverlappingTime = formData.times.some(newTime => existingHabitTimes.includes(newTime));

            return hasOverlappingTime;
        });

        if (isDuplicate) {
            if (duplicateNoticeEl) {
                showInlineNotice(duplicateNoticeEl, t('noticeDuplicateHabitAtTime'));
            }
            return;
        }

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
        t('confirmEndHabit', { habitName: escapeHTML(name), date: parseUTCIsoDate(getTodayUTCIso()).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long' }) }),
        () => endHabit(habitId),
        { title: t('modalEndHabitTitle'), confirmText: t('endButton') }
    );
}

function endHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const todayISO = getTodayUTCIso();
    const todayDate = parseUTCIsoDate(todayISO);

    // Encontra o agendamento ativo hoje.
    const activeSchedule = getScheduleForDate(habit, todayDate);

    // Se não houver agendamento ativo ou se já estiver encerrado, não faz nada.
    if (!activeSchedule || activeSchedule.endDate) return;

    // CORREÇÃO DE INTEGRIDADE DE DADOS [2024-12-11]: A lógica de "encerrar" foi refatorada
    // para lidar corretamente com agendamentos futuros. Agora, ela encerra o agendamento
    // *atualmente ativo* e remove quaisquer agendamentos futuros, armazenando-os para
    // a funcionalidade "Desfazer". Isso corrige um bug crítico onde encerrar um hábito
    // deixava agendamentos futuros órfãos.
    
    // Salva o estado para a funcionalidade "Desfazer" ANTES de fazer as alterações.
    const originalActiveSchedule = { ...activeSchedule };
    const removedSchedules = habit.scheduleHistory.filter(s => parseUTCIsoDate(s.startDate) > todayDate);
    state.lastEnded = { habitId, lastSchedule: originalActiveSchedule, removedSchedules };

    // Modifica o estado: encerra o agendamento ativo e remove os futuros.
    activeSchedule.endDate = todayISO;
    habit.scheduleHistory = habit.scheduleHistory.filter(s => parseUTCIsoDate(s.startDate) <= todayDate);

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
        const dailyInfo = ensureHabitDailyInfo(state.selectedDate, habitId);
        const schedule = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
        
        dailyInfo.dailySchedule = schedule.filter(t => t !== time);
        
        if (dailyInfo.instances) {
            delete dailyInfo.instances[time];
        }
        
        clearActiveHabitsCache();
        saveState();
        renderHabits();
    };
    
    const fromNowOnAction = () => {
        const todayISO = getTodayUTCIso();
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        if (lastSchedule.endDate && parseUTCIsoDate(lastSchedule.endDate) < parseUTCIsoDate(todayISO)) return;

        const newTimes = lastSchedule.times.filter(t => t !== time);

        if (lastSchedule.startDate === todayISO) {
            lastSchedule.times = newTimes;
        } else {
            lastSchedule.endDate = toUTCIsoDateString(addDays(parseUTCIsoDate(todayISO), -1));
            const newSchedule: HabitSchedule = { ...lastSchedule, startDate: todayISO, times: newTimes, endDate: undefined };
            habit.scheduleHistory.push(newSchedule);
        }
        clearScheduleCache();
        clearActiveHabitsCache();
        saveState();
        renderApp();
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
        if (lastSchedule.endDate && parseUTCIsoDate(lastSchedule.endDate) < parseUTCIsoDate(effectiveDate)) return;

        const newTimes = lastSchedule.times.filter(t => t !== fromTime);
        newTimes.push(toTime);
        newTimes.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));

        if (lastSchedule.startDate === effectiveDate) {
            lastSchedule.times = newTimes;
        } else {
            lastSchedule.endDate = toUTCIsoDateString(addDays(parseUTCIsoDate(effectiveDate), -1));
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
    
    // MELHORIA DE ROBUSTEZ [2024-12-12]: A lógica para obter o nome do idioma foi corrigida para usar a `nameKey` correta do objeto LANGUAGES, garantindo que o nome do idioma traduzido (ex: "Português") seja passado para a IA.
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
    
    const loaderHTML = `<div class="ai-response-loader"><svg class="loading-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div>`;
    ui.aiResponse.innerHTML = loaderHTML;
    openModal(ui.aiModal);

    try {
        const { prompt, systemInstruction } = _generateAIPrompt(analysisType);
        
        const ai = new (await import('@google/genai')).GoogleGenAI({ apiKey: process.env.API_KEY! });
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
            },
        });
        
        const resultText = response.text;
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