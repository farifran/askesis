/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { generateUUID, getTodayUTCIso, parseUTCIsoDate, addDays, escapeHTML, simpleMarkdownToHTML, getTodayUTC, toUTCIsoDateString, getActiveHabitsForDate } from './utils';
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
    formatGoalForDisplay,
    getUnitString,
} from './render';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { ui } from './ui';
import { renderChart } from './chart';
import { updateAppBadge } from './badge';

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
    // BUGFIX [2024-08-27]: Corrige um bug onde a renomeação de um hábito sobrescrevia
    // seu subtítulo com um valor genérico. A função agora atualiza apenas o nome,
    // preservando o subtítulo para manter a integridade dos dados.
    habit.scheduleHistory.forEach(schedule => {
        // Se era um hábito predefinido, agora se torna personalizado, então removemos a chave.
        schedule.nameKey = undefined;
        schedule.name = newName;
        // O subtítulo é gerenciado separadamente e não deve ser alterado aqui.
    });
}


function updateHabitSchedule(
    originalHabit: Habit,
    changeDateISO: string,
    updates: Partial<Pick<HabitSchedule, 'times' | 'frequency'>>
): void {
    const lastSchedule = originalHabit.scheduleHistory[originalHabit.scheduleHistory.length - 1];

    // REFACTOR [2024-08-26]: Se uma mudança de agendamento ocorrer na mesma data em que o agendamento
    // atual começou, modifica o agendamento existente em vez de criar um novo.
    // Isso evita entradas de agendamento de "duração zero" e mantém o histórico mais limpo.
    if (lastSchedule.startDate === changeDateISO) {
        // Modifica o agendamento atual
        Object.assign(lastSchedule, updates);
        // Se a frequência mudar, o dia da mudança se torna a nova "âncora" para o cálculo do padrão.
        if (updates.frequency) {
            lastSchedule.scheduleAnchor = changeDateISO;
        }
    } else {
        // Comportamento original: encerra o agendamento antigo e cria um novo.
        const newSchedule: HabitSchedule = {
            ...lastSchedule,
            ...updates,
            startDate: changeDateISO,
            scheduleAnchor: changeDateISO, // Um novo período de agendamento sempre se ancora na data de início.
            endDate: undefined,
        };
        
        lastSchedule.endDate = changeDateISO;
        originalHabit.scheduleHistory.push(newSchedule);
    }
    
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
    clearScheduleCache();
    clearActiveHabitsCache();
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
            ...('nameKey' in template ? { nameKey: template.nameKey, subtitleKey: template.subtitleKey } : { name: template.name, subtitleKey: template.subtitleKey })
        }],
    };
    state.habits.push(newHabit);
    clearActiveHabitsCache();
}

/**
 * Verifica se um hábito ativo com o mesmo nome já existe.
 * @param name O nome a ser verificado.
 * @param excludeHabitId O ID de um hábito a ser ignorado na verificação (útil ao editar).
 * @returns Verdadeiro se um duplicado ativo for encontrado.
 */
function isHabitNameDuplicate(name: string, excludeHabitId?: string): boolean {
    const lowerCaseName = name.toLowerCase();
    return state.habits.some(h => {
        if (h.id === excludeHabitId) return false; // Ignora o próprio hábito ao editar

        const { name: displayName } = getHabitDisplayInfo(h);
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        const isActive = !lastSchedule.endDate && !h.graduatedOn;
        
        return isActive && displayName.toLowerCase() === lowerCaseName;
    });
}

/**
 * Encontra um hábito encerrado ou graduado que pode ser reutilizado.
 * @param name O nome do hábito a ser procurado.
 * @returns O objeto do hábito se um reutilizável for encontrado, senão undefined.
 */
function findReusableHabitByName(name: string): Habit | undefined {
    const lowerCaseName = name.toLowerCase();
    return state.habits.find(h => {
        const { name: displayName } = getHabitDisplayInfo(h);
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        const isEnded = !!lastSchedule.endDate || !!h.graduatedOn;
        
        return isEnded && displayName.toLowerCase() === lowerCaseName;
    });
}

// REFACTOR [2024-07-30]: Esta função finaliza o processo de salvamento de hábito.
// Foi extraída para ser reutilizada pelos novos handlers `handleAddNewHabit` e `handleEditHabit`.
function finishSave() {
    closeModal(ui.editHabitModal);
    state.editingHabit = null;
    commitStateAndRender();
}


// REFACTOR [2024-07-30]: A lógica de criação foi extraída de `saveHabitFromModal`.
// Agora, esta função é a única responsável por lidar com a adição de um novo hábito,
// incluindo a reutilização de hábitos antigos e a confirmação para datas passadas.
function handleAddNewHabit(formData: HabitTemplate) {
    const habitName = 'name' in formData ? formData.name! : t(formData.nameKey!);
    const reusableHabit = findReusableHabitByName(habitName);

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
            newSchedule.subtitleKey = formData.subtitleKey;
        }
        
        reusableHabit.scheduleHistory.push(newSchedule);
        reusableHabit.icon = formData.icon;
        reusableHabit.color = formData.color;
        reusableHabit.goal = formData.goal;
        reusableHabit.graduatedOn = undefined;

        clearScheduleCache();
        clearActiveHabitsCache();
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
}


// REFACTOR [2024-07-30]: A lógica de edição foi extraída de `saveHabitFromModal`.
// Esta função agora lida exclusivamente com a atualização de um hábito existente,
// incluindo a verificação de alterações e a confirmação para edições no passado.
// REFACTOR [2024-08-11]: Simplifica a lógica de salvamento em handleEditHabit.
// A função agora usa uma cláusula de guarda para sair mais cedo se não houver alterações,
// e a estrutura condicional foi reorganizada para ser mais clara e menos repetitiva,
// melhorando a legibilidade e a manutenibilidade.
// REFACTOR [2024-08-24]: Simplifica a lógica de salvamento em handleEditHabit.
// A função agora usa uma cláusula de guarda para sair mais cedo se não houver alterações,
// e a estrutura condicional foi reorganizada para ser mais clara e menos repetitiva,
// melhorando a legibilidade e a manutenibilidade.
function handleEditHabit(originalData: Habit, formData: HabitTemplate) {
    const habitName = 'name' in formData ? formData.name! : t(formData.nameKey!);
    const latestSchedule = originalData.scheduleHistory[originalData.scheduleHistory.length - 1];
    
    const nameChanged = getHabitDisplayInfo(originalData).name !== habitName;
    const timesChanged = JSON.stringify(latestSchedule.times.sort()) !== JSON.stringify(formData.times.sort());
    const freqChanged = JSON.stringify(latestSchedule.frequency) !== JSON.stringify(formData.frequency);
    const scheduleChanged = timesChanged || freqChanged;

    // 1. Cláusula de Guarda: Se nada mudou, apenas fecha o modal.
    if (!nameChanged && !scheduleChanged) {
        closeModal(ui.editHabitModal);
        state.editingHabit = null;
        return;
    }

    // 2. Aplica a mudança de nome se houver.
    if (nameChanged) {
        updateHabitDetails(originalData, habitName);
        clearActiveHabitsCache();
    }

    // 3. Lida com a mudança de agendamento, que pode ser assíncrona.
    if (scheduleChanged) {
        const isTodayOrFuture = parseUTCIsoDate(state.selectedDate) >= parseUTCIsoDate(getTodayUTCIso());
        
        if (isTodayOrFuture) {
            updateHabitSchedule(originalData, state.selectedDate, { times: formData.times, frequency: formData.frequency });
            finishSave(); // Salva as alterações de nome e agendamento
        } else {
            showConfirmationModal(
                t('confirmScheduleChange', { habitName, date: state.selectedDate }),
                () => {
                    updateHabitSchedule(originalData, state.selectedDate, { times: formData.times, frequency: formData.frequency });
                    finishSave(); // Salva após a confirmação do usuário
                },
                {
                    title: t('modalEditTitle'),
                    confirmText: t('confirmButton'),
                    cancelText: t('cancelButton')
                }
            );
            // A ação é assíncrona, então retornamos aqui. `finishSave` será chamado no callback.
            return;
        }
    } else {
        // Se apenas o nome mudou (scheduleChanged é falso), salva imediatamente.
        finishSave();
    }
}

// REFACTOR [2024-07-30]: A função `saveHabitFromModal` foi simplificada para ser um "orquestrador".
// Sua responsabilidade agora é apenas validar a entrada do formulário e delegar
// para os handlers `handleAddNewHabit` ou `handleEditHabit`.
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

    const isDuplicate = isHabitNameDuplicate(habitName, isNew ? undefined : habitId);
    if (isDuplicate) {
        showInlineNotice(noticeEl, t('noticeDuplicateHabitWithName'));
        return;
    }

    // Atualiza o formData com os valores finais do formulário
    formData.times = selectedTimes;
    if ('name' in formData) {
        formData.name = habitName;
    }

    // Delega para o handler apropriado
    if (isNew) {
        handleAddNewHabit(formData);
    } else if (originalData) {
        handleEditHabit(originalData, formData);
    }
}

export function createDefaultHabit() {
    const waterHabitTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (waterHabitTemplate) {
        addHabit(waterHabitTemplate);
    }
}

// REFACTOR [2024-08-05]: A lógica de verificação de streak foi extraída para esta função
// para evitar repetição de código e centralizar a regra de negócio de celebração.
// Esta função é chamada sempre que o status de um hábito muda.
function checkAndTriggerStreakCelebrations(habitId: string) {
    const streak = calculateHabitStreak(habitId, state.selectedDate);

    const addPendingCelebration = (id: string, pendingList: string[]) => {
        // Uma celebração só é adicionada se o usuário ainda não a viu (notificationsShown)
        // e se ela já não está na lista de pendentes.
        if (!state.notificationsShown.includes(id) && !pendingList.includes(id)) {
            pendingList.push(id);
        }
    };

    if (streak === STREAK_SEMI_CONSOLIDATED) {
        addPendingCelebration(habitId, state.pending21DayHabitIds);
    } else if (streak === STREAK_CONSOLIDATED) {
        addPendingCelebration(habitId, state.pendingConsolidationHabitIds);
    }
}


export function toggleHabitStatus(habitId: string, time: TimeOfDay) {
    const dayData = ensureHabitInstanceData(state.selectedDate, habitId, time);
    dayData.status = getNextStatus(dayData.status);

    // Invalida o cache de streaks para que o novo cálculo seja correto.
    invalidateStreakCache(habitId, state.selectedDate);

    // Após a mudança de status, verifica se algum marco de streak foi atingido.
    checkAndTriggerStreakCelebrations(habitId);
    
    commitStateAndRender();
}

// REFACTOR [2024-08-25]: A função `updateGoalOverride` foi renomeada para `setGoalOverride` e simplificada.
// A responsabilidade de atualizar a UI do cartão de hábito foi movida para o listener (`habitCardListeners.ts`)
// para melhorar a coesão. Esta função agora se concentra exclusivamente na atualização do estado e na
// renderização de componentes não-card (calendário, gráfico, emblema), preservando a performance.
export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    // 1. Atualiza o estado
    const dayData = ensureHabitInstanceData(date, habitId, time);
    dayData.goalOverride = newGoal;
    saveState();

    // 2. Renderiza componentes dependentes, mas que não piscam (não a lista de hábitos).
    renderCalendar();
    renderChart();
    updateAppBadge();
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

function endHabit(habit: Habit, dateISO: string) {
    const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
    lastSchedule.endDate = dateISO;
    state.lastEnded = { habitId: habit.id, lastSchedule };

    invalidateStreakCache(habit.id, dateISO);
    clearScheduleCache();
    clearActiveHabitsCache();
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
                clearScheduleCache();
                clearActiveHabitsCache();
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
            clearActiveHabitsCache();
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

    const dataToMove = state.dailyData[changeDate]?.[habitId]?.instances[fromTime];
    
    if (permanent) {
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        const newTimes = lastSchedule.times.filter(t => t !== fromTime);
        if (!newTimes.includes(toTime)) {
            newTimes.push(toTime);
        }
        
        // REATORAÇÃO [2024-08-26]: Delega a lógica de atualização do agendamento para a função
        // centralizada e aprimorada, que agora lida com edições no mesmo dia de forma inteligente.
        updateHabitSchedule(habit, changeDate, { times: newTimes });

    } else { // Just for today
        const dailyInfo = state.dailyData[changeDate]?.[habitId] ?? { instances: {} };
        const activeSchedule = getScheduleForDate(habit, changeDate);
        if (!activeSchedule) return;

        const originalTimes = dailyInfo.dailySchedule || activeSchedule.times;
        const newTimes = originalTimes.filter(t => t !== fromTime);
        if (!newTimes.includes(toTime)) {
            newTimes.push(toTime);
        }

        dailyInfo.dailySchedule = newTimes;
        
        if (!state.dailyData[changeDate]) {
            state.dailyData[changeDate] = {};
        }
        state.dailyData[changeDate][habitId] = dailyInfo;
    }
    
    if (dataToMove) {
        const toInstance = ensureHabitInstanceData(changeDate, habitId, toTime);
        Object.assign(toInstance, dataToMove);
        delete state.dailyData[changeDate][habitId].instances[fromTime];
    }
    clearActiveHabitsCache();
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
                
                clearActiveHabitsCache();
                commitStateAndRender();
            }
        }
    );
}

// REFACTOR [2024-08-20]: A lógica de reordenação foi otimizada para remover uma busca redundante
// no array. Agora, os índices são encontrados uma vez, e o índice de destino é ajustado
// manualmente após a remoção, tornando a função mais performática e robusta.
export function reorderHabit(draggedId: string, targetId: string, position: 'before' | 'after') {
    const habitIndex = state.habits.findIndex(h => h.id === draggedId);
    let targetIndex = state.habits.findIndex(h => h.id === targetId);
    if (habitIndex === -1 || targetIndex === -1) return;

    // Remove o hábito arrastado, capturando-o.
    const [draggedHabit] = state.habits.splice(habitIndex, 1);

    // Ajusta o índice de destino se o item arrastado estava posicionado antes dele no array.
    if (habitIndex < targetIndex) {
        targetIndex--;
    }
    
    // Calcula o ponto de inserção final com base na posição ('antes' ou 'depois').
    const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
    
    // Insere o hábito na sua nova posição.
    state.habits.splice(insertIndex, 0, draggedHabit);
    
    clearActiveHabitsCache();
    commitStateAndRender();
}


/**
 * Função auxiliar refatorada para atualizar em massa os status dos hábitos para uma data.
 * @param date A data (string ISO) para a qual os hábitos serão atualizados.
 * @param newStatus O novo status a ser aplicado.
 */
function bulkUpdateHabitsForDate(date: string, newStatus: 'completed' | 'snoozed') {
    const dateObj = parseUTCIsoDate(date);
    const activeHabitsData = getActiveHabitsForDate(dateObj);
    let changed = false;

    activeHabitsData.forEach(({ habit, schedule }) => {
        let habitSpecificChange = false;
        
        schedule.forEach(time => {
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
            // BUGFIX [2024-08-06]: Garante que as celebrações de streak sejam acionadas
            // também durante ações em massa (ex: clique duplo), mantendo a consistência
            // com a ação de alternar individualmente.
            if (newStatus === 'completed') {
                checkAndTriggerStreakCelebrations(habit.id);
            }
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
    clearScheduleCache();
    clearActiveHabitsCache();
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
            clearActiveHabitsCache();
            commitStateAndRender();
            setupManageModal();
        },
        { title: t('modalStatusGraduated'), confirmText: t('aria_graduate', { habitName: '' }) }
    );
}


// --- Lógica de Construção de Prompt ---

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
    const activeHabitsData = getActiveHabitsForDate(date);

    if (activeHabitsData.length === 0) return null;

    const dayEntries = activeHabitsData.map(({ habit, schedule }) => {
        if (schedule.length === 0) return '';
        
        const { name } = getHabitDisplayInfo(habit);
        const habitInstances = dailyInfoByHabit[habit.id]?.instances || {};

        const statusDetails = schedule.map(time => {
            const instance = habitInstances[time];
            const status: HabitStatus = instance?.status || 'pending';
            const note = instance?.note;
            
            let detail = statusToSymbol[status];
            if (schedule.length > 1) {
                detail = `${t(timeToKeyMap[time])}: ${detail}`;
            }

            if ((habit.goal.type === 'pages' || habit.goal.type === 'minutes') && instance?.status === 'completed') {
                const goalValue = getCurrentGoalForInstance(habit, isoDate, time);
                const unit = t(habit.goal.unitKey, { count: goalValue });
                detail += ` ${goalValue} ${unit}`;
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
        
        // BUGFIX [2024-07-31]: Fixed a reference error in the 'general' analysis loop.
        // The loop was trying to increment an undefined variable 'date' instead of the loop
        // iterator 'd', which caused the general AI analysis to fail after the first day.
        // BUGFIX [2024-08-16]: Corrects a critical reference error in the general AI analysis prompt builder.
        // The loop was using an out-of-scope 'date' variable instead of the correct iterator 'd', causing the analysis to fail.
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
    // UX IMPROVEMENT [2024-08-04]: Exibe um indicador de carregamento imediatamente dentro do modal de IA
    // para fornecer feedback visual de que a solicitação está em andamento.
    // BUGFIX [2024-09-01]: Reutiliza o SVG do ícone de carregamento do cabeçalho para garantir consistência visual e de animação.
    const loadingIconHTML = ui.aiEvalBtn.querySelector('.loading-icon')?.outerHTML;
    ui.aiResponse.innerHTML = `<div class="ai-response-loader">${loadingIconHTML || ''}</div>`;
    closeModal(ui.aiOptionsModal);
    openModal(ui.aiModal);

    const MAX_RETRIES = 3;
    const INITIAL_BACKOFF_MS = 1000;

    try {
        const { prompt, systemInstruction } = buildAIPrompt(analysisType);
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const response = await fetch('/api/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt, systemInstruction }),
                });

                if (!response.ok) {
                    const errorBody = await response.json().catch(() => ({
                        error: 'Falha ao analisar a resposta de erro do servidor.',
                        details: response.statusText,
                    }));
                    throw new Error(`[${response.status}] ${errorBody.error || 'Erro de API'}: ${errorBody.details || ''}`);
                }

                const fullText = await response.text();
                ui.aiResponse.innerHTML = simpleMarkdownToHTML(fullText);
                state.lastAIResult = fullText;
                state.lastAIError = null;
                state.aiState = 'completed';
                // Sucesso, sai do loop de tentativas
                return; 
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                console.warn(`Attempt ${attempt + 1} failed:`, lastError.message);
                
                // Se for a última tentativa, o loop terminará e o erro será lançado
                if (attempt < MAX_RETRIES - 1) {
                    const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        // Se o loop terminar sem sucesso, lança o último erro capturado
        throw lastError;

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : t('aiErrorUnknown');
        const displayError = `${t('aiErrorPrefix')}: ${errorMessage}`;
        ui.aiResponse.innerHTML = `<p class="ai-error-message">${displayError}</p>`;
        state.lastAIResult = null;
        state.lastAIError = errorMessage;
        state.aiState = 'error';
    } finally {
        state.hasSeenAIResult = false;
        renderAINotificationState();
    }
}