/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. Código limpo e otimizado. Removida importação não utilizada 'icons'. Otimizada a função _generateAIPrompt com Compressão de Contexto Híbrida e Mapeamento de IDs.
// UPDATE [2025-01-19]: Surgical UI updates. toggleHabitStatus now bypasses renderApp for immediate feedback.
// UPDATE [2025-01-20]: Implemented RLE (Run-Length Encoding) for AI Prompt History.
// PERFORMANCE FIX [2025-01-21]: Moved saveState() inside requestIdleCallback in toggleHabitStatus to ensure <16ms INP (Interaction to Next Paint).
// UPDATE [2025-01-24]: Deferred Heavy Cleanup for habit deletion. UI updates instantly, DB cleanups happen in idle time.
// ROBUSTNESS [2025-01-29]: saveState() moved to setTimeout(0) to ensure persistence on quick tab close while keeping UI responsive.

import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays, escapeHTML, simpleMarkdownToHTML, getTodayUTC, toUTCIsoDateString, runIdle } from './utils';
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
    invalidateChartCache,
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
    renderHabitCardState,
    renderCalendarDayPartial,
    removeHabitFromCache,
} from './render';
import { renderChart } from './chart';
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
        
        // ROBUSTEZ [2025-02-01]: Limpa explicitamente os caches para garantir que o novo hábito
        // seja reconhecido imediatamente pela lógica de renderização (getActiveHabitsForDate).
        // Isso corrige o bug onde hábitos padrão não apareciam após um reset.
        clearActiveHabitsCache();
        clearScheduleCache();
        
        invalidateChartCache();
        // PERFORMANCE: Marca a estrutura da lista como suja pois adicionamos um hábito
        state.uiDirtyState.habitListStructure = true;
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
    
    // PERFORMANCE: Marca que a lista mudou estruturalmente (novo hábito ou mudança de horário/nome)
    state.uiDirtyState.habitListStructure = true;
    
    clearScheduleCache(); // Isso também limpará o cache de resumo diário e invalidará o gráfico
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
    state.uiDirtyState.habitListStructure = true; // Hábito removido da visualização ativa
    
    clearActiveHabitsCache(); // Limpa cache de agendamento e resumo e gráfico
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

    state.uiDirtyState.habitListStructure = true; // Hábito removido da visualização ativa

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

        state.uiDirtyState.habitListStructure = true; // Mudança de horário afeta a estrutura da lista hoje

        clearActiveHabitsCache();
        saveState();
        renderHabits();
        renderCalendar();
        // Gráfico depende de dados agendados vs concluídos, então invalida
        invalidateChartCache(); 
        renderApp(); // Garante re-render do gráfico se necessário
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
            
            state.uiDirtyState.habitListStructure = true; // Mudança de horário afeta a estrutura

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
            onEdit: justTodayAction,
            // UX [2025-02-01]: Oculta o botão cancelar para simplificar a decisão.
            hideCancel: true 
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
    
    state.uiDirtyState.habitListStructure = true; // Hábito restaurado

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
            // FASE 1: ATUALIZAÇÃO SÍNCRONA DA UI
            // Remove o hábito da lista ativa imediatamente para feedback instantâneo.
            state.habits = state.habits.filter(h => h.id !== habitId);
            
            // Atualiza caches críticos que afetam a renderização imediata
            state.uiDirtyState.habitListStructure = true;
            clearActiveHabitsCache();
            clearScheduleCache();
            invalidateChartCache();
            
            // Remove do DOM Cache para evitar reuso indevido e liberar memória
            removeHabitFromCache(habitId);

            // Atualiza a UI imediatamente
            renderApp();
            setupManageModal(); // O modal está aberto, precisa atualizar

            // FASE 2: LIMPEZA PESADA DIFERIDA (DEEP CLEANUP)
            // Move operações custosas (loop em dailyData e JSON.stringify) para o idle time.
            // Isso evita que a animação de fechamento do modal ou renderização trave.
            runIdle(() => {
                // Limpeza profunda O(Days)
                Object.keys(state.dailyData).forEach(date => {
                    if (state.dailyData[date]?.[habitId]) {
                        delete state.dailyData[date][habitId];
                    }
                });

                state.pending21DayHabitIds = state.pending21DayHabitIds.filter(id => id !== habitId);
                state.pendingConsolidationHabitIds = state.pendingConsolidationHabitIds.filter(id => id !== habitId);
                state.notificationsShown = state.notificationsShown.filter(notificationId => !notificationId.startsWith(habitId + '-'));
                
                invalidateDaySummaryCache();
                
                for (const key of state.streaksCache.keys()) {
                    if (key.startsWith(`${habitId}|`)) {
                        state.streaksCache.delete(key);
                    }
                }

                // Persistência (I/O Bloqueante)
                saveState();
            });
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
    // 1. Memory Update (Synchronous & Immediate)
    const habitDayData = ensureHabitInstanceData(dateISO, habitId, time);
    habitDayData.status = getNextStatus(habitDayData.status);

    // 2. Visual Update (Synchronous & Immediate)
    // PERFORMANCE [2025-01-19]: Surgical Update Strategy.
    // We update only the specific card and calendar day affected.
    renderHabitCardState(habitId, time);
    renderCalendarDayPartial(dateISO);
    
    // 3. Persistence & Heavy Processing (Deferred/Asynchronous)
    // REFACTOR [2025-01-29]: Hybrid Persistence Strategy.
    // Use setTimeout(0) for saveState() to ensure it runs as a high-priority macro-task,
    // preventing data loss if the user closes the tab immediately (<10ms) after clicking.
    // Use runIdle for truly optional tasks (analytics, caching).
    
    setTimeout(() => {
        saveState(); // BLOCKING I/O but scheduled after current frame render
    }, 0);

    runIdle(() => {
        invalidateStreakCache(habitId, dateISO);
        invalidateDaySummaryCache(dateISO); // Invalida cache apenas para este dia
        invalidateChartCache(); // Mudança de status afeta o gráfico
        
        renderChart(); // Gráfico precisa atualizar pois pontuação mudou
        renderAINotificationState();
        updateAppBadge();
    });
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.goalOverride = newGoal;
    invalidateDaySummaryCache(date);
    saveState();
    renderCalendarDayPartial(date); // Update only current day in calendar
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.note = ui.notesTextarea.value.trim();
    
    state.editingNoteFor = null;
    saveState();
    // Aqui usamos renderHabits porque mudar uma nota pode afetar ícones e estados que 
    // renderHabitCardState cobre, mas como estamos fechando um modal, uma renderização parcial é segura.
    // Mas para simplicidade e consistência visual após fechar modal, renderHabits é ok.
    // Podemos otimizar para renderHabitCardState se quisermos.
    renderHabitCardState(habitId, time);
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
    invalidateDaySummaryCache(dateISO);
    invalidateChartCache();
    saveState();
    // Em ações em massa, invalidamos tudo por simplicidade e consistência
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    renderApp(); 
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
    invalidateDaySummaryCache(dateISO);
    invalidateChartCache();
    saveState();
    // Em ações em massa, invalidamos tudo por simplicidade e consistência
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    renderApp(); 
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
    
    state.uiDirtyState.habitListStructure = true; // Ordem mudou

    clearActiveHabitsCache();
    saveState();
    renderHabits();
}

// --- AI Analysis ---

/**
 * ADVANCED PROMPT ENGINEERING [2025-01-20]: Chronological Run-Length Encoding (RLE).
 * To optimize token usage further, we group consecutive days with identical habit statuses.
 * Format: "YYYY-MM-DD to YYYY-MM-DD: [H1:C, H2:P]"
 * This drastically compresses stable routine data.
 */
function _generateAIPrompt(analysisType: 'weekly' | 'monthly' | 'general'): { prompt: string, systemInstruction: string } {
    const today = getTodayUTC();
    const lang = state.activeLanguageCode;
    
    let daysToScan: number;

    switch (analysisType) {
        case 'weekly':
            daysToScan = 7;
            break;
        case 'monthly':
            daysToScan = 30;
            break;
        case 'general':
        default:
            daysToScan = 60;
            break;
    }

    // Status mapping for density
    const statusMap: Record<HabitStatus, string> = {
        completed: 'C', // Completed
        pending: 'P',   // Pending
        snoozed: 'S',   // Snoozed
    };

    // ID Mapping
    const habitIdMap = new Map<string, string>();
    const habitNameMap = new Map<string, string>();
    let habitCounter = 1;

    state.habits.forEach(h => {
        if (!h.graduatedOn) {
            const { name } = getHabitDisplayInfo(h);
            const id = `H${habitCounter++}`;
            habitIdMap.set(h.id, id);
            habitNameMap.set(id, name);
        }
    });

    // RLE Logic
    const denseHistoryEntries: string[] = [];
    let currentRangeStart: string | null = null;
    let currentRangeEnd: string | null = null;
    let currentDayTokenString = "";

    // Iterate chronologically (past to present) for better RLE
    for (let i = daysToScan - 1; i >= 0; i--) {
        const date = addDays(today, -i);
        const dateISO = toUTCIsoDateString(date);
        const dailyInfo = getHabitDailyInfoForDate(dateISO);
        const activeHabits = getActiveHabitsForDate(date);
        
        if (activeHabits.length === 0) {
            if (currentRangeStart) {
                denseHistoryEntries.push(`${currentRangeStart}${currentRangeStart !== currentRangeEnd ? ' to ' + currentRangeEnd : ''}: [${currentDayTokenString}]`);
                currentRangeStart = null;
            }
            continue;
        }

        const dayTokens: string[] = [];
        activeHabits.forEach(({ habit, schedule }) => {
            const shortId = habitIdMap.get(habit.id);
            const idOrName = shortId || getHabitDisplayInfo(habit, dateISO).name.replace(/[:|]/g, '');
            
            schedule.forEach(time => {
                const status = dailyInfo[habit.id]?.instances[time]?.status ?? 'pending';
                const statusCode = statusMap[status] || 'P';
                dayTokens.push(`${idOrName}:${statusCode}`);
            });
        });
        
        const newDayTokenString = dayTokens.join(',');

        if (currentRangeStart === null) {
            // Start new range
            currentRangeStart = dateISO;
            currentRangeEnd = dateISO;
            currentDayTokenString = newDayTokenString;
        } else {
            // Check if identical to previous
            if (newDayTokenString === currentDayTokenString) {
                currentRangeEnd = dateISO;
            } else {
                // Flush previous range
                denseHistoryEntries.push(`${currentRangeStart}${currentRangeStart !== currentRangeEnd ? ' to ' + currentRangeEnd : ''}: [${currentDayTokenString}]`);
                // Start new range
                currentRangeStart = dateISO;
                currentRangeEnd = dateISO;
                currentDayTokenString = newDayTokenString;
            }
        }
    }

    // Flush final range
    if (currentRangeStart) {
        denseHistoryEntries.push(`${currentRangeStart}${currentRangeStart !== currentRangeEnd ? ' to ' + currentRangeEnd : ''}: [${currentDayTokenString}]`);
    }

    const fullHistoryText = denseHistoryEntries.join('\n');
    
    const languageInfo = LANGUAGES.find(l => l.code === lang);
    const languageName = languageInfo ? t(languageInfo.nameKey) : lang;
    
    const legendParts: string[] = [];
    habitNameMap.forEach((name, id) => {
        legendParts.push(`${id}=${name}`);
    });
    const legendString = legendParts.join(', ');

    const systemInstruction = t('aiSystemInstruction', { languageName }) + 
        ` \nDATA FORMAT: DateRange: [HabitID:Status]\nCODES: C=Completed, S=Snoozed, P=Pending.\nLEGEND: ${legendString}`;
    
    const promptKey = `aiPrompt${analysisType.charAt(0).toUpperCase() + analysisType.slice(1)}`;

    const prompt = t(promptKey, {
        activeHabitList: state.habits.filter(h => !h.graduatedOn && getScheduleForDate(h, today)).map(h => getHabitDisplayInfo(h).name).join(', ') || t('aiPromptNone'),
        graduatedHabitsSection: state.habits.some(h => h.graduatedOn) ? t('aiPromptGraduatedSection', { graduatedHabitList: state.habits.filter(h => h.graduatedOn).map(h => getHabitDisplayInfo(h).name).join(', ') }) : '',
        history: fullHistoryText || t('aiPromptNoData'),
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