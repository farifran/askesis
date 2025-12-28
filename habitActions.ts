/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file habitActions.ts
 * @description Controlador de Lógica de Negócios (Business Logic Controller).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo roda na thread principal e orquestra mutações de estado seguidas de atualizações de UI.
 * O foco é manter a responsividade da UI (60fps), delegando tarefas pesadas.
 * 
 * ARQUITETURA (MVC Controller):
 * - Responsabilidade Única: Receber intenções do usuário (via listeners), validar regras de negócio,
 *   mutar o estado global (AppState) e disparar a renderização/persistência.
 * - Desacoplamento: Não manipula o DOM diretamente (delega para `render/`). Não acessa API bruta (delega para `services/`).
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: A estrutura de dados mutável. Alterações aqui propagam para todo o sistema.
 * - `services/persistence.ts`: Garante a durabilidade dos dados (LocalStorage).
 * - `services/selectors.ts`: Leitura otimizada do estado.
 * 
 * DECISÕES TÉCNICAS:
 * 1. Mutabilidade Controlada: O estado é mutado diretamente para performance (evitando clonagem profunda de objetos complexos),
 *    mas a consistência é garantida via funções de finalização (`_finalizeScheduleUpdate`) que invalidam caches.
 * 2. Lógica Temporal: Funções como `_requestFutureScheduleChange` implementam "Time-Travel", permitindo
 *    que hábitos mudem de propriedades no tempo sem perder o histórico passado.
 * 3. Batch Updates: Agrupa invalidações de cache para evitar Layout Thrashing (recalculos de layout desnecessários).
 */

import { 
    state, 
    Habit, 
    HabitSchedule, 
    TimeOfDay, 
    ensureHabitDailyInfo, 
    ensureHabitInstanceData, 
    getNextStatus, 
    HabitStatus,
    clearScheduleCache,
    clearActiveHabitsCache,
    invalidateCachesForDateChange,
    getPersistableState,
    HabitDayData,
    STREAK_SEMI_CONSOLIDATED,
    STREAK_CONSOLIDATED,
    getHabitDailyInfoForDate,
    AppState,
    isDateLoading
} from './state';
import { saveState, clearLocalPersistence } from './services/persistence';
import { PREDEFINED_HABITS } from './data/predefinedHabits';
import { 
    getEffectiveScheduleForHabitOnDate, 
    getActiveHabitsForDate, 
    isHabitNameDuplicate,
    clearSelectorInternalCaches,
    calculateHabitStreak,
    shouldHabitAppearOnDate,
    getHabitDisplayInfo
} from './services/selectors';
import { 
    generateUUID, 
    getTodayUTCIso, 
    parseUTCIsoDate,
    triggerHaptic,
    getSafeDate
} from './utils';
import { 
    closeModal, 
    showConfirmationModal, 
    openEditModal, 
    renderAINotificationState,
    clearHabitDomCache
} from './render';
import { ui } from './render/ui';
import { t, getTimeOfDayName, formatDate } from './i18n'; // SOPA Update: formatDate
import { runWorkerTask } from './services/cloud';
import { apiFetch, clearKey } from './services/api';

// --- PRIVATE HELPERS ---

/**
 * Finaliza uma transação de mutação de estado.
 * PERFORMANCE: Centraliza a invalidação de cache e o disparo de eventos.
 * @param affectsHistory Se true, invalida caches estruturais profundos (histórico, DOM elements). Se false, apenas caches de visualização diária.
 */
function _finalizeScheduleUpdate(affectsHistory: boolean = true) {
    if (affectsHistory) {
        // PERFORMANCE: Limpeza pesada. Força recriação de DOM elements e recálculo de streaks.
        clearScheduleCache();
        clearHabitDomCache();
        // ROBUSTNESS [2025-03-27]: Limpa caches internos de seletores (ex: datas memoizadas) para evitar vazamento em mudanças estruturais.
        clearSelectorInternalCaches();
    } else {
        // PERFORMANCE: Limpeza leve. Apenas revalida quais hábitos aparecem hoje.
        clearActiveHabitsCache();
    }
    
    // Dirty Flags para o Loop de Renderização
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    
    // IO Assíncrono (IndexedDB)
    // FIRE-AND-FORGET: Não esperamos a Promise aqui para manter a UI responsiva.
    // O saveState trata erros internamente.
    saveState();
    
    // Event Bus para notificar componentes desacoplados
    document.dispatchEvent(new CustomEvent('render-app'));
    // EVOLUTION [2025-03-16]: Update PWA Badge immediately after structural changes.
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

/**
 * CRITICAL LOGIC: Temporal State Bifurcation.
 * Gerencia a complexidade de alterar um hábito "de agora em diante" sem reescrever o passado.
 * Cria uma nova entrada no `scheduleHistory` se necessário, preservando a integridade histórica.
 * DO NOT REFACTOR: A lógica de índices e datas é sensível a erros de "off-by-one".
 */
function _requestFutureScheduleChange(
    habitId: string, 
    targetDate: string, 
    updateFn: (schedule: HabitSchedule) => HabitSchedule
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // 1. Encontra o agendamento ativo na data alvo
    let activeScheduleIndex = -1;
    for (let i = habit.scheduleHistory.length - 1; i >= 0; i--) {
        const s = habit.scheduleHistory[i];
        if (targetDate >= s.startDate && (!s.endDate || targetDate < s.endDate)) {
            activeScheduleIndex = i;
            break;
        }
    }

    if (activeScheduleIndex !== -1) {
        // --- CAMINHO A: MODIFICANDO UM AGENDAMENTO ATIVO ---
        const currentSchedule = habit.scheduleHistory[activeScheduleIndex];

        // 2. Decide se atualiza in-place ou bifurca o histórico
        if (currentSchedule.startDate === targetDate) {
            // Se a mudança começa exatamente no início do agendamento atual, atualizamos in-place.
            habit.scheduleHistory[activeScheduleIndex] = updateFn({ ...currentSchedule });
        } else {
            // Bifurcação: Encerra o agendamento atual ontem e começa um novo hoje.
            currentSchedule.endDate = targetDate;

            const newSchedule = updateFn({ 
                ...currentSchedule, 
                startDate: targetDate, 
                endDate: undefined
            });
            
            habit.scheduleHistory.push(newSchedule);
            habit.scheduleHistory.sort((a, b) => (a.startDate > b.startDate ? 1 : -1));
        }
    } else {
        // --- CAMINHO B: "REATIVANDO" UM HÁBITO ---
        // Nenhum agendamento ativo encontrado. Isso significa que o hábito foi encerrado ou graduado,
        // e o usuário está reativando-o a partir de uma data futura.
        
        const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        if (!lastSchedule) {
            console.error(`Não é possível modificar o hábito ${habitId}: Nenhum histórico de agendamento encontrado.`);
            return;
        }

        const newSchedule = updateFn({ 
            ...lastSchedule, 
            startDate: targetDate, 
            endDate: undefined // Esta é a parte crucial que o torna ativo novamente.
        });

        if (lastSchedule.endDate && lastSchedule.endDate > targetDate) {
            lastSchedule.endDate = targetDate;
        }
        
        habit.graduatedOn = undefined;

        habit.scheduleHistory.push(newSchedule);
        habit.scheduleHistory.sort((a, b) => (a.startDate > b.startDate ? 1 : -1));
    }
    
    _finalizeScheduleUpdate(true);
}

/**
 * REFACTOR [2025-03-18]: Helper to centralize status mutations and side effects (like goal overrides).
 * Returns true if the status effectively changed.
 */
function _updateHabitInstanceStatus(
    habit: Habit, 
    instance: HabitDayData, 
    newStatus: HabitStatus
): boolean {
    if (instance.status === newStatus) return false;

    instance.status = newStatus;

    // Special handling for 'Check' type habits:
    // When completed, they should have a goal of 1 (100%).
    // When pending/snoozed, override is removed to fallback to default logic.
    if (habit.goal.type === 'check') {
        if (newStatus === 'completed') {
            instance.goalOverride = 1;
        } else {
            instance.goalOverride = undefined;
        }
    }
    return true;
}

/**
 * Verifica se o hábito atingiu marcos de consistência (21 ou 66 dias)
 * e agenda a celebração pela IA se ainda não foi mostrada.
 */
function _checkStreakMilestones(habitId: string, dateISO: string) {
    const streak = calculateHabitStreak(habitId, dateISO);
    
    // Check 21 Days (Semi-Consolidation)
    if (streak === STREAK_SEMI_CONSOLIDATED) {
        const notificationKey = `${habitId}-${STREAK_SEMI_CONSOLIDATED}`;
        if (!state.notificationsShown.includes(notificationKey) && !state.pending21DayHabitIds.includes(habitId)) {
            state.pending21DayHabitIds.push(habitId);
            renderAINotificationState();
        }
    }
    
    // Check 66 Days (Consolidation)
    if (streak === STREAK_CONSOLIDATED) {
        const notificationKey = `${habitId}-${STREAK_CONSOLIDATED}`;
        if (!state.notificationsShown.includes(notificationKey) && !state.pendingConsolidationHabitIds.includes(habitId)) {
            state.pendingConsolidationHabitIds.push(habitId);
            renderAINotificationState();
        }
    }
}

// ... (export functions)

export function createDefaultHabit() {
    const defaultTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (defaultTemplate) {
        const newHabit: Habit = {
            id: generateUUID(),
            createdOn: getTodayUTCIso(),
            icon: defaultTemplate.icon,
            color: defaultTemplate.color,
            goal: defaultTemplate.goal,
            scheduleHistory: [{
                startDate: getTodayUTCIso(),
                times: defaultTemplate.times,
                frequency: defaultTemplate.frequency,
                nameKey: defaultTemplate.nameKey,
                subtitleKey: defaultTemplate.subtitleKey,
                scheduleAnchor: getTodayUTCIso()
            }]
        };
        state.habits.push(newHabit);
        _finalizeScheduleUpdate(true);
    }
}

export function reorderHabit(movedHabitId: string, targetHabitId: string, position: 'before' | 'after', skipFinalize = false) {
    // PERFORMANCE: Operação O(N) em array pequeno (<100 itens), aceitável na Main Thread.
    const movedIndex = state.habits.findIndex(h => h.id === movedHabitId);
    const targetIndex = state.habits.findIndex(h => h.id === targetHabitId);

    if (movedIndex === -1 || targetIndex === -1) return;

    const [movedHabit] = state.habits.splice(movedIndex, 1);
    
    const newTargetIndex = (movedIndex < targetIndex) ? targetIndex - 1 : targetIndex;
    
    const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
    state.habits.splice(insertIndex, 0, movedHabit);

    if (!skipFinalize) {
        _finalizeScheduleUpdate(false);
    }
}

// LOGIC LOCK: Manipula a complexidade de UI do Drag & Drop transformando-a em lógica de estado.
export function handleHabitDrop(
    habitId: string, 
    fromTime: TimeOfDay, 
    toTime: TimeOfDay,
    reorderInfo?: { id: string, pos: 'before' | 'after' }
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = getSafeDate(state.selectedDate);

    // Opção 1: Alteração Temporária (Override na DailyData)
    const applyJustToday = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        const currentSchedule = [...getEffectiveScheduleForHabitOnDate(habit, targetDate)];

        const fromIndex = currentSchedule.indexOf(fromTime);
        if (fromIndex > -1) {
            currentSchedule.splice(fromIndex, 1);
        }
        
        let toIndex = currentSchedule.indexOf(toTime);
        if (toIndex === -1) {
            currentSchedule.push(toTime);
        }

        dailyInfo.dailySchedule = currentSchedule;
        
        if (reorderInfo) {
            const reorderTargetHabit = state.habits.find(h => h.id === reorderInfo.id);
            if (reorderTargetHabit) {
                reorderHabit(habitId, reorderInfo.id, reorderInfo.pos, true);
            }
        }
        
        _finalizeScheduleUpdate(false);
    };

    // Opção 2: Alteração Permanente (Novo Schedule no History)
    const applyFromNowOn = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        
        // Remove override local se existir, pois a regra permanente terá precedência
        const currentOverride = dailyInfo.dailySchedule ? [...dailyInfo.dailySchedule] : null;

        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        if (reorderInfo) {
            reorderHabit(habitId, reorderInfo.id, reorderInfo.pos, true);
        }

        _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
            scheduleToUpdate.times = [...scheduleToUpdate.times];

            // Se havia um override hoje, usamos ele como base para a nova regra permanente
            if (currentOverride) {
                scheduleToUpdate.times = currentOverride;
            }

            const fromIndex = scheduleToUpdate.times.indexOf(fromTime);
            if (fromIndex > -1) {
                scheduleToUpdate.times.splice(fromIndex, 1);
            }
            if (!scheduleToUpdate.times.includes(toTime)) {
                scheduleToUpdate.times.push(toTime);
            }
            return scheduleToUpdate;
        });
    };
    
    const timeNames = { oldTime: getTimeOfDayName(fromTime), newTime: getTimeOfDayName(toTime) };
    const habitName = getHabitDisplayInfo(habit, targetDate).name;

    showConfirmationModal(
        t('confirmHabitMove', { habitName, ...timeNames }),
        applyFromNowOn,
        {
            title: t('modalMoveHabitTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: applyJustToday
        }
    );
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    const { isNew, habitId, formData, targetDate } = state.editingHabit;

    if (formData.name) {
        formData.name = formData.name.trim();
    }
    const displayName = formData.nameKey ? t(formData.nameKey) : formData.name;

    if (!displayName) {
        return; 
    }
    if (isHabitNameDuplicate(displayName, habitId)) {
        console.warn(`Save blocked due to duplicate name: "${displayName}"`);
        return;
    }
    
    if (isNew) {
        const newHabit: Habit = {
            id: generateUUID(),
            createdOn: targetDate,
            icon: formData.icon,
            color: formData.color,
            goal: formData.goal,
            scheduleHistory: [{
                startDate: targetDate,
                times: formData.times,
                frequency: formData.frequency,
                name: formData.name,
                nameKey: formData.nameKey,
                subtitleKey: formData.subtitleKey,
                scheduleAnchor: targetDate
            }]
        };
        state.habits.push(newHabit);
        _finalizeScheduleUpdate(true);
    } else {
        const habit = state.habits.find(h => h.id === habitId);
        if (!habit) return;

        // Atualizações visuais são retroativas (ícone/cor/meta)
        habit.icon = formData.icon;
        habit.color = formData.color;
        habit.goal = formData.goal;

        // Limpa overrides conflitantes
        const dailyInfo = ensureHabitDailyInfo(targetDate, habit.id);
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        // Edge Case: Editando um hábito antes de ele existir na timeline
        const firstSchedule = habit.scheduleHistory[0];

        if (targetDate < firstSchedule.startDate) {
            firstSchedule.startDate = targetDate;
            firstSchedule.name = formData.name;
            firstSchedule.nameKey = formData.nameKey;
            firstSchedule.times = formData.times;
            firstSchedule.frequency = formData.frequency;
            firstSchedule.scheduleAnchor = targetDate;
            
            _finalizeScheduleUpdate(true);
        } else {
            // Caso padrão: Time-Travel logic
            _requestFutureScheduleChange(habit.id, targetDate, (schedule) => {
                schedule.name = formData.name;
                schedule.nameKey = formData.nameKey;
                schedule.times = formData.times;
                schedule.frequency = formData.frequency;
                return schedule;
            });
        }
    }

    closeModal(ui.editHabitModal);
    state.editingHabit = null;
}

// PERFORMANCE [2025-04-13]: Hoisted Intl Options.
const OPTS_CONFIRM_DATE: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
};

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const targetDate = getSafeDate(state.selectedDate);
    const { name } = getHabitDisplayInfo(habit, targetDate);
    
    const dateObj = parseUTCIsoDate(targetDate);
    // SOPA Update: Use hoisted options
    const formattedDate = formatDate(dateObj, OPTS_CONFIRM_DATE);
    
    showConfirmationModal(
        t('confirmEndHabit', { habitName: name, date: formattedDate }),
        () => {
            _requestFutureScheduleChange(habitId, targetDate, (schedule) => {
                schedule.endDate = targetDate;
                return schedule;
            });
            // UX FIX [2025-03-22]: Não fecha o modal de Gerenciar Hábitos ao encerrar um hábito.
            // Isso permite que o usuário veja o status atualizado na lista e continue gerenciando outros itens.
            // O update de estado disparado por _finalizeScheduleUpdate fará a UI atualizar.
        },
        { confirmButtonStyle: 'danger', confirmText: t('endButton') }
    );
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmPermanentDelete', { habitName: name }),
        async () => { 
            // 1. Remove from Metadata (Mutable State)
            state.habits = state.habits.filter(h => h.id !== habitId);
            
            // 2. Remove from Hot Storage (Daily Data)
            // PERFORMANCE: Object.keys iteration is O(N) where N is cached days (usually < 90). Fast enough.
            Object.values(state.dailyData).forEach(day => {
                delete day[habitId];
            });

            // 3. Remove from Cold Storage (Worker Offload)
            // STATE OF THE ART [2025-04-06]: Offload heavy decompression/parsing to worker.
            // The Main Thread is blocked by JSON.parse/stringify of 1MB+ strings.
            const earliestDate = habit.scheduleHistory[0]?.startDate || habit.createdOn;
            const startYear = parseInt(earliestDate.substring(0, 4), 10);

            try {
                // Send job to worker. Returns a map of updated GZIP strings for affected years.
                const updatedArchives = await runWorkerTask<AppState['archives']>('prune-habit', {
                    habitId,
                    archives: state.archives,
                    startYear
                });

                // Apply updates atomically to Cold Storage
                for (const year in updatedArchives) {
                    const newValue = updatedArchives[year];
                    if (newValue === "") {
                        // Empty string signal -> Delete year
                        delete state.archives[year];
                        state.unarchivedCache.delete(year);
                    } else {
                        state.archives[year] = newValue;
                        // Invalidate memory cache so next read fetches fresh data from archive
                        state.unarchivedCache.delete(year);
                    }
                }
            } catch (e) {
                console.error("Worker pruning failed:", e);
                // Fail-safe: Data might be stale in archives, but Hot Storage is clean.
                // Next sync might perform a merge where deletion propagates if logic allows,
                // or data remains in archives as "orphaned". 
            }
            
            _finalizeScheduleUpdate(true);
            
            if (ui.manageModal.classList.contains('visible')) {
                closeModal(ui.manageModal);
            }
        },
        { confirmButtonStyle: 'danger', confirmText: t('deleteButton') }
    );
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        closeModal(ui.manageModal);
        openEditModal(habit);
    }
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const targetDate = getSafeDate(state.selectedDate);
    habit.graduatedOn = targetDate;
    _finalizeScheduleUpdate(true);
    closeModal(ui.manageModal);
    
    triggerHaptic('success');
}

export async function resetApplicationData() {
    state.habits = [];
    state.dailyData = {};
    state.archives = {};
    state.notificationsShown = [];
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    
    // Aguarda a limpeza do banco antes de recarregar
    await clearLocalPersistence();
    clearKey();
    
    location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;

    const { habitId, date, time } = state.editingNoteFor;
    const noteContent = ui.notesTextarea.value.trim();

    // SAFETY CHECK: Data loading guard
    if (isDateLoading(date)) {
        console.warn('Attempted to save note while data is loading.');
        return;
    }

    const instance = ensureHabitInstanceData(date, habitId, time);

    // OTIMIZAÇÃO: Evita gravação se o conteúdo não mudou.
    if ((instance.note || '') !== noteContent) {
        if (noteContent) {
            instance.note = noteContent;
        } else {
            delete instance.note;
        }

        state.uiDirtyState.habitListStructure = true;
        saveState();
        document.dispatchEvent(new CustomEvent('render-app'));
    }

    closeModal(ui.notesModal);
}

// Concurrency Guard: Simple timestamp ID to reject stale responses.
let lastAIRequestId = 0;

export async function performAIAnalysis(analysisType: 'monthly' | 'quarterly' | 'historical') {
    if (state.aiState === 'loading') return;

    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    
    // RACE CONDITION GUARD: Increment ID. Only matches of the current ID will apply.
    const requestId = ++lastAIRequestId;
    
    renderAINotificationState();
    closeModal(ui.aiOptionsModal);

    try {
        // BUGFIX [2025-03-22]: Seleção dinâmica da chave de tradução baseada no tipo de análise.
        let promptTemplateKey = 'aiPromptGeneral'; // Fallback para 'historical'
        if (analysisType === 'monthly') {
            promptTemplateKey = 'aiPromptMonthly';
        } else if (analysisType === 'quarterly') {
            promptTemplateKey = 'aiPromptQuarterly';
        }

        // TYPE SAFETY FIX: Strict typing for worker payload map.
        const translations: Record<string, string> = {
            promptTemplate: t(promptTemplateKey),
            aiPromptGraduatedSection: t('aiPromptGraduatedSection'),
            aiPromptNoData: t('aiPromptNoData'),
            aiPromptNone: t('aiPromptNone'),
            aiSystemInstruction: t('aiSystemInstruction'),
        };
        
        // REFACTOR [2025-04-07]: Zero-allocation loop (substitui forEach)
        for (const h of PREDEFINED_HABITS) {
            translations[h.nameKey] = t(h.nameKey);
        }

        // PERFORMANCE: Off-Main-Thread Architecture.
        const { prompt, systemInstruction } = await runWorkerTask<{ prompt: string, systemInstruction: string }>(
            'build-ai-prompt',
            {
                analysisType,
                habits: state.habits,
                dailyData: state.dailyData,
                archives: state.archives,
                languageName: t(state.activeLanguageCode === 'pt' ? 'langPortuguese' : (state.activeLanguageCode === 'es' ? 'langSpanish' : 'langEnglish')),
                translations,
                todayISO: getTodayUTCIso()
            }
        );

        // STALE CHECK: User triggered another analysis?
        if (requestId !== lastAIRequestId) return;

        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
        });

        const text = await response.text();
        
        // STALE CHECK: Late response?
        if (requestId !== lastAIRequestId) return;

        state.lastAIResult = text;
        state.aiState = 'completed';
    } catch (error) {
        if (requestId !== lastAIRequestId) return; // Ignore errors from stale requests
        
        console.error("AI Analysis failed", error);
        state.lastAIError = String(error);
        state.aiState = 'error';
        state.lastAIResult = t('aiErrorGeneric');
    } finally {
        if (requestId === lastAIRequestId) {
            saveState();
            renderAINotificationState();
        }
    }
}

export function exportData() {
    const dataStr = JSON.stringify(getPersistableState(), null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `askesis-backup-${getTodayUTCIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

export function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        
        const { loadState, saveState } = await import('./services/persistence');
        
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (data.habits && data.version) {
                await loadState(data);
                await saveState(); // Async IDB save
                document.dispatchEvent(new CustomEvent('render-app'));
                document.dispatchEvent(new CustomEvent('habitsChanged'));
                
                closeModal(ui.manageModal);
                
                // UX IMPROVEMENT (SOTA): Native-like feedback instead of browser alert
                showConfirmationModal(
                    t('importSuccess'),
                    () => {}, // No-op on confirm
                    {
                        title: t('privacyLabel'), // "Data & Privacy"
                        confirmText: 'OK',
                        hideCancel: true
                    }
                );
            } else {
                showConfirmationModal(
                    t('importInvalid'),
                    () => {},
                    {
                        title: t('importError'),
                        confirmText: 'OK',
                        hideCancel: true,
                        confirmButtonStyle: 'danger'
                    }
                );
            }
        } catch (err) {
            console.error(err);
            showConfirmationModal(
                t('importError'),
                () => {},
                {
                    title: 'Error',
                    confirmText: 'OK',
                    hideCancel: true,
                    confirmButtonStyle: 'danger'
                }
            );
        }
    };
    input.click();
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // SAFETY CHECK: Prevent writing to uninitialized cold storage
    if (isDateLoading(date)) {
        console.warn('Attempted to toggle habit while data is loading.');
        return;
    }

    const instance = ensureHabitInstanceData(date, habitId, time);
    const oldStatus = instance.status;
    const newStatus = getNextStatus(oldStatus);
    
    // REFACTOR [2025-03-18]: Logic centralized in helper
    if (_updateHabitInstanceStatus(habit, instance, newStatus)) {
        // PERFORMANCE: Invalida caches granularmente para apenas este hábito nesta data.
        invalidateCachesForDateChange(date, [habitId]);
        
        // BUGFIX [2025-03-27]: Verifica marcos de consistência (21/66 dias)
        // Se o novo status for 'completed', verificamos se atingiu um marco.
        if (newStatus === 'completed') {
            // Nota: invalidateCachesForDateChange limpou o cache de streak,
            // então a chamada dentro de _checkStreakMilestones calculará o novo valor correto.
            _checkStreakMilestones(habitId, date);
        }
        
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        
        saveState();
        
        document.dispatchEvent(new CustomEvent('render-app'));
        document.dispatchEvent(new CustomEvent('habitsChanged'));
    }
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
    // SAFETY CHECK: Prevent writing to uninitialized cold storage
    if (isDateLoading(date)) {
        console.warn('Attempted to set goal while data is loading.');
        return;
    }

    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.goalOverride = value;
    
    invalidateCachesForDateChange(date, [habitId]);
    
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    
    document.dispatchEvent(new CustomEvent('render-app'));
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = getSafeDate(state.selectedDate); 
    const { name } = getHabitDisplayInfo(habit, targetDate);
    const timeName = getTimeOfDayName(time);
    
    const confirmDeletion = () => {
        // SAFETY CHECK: Prevent writing to uninitialized cold storage
        if (isDateLoading(targetDate)) {
            console.warn('Attempted to remove habit time while data is loading.');
            return;
        }

        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        
        if (dailyInfo.dailySchedule) {
            delete dailyInfo.dailySchedule;
        }

        _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
            scheduleToUpdate.times = [...scheduleToUpdate.times];

            const index = scheduleToUpdate.times.indexOf(time);
            if (index > -1) {
                scheduleToUpdate.times.splice(index, 1);
            }
            return scheduleToUpdate;
        });
    };

    showConfirmationModal(
        t('confirmRemoveTimePermanent', { habitName: name, time: timeName }),
        confirmDeletion,
        {
            title: t('modalRemoveTimeTitle'), 
            confirmText: t('deleteButton'),
            confirmButtonStyle: 'danger' 
        }
    );
}

export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    // SAFETY CHECK: Prevent mass writing to uninitialized cold storage
    if (isDateLoading(dateISO)) {
        console.warn('Attempted to batch update habits while data is loading.');
        return false;
    }

    // PERFORMANCE OPTIMIZATION [2025-04-06]: Zero-Allocation Loop.
    // Replace complex selector chain `getActiveHabitsForDate` (which allocates objects)
    // with a raw loop over the habit array. This is a hot path for "Quick Actions".
    
    const dateObj = parseUTCIsoDate(dateISO);
    
    // OPTIMIZATION [2025-04-07]: Hoist Hot Storage Hydration.
    // Ensure the day record exists in state.dailyData ONCE before the loop.
    // This avoids repeated checks/clones inside ensureHabitDailyInfo for every habit.
    if (!state.dailyData[dateISO]) {
        const archivedDay = getHabitDailyInfoForDate(dateISO);
        // Use a lightweight check for empty object if constant is not available here, 
        // or rely on the fact that getHabitDailyInfoForDate returns a fresh object if empty.
        // Actually, we can just use the logic from ensureHabitDailyInfo but manually inlined/hoisted.
        state.dailyData[dateISO] = (Object.keys(archivedDay).length > 0) 
            ? structuredClone(archivedDay) 
            : {};
    }
    
    // Direct reference to the hot storage day object
    const hotDayData = state.dailyData[dateISO];
    
    let changed = false;
    // We use a simple array instead of Set for iteration speed, pushing unique IDs only.
    const changedHabitIds: string[] = [];

    const habits = state.habits;
    const len = habits.length;

    for (let i = 0; i < len; i++) {
        const habit = habits[i];
        
        // Fast Check: Memoized Appearance
        if (!shouldHabitAppearOnDate(habit, dateISO, dateObj)) {
            continue;
        }

        const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
        if (schedule.length === 0) continue;

        // Optimization: Initialize habit entry directly
        hotDayData[habit.id] ??= { instances: {} };
        const dailyInfo = hotDayData[habit.id];
        
        let habitChanged = false;

        for (let j = 0; j < schedule.length; j++) {
            const time = schedule[j];
            dailyInfo.instances[time] ??= { status: 'pending' };
            const instance = dailyInfo.instances[time]!;
            
            // Unified logic helper
            if (_updateHabitInstanceStatus(habit, instance, status)) {
                habitChanged = true;
                changed = true;
            }
        }

        if (habitChanged) {
            changedHabitIds.push(habit.id);
        }
    }
    
    if (changed) {
        // Batch invalidation
        invalidateCachesForDateChange(dateISO, changedHabitIds);
        
        // Check milestones
        if (status === 'completed') {
            for (let k = 0; k < changedHabitIds.length; k++) {
                _checkStreakMilestones(changedHabitIds[k], dateISO);
            }
        }
        
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        saveState();
        
        document.dispatchEvent(new CustomEvent('habitsChanged'));
    }
    return changed;
}

/**
 * Lida com a transição automática da meia-noite.
 * Chamado quando o evento 'dayChanged' é disparado pelo Midnight Loop.
 */
export function handleDayTransition() {
    const newToday = getTodayUTCIso(); // Isso revalidará e pegará a nova data
    
    // Limpa caches que dependem da noção de "Hoje"
    clearActiveHabitsCache();
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.chartData = true;
    
    // Força reconstrução do array de datas do calendário para centralizar no novo dia
    state.calendarDates = [];

    // Se o usuário estava vendo "Hoje" (que agora é "Ontem"), atualiza para o novo "Hoje".
    // Isso é o comportamento padrão esperado de um app "vivo".
    if (state.selectedDate !== newToday) {
        state.selectedDate = newToday;
    }

    document.dispatchEvent(new CustomEvent('render-app'));
}