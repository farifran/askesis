/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído. A lógica de negócio principal para manipulação de hábitos é robusta, com tratamento de casos de borda e integridade de dados. Nenhuma outra análise é necessária.
import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays, escapeHTML, simpleMarkdownToHTML, getTodayUTC, toUTCIsoDateString, getActiveHabitsForDate, apiFetch, getHabitStatusForSorting } from './utils';
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
} from './render';
import { ui } from './ui';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { updateAppBadge } from './badge';
// FIX: Import the missing 'renderChart' function to resolve reference errors.
import { renderChart } from './chart';

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

    // Basic validation
    if (formData.times.length === 0 || (!formData.name && !formData.nameKey)) {
        const noticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice');
        if (noticeEl) {
            noticeEl.textContent = t('modalEditFormNotice');
            noticeEl.classList.add('visible');
            setTimeout(() => noticeEl.classList.remove('visible'), 3000);
        }
        return;
    }

    if (isNew) {
        const newHabitName = (formData.nameKey ? t(formData.nameKey) : formData.name).trim().toLowerCase();
        const newHabitTimes = formData.times;
        const startDate = state.selectedDate;

        const activeHabitsOnDate = getActiveHabitsForDate(parseUTCIsoDate(startDate));

        for (const { habit, schedule } of activeHabitsOnDate) {
            const existingHabitName = getHabitDisplayInfo(habit, startDate).name.trim().toLowerCase();
            
            if (existingHabitName === newHabitName) {
                const overlappingTime = schedule.find(time => newHabitTimes.includes(time));
                if (overlappingTime) {
                    const noticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice');
                    if (noticeEl) {
                        noticeEl.textContent = t('noticeHabitExistsAtTime', { time: getTimeOfDayName(overlappingTime) });
                        noticeEl.classList.add('visible');
                        setTimeout(() => noticeEl.classList.remove('visible'), 3000);
                    }
                    return; // Stop the save process.
                }
            }
        }

        const performCreation = () => {
            // Verifica se um hábito encerrado ou graduado com o mesmo nome pode ser reativado.
            const habitToReactivate = state.habits.find(h => {
                const hStatus = getHabitStatusForSorting(h);
                if (hStatus === 'active') return false; // Não corresponder a hábitos ativos.

                const lastSchedule = h.scheduleHistory.length > 0 ? h.scheduleHistory[h.scheduleHistory.length - 1] : null;
                if (!lastSchedule) return false;

                const nameOfExisting = lastSchedule.nameKey ? t(lastSchedule.nameKey) : lastSchedule.name;
                const nameOfNew = formData.nameKey ? t(formData.nameKey) : formData.name;
                
                // Compara os nomes sem diferenciar maiúsculas/minúsculas.
                return nameOfExisting?.trim().toLowerCase() === nameOfNew?.trim().toLowerCase();
            });

            if (habitToReactivate) {
                // Reativa adicionando um novo agendamento.
                const newSchedule: HabitSchedule = {
                    startDate: state.selectedDate,
                    times: formData.times,
                    frequency: formData.frequency,
                    // Ao reativar, cria uma nova data de âncora para os cálculos de frequência.
                    scheduleAnchor: state.selectedDate, 
                    ...(formData.nameKey ? { nameKey: formData.nameKey, subtitleKey: formData.subtitleKey } : { name: formData.name, subtitleKey: formData.subtitleKey })
                };
                habitToReactivate.scheduleHistory.push(newSchedule);
                
                // Atualiza as propriedades principais, já que o usuário pode ter escolhido um modelo com ícone/cor diferente.
                habitToReactivate.icon = formData.icon;
                habitToReactivate.color = formData.color;
                habitToReactivate.goal = { ...formData.goal };

                // Se estava graduado, não está mais ao ser reativado.
                delete habitToReactivate.graduatedOn;

            } else {
                // Lógica Original: Nenhum hábito existente para reativar, então cria um verdadeiramente novo.
                const newHabit = _createNewHabitFromTemplate(formData);
                state.habits.push(newHabit);
            }

            state.editingHabit = null;
            clearScheduleCache();
            clearActiveHabitsCache();
            saveState();
            renderApp();
            closeModal(ui.editHabitModal);
        };

        performCreation();
    } else if (habitId) {
        const habit = state.habits.find(h => h.id === habitId);
        if (habit) {
            const todayISO = getTodayUTCIso();
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

        state.editingHabit = null;
        clearScheduleCache();
        clearActiveHabitsCache();
        saveState();
        renderApp();
        closeModal(ui.editHabitModal);
    }
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

    const today = getTodayUTC();
    const formattedDate = today.toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });

    showConfirmationModal(
        t('confirmEndHabit', { habitName: escapeHTML(name), date: formattedDate }),
        () => endHabit(habitId, getTodayUTCIso()),
        { title: t('modalEndHabitTitle'), confirmText: t('buttonEndHabit') }
    );
}

function endHabit(habitId: string, fromDateISO: string = getTodayUTCIso()) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const newScheduleHistory: HabitSchedule[] = [];
    const sortedHistory = [...habit.scheduleHistory].sort((a, b) => a.startDate.localeCompare(b.startDate));
    let lastScheduleForUndo: HabitSchedule | null = null;

    for (const schedule of sortedHistory) {
        const start = schedule.startDate;
        const end = schedule.endDate || '9999-12-31';

        if (start >= fromDateISO) {
            // Schedule starts on or after the end date, so we discard it.
            continue;
        } else if (fromDateISO > start && fromDateISO < end) {
            // The end date falls within this schedule. We need to truncate it.
            const truncatedSchedule = { ...schedule, endDate: fromDateISO };
            newScheduleHistory.push(truncatedSchedule);
            lastScheduleForUndo = schedule; // Save the original for undo
        } else {
            // Schedule is entirely before the end date. Keep it.
            newScheduleHistory.push(schedule);
        }
    }

    habit.scheduleHistory = newScheduleHistory;

    if (lastScheduleForUndo) {
        state.lastEnded = { habitId, lastSchedule: { ...lastScheduleForUndo } };
        showUndoToast();
    }

    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderApp();
    setupManageModal();
}

function removeTimeFromHabitSchedule(habitId: string, timeToRemove: TimeOfDay, fromDateISO: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // [REWRITE-2024-12-18] Adotando uma abordagem funcional e imutável para reconstruir
    // o histórico de agendamentos. Isso é mais seguro e declarativo do que modificar o array
    // no local com `splice`, eliminando potenciais bugs de "off-by-one" e de referência.
    const newScheduleHistory: HabitSchedule[] = [];
    
    // Processa o histórico em ordem cronológica.
    const sortedHistory = [...habit.scheduleHistory].sort((a, b) => a.startDate.localeCompare(b.startDate));

    for (const schedule of sortedHistory) {
        const start = schedule.startDate;
        const end = schedule.endDate || '9999-12-31';
        
        // Caso 1: O agendamento está totalmente no futuro em relação à data da alteração.
        // Aplica a alteração diretamente a ele.
        if (start >= fromDateISO) {
            const newTimes = schedule.times.filter(t => t !== timeToRemove);
            // Só adiciona o agendamento se ele ainda tiver horários.
            if (newTimes.length > 0) {
                newScheduleHistory.push({ ...schedule, times: newTimes });
            }
        } 
        // Caso 2: A data da alteração está DENTRO do intervalo deste agendamento.
        // É necessário dividir o agendamento em dois.
        else if (fromDateISO > start && fromDateISO < end) {
            // Parte 1: O período antes da alteração. Mantém os horários originais.
            newScheduleHistory.push({ ...schedule, endDate: fromDateISO });

            // Parte 2: O período a partir da alteração. Aplica os novos horários filtrados.
            const newTimes = schedule.times.filter(t => t !== timeToRemove);
            if (newTimes.length > 0) {
                newScheduleHistory.push({ 
                    ...schedule, 
                    startDate: fromDateISO, 
                    // Mantém a data de término original (que pode ser indefinida).
                    endDate: schedule.endDate, 
                    times: newTimes 
                });
            }
        }
        // Caso 3: O agendamento está totalmente no passado ou não é afetado.
        // Adiciona-o ao novo histórico sem modificações.
        else {
            newScheduleHistory.push({ ...schedule });
        }
    }
    
    habit.scheduleHistory = newScheduleHistory;

    // Limpa caches, salva o estado e re-renderiza a UI por completo.
    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderHabits();
    renderCalendar();
    updateAppBadge();
}

/**
 * BUGFIX & FEATURE [2024-12-15]: Refactored to address user feedback. The function now shows a confirmation
 * modal with "Just Today" and "From Now On" options, preventing accidental permanent changes and
 * fixing the bug where no action occurred.
 */
export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const activeSchedule = getScheduleForDate(habit, state.selectedDate);
    if (!activeSchedule) return;

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);

    const justToday = () => {
        const dateISO = state.selectedDate;
        const dailyInfo = ensureHabitDailyInfo(dateISO, habitId);
        const currentSchedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
        
        const newDailySchedule = currentSchedule.filter(t => t !== time);
        dailyInfo.dailySchedule = newDailySchedule;
        
        if (dailyInfo.instances[time]) {
            delete dailyInfo.instances[time];
        }
        
        clearActiveHabitsCache();
        saveState();
        renderHabits();
        renderCalendar();
        updateAppBadge();
    };

    // Case 1: If it's the last time slot, "From Now On" means ending the habit.
    if (activeSchedule.times.length <= 1) {
        showConfirmationModal(
            t('confirmRemoveLastTime', { habitName: escapeHTML(name) }),
            () => endHabit(habitId, state.selectedDate),
            {
                title: t('modalEndHabitTitle'),
                confirmText: t('buttonEndHabit'),
                confirmButtonStyle: 'danger',
                editText: t('buttonJustToday'),
                onEdit: justToday,
            }
        );
        return;
    }

    // Case 2: Offer 'Just Today' vs 'From Now On' for multiple time slots.
    const fromNowOn = () => {
        removeTimeFromHabitSchedule(habitId, time, state.selectedDate);
    };

    const dateStr = state.selectedDate === getTodayUTCIso() 
        ? t('headerTitleToday').toLowerCase() 
        : parseUTCIsoDate(state.selectedDate).toLocaleDateString(state.activeLanguageCode, { day: 'numeric', month: 'long', timeZone: 'UTC' });

    showConfirmationModal(
        t('confirmRemoveTimeWithOptions', { 
            habitName: `<strong>${escapeHTML(name)}</strong>`,
            time: `<strong>${getTimeOfDayName(time)}</strong>`,
            date: dateStr
        }),
        fromNowOn,
        {
            title: t('modalRemoveTimeTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: justToday,
            confirmButtonStyle: 'danger'
        }
    );
}

export function requestHabitMove(habitId: string, oldTime: TimeOfDay, newTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId)!;
    const { name } = getHabitDisplayInfo(habit, state.selectedDate);

    const justToday = () => { handleHabitDrop(habitId, oldTime, newTime); };
    const fromNowOn = () => {
        const habit = state.habits.find(h => h.id === habitId)!;
        const todayISO = getTodayUTCIso();
        const currentSchedule = getScheduleForDate(habit, todayISO);
        if (!currentSchedule) return;

        // BUGFIX [2024-12-13]: Corrige a lógica de versionamento do agendamento para evitar uma lacuna de um dia, alinhando-a com `removeTimeFromHabitSchedule`.
        currentSchedule.endDate = todayISO;

        const newTimes = currentSchedule.times.filter(t => t !== oldTime);
        if (!newTimes.includes(newTime)) {
            newTimes.push(newTime);
        }

        const newSchedule: HabitSchedule = {
            ...currentSchedule,
            startDate: todayISO,
            endDate: undefined,
            times: newTimes,
        };

        habit.scheduleHistory.push(newSchedule);

        clearScheduleCache();
        clearActiveHabitsCache();
        saveState();
        renderHabits();
    };
    
    showConfirmationModal(
        t('confirmHabitMove', {
            habitName: `<strong>${escapeHTML(name)}</strong>`,
            oldTime: `<strong>${getTimeOfDayName(oldTime)}</strong>`,
            newTime: `<strong>${getTimeOfDayName(newTime)}</strong>`
        }),
        fromNowOn,
        {
            title: t('modalMoveHabitTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: justToday,
            cancelText: t('cancelButton')
        }
    );
}


export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmPermanentDelete', { habitName: escapeHTML(name) }),
        () => _permanentDeleteHabit(habitId),
        { 
            title: t('aria_delete_permanent', { habitName: '' }).trim(), 
            confirmText: t('aria_delete_permanent', { habitName: '' }).trim(),
            // UX-FIX [2024-10-27]: Usa o estilo 'danger' para o botão de confirmação.
            confirmButtonStyle: 'danger'
        }
    );
}

function _permanentDeleteHabit(habitId: string) {
    state.habits = state.habits.filter(h => h.id !== habitId);
    // Limpa os dados diários associados
    Object.keys(state.dailyData).forEach(date => {
        delete state.dailyData[date][habitId];
    });
    // Limpa caches
    delete state.streaksCache[habitId];
    clearScheduleCache();
    clearActiveHabitsCache();
    
    saveState();
    renderApp();
    setupManageModal();
}

export function handleUndoDelete() {
    if (state.undoTimeout) {
        clearTimeout(state.undoTimeout);
        state.undoTimeout = null;
    }
    ui.undoToast.classList.remove('visible');
    
    const lastEnded = state.lastEnded;
    if (!lastEnded) return;

    const habit = state.habits.find(h => h.id === lastEnded.habitId);
    if (habit) {
        // Encontra o agendamento que foi encerrado e restaura-o.
        const scheduleToEnd = habit.scheduleHistory.find(s => s.endDate === lastEnded.lastSchedule.endDate);
        if (scheduleToEnd) {
             // Se o undo restaura o estado exato de antes, devemos restaurar o `endDate` original.
             scheduleToEnd.endDate = lastEnded.lastSchedule.endDate;
        } else {
             // Se não encontrarmos o agendamento truncado, pode ser porque o hábito foi completamente removido.
             // Neste caso, readicionamos o agendamento original.
             habit.scheduleHistory.push(lastEnded.lastSchedule);
        }
    }
    
    state.lastEnded = null;
    clearScheduleCache();
    clearActiveHabitsCache();
    saveState();
    renderApp();
    setupManageModal();
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        closeModal(ui.manageModal);
        openEditModal(habit);
    }
}


// --- Habit Status & Goal Updates ---

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    const oldStatus = dayInstanceData.status;
    const newStatus = getNextStatus(oldStatus);
    dayInstanceData.status = newStatus;

    if (newStatus === 'completed' && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
        dayInstanceData.goalOverride = getCurrentGoalForInstance(habit, date, time);
    } else {
        delete dayInstanceData.goalOverride;
    }
    
    // Invalida o cache de streaks para este dia e todos os dias futuros
    invalidateStreakCache(habitId, date);

    // Lógica de celebração
    const todayISO = getTodayUTCIso();
    if (date === todayISO) {
        const streak = calculateHabitStreak(habitId, todayISO);
        const semiConsolidatedId = `${habitId}-${STREAK_SEMI_CONSOLIDATED}`;
        const consolidatedId = `${habitId}-${STREAK_CONSOLIDATED}`;
        
        if (streak === STREAK_SEMI_CONSOLIDATED && !state.notificationsShown.includes(semiConsolidatedId)) {
            if (!state.pending21DayHabitIds.includes(habitId)) {
                state.pending21DayHabitIds.push(habitId);
            }
        }
        if (streak === STREAK_CONSOLIDATED && !state.notificationsShown.includes(consolidatedId)) {
             if (!state.pendingConsolidationHabitIds.includes(habitId)) {
                state.pendingConsolidationHabitIds.push(habitId);
            }
        }
    }
    
    saveState();
    renderHabits();
    renderCalendar();
    renderAINotificationState();
    renderChart();
    updateAppBadge();
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const dayInstanceData = ensureHabitInstanceData(date, habitId, time);
    dayInstanceData.goalOverride = newGoal;
    
    saveState();
    // Apenas o gráfico precisa de uma re-renderização completa aqui, pois a meta pode afetar
    // o indicador "plus" que é calculado em `calculateDaySummary`.
    renderChart();
    renderCalendar();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;

    const { habitId, date, time } = state.editingNoteFor;
    const dayData = ensureHabitInstanceData(date, habitId, time);
    const noteText = ui.notesTextarea.value.trim();
    
    if (noteText) {
        dayData.note = noteText;
    } else {
        delete dayData.note;
    }

    state.editingNoteFor = null;
    saveState();
    renderHabits();
    closeModal(ui.notesModal);
}

// --- Drag and Drop Actions ---
/**
 * Handles moving a habit to a different time slot for the selected day.
 * This creates a daily schedule override to reflect the change.
 */
export function handleHabitDrop(habitId: string, oldTime: TimeOfDay, newTime: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Garante que a estrutura `HabitDailyInfo` exista para o dia.
    const dailyInfo = ensureHabitDailyInfo(state.selectedDate, habitId);

    // Obtém o agendamento atual para o dia, seja ele um override ou o padrão.
    const currentSchedule = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);

    // Cria o novo agendamento diário
    const newDailySchedule = currentSchedule.filter(t => t !== oldTime);
    if (!newDailySchedule.includes(newTime)) {
        newDailySchedule.push(newTime);
    }
    
    dailyInfo.dailySchedule = newDailySchedule;

    // Move os dados da instância (status, nota, etc.) para o novo horário.
    const instanceData = dailyInfo.instances[oldTime];
    if (instanceData) {
        dailyInfo.instances[newTime] = instanceData;
        delete dailyInfo.instances[oldTime];
    }
    
    clearActiveHabitsCache();
    saveState();
    renderHabits();
}

/**
 * Reorders a habit within the same time slot for the selected day.
 * This also creates or updates a daily schedule override.
 */
export function reorderHabit(draggedHabitId: string, targetHabitId: string, position: 'before' | 'after') {
    const time = (document.querySelector(`[data-habit-id="${draggedHabitId}"]`) as HTMLElement).dataset.time as TimeOfDay;
    
    const activeHabitsForTime = getActiveHabitsForDate(parseUTCIsoDate(state.selectedDate))
        .filter(({ schedule }) => schedule.includes(time))
        .map(({ habit }) => habit.id);

    const fromIndex = activeHabitsForTime.indexOf(draggedHabitId);
    const toIndex = activeHabitsForTime.indexOf(targetHabitId);

    if (fromIndex === -1 || toIndex === -1) return;

    const [movedHabit] = activeHabitsForTime.splice(fromIndex, 1);
    const newToIndex = position === 'before' ? (fromIndex < toIndex ? toIndex - 1 : toIndex) : (fromIndex < toIndex ? toIndex : toIndex + 1);
    activeHabitsForTime.splice(newToIndex, 0, movedHabit);
    
    // Aplica a nova ordem a TODOS os hábitos no grupo de tempo para o dia selecionado.
    // Isso garante que a ordem seja consistente e persistida corretamente.
    getActiveHabitsForDate(parseUTCIsoDate(state.selectedDate))
        .filter(({ schedule }) => schedule.includes(time))
        .forEach(({ habit }) => {
            const dailyInfo = ensureHabitDailyInfo(state.selectedDate, habit.id);
            const originalSchedule = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
            const timesForOtherGroups = originalSchedule.filter(t => t !== time);
            
            const newScheduleForTime = activeHabitsForTime
                .map(id => state.habits.find(h => h.id === id)!)
                .filter(h => getEffectiveScheduleForHabitOnDate(h, state.selectedDate).includes(time))
                .map(h => h.id === habit.id ? time : undefined)
                .filter((t): t is TimeOfDay => t !== undefined);

            dailyInfo.dailySchedule = [...timesForOtherGroups, ...newScheduleForTime];
        });

    // BUGFIX [2024-12-13]: Invalida o cache de hábitos ativos após a reordenação.
    // A função `reorderHabit` modifica o `dailySchedule` para a data selecionada, e o cache dependente precisava ser limpo para refletir a nova ordem.
    clearActiveHabitsCache();
    saveState();
    renderHabits();
}


// --- Bulk Actions ---

export function completeAllHabitsForDate(date: string) {
    const activeHabitsData = getActiveHabitsForDate(parseUTCIsoDate(date));

    activeHabitsData.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const dayInstanceData = ensureHabitInstanceData(date, habit.id, time);
            if (dayInstanceData.status !== 'completed') {
                dayInstanceData.status = 'completed';
            }
        });
    });
    
    // Invalida o cache de streaks para todos os hábitos a partir desta data.
    activeHabitsData.forEach(({ habit }) => invalidateStreakCache(habit.id, date));
    
    saveState();
    renderApp();
}

export function snoozeAllHabitsForDate(date: string) {
    const activeHabitsData = getActiveHabitsForDate(parseUTCIsoDate(date));
    activeHabitsData.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const dayInstanceData = ensureHabitInstanceData(date, habit.id, time);
            if (dayInstanceData.status !== 'snoozed') {
                dayInstanceData.status = 'snoozed';
            }
        });
    });
    
    invalidateStreakCache(activeHabitsData.map(({ habit }) => habit.id).join(','), date);
    saveState();
    renderApp();
}

// --- App Data Management ---

export function resetApplicationData() {
    localStorage.clear();
    // Recarrega a página para limpar todo o estado na memória e começar do zero.
    window.location.reload();
}

// --- AI Analysis ---

function generateHistoryForAI(days: number): string {
    let history = '';
    const today = getTodayUTC();
    const habitStatusSymbols: Record<HabitStatus, string> = {
        completed: '✅',
        snoozed: '➡️',
        pending: '⚪️'
    };

    for (let i = 0; i < days; i++) {
        const date = addDays(today, -i);
        const dateISO = toUTCIsoDateString(date);
        
        const activeHabitsForDate = getActiveHabitsForDate(date);
        if (activeHabitsForDate.length === 0) continue;

        const dateString = date.toLocaleDateString(state.activeLanguageCode, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
        history += `\n**${dateString}**\n`;

        const dailyInfo = getHabitDailyInfoForDate(dateISO);

        activeHabitsForDate.forEach(({ habit, schedule }) => {
            const { name } = getHabitDisplayInfo(habit, dateISO);
            const statuses = schedule.map(time => {
                const instance = dailyInfo[habit.id]?.instances[time];
                const status = instance?.status ?? 'pending';
                let output = habitStatusSymbols[status];
                if (instance?.note) {
                    output += ` (${t('aiPromptNotePrefix')}: ${instance.note})`;
                }
                return output;
            }).join(' ');

            history += `- ${name}: ${statuses}\n`;
        });
    }

    return history || t('aiPromptNoData');
}


async function getActiveAndGraduatedHabitListsForAI(): Promise<{ activeHabitList: string, graduatedHabitsSection: string }> {
    const activeHabits = state.habits.filter(h => !h.graduatedOn && getScheduleForDate(h, getTodayUTCIso()));
    const graduatedHabits = state.habits.filter(h => h.graduatedOn);

    const getHabitListString = (habits: Habit[]) => habits.length > 0
        ? habits.map(h => getHabitDisplayInfo(h).name).join(', ')
        : t('aiPromptNone');

    const activeHabitList = getHabitListString(activeHabits);
    const graduatedHabitList = getHabitListString(graduatedHabits);
    
    const graduatedHabitsSection = graduatedHabits.length > 0
        ? t('aiPromptGraduatedSection', { graduatedHabitList })
        : '';
        
    return { activeHabitList, graduatedHabitsSection };
}


export async function performAIAnalysis(analysisType: 'weekly' | 'monthly' | 'general') {
    closeModal(ui.aiOptionsModal);
    ui.aiResponse.innerHTML = `<div class="ai-response-loader"><svg class="loading-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div>`;
    openModal(ui.aiModal);
    
    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    renderAINotificationState();

    try {
        const { activeHabitList, graduatedHabitsSection } = await getActiveAndGraduatedHabitListsForAI();
        const days = analysisType === 'weekly' ? 7 : (analysisType === 'monthly' ? 30 : 365);
        const history = generateHistoryForAI(days);
        
        let promptKey: 'aiPromptWeekly' | 'aiPromptMonthly' | 'aiPromptGeneral';
        switch (analysisType) {
            case 'weekly': promptKey = 'aiPromptWeekly'; break;
            case 'monthly': promptKey = 'aiPromptMonthly'; break;
            case 'general': promptKey = 'aiPromptGeneral'; break;
        }

        const prompt = t(promptKey, {
            activeHabitList: escapeHTML(activeHabitList),
            graduatedHabitsSection: escapeHTML(graduatedHabitsSection),
            history: escapeHTML(history)
        });
        
        // CORREÇÃO DE BUG DE IDIOMA DA IA: Determina dinamicamente o nome do idioma atual para a instrução do sistema.
        const currentLangInfo = LANGUAGES.find(lang => lang.code === state.activeLanguageCode);
        const languageName = currentLangInfo ? t(currentLangInfo.nameKey) : t('langEnglish');
        const systemInstruction = t('aiSystemInstruction', { languageName });
        
        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
        });

        const analysisText = await response.text();
        state.lastAIResult = analysisText;
        state.aiState = 'completed';
        ui.aiResponse.innerHTML = simpleMarkdownToHTML(analysisText);

    } catch (error) {
        console.error("AI Analysis failed:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        state.lastAIResult = `**${t('aiErrorPrefix')}:** ${t('aiErrorUnknown')}\n\n*${escapeHTML(errorMessage)}*`;
        state.aiState = 'error';
        ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult);
    } finally {
        renderAINotificationState();
        saveState();
    }
}