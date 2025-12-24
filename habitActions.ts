
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
 * 
 * ARQUITETURA (MVC Controller):
 * - Responsabilidade Única: Receber intenções do usuário (via listeners), validar regras de negócio,
 *   mutar o estado global (AppState) e disparar a renderização/persistência.
 * - Desacoplamento: Não manipula o DOM diretamente (delega para `render/`). Não acessa API bruta (delega para `services/`).
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: A estrutura de dados mutável. Alterações aqui propagam para todo o sistema.
 * - `services/persistence`: Garante a durabilidade dos dados (LocalStorage).
 * - `services/selectors`: Leitura otimizada do estado.
 * 
 * DECISÕES TÉCNICAS:
 * 1. Mutabilidade Controlada: O estado é mutado diretamente para performance (evitando clonagem profunda de objetos complexos),
 *    mas a consistência é garantida via funções de finalização (`_finalizeScheduleUpdate`) que invalidam caches.
 * 2. Lógica Temporal: Funções como `_requestFutureScheduleChange` implementam "Time-Travel", permitindo
 *    que hábitos mudem de propriedades no tempo sem perder o histórico passado.
 * 3. Batch Updates: Agrupa invalidações de cache para evitar Layout Thrashing.
 */

// ... (imports remain the same)
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
    HabitDayData
} from './state';
// ARCHITECTURE FIX: Import persistence logic from service layer.
import { saveState, clearLocalPersistence } from './services/persistence';
// ARCHITECTURE FIX: Import predefined habits from data layer, not state module.
import { PREDEFINED_HABITS } from './data/predefinedHabits';
import { getEffectiveScheduleForHabitOnDate, getActiveHabitsForDate, getScheduleForDate, isHabitNameDuplicate } from './services/selectors';
import { 
    generateUUID, 
    getTodayUTCIso, 
    toUTCIsoDateString, 
    addDays, 
    parseUTCIsoDate,
    triggerHaptic,
    getSafeDate,
    getDateTimeFormat
} from './utils';
import { 
    closeModal, 
    openModal, 
    showConfirmationModal, 
    openEditModal, 
    renderAINotificationState,
    clearHabitDomCache,
    setupManageModal
} from './render';
import { ui } from './render/ui';
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
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
    } else {
        // PERFORMANCE: Limpeza leve. Apenas revalida quais hábitos aparecem hoje.
        clearActiveHabitsCache();
    }
    
    // Dirty Flags para o Loop de Renderização
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    
    // IO Assíncrono (LocalStorage)
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

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const targetDate = getSafeDate(state.selectedDate);
    const { name } = getHabitDisplayInfo(habit, targetDate);
    
    const dateObj = parseUTCIsoDate(targetDate);
    const formattedDate = getDateTimeFormat(state.activeLanguageCode, {
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC'
    }).format(dateObj);
    
    showConfirmationModal(
        t('confirmEndHabit', { habitName: name, date: formattedDate }),
        () => {
            _requestFutureScheduleChange(habitId, targetDate, (schedule) => {
                schedule.endDate = targetDate;
                return schedule;
            });
            
            closeModal(ui.manageModal);
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
        () => {
            // 1. Remove from Metadata
            state.habits = state.habits.filter(h => h.id !== habitId);
            
            // 2. Remove from Hot Storage
            Object.values(state.dailyData).forEach(day => {
                delete day[habitId];
            });

            // PERFORMANCE: Garbage Collection de Arquivos Mortos (Cold Storage)
            // Evita percorrer todos os arquivos se o hábito for recente.
            const earliestDate = habit.scheduleHistory[0]?.startDate || habit.createdOn;
            const startYear = parseInt(earliestDate.substring(0, 4), 10);

            // 3. Remove from Cold Storage (Archives) & Update Warm Cache
            for (const year in state.archives) {
                // Skip years before the habit existed
                if (parseInt(year, 10) < startYear) continue;

                try {
                    let yearData: any;
                    let isFromCache = false;

                    // Optimization: Check if already parsed in memory
                    if (state.unarchivedCache.has(year)) {
                        yearData = state.unarchivedCache.get(year);
                        isFromCache = true;
                    } else {
                        yearData = JSON.parse(state.archives[year]);
                    }

                    let yearWasModified = false;
                    
                    for (const date in yearData) {
                        if (yearData[date][habitId]) {
                            delete yearData[date][habitId];
                            yearWasModified = true;
                        }
                        if (Object.keys(yearData[date]).length === 0) {
                            delete yearData[date];
                            yearWasModified = true;
                        }
                    }

                    if (yearWasModified) {
                        // Update Cold Storage
                        if (Object.keys(yearData).length === 0) {
                            delete state.archives[year];
                            state.unarchivedCache.delete(year); // Clean empty cache entry
                        } else {
                            state.archives[year] = JSON.stringify(yearData);
                            // Update Warm Cache in-place if it existed
                            if (isFromCache) {
                                state.unarchivedCache.set(year, yearData);
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Error cleaning archive for year ${year}:`, e);
                }
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

export function resetApplicationData() {
    state.habits = [];
    state.dailyData = {};
    state.archives = {};
    state.notificationsShown = [];
    state.pending21DayHabitIds = [];
    state.pendingConsolidationHabitIds = [];
    
    clearLocalPersistence();
    clearKey();
    
    location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;

    const { habitId, date, time } = state.editingNoteFor;
    const noteContent = ui.notesTextarea.value.trim();

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

export async function performAIAnalysis(analysisType: 'monthly' | 'quarterly' | 'historical') {
    if (state.aiState === 'loading') return;

    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    renderAINotificationState();
    closeModal(ui.aiOptionsModal);

    try {
        const translations: any = {
            promptTemplate: t('aiPromptTemplate'),
            aiPromptGraduatedSection: t('aiPromptGraduatedSection'),
            aiPromptNoData: t('aiPromptNoData'),
            aiPromptNone: t('aiPromptNone'),
            aiSystemInstruction: t('aiSystemInstruction'),
        };
        PREDEFINED_HABITS.forEach(h => {
            translations[h.nameKey] = t(h.nameKey);
        });

        // PERFORMANCE: Off-Main-Thread Architecture.
        // A construção do prompt (parse de JSON massivo, strings) ocorre no Worker.
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

        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
        });

        const text = await response.text();
        state.lastAIResult = text;
        state.aiState = 'completed';
    } catch (error) {
        console.error("AI Analysis failed", error);
        state.lastAIError = String(error);
        state.aiState = 'error';
        state.lastAIResult = t('aiErrorGeneric');
    } finally {
        saveState();
        renderAINotificationState();
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
                loadState(data);
                saveState();
                document.dispatchEvent(new CustomEvent('render-app'));
                document.dispatchEvent(new CustomEvent('habitsChanged'));
                
                closeModal(ui.manageModal);
                alert(t('importSuccess'));
            } else {
                alert(t('importInvalid'));
            }
        } catch (err) {
            console.error(err);
            alert(t('importError'));
        }
    };
    input.click();
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const instance = ensureHabitInstanceData(date, habitId, time);
    const oldStatus = instance.status;
    const newStatus = getNextStatus(oldStatus);
    
    // REFACTOR [2025-03-18]: Logic centralized in helper
    if (_updateHabitInstanceStatus(habit, instance, newStatus)) {
        // PERFORMANCE: Invalida caches granularmente para apenas este hábito nesta data.
        invalidateCachesForDateChange(date, [habitId]);
        
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        
        saveState();
        
        document.dispatchEvent(new CustomEvent('render-app'));
        document.dispatchEvent(new CustomEvent('habitsChanged'));
    }
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
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
    // PERFORMANCE OPTIMIZATION [2025-03-16]: Pre-parse date to avoid parsing inside loop selectors.
    const dateObj = parseUTCIsoDate(dateISO);
    const activeHabits = getActiveHabitsForDate(dateISO, dateObj);
    
    let changed = false;
    const changedHabitIds = new Set<string>();
    
    activeHabits.forEach(({ habit, schedule }) => {
        const dailyInfo = ensureHabitDailyInfo(dateISO, habit.id);
        
        schedule.forEach(time => {
            dailyInfo.instances[time] ??= { status: 'pending' };
            const instance = dailyInfo.instances[time]!;
            
            // REFACTOR [2025-03-18]: Use unified logic helper
            if (_updateHabitInstanceStatus(habit, instance, status)) {
                changed = true;
                changedHabitIds.add(habit.id);
            }
        });
    });
    
    if (changed) {
        // Batch invalidation
        invalidateCachesForDateChange(dateISO, Array.from(changedHabitIds));
        
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        saveState();
        
        document.dispatchEvent(new CustomEvent('habitsChanged'));
    }
    return changed;
}