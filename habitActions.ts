
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. Código limpo e otimizado. Removida importação não utilizada 'icons'. Otimizada a função _generateAIPrompt movendo a definição do mapa de status para fora do loop para evitar realocação de memória desnecessária.

import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays, escapeHTML, simpleMarkdownToHTML, getTodayUTC, toUTCIsoDateString } from './utils';
import { apiFetch } from './api';
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
    getActiveHabitsForDate,
    invalidateDaySummaryCache,
} from './state';
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
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { updateAppBadge } from './badge';

// --- Habit Creation & Deletion ---

function _createNewHabitFromTemplate(template: HabitTemplate): Habit {
    const startDate = state.selectedDate;
    return {
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
}

export function createDefaultHabit() {
    const defaultHabitTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (defaultHabitTemplate) {
        const newHabit = _createNewHabitFromTemplate(defaultHabitTemplate);
        state.habits.push(newHabit);
    }
}


/**
 * REATORAÇÃO DE MODULARIDADE: Localiza um hábito existente que pode ser reativado
 * com base no nome ou na chave de nome de um novo formulário de hábito.
 */
function _findReactivatableHabit(formData: HabitTemplate): Habit | undefined {
    const identifier = formData.nameKey
        ? { key: 'nameKey', value: formData.nameKey }
        : { key: 'name', value: (formData.name || '').trim().toLowerCase() };

    if (!identifier.value) return undefined;

    return state.habits.find(h =>
        h.scheduleHistory.some(s => {
            if (identifier.key === 'nameKey') {
                return s.nameKey === identifier.value;
            } else {
                return !s.nameKey && s.name?.trim().toLowerCase() === identifier.value;
            }
        })
    );
}

/**
 * REATORAÇÃO DE MODULARIDADE: Aplica as atualizações de agendamento a um hábito,
 * seja atualizando o agendamento atual no local ou dividindo o histórico para criar um novo.
 */
function _updateScheduleForHabit(habit: Habit, formData: HabitTemplate, isReactivating: boolean, effectiveDate: string) {
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];

    const namePropsChanged = (formData.nameKey && lastSchedule.nameKey !== formData.nameKey) || 
                             (formData.name && !formData.nameKey && lastSchedule.name !== formData.name);
                             
    // BUGFIX [2024-12-28]: Usa o operador spread [...] antes de .sort() para evitar a mutação 
    // dos arrays originais no estado da aplicação durante a comparação.
    // DATA INTEGRITY: Garante que os horários do formulário também estejam ordenados antes da comparação e salvamento.
    const sortedFormTimes = [...formData.times].sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
    
    const schedulePropsChanged =
        JSON.stringify([...lastSchedule.times].sort()) !== JSON.stringify(sortedFormTimes) ||
        JSON.stringify(lastSchedule.frequency) !== JSON.stringify(formData.frequency) ||
        namePropsChanged;

    if (isReactivating || (schedulePropsChanged && !lastSchedule.endDate)) {
        const nameProps = formData.nameKey 
            ? { nameKey: formData.nameKey, subtitleKey: formData.subtitleKey, name: undefined } 
            : { name: formData.name, subtitleKey: formData.subtitleKey, nameKey: undefined };

        if (lastSchedule.startDate === effectiveDate && !lastSchedule.endDate) {
            // Se a edição ocorrer no mesmo dia em que o agendamento começou, atualize no local.
            Object.assign(lastSchedule, {
                times: sortedFormTimes,
                frequency: formData.frequency,
                ...nameProps
            });
        } else {
            // Caso contrário, divida o histórico: encerre o agendamento atual e comece um novo.
            if (!lastSchedule.endDate) {
                lastSchedule.endDate = effectiveDate;
            }
            const newSchedule: HabitSchedule = {
                startDate: effectiveDate,
                times: sortedFormTimes,
                frequency: formData.frequency,
                scheduleAnchor: isReactivating ? effectiveDate : lastSchedule.scheduleAnchor,
                ...nameProps,
            };
            habit.scheduleHistory.push(newSchedule);
        }
    }
}

/**
 * REATORAÇÃO DE MODULARIDADE: Função principal para salvar hábitos, agora orquestrando helpers.
 */
export function saveHabitFromModal() {
    if (!state.editingHabit) return;
    const { isNew, habitId, formData } = state.editingHabit;

    // 1. Validação
    const formNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice');
    if (formData.times.length === 0 || (!formData.name && !formData.nameKey)) {
        if (formNoticeEl) {
            showInlineNotice(formNoticeEl, t('modalEditFormNotice'));
        }
        return;
    }

    // DATA CONSISTENCY [2024-12-28]: Ordena os horários de forma canônica (Manhã, Tarde, Noite)
    // para evitar que a ordem dos cliques do usuário crie inconsistências no armazenamento.
    // Esta ordenação é crucial e é aplicada diretamente no objeto formData antes de qualquer processamento.
    formData.times.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));

    // 2. Determina o hábito a ser atualizado (novo, reativado ou editado)
    let habitToUpdate: Habit | undefined;
    let isReactivating = false;

    if (isNew) {
        habitToUpdate = _findReactivatableHabit(formData);
        if (habitToUpdate) {
            isReactivating = true;
        } else {
            const newHabit = _createNewHabitFromTemplate(formData);
            state.habits.push(newHabit);
            habitToUpdate = newHabit; // Define como o hábito a ser atualizado (embora já esteja 'atualizado')
        }
    } else {
        habitToUpdate = state.habits.find(h => h.id === habitId);
    }
    
    // 3. Aplica as atualizações se um hábito foi encontrado ou criado
    if (habitToUpdate) {
        habitToUpdate.icon = formData.icon;
        habitToUpdate.color = formData.color;
        habitToUpdate.goal = formData.goal;
        
        _updateScheduleForHabit(habitToUpdate, formData, isReactivating, state.selectedDate);

        if (isReactivating) {
            delete habitToUpdate.graduatedOn;
        }
    }

    // 4. Finalização
    state.editingHabit = null;
    clearScheduleCache(); // Isso também limpará o cache de resumo diário
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
    clearActiveHabitsCache(); // Limpa cache de agendamento e resumo
    saveState();
    renderApp();
    // PERFORMANCE: Só atualiza a lista do modal se ele estiver visível.
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }
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
    
    const activeSchedule = getScheduleForDate(habit, endDateISO);
    
    if (!activeSchedule) {
        console.warn(`No active schedule found for habit ${habitId} to end at ${endDateISO}.`);
        return;
    }

    const scheduleInHistory = habit.scheduleHistory.find(s => s.startDate === activeSchedule.startDate);
    if (!scheduleInHistory) {
         console.error(`Consistency error: Could not find the matched schedule in the habit's history to end it.`);
         return;
    }
    
    const endDate = parseUTCIsoDate(endDateISO);
    const originalActiveSchedule = { ...scheduleInHistory };
    const removedSchedules = habit.scheduleHistory.filter(s => parseUTCIsoDate(s.startDate) > endDate);
    state.lastEnded = { habitId, lastSchedule: originalActiveSchedule, removedSchedules };

    scheduleInHistory.endDate = endDateISO;
    habit.scheduleHistory = habit.scheduleHistory.filter(s => parseUTCIsoDate(s.startDate) <= endDate);

    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderApp();
    
    // PERFORMANCE: Só regera a lista de gerenciamento se o modal estiver aberto.
    // Importante para chamadas de endHabit via swipe na tela principal.
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }
    showUndoToast();
}

function _requestFutureScheduleChange(
    habit: Habit,
    effectiveDate: string,
    confirmationText: string,
    confirmationTitle: string,
    fromTime: TimeOfDay,
    toTime?: TimeOfDay
) {
    const scheduleModifier = (times: TimeOfDay[]): TimeOfDay[] => {
        const newTimes = times.filter(t => t !== fromTime);
        if (toTime) {
            newTimes.push(toTime);
        }
        return newTimes.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
    };

    const justTodayAction = () => {
        const dailyInfo = ensureHabitDailyInfo(effectiveDate, habit.id);
        const originalSchedule = getEffectiveScheduleForHabitOnDate(habit, effectiveDate);
        
        dailyInfo.dailySchedule = scheduleModifier(originalSchedule);
        
        const instanceData = dailyInfo.instances[fromTime];
        if (instanceData) {
            if (toTime) {
                dailyInfo.instances[toTime] = instanceData;
            }
            delete dailyInfo.instances[fromTime];
        }

        clearActiveHabitsCache();
        saveState();
        renderHabits();
        renderCalendar();
    };
    
    const fromNowOnAction = () => {
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        if (lastSchedule.endDate && parseUTCIsoDate(lastSchedule.endDate) <= parseUTCIsoDate(effectiveDate)) return;

        const newTimes = scheduleModifier(lastSchedule.times);
        
        if (newTimes.length === 0) {
            endHabit(habit.id, effectiveDate);
        } else {
            if (lastSchedule.startDate === effectiveDate && !lastSchedule.endDate) {
                lastSchedule.times = newTimes;
            } else {
                lastSchedule.endDate = effectiveDate;
                const newSchedule: HabitSchedule = { 
                    ...lastSchedule, 
                    startDate: effectiveDate, 
                    times: newTimes, 
                    endDate: undefined 
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
        confirmationText,
        fromNowOnAction,
        {
            title: confirmationTitle,
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: justTodayAction
        }
    );
}


export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    const timeName = t(`filter${time}`);
    
    _requestFutureScheduleChange(
        habit,
        state.selectedDate,
        t('confirmRemoveTime', { habitName: escapeHTML(name), time: timeName }),
        t('modalRemoveTimeTitle'),
        time
    );
}


export function handleUndoDelete() {
    if (!state.lastEnded) return;
    const { habitId, lastSchedule, removedSchedules } = state.lastEnded;
    const habit = state.habits.find(h => h.id === habitId);

    if (habit) {
        const scheduleToRestore = habit.scheduleHistory.find(s => s.startDate === lastSchedule.startDate);
        if (scheduleToRestore) {
            delete scheduleToRestore.endDate;
        }
        
        if (removedSchedules && removedSchedules.length > 0) {
            habit.scheduleHistory.push(...removedSchedules);
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
    
    // PERFORMANCE: Só regera a lista de gerenciamento se o modal estiver aberto.
    // Evita processamento desnecessário quando o desfazer é acionado pelo Toast na tela principal.
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }
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
                if (state.dailyData[date]?.[habitId]) {
                    delete state.dailyData[date][habitId];
                }
            });

            state.pending21DayHabitIds = state.pending21DayHabitIds.filter(id => id !== habitId);
            state.pendingConsolidationHabitIds = state.pendingConsolidationHabitIds.filter(id => id !== habitId);
            state.notificationsShown = state.notificationsShown.filter(notificationId => !notificationId.startsWith(habitId + '-'));
            
            clearActiveHabitsCache();
            clearScheduleCache();
            invalidateDaySummaryCache(); // Limpa cache de resumo após exclusão
            Object.keys(state.streaksCache).forEach(key => {
                if (key.startsWith(`${habitId}|`)) {
                    delete state.streaksCache[key];
                }
            });

            saveState();
            // Exclusão permanente só ocorre dentro do modal, então a atualização é sempre necessária.
            setupManageModal();
            renderApp();
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
    invalidateDaySummaryCache(dateISO); // Invalida cache apenas para este dia
    saveState();
    renderApp(); // Atualiza tudo: Hábitos, Calendário, Gráfico e IA
    updateAppBadge();
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.goalOverride = newGoal;
    invalidateDaySummaryCache(date); // Invalida cache apenas para este dia
    saveState();
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
    invalidateDaySummaryCache(dateISO); // Invalida cache apenas para este dia
    saveState();
    renderApp(); // Atualiza tudo: Hábitos, Calendário, Gráfico e IA
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
    invalidateDaySummaryCache(dateISO); // Invalida cache apenas para este dia
    saveState();
    renderApp(); // Atualiza tudo: Hábitos, Calendário, Gráfico e IA
    updateAppBadge();
}

// --- Drag and Drop Actions ---

export function handleHabitDrop(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
    if (scheduleForDay.includes(toTime)) return;

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    const fromTimeName = t(`filter${fromTime}`);
    const toTimeName = t(`filter${toTime}`);

    _requestFutureScheduleChange(
        habit,
        state.selectedDate,
        t('confirmHabitMove', { habitName: escapeHTML(name), oldTime: fromTimeName, newTime: toTimeName }),
        t('modalMoveHabitTitle'),
        fromTime,
        toTime
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
    let historyLogDays: number;

    switch (analysisType) {
        case 'weekly':
            startDate = addDays(today, -7);
            daysToScan = 7;
            historyLogDays = 7;
            break;
        case 'monthly':
            startDate = addDays(today, -30);
            daysToScan = 30;
            historyLogDays = 30;
            break;
        case 'general':
        default:
            startDate = new Date(0);
            daysToScan = 365;
            historyLogDays = 90;
            break;
    }

    const logCutoffDate = addDays(today, -historyLogDays);

    const historyEntries: string[] = [];
    
    // OTIMIZAÇÃO DE PERFORMANCE [2025-01-16]: Move a definição do objeto statusMap para fora do loop.
    // Isso evita a alocação e coleta de lixo repetida desse objeto a cada iteração do loop (especialmente em 'general' com 365 dias),
    // melhorando a eficiência de memória durante a geração do prompt.
    const statusMap: Record<HabitStatus, string> = {
        completed: '✅',
        pending: '⚪️',
        snoozed: '➡️',
    };

    for (let i = 0; i < daysToScan; i++) {
        const date = addDays(today, -i);
        if (date < logCutoffDate) break; 
        if (analysisType !== 'general' && date < startDate) break;

        const dateISO = toUTCIsoDateString(date);
        const dailyInfo = getHabitDailyInfoForDate(dateISO);
        const activeHabits = getActiveHabitsForDate(date);
        if (activeHabits.length === 0) continue;
        
        const dayHabitEntries: string[] = [];
        activeHabits.forEach(({ habit, schedule }) => {
            const { name } = getHabitDisplayInfo(habit, dateISO);
            schedule.forEach(time => {
                const status = dailyInfo[habit.id]?.instances[time]?.status ?? 'pending';
                const statusSymbol = statusMap[status] || '⚪️';
                dayHabitEntries.push(`- ${name} (${getTimeOfDayName(time)}): ${statusSymbol}`);
            });
        });
        
        if (dayHabitEntries.length > 0) {
            historyEntries.push(`Date: ${dateISO}\n${dayHabitEntries.join('\n')}`);
        }
    }
    const history = historyEntries.join('\n\n');
    
    const languageInfo = LANGUAGES.find(l => l.code === lang);
    const languageName = languageInfo ? t(languageInfo.nameKey) : lang;
    const systemInstruction = t('aiSystemInstruction', { languageName });
    
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
    
    const loaderHTML = `<div class="ai-response-loader"><svg class="loading-icon"><use href="#icon-spinner"></use></svg></div>`;
    ui.aiResponse.innerHTML = loaderHTML;
    openModal(ui.aiModal);

    try {
        const { prompt, systemInstruction } = _generateAIPrompt(analysisType);
        
        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
            timeout: 60000,
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
