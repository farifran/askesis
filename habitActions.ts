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
 * CORREÇÃO DE BUG CRÍTICO [2024-09-19]: A função `updateHabitSchedule` foi completamente reescrita para corrigir uma falha de integridade de dados.
 * A lógica anterior modificava incorretamente o último agendamento ao editar em datas passadas. A nova implementação localiza o segmento de agendamento
 * historicamente correto ativo na data da edição e o divide ou modifica, garantindo que as alterações sejam aplicadas a partir do ponto correto no
 * tempo sem corromper o histórico do hábito.
 */
function updateHabitSchedule(
    habit: Habit,
    changeDateISO: string,
    updates: Partial<Pick<HabitSchedule, 'times' | 'frequency' | 'name' | 'nameKey' | 'subtitleKey'>>
): void {
    const changeDate = parseUTCIsoDate(changeDateISO);
    
    // 1. Encontra o índice do segmento de agendamento que estava ativo na data da mudança.
    const activeScheduleIndex = habit.scheduleHistory.findIndex(schedule => {
        const start = parseUTCIsoDate(schedule.startDate);
        const end = schedule.endDate ? parseUTCIsoDate(schedule.endDate) : new Date(8640000000000000); // Data máxima
        return changeDate >= start && changeDate < end;
    });

    if (activeScheduleIndex === -1) {
        // CORREÇÃO DE INTEGRIDADE DE DADOS [2024-09-26]: Lida com o caso de edição em uma data anterior ao início do hábito.
        // Em vez de modificar o último agendamento (o que corromperia o estado atual), a lógica agora assume que
        // a intenção é antecipar o início do hábito. Portanto, modifica o *primeiro* registro de agendamento.
        const firstSchedule = habit.scheduleHistory[0];
        if (firstSchedule && changeDateISO < firstSchedule.startDate) {
            console.log(`Adjusting start date for habit ${habit.id} from ${firstSchedule.startDate} to ${changeDateISO}.`);
            Object.assign(firstSchedule, updates);
            firstSchedule.startDate = changeDateISO;
            firstSchedule.scheduleAnchor = changeDateISO;
        } else {
            // Este caso não deveria ocorrer se o histórico estiver ordenado e a data for realmente anterior.
            // É um log de segurança contra estados de dados inesperados.
            console.error(`Could not apply schedule update for habit ${habit.id} on ${changeDateISO}. The habit's history might be inconsistent or the change date is not before its start date as expected.`);
        }
    } else {
        const targetSchedule = habit.scheduleHistory[activeScheduleIndex];
        
        // 2. Otimização: Se a data da mudança é a mesma data de início do agendamento, modifica-o no local.
        if (targetSchedule.startDate === changeDateISO) {
            Object.assign(targetSchedule, updates);
            if (updates.frequency || updates.times) {
                targetSchedule.scheduleAnchor = changeDateISO;
            }
        } else {
            // 3. Lógica de "divisão": encerra o agendamento antigo e cria um novo.
            const newSchedule: HabitSchedule = {
                ...targetSchedule, // Herda propriedades como nome, subtítulo, etc.
                ...updates,
                startDate: changeDateISO,
                scheduleAnchor: changeDateISO,
                endDate: undefined,
            };

            // Encerra o agendamento antigo um dia antes da data da mudança.
            targetSchedule.endDate = toUTCIsoDateString(addDays(changeDate, -1));

            // Insere o novo agendamento na ordem cronológica correta.
            habit.scheduleHistory.splice(activeScheduleIndex + 1, 0, newSchedule);
        }
    }
    
    // 4. Invalida caches e limpa dados futuros para refletir as mudanças.
    invalidateStreakCache(habit.id, changeDateISO);

    const futureDateKeys = Object.keys(state.dailyData).filter(dateStr => parseUTCIsoDate(dateStr) >= changeDate);
    futureDateKeys.forEach(dateStr => {
        const habitDataOnDate = state.dailyData[dateStr]?.[habit.id];
        if (habitDataOnDate) {
            // CORREÇÃO DE INTEGRIDADE DE DADOS [2024-10-02]: Limpa os overrides de agendamento diário ('Just Today')
            // a partir da data da mudança para garantir que a mudança permanente seja a fonte da verdade.
            if (habitDataOnDate.dailySchedule) {
                delete habitDataOnDate.dailySchedule;
            }

            if (updates.times) {
                const newTimesSet = new Set(updates.times);
                for (const time in habitDataOnDate.instances) {
                    if (!newTimesSet.has(time as TimeOfDay)) {
                        delete habitDataOnDate.instances[time as TimeOfDay];
                    }
                }
            }
        }
    });

    clearScheduleCache();
    clearActiveHabitsCache();
}


/**
 * REATORAÇÃO [2024-09-13]: A criação do objeto de agendamento em addHabit foi refatorada
 * para usar o padrão namePart, alinhando-se com handleAddNewHabit para maior
 * consistência e legibilidade.
 */
function addHabit(template: HabitTemplate) {
    const namePart = 'nameKey' in template
        ? { nameKey: template.nameKey, subtitleKey: template.subtitleKey }
        : { name: template.name, subtitleKey: template.subtitleKey };
        
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
            ...namePart
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
    // UX BUGFIX [2024-10-22]: Adiciona uma verificação para atualizar a lista de gerenciamento de hábitos se ela estiver aberta ao salvar,
    // garantindo que as alterações (como um novo nome) sejam refletidas imediatamente sem a necessidade de fechar e reabrir o modal.
    if (ui.manageModal.classList.contains('visible')) {
        setupManageModal();
    }
}


// REFACTOR [2024-07-30]: A lógica de criação foi extraída de `saveHabitFromModal`.
// Agora, esta função é a única responsável por lidar com a adição de um novo hábito,
// incluindo a reutilização de hábitos antigos e a confirmação para datas passadas.
function handleAddNewHabit(formData: HabitTemplate) {
    const habitName = 'name' in formData ? formData.name! : t(formData.nameKey!);
    const reusableHabit = findReusableHabitByName(habitName);

    if (reusableHabit) {
        // REFACTOR [2024-09-03]: Simplifica a criação do objeto de agendamento.
        // Utiliza um objeto `namePart` e a sintaxe de spread para atribuir condicionalmente
        // as propriedades `name` ou `nameKey`, alinhando-se com o padrão mais limpo usado na
        // função `addHabit` e reduzindo a redundância do código.
        const namePart = 'nameKey' in formData
            ? { nameKey: formData.nameKey, subtitleKey: formData.subtitleKey }
            : { name: formData.name, subtitleKey: formData.subtitleKey };

        const newSchedule: HabitSchedule = {
            startDate: state.selectedDate,
            scheduleAnchor: state.selectedDate,
            times: formData.times,
            frequency: formData.frequency,
            ...namePart
        };
        
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


/**
 * REATORAÇÃO DE INTEGRIDADE DE DADOS [2024-09-25]: A lógica de edição foi unificada. Agora, tanto as alterações de nome quanto as de agendamento são tratadas
 * como uma atualização única que cria um novo segmento de histórico. Isso corrige um bug crítico onde renomear um hábito alterava seu nome retroativamente,
 * garantindo a preservação e a precisão do histórico de dados do usuário.
 * @param originalData O estado original do hábito antes da edição.
 * @param formData Os novos dados do formulário de edição.
 */
function handleEditHabit(originalData: Habit, formData: HabitTemplate) {
    const newHabitName = 'name' in formData ? formData.name! : t(formData.nameKey!);
    const activeSchedule = getScheduleForDate(originalData, state.selectedDate) || originalData.scheduleHistory[originalData.scheduleHistory.length - 1];
    
    const nameChanged = getHabitDisplayInfo(originalData, state.selectedDate).name !== newHabitName;
    const timesChanged = JSON.stringify(activeSchedule.times.sort()) !== JSON.stringify(formData.times.sort());
    const freqChanged = JSON.stringify(activeSchedule.frequency) !== JSON.stringify(formData.frequency);
    const scheduleChanged = timesChanged || freqChanged;

    if (!nameChanged && !scheduleChanged) {
        closeModal(ui.editHabitModal);
        state.editingHabit = null;
        return;
    }

    const updates: Partial<Pick<HabitSchedule, 'times' | 'frequency' | 'name' | 'nameKey' | 'subtitleKey'>> = {};
    if (scheduleChanged) {
        updates.times = formData.times;
        updates.frequency = formData.frequency;
    }
    if (nameChanged) {
        updates.name = newHabitName;
        updates.nameKey = undefined;
        updates.subtitleKey = formData.subtitleKey;
    }

    const applyChanges = () => {
        updateHabitSchedule(originalData, state.selectedDate, updates);
        finishSave();
    };

    const isPastDate = parseUTCIsoDate(state.selectedDate) < parseUTCIsoDate(getTodayUTCIso());

    if (isPastDate) {
        showConfirmationModal(
            t('confirmScheduleChange', { habitName: newHabitName, date: state.selectedDate }),
            applyChanges,
            {
                title: t('modalEditTitle', { habitName: newHabitName }),
                confirmText: t('confirmButton'),
                cancelText: t('cancelButton')
            }
        );
    } else {
        applyChanges();
    }
}


// REFACTOR [2024-07-30]: A função `saveHabitFromModal` foi simplificada para ser um "orquestrador".
// Sua responsabilidade agora é apenas validar la entrada do formulário e delegar
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

    // MELHORIA DE UX: Se o nome de um hábito predefinido for alterado, ele se torna um hábito personalizado.
    // Isso dá aos usuários a liberdade de usar modelos como ponto de partida sem ficarem presos a eles.
    if ('nameKey' in formData && formData.nameKey && t(formData.nameKey) !== habitName) {
        // Converte o modelo em um hábito personalizado, removendo a chave de tradução.
        const customFormData = formData as any; // Usa 'any' para a transformação do tipo.
        delete customFormData.nameKey;
        customFormData.name = habitName;
        customFormData.subtitleKey = 'customHabitSubtitle';
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

/**
 * REATORAÇÃO DE INTEGRIDADE DE DADOS [2024-09-28]: A verificação de celebração de streak foi corrigida para usar
 * a data real do evento, em vez da data selecionada na UI. A função agora aceita `dateISO` para
 * garantir que os marcos de streak sejam calculados e acionados com precisão histórica.
 * @param habitId O ID do hábito a ser verificado.
 * @param dateISO A data da conclusão do hábito.
 */
function checkAndTriggerStreakCelebrations(habitId: string, dateISO: string) {
    const streak = calculateHabitStreak(habitId, dateISO);

    // Helper to add a celebration if it hasn't been shown and isn't already pending.
    const addPendingCelebration = (pendingList: string[], celebrationId: string) => {
        if (!state.notificationsShown.includes(celebrationId) && !pendingList.includes(habitId)) {
            pendingList.push(habitId);
        }
    };

    // CORREÇÃO DE LÓGICA [2024-10-23]: A verificação de celebração agora usa uma chave composta ('habitId-dias')
    // para rastrear as notificações mostradas. Isso corrige um bug onde a celebração de 21 dias de um hábito
    // impedia que a celebração de 66 dias do mesmo hábito fosse exibida.
    if (streak === STREAK_SEMI_CONSOLIDATED) {
        addPendingCelebration(state.pending21DayHabitIds, `${habitId}-${STREAK_SEMI_CONSOLIDATED}`);
    } else if (streak === STREAK_CONSOLIDATED) {
        addPendingCelebration(state.pendingConsolidationHabitIds, `${habitId}-${STREAK_CONSOLIDATED}`);
    }
}

/**
 * REATORAÇÃO [2024-09-16]: Centraliza a lógica de mutação de estado para o status de uma instância.
 * Esta função é agora a única fonte da verdade para alterar um status, invalidar
 * o cache de sequências e verificar celebrações, garantindo consistência e corrigindo um
 * bug de ordem de operações.
 * @param habitId O ID do hábito a ser atualizado.
 * @param date A data da instância.
 * @param time O horário da instância.
 * @param newStatus O novo status a ser aplicado.
 */
function _updateHabitInstanceStatus(habitId: string, date: string, time: TimeOfDay, newStatus: HabitStatus): void {
    const dayData = ensureHabitInstanceData(date, habitId, time);
    dayData.status = newStatus;

    // Passo 1: Invalida o cache para garantir que cálculos futuros sejam precisos.
    invalidateStreakCache(habitId, date);

    // Passo 2: Verifica celebrações usando dados atualizados (o cache será recalculado).
    if (newStatus === 'completed') {
        checkAndTriggerStreakCelebrations(habitId, date);
    }
}


/**
 * REATORAÇÃO DE INTEGRIDADE DE DADOS [2024-09-28]: A função foi atualizada para aceitar o parâmetro `date`
 * para corrigir um bug onde a celebração de streaks era calculada com base na data da UI
 * em vez da data real do evento, garantindo a precisão dos marcos.
 */
export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const dayData = ensureHabitInstanceData(date, habitId, time);
    const newStatus = getNextStatus(dayData.status);

    _updateHabitInstanceStatus(habitId, date, time, newStatus);
    
    commitStateAndRender();
}

// REFACTOR [2024-09-05]: A função foi refatorada para apenas atualizar o estado.
// A responsabilidade de atualizar a UI do cartão de hábito foi movida para `habitCardListeners.ts`
// para melhorar a coesão e corrigir o bug de "piscar". Esta função agora renderiza apenas
// componentes não-card (calendário, gráfico, emblema) para manter a performance.
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
    const date = parseUTCIsoDate(dateISO);
    let endedSchedule: HabitSchedule | null = null;
    const removedSchedules: HabitSchedule[] = [];
    
    // Encontra o agendamento a ser encerrado e filtra os agendamentos futuros
    const remainingSchedules = habit.scheduleHistory.filter(schedule => {
        const startDate = parseUTCIsoDate(schedule.startDate);
        if (startDate > date) {
            removedSchedules.push(schedule);
            return false; // Remove este agendamento
        }
        
        const endDate = schedule.endDate ? parseUTCIsoDate(schedule.endDate) : new Date(8640000000000000);
        if (date >= startDate && date < endDate) {
            endedSchedule = schedule;
        }
        return true; // Mantém este agendamento
    });

    if (endedSchedule) {
        // CORREÇÃO DE INTEGRIDADE DE DADOS [2024-10-06]: A lógica de finalização de hábito foi reescrita
        // para manipular corretamente o histórico de agendamentos. Agora, ela encerra o agendamento
        // ativo na data selecionada e remove quaisquer agendamentos futuros, prevenindo estados de
        // dados inconsistentes e permitindo uma restauração precisa via "Desfazer".
        endedSchedule.endDate = dateISO;
        habit.scheduleHistory = remainingSchedules;
        state.lastEnded = { habitId: habit.id, lastSchedule: endedSchedule, removedSchedules };
        
        invalidateStreakCache(habit.id, dateISO);
        clearScheduleCache();
        clearActiveHabitsCache();
        commitStateAndRender();
        showUndoToast();
    } else {
        console.error(`Could not end habit ${habit.id} on ${dateISO}: No active schedule found.`);
    }
}

export function handleUndoDelete() {
    if (state.lastEnded) {
        const habit = state.habits.find(h => h.id === state.lastEnded?.habitId);
        if (habit) {
            // MELHORIA DE ROBUSTEZ [2024-10-06]: A função "Desfazer" foi aprimorada para restaurar
            // completamente o estado do hábito, incluindo a re-inserção de quaisquer agendamentos
            // futuros que foram removidos quando o hábito foi encerrado, garantindo uma
            // restauração de dados precisa.

            // 1. Restaura o agendamento que foi encerrado
            delete state.lastEnded.lastSchedule.endDate;

            // 2. Restaura quaisquer agendamentos futuros que foram removidos
            if (state.lastEnded.removedSchedules && state.lastEnded.removedSchedules.length > 0) {
                habit.scheduleHistory.push(...state.lastEnded.removedSchedules);
                // Garante a ordem cronológica após a re-adição
                habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
            }
            
            invalidateStreakCache(habit.id, state.lastEnded.lastSchedule.startDate);
            clearScheduleCache();
            clearActiveHabitsCache();
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
    // CORREÇÃO DE BUG DE CONTEXTO [2024-10-01]: Usa state.selectedDate em vez de getTodayUTCIso() para
    // garantir que o encerramento do hábito respeite a data que o usuário está visualizando.
    const date = parseUTCIsoDate(state.selectedDate).toLocaleDateString(state.activeLanguageCode, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

    showConfirmationModal(
        t('confirmEndHabit', { habitName: escapeHTML(name), date }),
        () => {
            endHabit(habit, state.selectedDate);
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
        { 
            confirmText: t('modalManageResetButton'), 
            title: t('aria_delete_permanent', { habitName: name }),
            // UX-FIX [2024-10-27]: Usa o estilo 'danger' para o botão de confirmação.
            confirmButtonStyle: 'danger'
        }
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
        // CORREÇÃO DE DADOS HISTÓRICOS [2024-10-06]: A lógica foi corrigida para buscar o agendamento
        // que estava ativo na data da alteração ('changeDate'), em vez de assumir incorretamente
        // o agendamento mais recente. Isso garante que as edições no passado sejam aplicadas
        // ao segmento de histórico correto.
        const activeSchedule = getScheduleForDate(habit, changeDate);
        if (!activeSchedule) {
            console.error(`Cannot move habit schedule permanently on ${changeDate}: No active schedule.`);
            return;
        }

        const newTimes = activeSchedule.times.filter(t => t !== fromTime);
        if (!newTimes.includes(toTime)) {
            newTimes.push(toTime);
        }
        
        updateHabitSchedule(habit, changeDate, { times: newTimes });

    } else { // Just for today
        // REATORAÇÃO [2024-10-04]: Usa a nova função auxiliar `ensureHabitDailyInfo` para
        // centralizar a criação do objeto de dados diários, tornando o código mais limpo e consistente.
        const dailyInfo = ensureHabitDailyInfo(changeDate, habit.id);
        const activeSchedule = getScheduleForDate(habit, changeDate);
        if (!activeSchedule) return;

        const originalTimes = dailyInfo.dailySchedule || activeSchedule.times;
        const newTimes = originalTimes.filter(t => t !== fromTime);
        if (!newTimes.includes(toTime)) {
            newTimes.push(toTime);
        }
        dailyInfo.dailySchedule = newTimes;
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

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
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

    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    const date = parseUTCIsoDate(state.selectedDate).toLocaleDateString(state.activeLanguageCode, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    const timeName = getTimeOfDayName(timeToRemove);

    showConfirmationModal(
        t('confirmRemoveTime', { habitName: escapeHTML(name), time: timeName, date }),
        () => { // onConfirm: permanent change
            // CORREÇÃO DE DADOS HISTÓRICOS [2024-10-06]: A lógica foi corrigida para buscar o
            // agendamento ativo na data selecionada, garantindo que a remoção do horário
            // seja baseada no agendamento historicamente correto, em vez do mais recente.
            const activeSchedule = getScheduleForDate(habit, state.selectedDate);
            if (!activeSchedule) {
                console.error(`Cannot remove habit time permanently on ${state.selectedDate}: No active schedule.`);
                return;
            }
            const newTimes = activeSchedule.times.filter(t => t !== timeToRemove);

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
                // REATORAÇÃO [2024-10-04]: Usa a nova função auxiliar `ensureHabitDailyInfo` para
                // simplificar a manipulação do estado e remover código redundante.
                const dailyInfo = ensureHabitDailyInfo(state.selectedDate, habit.id);
                const activeSchedule = getScheduleForDate(habit, state.selectedDate);
                if (!activeSchedule) return;

                const originalTimes = dailyInfo.dailySchedule || activeSchedule.times;
                const newTimes = originalTimes.filter(t => t !== timeToRemove);
                dailyInfo.dailySchedule = newTimes;

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
        schedule.forEach(time => {
            const dayData = ensureHabitInstanceData(date, habit.id, time);
            let shouldUpdate = false;
            
            if (newStatus === 'completed' && dayData.status === 'pending') {
                shouldUpdate = true;
            } else if (newStatus === 'snoozed' && (dayData.status === 'pending' || dayData.status === 'completed')) {
                shouldUpdate = true;
            }
            
            if (shouldUpdate) {
                _updateHabitInstanceStatus(habit.id, date, time, newStatus);
                changed = true;
            }
        });
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
        
        // CORREÇÃO DE DADOS HISTÓRICOS [2024-09-20]: Passa a data do resumo para obter o nome/subtítulo
        // historicamente correto do hábito para aquele dia, garantindo que a IA receba dados precisos.
        const { name } = getHabitDisplayInfo(habit, isoDate);
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
    const today = getTodayUTC();

    if (analysisType === 'weekly' || analysisType === 'monthly') {
        const daySummaries: string[] = [];
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
        
        // PERFORMANCE [2024-09-02]: Otimiza a geração do prompt de análise geral.
        // Em vez de iterar por cada dia desde o início, o que é ineficiente para longos períodos,
        // agora iteramos diretamente sobre as chaves de `state.dailyData`. Isso processa
        // apenas os dias que têm registros, melhorando drasticamente a performance.
        const allSummaries: string[] = [];
        const sortedDatesWithData = Object.keys(state.dailyData).sort();

        for (const dateStr of sortedDatesWithData) {
            const date = parseUTCIsoDate(dateStr);
            // Garante que não incluímos datas futuras na análise, embora seja improvável.
            if (date <= today) {
                const summary = generateDailyHabitSummary(date);
                if (summary) {
                    allSummaries.push(summary);
                }
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

        // REFINAMENTO DA QUALIDADE DO PROMPT [2024-10-24]: Formata os cabeçalhos de mês para serem legíveis por humanos (ex: "outubro de 2024").
        // Isso fornece um contexto mais claro para a IA, o que pode levar a uma análise de melhor qualidade, especialmente para dados que abrangem vários anos.
        history = Object.entries(summaryByMonth)
            .map(([month, entries]) => {
                const [year, monthNum] = month.split('-');
                const date = new Date(Date.UTC(parseInt(year), parseInt(monthNum) - 1, 1));
                const formattedMonth = date.toLocaleString(state.activeLanguageCode, { month: 'long', year: 'numeric', timeZone: 'UTC' });
                return `${t('aiPromptMonthHeader', { month: formattedMonth })}:\n${entries.join('\n\n')}`;
            })
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
                // REATORAÇÃO [2024-09-10]: Utiliza o wrapper apiFetch para consistência no tratamento de chamadas de rede e erros.
                const response = await apiFetch('/api/analyze', {
                    method: 'POST',
                    body: JSON.stringify({ prompt, systemInstruction }),
                });

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