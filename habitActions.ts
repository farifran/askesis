
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
 * ARQUITETURA (Kernel-Managed IO):
 * - **Unified Data Access:** Toda a escrita de status e metas agora passa pelo `kernel`, que decide
 *   internamente se deve usar Atomics (Hot Path) ou Objetos (Cold Path).
 * - **Zero-Allocation:** Usa Pools estáticos e evita closures em loops críticos.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: A estrutura de dados mutável e o Kernel.
 * - `services/persistence.ts`: Garante a durabilidade dos dados.
 */

import { 
    state, 
    Habit, 
    HabitSchedule, 
    TimeOfDay, 
    ensureHabitDailyInfo, 
    ensureHabitInstanceData, 
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
    isDateLoading,
    HabitDailyInfo,
    resetKernel,
    kernel,
    KernelHabitStatus,
    MAX_DAYS_WINDOW,
    TIME_INDEX_MAP,
    isDateInKernelRange,
    getNextStatus,
    kernelToStatus
} from './state';
import { saveState, clearLocalPersistence } from './services/persistence';
import { PREDEFINED_HABITS } from './data/predefinedHabits';
import { 
    getEffectiveScheduleForHabitOnDate, 
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
    getSafeDate,
    addDays,
    toUTCIsoDateString
} from './utils';
import { 
    closeModal, 
    showConfirmationModal, 
    openEditModal, 
    renderAINotificationState,
    clearHabitDomCache
} from './render';
import { ui } from './render/ui';
import { t, getTimeOfDayName, formatDate } from './i18n'; 
import { runWorkerTask } from './services/cloud';
import { apiFetch, clearKey } from './services/api';

// --- STATIC MEMORY POOLS (Zero-Allocation) ---
// Used for batch operations to avoid GC pressure.
const _batchHabitIdsPool: string[] = [];
const _batchHabitsRefPool: Habit[] = [];

// --- STATIC TRANSACTION CONTEXT (Zero-Closure Pattern) ---
// Holds state for pending confirmations to avoid allocating closures in hot paths.
const ActionContext = {
    drop: null as { habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay, reorderInfo?: { id: string, pos: 'before' | 'after' } } | null,
    removal: null as { habitId: string, time: TimeOfDay, targetDate: string } | null,
    ending: null as { habitId: string, targetDate: string } | null,
    deletion: null as { habitId: string } | null
};

// --- PRIVATE HELPERS ---

/**
 * Finaliza uma transação de mutação de estado.
 * PERFORMANCE: Centraliza a invalidação de cache e o disparo de eventos.
 * @param affectsHistory Se true, invalida caches estruturais profundos.
 */
function _finalizeScheduleUpdate(affectsHistory: boolean = true) {
    if (affectsHistory) {
        // PERFORMANCE: Limpeza pesada.
        clearScheduleCache();
        clearHabitDomCache();
        // ROBUSTNESS: Limpa caches internos de seletores.
        clearSelectorInternalCaches();
    } else {
        // PERFORMANCE: Limpeza leve.
        clearActiveHabitsCache();
    }
    
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.calendarVisuals = true;
    
    // FIRE-AND-FORGET IO
    saveState();
    
    document.dispatchEvent(new CustomEvent('render-app'));
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

/**
 * CRITICAL LOGIC: Temporal State Bifurcation.
 * Gerencia a complexidade de alterar um hábito "de agora em diante".
 */
function _requestFutureScheduleChange(
    habitId: string, 
    targetDate: string, 
    updateFn: (schedule: HabitSchedule) => HabitSchedule
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Optimized reverse loop
    let activeScheduleIndex = -1;
    const history = habit.scheduleHistory;
    for (let i = history.length - 1; i >= 0; i--) {
        const s = history[i];
        if (targetDate >= s.startDate && (!s.endDate || targetDate < s.endDate)) {
            activeScheduleIndex = i;
            break;
        }
    }

    if (activeScheduleIndex !== -1) {
        const currentSchedule = history[activeScheduleIndex];

        if (currentSchedule.startDate === targetDate) {
            // Update in-place
            history[activeScheduleIndex] = updateFn({ ...currentSchedule });
        } else {
            // Bifurcation
            currentSchedule.endDate = targetDate;

            const newSchedule = updateFn({ 
                ...currentSchedule, 
                startDate: targetDate, 
                endDate: undefined
            });
            
            history.push(newSchedule);
            // Sort logic is required after push
            history.sort((a, b) => (a.startDate > b.startDate ? 1 : -1));
        }
    } else {
        // Reactivation logic
        const lastSchedule = history[history.length - 1];
        if (!lastSchedule) {
            console.error(`Cannot modify habit ${habitId}: No schedule history.`);
            return;
        }

        const newSchedule = updateFn({ 
            ...lastSchedule, 
            startDate: targetDate, 
            endDate: undefined 
        });

        if (lastSchedule.endDate && lastSchedule.endDate > targetDate) {
            lastSchedule.endDate = targetDate;
        }
        
        habit.graduatedOn = undefined;

        history.push(newSchedule);
        history.sort((a, b) => (a.startDate > b.startDate ? 1 : -1));
    }
    
    _finalizeScheduleUpdate(true);
}

/**
 * Checks for milestones.
 * SOPA OPTIMIZATION [2025-04-22]: Accepts Habit object directly.
 * Avoids O(N) lookup in selectors.
 */
function _checkStreakMilestones(habit: Habit, dateISO: string) {
    // Pass object reference directly
    const streak = calculateHabitStreak(habit, dateISO);
    
    if (streak === STREAK_SEMI_CONSOLIDATED) {
        const notificationKey = `${habit.id}-${STREAK_SEMI_CONSOLIDATED}`;
        if (!state.notificationsShown.includes(notificationKey) && !state.pending21DayHabitIds.includes(habit.id)) {
            state.pending21DayHabitIds.push(habit.id);
            renderAINotificationState();
        }
    }
    
    if (streak === STREAK_CONSOLIDATED) {
        const notificationKey = `${habit.id}-${STREAK_CONSOLIDATED}`;
        if (!state.notificationsShown.includes(notificationKey) && !state.pendingConsolidationHabitIds.includes(habit.id)) {
            state.pendingConsolidationHabitIds.push(habit.id);
            renderAINotificationState();
        }
    }
}

// --- STATIC CONFIRMATION HANDLERS (DROP) ---

const _applyDropJustToday = () => {
    const ctx = ActionContext.drop;
    if (!ctx) return;
    const { habitId, fromTime, toTime, reorderInfo } = ctx;
    
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const targetDate = getSafeDate(state.selectedDate);
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
    ActionContext.drop = null;
};

const _applyDropFromNowOn = () => {
    const ctx = ActionContext.drop;
    if (!ctx) return;
    const { habitId, fromTime, toTime, reorderInfo } = ctx;

    const targetDate = getSafeDate(state.selectedDate);
    const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
    
    const currentOverride = dailyInfo.dailySchedule ? [...dailyInfo.dailySchedule] : null;

    if (dailyInfo.dailySchedule) {
        dailyInfo.dailySchedule = undefined; 
    }

    if (reorderInfo) {
        reorderHabit(habitId, reorderInfo.id, reorderInfo.pos, true);
    }

    _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
        scheduleToUpdate.times = [...scheduleToUpdate.times];

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
    
    ActionContext.drop = null;
};

// --- STATIC CONFIRMATION HANDLERS (ACTIONS) ---

const _applyHabitEnding = () => {
    const ctx = ActionContext.ending;
    if (!ctx) return;
    const { habitId, targetDate } = ctx;

    _requestFutureScheduleChange(habitId, targetDate, (schedule) => {
        schedule.endDate = targetDate;
        return schedule;
    });
    
    ActionContext.ending = null;
};

const _applyHabitDeletion = async () => {
    const ctx = ActionContext.deletion;
    if (!ctx) return;
    const { habitId } = ctx;

    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    state.habits = state.habits.filter(h => h.id !== habitId);
    
    // For permanent deletion, 'delete' on the dictionary is acceptable as 
    // the object key is being removed forever.
    Object.values(state.dailyData).forEach(day => {
        delete day[habitId];
    });

    const earliestDate = habit.scheduleHistory[0]?.startDate || habit.createdOn;
    const startYear = parseInt(earliestDate.substring(0, 4), 10);

    try {
        const updatedArchives = await runWorkerTask<AppState['archives']>('prune-habit', {
            habitId,
            archives: state.archives,
            startYear
        });

        for (const year in updatedArchives) {
            const newValue = updatedArchives[year];
            if (newValue === "") {
                delete state.archives[year];
                state.unarchivedCache.delete(year);
            } else {
                state.archives[year] = newValue;
                state.unarchivedCache.delete(year);
            }
        }
    } catch (e) {
        console.error("Worker pruning failed:", e);
    }
    
    _finalizeScheduleUpdate(true);
    
    if (ui.manageModal.classList.contains('visible')) {
        closeModal(ui.manageModal);
    }
    
    ActionContext.deletion = null;
};

const _applyTimeRemoval = () => {
    const ctx = ActionContext.removal;
    if (!ctx) return;
    const { habitId, time, targetDate } = ctx;

    if (isDateLoading(targetDate)) {
        console.warn('Attempted to remove habit time while data is loading.');
        return;
    }

    const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
    
    // V8 OPTIMIZATION: undefined assignment
    if (dailyInfo.dailySchedule) {
        dailyInfo.dailySchedule = undefined;
    }

    _requestFutureScheduleChange(habitId, targetDate, (scheduleToUpdate) => {
        scheduleToUpdate.times = [...scheduleToUpdate.times];

        const index = scheduleToUpdate.times.indexOf(time);
        if (index > -1) {
            scheduleToUpdate.times.splice(index, 1);
        }
        return scheduleToUpdate;
    });
    
    ActionContext.removal = null;
};

// ... (export functions)

const ARCHIVE_THRESHOLD_DAYS = 90; 

export function performArchivalCheck() {
    const runArchive = async () => {
        const today = parseUTCIsoDate(getTodayUTCIso());
        const thresholdDate = addDays(today, -ARCHIVE_THRESHOLD_DAYS);
        const thresholdISO = toUTCIsoDateString(thresholdDate);
        
        const yearBuckets: Record<string, { additions: Record<string, Record<string, HabitDailyInfo>>, base?: any }> = {};
        const keysToRemove: string[] = [];

        // Object.keys is O(N) but N is small (cached days < 90 + margin)
        const dailyKeys = Object.keys(state.dailyData);
        for (const dateStr of dailyKeys) {
            if (dateStr < thresholdISO) {
                const year = dateStr.substring(0, 4);
                if (!yearBuckets[year]) {
                    yearBuckets[year] = { additions: {} };
                    if (state.unarchivedCache.has(year)) {
                        yearBuckets[year].base = state.unarchivedCache.get(year);
                    } else if (state.archives[year]) {
                        yearBuckets[year].base = state.archives[year];
                    }
                }
                yearBuckets[year].additions[dateStr] = state.dailyData[dateStr];
                keysToRemove.push(dateStr);
            }
        }

        if (keysToRemove.length === 0) return;

        try {
            console.log(`Offloading archive task for ${keysToRemove.length} days to worker...`);
            type ArchiveOutput = Record<string, string>;
            const newArchives = await runWorkerTask<ArchiveOutput>('archive', yearBuckets);

            let totalMoved = 0;

            for (const year in newArchives) {
                const additionsForYear = yearBuckets[year].additions;
                let isYearStale = false;

                // Validation
                for (const dateStr in additionsForYear) {
                    const originalDataSent = additionsForYear[dateStr];
                    const currentDataInState = state.dailyData[dateStr];
                    if (JSON.stringify(originalDataSent) !== JSON.stringify(currentDataInState)) {
                        isYearStale = true;
                        console.warn(`[ARCHIVE] Stale data detected for year ${year}. Aborting.`);
                        break; 
                    }
                }

                if (!isYearStale) {
                    state.archives[year] = newArchives[year];
                    state.unarchivedCache.delete(year);
                    
                    const keysForThisYear = Object.keys(additionsForYear);
                    // Optimized deletion: 'delete' here is necessary to free memory
                    for(const k of keysForThisYear) {
                        delete state.dailyData[k];
                    }
                    totalMoved += keysForThisYear.length;
                }
            }
            
            if (totalMoved > 0) {
                 console.log(`Archiving complete. Moved ${totalMoved} records.`);
                 await saveState();
            }

        } catch (e) {
            console.error("Archive task failed in worker:", e);
        }
    };

    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { runArchive().catch(console.error); }, { timeout: 10000 });
    } else {
        setTimeout(() => { runArchive().catch(console.error); }, 5000);
    }
}

export function createDefaultHabit() {
    const defaultTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (defaultTemplate) {
        // MONOMORPHISM: Ensure property order matches 'Habit' interface strictly
        const newHabit: Habit = {
            id: generateUUID(),
            icon: defaultTemplate.icon,
            color: defaultTemplate.color,
            goal: defaultTemplate.goal,
            createdOn: getTodayUTCIso(),
            graduatedOn: undefined, // Explicit undefined for shape stability
            scheduleHistory: [{
                startDate: getTodayUTCIso(),
                endDate: undefined,
                name: undefined,
                subtitle: undefined,
                nameKey: defaultTemplate.nameKey,
                subtitleKey: defaultTemplate.subtitleKey,
                times: defaultTemplate.times,
                frequency: defaultTemplate.frequency,
                scheduleAnchor: getTodayUTCIso()
            }]
        };
        state.habits.push(newHabit);
        _finalizeScheduleUpdate(true);
    }
}

export function reorderHabit(movedHabitId: string, targetHabitId: string, position: 'before' | 'after', skipFinalize = false) {
    const habits = state.habits;
    const movedIndex = habits.findIndex(h => h.id === movedHabitId);
    const targetIndex = habits.findIndex(h => h.id === targetHabitId);

    if (movedIndex === -1 || targetIndex === -1) return;

    const [movedHabit] = habits.splice(movedIndex, 1);
    
    const newTargetIndex = (movedIndex < targetIndex) ? targetIndex - 1 : targetIndex;
    const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
    
    habits.splice(insertIndex, 0, movedHabit);

    if (!skipFinalize) {
        _finalizeScheduleUpdate(false);
    }
}

export function handleHabitDrop(
    habitId: string, 
    fromTime: TimeOfDay, 
    toTime: TimeOfDay,
    reorderInfo?: { id: string, pos: 'before' | 'after' }
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = getSafeDate(state.selectedDate);
    
    // Set transaction context
    ActionContext.drop = { habitId, fromTime, toTime, reorderInfo };

    const timeNames = { oldTime: getTimeOfDayName(fromTime), newTime: getTimeOfDayName(toTime) };
    const habitName = getHabitDisplayInfo(habit, targetDate).name;

    showConfirmationModal(
        t('confirmHabitMove', { habitName, ...timeNames }),
        _applyDropFromNowOn, // Static handler
        {
            title: t('modalMoveHabitTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: _applyDropJustToday // Static handler
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
        // MONOMORPHISM: Ensure strict shape matching
        const newHabit: Habit = {
            id: generateUUID(),
            icon: formData.icon,
            color: formData.color,
            goal: formData.goal,
            createdOn: targetDate,
            graduatedOn: undefined,
            scheduleHistory: [{
                startDate: targetDate,
                endDate: undefined,
                times: formData.times,
                frequency: formData.frequency,
                name: formData.name,
                nameKey: formData.nameKey,
                subtitle: undefined,
                subtitleKey: formData.subtitleKey,
                scheduleAnchor: targetDate
            }]
        };
        state.habits.push(newHabit);
        _finalizeScheduleUpdate(true);
    } else {
        const habit = state.habits.find(h => h.id === habitId);
        if (!habit) return;

        habit.icon = formData.icon;
        habit.color = formData.color;
        habit.goal = formData.goal;

        const dailyInfo = ensureHabitDailyInfo(targetDate, habit.id);
        // V8 OPTIMIZATION: Avoid 'delete'
        if (dailyInfo.dailySchedule) {
            dailyInfo.dailySchedule = undefined;
        }

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

// PERFORMANCE: Hoisted Intl Options
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
    const formattedDate = formatDate(dateObj, OPTS_CONFIRM_DATE);
    
    ActionContext.ending = { habitId, targetDate };

    showConfirmationModal(
        t('confirmEndHabit', { habitName: name, date: formattedDate }),
        _applyHabitEnding, // Static handler
        { confirmButtonStyle: 'danger', confirmText: t('endButton') }
    );
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const { name } = getHabitDisplayInfo(habit);
    
    ActionContext.deletion = { habitId };

    showConfirmationModal(
        t('confirmPermanentDelete', { habitName: name }),
        _applyHabitDeletion, // Static handler
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
    
    // CRITICAL: Reset Kernel Memory to prevent zombie state
    resetKernel();
    
    await clearLocalPersistence();
    clearKey();
    
    location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;

    const { habitId, date, time } = state.editingNoteFor;
    const noteContent = ui.notesTextarea.value.trim();

    if (isDateLoading(date)) {
        console.warn('Attempted to save note while data is loading.');
        return;
    }

    const instance = ensureHabitInstanceData(date, habitId, time);

    if ((instance.note || '') !== noteContent) {
        if (noteContent) {
            instance.note = noteContent;
        } else {
            // V8 OPTIMIZATION: Use undefined instead of delete
            instance.note = undefined;
        }

        state.uiDirtyState.habitListStructure = true;
        saveState();
        document.dispatchEvent(new CustomEvent('render-app'));
    }

    closeModal(ui.notesModal);
}

let lastAIRequestId = 0;

export async function performAIAnalysis(analysisType: 'monthly' | 'quarterly' | 'historical') {
    if (state.aiState === 'loading') return;

    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    
    const requestId = ++lastAIRequestId;
    
    renderAINotificationState();
    closeModal(ui.aiOptionsModal);

    try {
        let promptTemplateKey = 'aiPromptGeneral';
        if (analysisType === 'monthly') {
            promptTemplateKey = 'aiPromptMonthly';
        } else if (analysisType === 'quarterly') {
            promptTemplateKey = 'aiPromptQuarterly';
        }

        const translations: Record<string, string> = {
            promptTemplate: t(promptTemplateKey),
            aiPromptGraduatedSection: t('aiPromptGraduatedSection'),
            aiPromptNoData: t('aiPromptNoData'),
            aiPromptNone: t('aiPromptNone'),
            aiSystemInstruction: t('aiSystemInstruction'),
        };
        
        // Zero-allocation loop
        for (const h of PREDEFINED_HABITS) {
            translations[h.nameKey] = t(h.nameKey);
        }

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

        if (requestId !== lastAIRequestId) return;

        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ prompt, systemInstruction }),
        });

        const text = await response.text();
        
        if (requestId !== lastAIRequestId) return;

        state.lastAIResult = text;
        state.aiState = 'completed';
    } catch (error) {
        if (requestId !== lastAIRequestId) return; 
        
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
                await saveState(); 
                document.dispatchEvent(new CustomEvent('render-app'));
                document.dispatchEvent(new CustomEvent('habitsChanged'));
                
                closeModal(ui.manageModal);
                
                showConfirmationModal(
                    t('importSuccess'),
                    () => {}, 
                    {
                        title: t('privacyLabel'), 
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

/**
 * [HFT REFACTOR] toggleHabitStatus (Logic Hardening)
 * 
 * Substitui manipulação direta e bifurcação de lógica por chamadas unificadas ao Kernel.
 * O Kernel agora decide internamente se usa Atomics (Hot) ou Objetos (Cold).
 */
export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    if (isDateLoading(date)) {
        console.warn('Attempted to toggle habit while data is loading.');
        return;
    }

    const hIdx = kernel.getHabitIndex(habitId);
    if (hIdx === -1) return; // Zombie Habit protection

    // 1. UNIFIED KERNEL CALLS
    // Lê o status atual (abstraído pelo kernel)
    const currentKernelStatus = kernel.getDailyStatus(habitId, date, time);
    
    // Lógica Branchless para alternância cíclica
    const nextKernelStatus = (currentKernelStatus + 1) % 3;
    
    // Escreve o novo status (Kernel roteia para Hot/Cold storage)
    kernel.setDailyStatus(habitId, date, time, nextKernelStatus);

    // Estrutura de dados para persistência e lógica legada
    // Garante que o objeto existe para travessia, mesmo que o valor venha do Kernel
    ensureHabitInstanceData(date, habitId, time);
    
    // Special Rule for 'Check' habits
    const habit = state.habits.find(h => h.id === habitId);
    if (habit && habit.goal.type === 'check') {
        const goalValue = (nextKernelStatus === KernelHabitStatus.COMPLETED) ? 1 : 0;
        kernel.setDailyGoal(habitId, date, time, goalValue);
    }

    // 6. UI & Caching Updates
    invalidateCachesForDateChange(date, [habitId]);
    
    // Check milestones only if completed
    const finalStatus = kernel.getDailyStatus(habitId, date, time);
    if (finalStatus === KernelHabitStatus.COMPLETED && habit) {
        _checkStreakMilestones(habit, date);
    }
    
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    
    document.dispatchEvent(new CustomEvent('render-app'));
    document.dispatchEvent(new CustomEvent('habitsChanged'));
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
    if (isDateLoading(date)) {
        console.warn('Attempted to set goal while data is loading.');
        return;
    }

    // Ensure structure exists for persistence layer traversal
    ensureHabitInstanceData(date, habitId, time);
    
    // Unified Kernel Write
    kernel.setDailyGoal(habitId, date, time, value);
    
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
    
    ActionContext.removal = { habitId, time, targetDate };

    showConfirmationModal(
        t('confirmRemoveTimePermanent', { habitName: name, time: timeName }),
        _applyTimeRemoval, // Static handler
        {
            title: t('modalRemoveTimeTitle'), 
            confirmText: t('deleteButton'),
            confirmButtonStyle: 'danger' 
        }
    );
}

/**
 * [HFT REFACTOR] markAllHabitsForDate (Batch Processing)
 * 
 * Executa uma mutação em lote vetorizada.
 * Coleta todos os índices relevantes e aplica mudanças via Kernel.
 */
export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    if (isDateLoading(dateISO)) {
        console.warn('Attempted to batch update habits while data is loading.');
        return false;
    }

    const dateObj = parseUTCIsoDate(dateISO);
    
    // OPTIMIZATION: Hoist Hot Storage Hydration.
    if (!state.dailyData[dateISO]) {
        const archivedDay = getHabitDailyInfoForDate(dateISO);
        state.dailyData[dateISO] = (Object.keys(archivedDay).length > 0) 
            ? structuredClone(archivedDay) 
            : {};
    }
    
    const hotDayData = state.dailyData[dateISO];
    let changed = false;
    
    // PERF: Use static pools for batch updates
    _batchHabitIdsPool.length = 0;
    _batchHabitsRefPool.length = 0;

    const habits = state.habits;
    const len = habits.length;
    
    // Target Enum
    let targetKernelStatus = KernelHabitStatus.PENDING;
    if (status === 'completed') targetKernelStatus = KernelHabitStatus.COMPLETED;
    else if (status === 'snoozed') targetKernelStatus = KernelHabitStatus.SNOOZED;

    for (let i = 0; i < len; i = (i + 1) | 0) {
        const habit = habits[i];
        
        if (!shouldHabitAppearOnDate(habit, dateISO, dateObj)) {
            continue;
        }

        const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
        const schedLen = schedule.length;
        if (schedLen === 0) continue;

        // Ensure legacy object structure exists for persistence traversal
        hotDayData[habit.id] ??= { instances: {}, dailySchedule: undefined };
        
        let habitChanged = false;

        for (let j = 0; j < schedLen; j = (j + 1) | 0) {
            const time = schedule[j];
            
            // Read via Kernel Unified Accessor
            const currentVal = kernel.getDailyStatus(habit.id, dateISO, time);
            
            if (currentVal !== targetKernelStatus) {
                // Write via Kernel Unified Accessor
                kernel.setDailyStatus(habit.id, dateISO, time, targetKernelStatus);
                
                habitChanged = true;
                changed = true;
                
                if (habit.goal.type === 'check') {
                    const goalValue = (targetKernelStatus === KernelHabitStatus.COMPLETED) ? 1 : 0;
                    kernel.setDailyGoal(habit.id, dateISO, time, goalValue);
                }
            }
        }

        if (habitChanged) {
            _batchHabitIdsPool.push(habit.id);
            _batchHabitsRefPool.push(habit);
        }
    }
    
    if (changed) {
        // PERF: Pass the ID array collected during the loop
        invalidateCachesForDateChange(dateISO, _batchHabitIdsPool);
        
        if (status === 'completed') {
            const batchLen = _batchHabitsRefPool.length;
            for (let k = 0; k < batchLen; k = (k + 1) | 0) {
                _checkStreakMilestones(_batchHabitsRefPool[k], dateISO);
            }
        }
        
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        saveState();
        
        document.dispatchEvent(new CustomEvent('habitsChanged'));
    }
    return changed;
}

export function handleDayTransition() {
    const newToday = getTodayUTCIso(); 
    
    clearActiveHabitsCache();
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.chartData = true;
    
    state.calendarDates = [];

    if (state.selectedDate !== newToday) {
        state.selectedDate = newToday;
    }

    document.dispatchEvent(new CustomEvent('render-app'));
}
