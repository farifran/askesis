
// habitActions.ts

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { 
    state, Habit, HabitSchedule, TimeOfDay, Frequency, 
    saveState, getScheduleForDate, 
    clearActiveHabitsCache, clearScheduleCache, invalidateChartCache,
    ensureHabitDailyInfo, getEffectiveScheduleForHabitOnDate,
    PREDEFINED_HABITS, TIMES_OF_DAY, 
    ensureHabitInstanceData, getNextStatus, calculateHabitStreak,
    invalidateStreakCache,
    invalidateDaySummaryCache,
    getActiveHabitsForDate,
    AppState,
    getHabitDailyInfoForDate,
    HabitDailyInfo, // Required for correlation helper
    APP_VERSION,
    persistStateLocally,
    loadState,
    HabitStatus,
    getPersistableState // REFACTOR [2025-03-04]: Importado para DRY
} from './state';
import { ui } from './render/ui';
import { 
    renderApp, renderHabits, openEditModal, 
    closeModal, showConfirmationModal, showUndoToast, renderAINotificationState, renderHabitCardState,
    renderCalendarDayPartial, setupManageModal, removeHabitFromCache, openModal
} from './render';
import { t, getHabitDisplayInfo } from './i18n';
import { 
    toUTCIsoDateString, parseUTCIsoDate, generateUUID, 
    getTodayUTCIso, addDays, getDateTimeFormat, simpleMarkdownToHTML
} from './utils';
import { apiFetch } from './services/api';
import { mergeStates } from './services/dataMerge';
import { syncStateWithCloud } from './cloud';

// --- HELPERS ---

// NEW [2025-02-15]: Calculates conditional probability of failure.
// "If TriggerHabit fails, how often does TargetHabit fail?"
function calculateCorrelation(
    triggerHabitId: string, 
    targetHabitId: string, 
    // CHANGE: No longer passes raw dailyData, but we assume the caller uses getHabitDailyInfoForDate or passes a resolved structure.
    // However, for performance in analysis, we can't easily iterate global state with lazy loading.
    // FIX: We iterate daysToCheck and call accessor.
    daysToCheck: string[]
): number {
    let triggerFailures = 0;
    let jointFailures = 0;

    for (const date of daysToCheck) {
        // USE LAZY ACCESSOR
        const dayData = getHabitDailyInfoForDate(date);
        if (!dayData) continue;

        const triggerInstances = dayData[triggerHabitId]?.instances || {};
        const triggerHasInstances = Object.keys(triggerInstances).length > 0;

        // Skip days where the trigger habit wasn't tracked/scheduled
        if (!triggerHasInstances) continue;

        // Check if trigger failed (Absence of 'completed' status in any slot)
        const triggerCompleted = Object.values(triggerInstances).some(i => i.status === 'completed');

        if (!triggerCompleted) {
            triggerFailures++;
            
            const targetInstances = dayData[targetHabitId]?.instances || {};
            const targetHasInstances = Object.keys(targetInstances).length > 0;
            
            // Check if target also failed (and was tracked)
            if (targetHasInstances) {
                const targetCompleted = Object.values(targetInstances).some(i => i.status === 'completed');
                
                if (!targetCompleted) {
                    jointFailures++;
                }
            }
        }
    }

    return triggerFailures > 0 ? (jointFailures / triggerFailures) : 0;
}

/**
 * STATE HYGIENE HELPER [2025-02-21]:
 * Removes any "dailySchedule" overrides for a specific habit on a specific date.
 * crucial when saving/editing/reviving habits to ensure the new configuration takes precedence
 * over old "moved" or "deleted" exceptions stored in dailyData.
 */
function _cleanDailyOverrides(date: string, habitId: string) {
    // USE LAZY ACCESSOR - Must ensure it's editable if it exists
    const dailyInfo = ensureHabitDailyInfo(date, habitId);
    if (dailyInfo && dailyInfo.dailySchedule !== undefined) {
        // CRITICAL: We strictly delete the key so `dailySchedule` becomes undefined.
        // This forces the "Opaque Layer" logic in state.ts to fall through to the permanent history.
        delete dailyInfo.dailySchedule;
    }
}

/**
 * DEEP CLEAN HELPER [2025-02-21]:
 * Removes ALL daily data (instances, notes, overrides) for the given habit IDs across ALL dates.
 * Used for Permanent Deletion to ensure no "ghost data" remains if the ID is reused later.
 */
function _wipeDailyDataForHabits(habitIds: string[]) {
    if (habitIds.length === 0) return;
    const idsSet = new Set(habitIds);
    
    // UPDATE: Iterating over Hot Storage only is safer/faster for now. 
    // Deleting from archives would require parsing everything. 
    // For now, let's clean hot storage. Archiving naturally handles "old" data.
    // If a user deletes a habit, old archive data remains (historical record).
    
    Object.keys(state.dailyData).forEach(dateKey => {
        const dayRecord = state.dailyData[dateKey];
        if (!dayRecord) return;
        
        let changed = false;
        habitIds.forEach(id => {
            if (dayRecord[id]) {
                delete dayRecord[id];
                changed = true;
            }
        });
        
        // Clean up empty date records to keep state small
        if (changed && Object.keys(dayRecord).length === 0) {
            delete state.dailyData[dateKey];
        }
    });
}

/**
 * FUTURE CLEAN HELPER [2025-02-23]:
 * Removes daily data for a habit for all dates strictly greater than the provided date.
 * Used when Ending a habit to clear any future "ghost" moves/notes that are now orphan.
 * UPDATE: Returns the wiped data so it can be stored for Undo capability.
 */
function _wipeFutureDailyDataForHabit(habitId: string, fromDateISO: string): Record<string, HabitDailyInfo> {
    const wipedData: Record<string, HabitDailyInfo> = {};
    
    // UPDATE: Only clean hot storage. Future dates are unlikely to be archived.
    Object.keys(state.dailyData).forEach(dateKey => {
        if (dateKey > fromDateISO) {
            const dayRecord = state.dailyData[dateKey];
            if (dayRecord && dayRecord[habitId]) {
                // Capture data before deletion
                wipedData[dateKey] = JSON.parse(JSON.stringify(dayRecord[habitId]));
                
                delete dayRecord[habitId];
                if (Object.keys(dayRecord).length === 0) {
                    delete state.dailyData[dateKey];
                }
            }
        }
    });
    return wipedData;
}

/**
 * REFACTOR [2025-02-22]: Finds the index of the schedule active on the given date.
 * Reduces duplication in _removeTimeFromSchedule and _requestFutureScheduleChange.
 */
function _findActiveScheduleIndex(habit: Habit, dateISO: string): number {
    let index = habit.scheduleHistory.findIndex(s => {
        const startOk = s.startDate <= dateISO;
        const endOk = !s.endDate || s.endDate > dateISO;
        return startOk && endOk;
    });

    // Fallback to the last schedule if none found (defensive coding)
    if (index === -1) {
        index = habit.scheduleHistory.length - 1;
    }
    return index;
}

/**
 * REFACTOR [2025-03-04]: Consolidated cleanup and save logic for schedule changes.
 * Used by both "Just Today" and "From Now On" actions.
 */
function _finalizeScheduleUpdate(habitId: string, clearHistoryCache: boolean) {
    // CLEANUP [2025-02-21]: Essential for DOM Cache consistency.
    removeHabitFromCache(habitId);

    state.uiDirtyState.habitListStructure = true;
    
    if (clearHistoryCache) {
        clearScheduleCache();
    }
    
    clearActiveHabitsCache();
    saveState();
    renderApp();
}

// --- ACTIONS ---

// DATA SOVEREIGNTY ACTIONS [2025-02-23]

export function exportData() {
    // REFACTOR [2025-03-04]: Use centralized snapshot creator (DRY)
    const dataToExport = getPersistableState();

    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `askesis-backup-${getTodayUTCIso()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    
    input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const importedState = JSON.parse(text);

            // Validação Básica
            if (!importedState.habits || !importedState.version) {
                throw new Error("Invalid backup file format.");
            }

            // SMART MERGE: Combina o estado atual com o backup
            // Isso previne a perda de dados se o usuário fez algo antes de importar.
            // REFACTOR [2025-03-04]: Use centralized snapshot creator (DRY)
            const currentState = getPersistableState();

            const mergedState = mergeStates(currentState, importedState);
            
            // 1. Persiste Localmente
            persistStateLocally(mergedState);
            
            // 2. Carrega na Memória (Reseta caches e dirty flags)
            loadState(mergedState); 
            
            // 3. CRÍTICO: Força sincronização IMEDIATA (sem debounce)
            // Se fizéssemos window.reload() aqui, o navegador cancelaria o request de rede.
            syncStateWithCloud(mergedState, true);
            
            // 4. Atualiza a UI via SPA (sem reload)
            renderApp();
            
            // Se o modal de gerenciamento estiver aberto, atualiza a lista interna
            if (ui.manageModal.classList.contains('visible')) {
                setupManageModal();
            }
            
            alert(t('importSuccess'));

        } catch (err) {
            console.error("Import failed", err);
            alert(t('importError'));
        }
    };

    input.click();
}

export function createDefaultHabit() {
    const defaultTemplate = PREDEFINED_HABITS.find(h => h.isDefault) || PREDEFINED_HABITS[0];
    const today = getTodayUTCIso();
    
    const newHabit: Habit = {
        id: generateUUID(),
        icon: defaultTemplate.icon,
        color: defaultTemplate.color,
        goal: defaultTemplate.goal,
        createdOn: today,
        scheduleHistory: [{
            startDate: today,
            nameKey: defaultTemplate.nameKey,
            subtitleKey: defaultTemplate.subtitleKey,
            times: defaultTemplate.times,
            frequency: defaultTemplate.frequency,
            scheduleAnchor: today
        }]
    };
    
    state.habits.push(newHabit);
    state.uiDirtyState.habitListStructure = true;
    
    // FIX [2025-02-23]: Invalida o cache de hábitos ativos.
    // Isso garante que `getActiveHabitsForDate` reavalie a lista e inclua o novo hábito
    // imediatamente na próxima renderização, evitando que ele fique invisível.
    clearActiveHabitsCache();
    
    saveState();
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const instanceData = ensureHabitInstanceData(date, habitId, time);
    const oldStatus = instanceData.status;
    const newStatus = getNextStatus(oldStatus);
    
    instanceData.status = newStatus;
    
    // STORAGE OPTIMIZATION [2025-02-21]: Pruning.
    // If the status is 'pending' (default) AND there is no note AND no goalOverride,
    // this entry provides no information. We delete it to keep storage minimal.
    if (newStatus === 'pending' && !instanceData.note && instanceData.goalOverride === undefined) {
        const dailyInfo = ensureHabitDailyInfo(date, habitId); // Ensure editable ref
        if (dailyInfo && dailyInfo.instances) {
            delete dailyInfo.instances[time];
            
            // LOGIC FIX [2025-02-21]: Protection against deleting Valid Overrides.
            if (Object.keys(dailyInfo.instances).length === 0 && dailyInfo.dailySchedule === undefined) {
                // We need to delete the habit entry from the date record.
                // Since we are modifying state.dailyData directly, we check if it exists there.
                if (state.dailyData[date]) {
                    delete state.dailyData[date][habitId];
                    if (Object.keys(state.dailyData[date]).length === 0) {
                        delete state.dailyData[date];
                    }
                }
            }
        }
    }

    invalidateStreakCache(habitId, date);
    invalidateChartCache(); // Status mudou, gráfico muda
    
    // Atualiza apenas o cartão específico e o resumo do dia
    renderHabitCardState(habitId, time);
    
    // CORREÇÃO [2025-03-03]: Invalida o cache de resumo diário incondicionalmente para garantir consistência
    // mesmo se o dia estiver fora da tela. Remove a verificação redundante do DOM antes de chamar a atualização.
    invalidateDaySummaryCache(date);
    
    // Atualiza o dia no calendário (progresso) se visível
    renderCalendarDayPartial(date);
    
    saveState();
    
    // Check for celebrations
    if (newStatus === 'completed') {
        const streak = calculateHabitStreak(habitId, date);
        if (streak === 21 && !state.pending21DayHabitIds.includes(habitId)) {
            state.pending21DayHabitIds.push(habitId);
            renderAINotificationState();
        } else if (streak === 66 && !state.pendingConsolidationHabitIds.includes(habitId)) {
            state.pendingConsolidationHabitIds.push(habitId);
            renderAINotificationState();
        }
    }
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, value: number) {
    const instanceData = ensureHabitInstanceData(date, habitId, time);
    instanceData.goalOverride = value;
    
    invalidateChartCache();
    saveState();
}

export function handleUndoDelete() {
    if (!state.lastEnded) return;

    const { habitId, lastSchedule, removedSchedules, wipedDailyData } = state.lastEnded;
    const habit = state.habits.find(h => h.id === habitId);

    if (habit) {
        // Reverte a alteração no último agendamento
        const scheduleToRestore = habit.scheduleHistory.find(s => 
            s.startDate === lastSchedule.startDate && s.scheduleAnchor === lastSchedule.scheduleAnchor
        );

        if (scheduleToRestore) {
            // Restaura propriedades
            scheduleToRestore.endDate = lastSchedule.endDate;
            scheduleToRestore.times = [...lastSchedule.times]; // Deep copy array
        } else {
            // Se não encontrou (foi removido completamente?), readiciona
            habit.scheduleHistory.push(lastSchedule);
            habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
        }
        
        // Re-adiciona agendamentos futuros que foram removidos
        if (removedSchedules && removedSchedules.length > 0) {
            habit.scheduleHistory.push(...removedSchedules);
            habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
        }

        // Limpa estado de graduação se foi uma ação de graduação desfeita
        if (habit.graduatedOn) {
            habit.graduatedOn = undefined;
        }
        
        // RESTORE WIPED DATA [2025-02-23]: Critical for preventing data loss on undo.
        if (wipedDailyData) {
             Object.entries(wipedDailyData).forEach(([date, data]) => {
                 // Ensure day exists
                 if (!state.dailyData[date]) state.dailyData[date] = {};
                 // Restore habit data for that day
                 state.dailyData[date][habitId] = data;
             });
        }

        clearScheduleCache();
        clearActiveHabitsCache();
        invalidateChartCache();
        
        state.uiDirtyState.habitListStructure = true;
        state.uiDirtyState.calendarVisuals = true;
        
        saveState();
        renderApp();
        
        // Remove toast e estado
        state.lastEnded = null;
        if (ui.undoToast.classList.contains('visible')) {
            ui.undoToast.classList.remove('visible');
        }
    }
}

/**
 * LOGIC FIX [2025-02-21]: Robust removal logic.
 * Distinguishes between removing a time that is in the Permanent History vs. a Just Today override.
 * Ensures we don't accidentally wipe out other times or leave stale overrides.
 */
function _removeTimeFromSchedule(habit: Habit, effectiveDate: string, timeToRemove: TimeOfDay) {
    // 1. Find the active schedule definition (History)
    const targetScheduleIndex = _findActiveScheduleIndex(habit, effectiveDate);
    const activeSchedule = habit.scheduleHistory[targetScheduleIndex];
    
    // Check permanent history, not effective schedule (which might include overrides already)
    const isTimeInHistory = activeSchedule.times.includes(timeToRemove);
    
    // CASE A: The time exists in the Permanent History.
    // We treat this as "From Now On" implicitly if the user deletes a permanent item.
    // To prevent data loss of other "Just Today" edits, we use the Effective Schedule as the new base.
    if (isTimeInHistory) {
        // Calculate the NEW complete list for the day based on what the user SEES
        const currentEffective = getEffectiveScheduleForHabitOnDate(habit, effectiveDate);
        const newTimesSet = new Set(currentEffective);
        newTimesSet.delete(timeToRemove);
        const newTimes = Array.from(newTimesSet).sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));

        if (newTimes.length === 0) {
            // If removing this time leaves the habit with NO times, end the habit.
            endHabit(habit.id, effectiveDate);
            return;
        }

        // Apply history change (Split or Update)
        if (activeSchedule.startDate === effectiveDate) {
            // If the schedule started today, we can just modify it in-place.
            activeSchedule.times = newTimes;
        } else {
            // If it's an older schedule, we close it yesterday and start a new one today.
            activeSchedule.endDate = effectiveDate;
            
            habit.scheduleHistory.push({
                startDate: effectiveDate,
                times: newTimes,
                frequency: activeSchedule.frequency,
                name: activeSchedule.name,
                nameKey: activeSchedule.nameKey,
                subtitle: activeSchedule.subtitle,
                subtitleKey: activeSchedule.subtitleKey,
                scheduleAnchor: activeSchedule.scheduleAnchor
            });
            habit.scheduleHistory.sort((a, b) => a.startDate.localeCompare(b.startDate));
        }

        // CLEANUP: Since we updated the permanent history with the effective state,
        // we MUST wipe the override to avoid conflicts.
        _cleanDailyOverrides(effectiveDate, habit.id);

        // Cache cleanup for History change
        _finalizeScheduleUpdate(habit.id, true);

    } 
    // CASE B: The time is NOT in history (It was a "Just Today" addition/move).
    // We only need to remove it from the daily override.
    else {
        // Ensure dailyInfo exists first
        const info = ensureHabitDailyInfo(effectiveDate, habit.id);
        
        // If we are here, there MUST be a daily override or the habit wouldn't be visible to click.
        // We get the current *effective* schedule (which includes the override).
        const currentEffectiveSchedule = getEffectiveScheduleForHabitOnDate(habit, effectiveDate);
        
        // Filter out the removed time
        const newSchedule = currentEffectiveSchedule.filter(t => t !== timeToRemove);
        
        // Update the override. Even if it's empty [], we save it to block the permanent schedule.
        info.dailySchedule = newSchedule;

        // Cache cleanup for Daily override change (No history clear needed)
        _finalizeScheduleUpdate(habit.id, false);
    }
    
    // Always clean up instance data (notes, status) for the removed time
    const info = ensureHabitDailyInfo(effectiveDate, habit.id);
    if (info && info.instances[timeToRemove]) {
        delete info.instances[timeToRemove];
    }
}

function _requestFutureScheduleChange(
    habit: Habit,
    effectiveDate: string,
    confirmationText: string,
    confirmationTitle: string,
    fromTime: TimeOfDay,
    toTime?: TimeOfDay,
    reorderTarget?: { id: string, pos: 'before' | 'after' }
) {
    const justTodayAction = () => {
        const dailyInfo = ensureHabitDailyInfo(effectiveDate, habit.id);
        
        // FIX [2025-02-21]: "Just Today" needs to create a complete snapshot of the day.
        // We get the current effective schedule (which might already have overrides)
        const currentEffectiveSchedule = getEffectiveScheduleForHabitOnDate(habit, effectiveDate);
        
        // We calculate the NEW complete list for the day
        const newSchedule = currentEffectiveSchedule.filter(t => t !== fromTime);
        if (toTime) {
            if (!newSchedule.includes(toTime)) {
                newSchedule.push(toTime);
            }
        }
        // Sort to maintain order Morning -> Evening
        newSchedule.sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));
        
        // Save this as the "Opaque Layer" for the day
        dailyInfo.dailySchedule = newSchedule;
        
        // Migrate data if moving
        const instanceData = dailyInfo.instances[fromTime];
        if (instanceData) {
            if (toTime) {
                dailyInfo.instances[toTime] = instanceData;
            }
            delete dailyInfo.instances[fromTime];
        }

        // Apply Reordering logic inside the Just Today action to ensure immediate consistency
        if (reorderTarget) {
            reorderHabit(habit.id, reorderTarget.id, reorderTarget.pos, false);
        }

        _finalizeScheduleUpdate(habit.id, false);
    };
    
    const fromNowOnAction = () => {
        // We find the background schedule to clone properties (frequency, name, etc)
        const targetScheduleIndex = _findActiveScheduleIndex(habit, effectiveDate);
        const activeSchedule = habit.scheduleHistory[targetScheduleIndex];
        
        // CRITICAL LOGIC FIX [2025-02-22]: Use EFFECTIVE Schedule as the base.
        // When user says "From Now On", they expect the NEW rule to reflect what they 
        // currently see (which might include previous "Just Today" edits), minus the 
        // slot they are moving, plus the slot they are moving to.
        // If we only look at history, we lose previous "Just Today" edits and cause ghosts.
        const currentEffective = getEffectiveScheduleForHabitOnDate(habit, effectiveDate);
        
        const newTimesSet = new Set(currentEffective);
        // Remove the 'from' time
        newTimesSet.delete(fromTime);
        // Add the 'to' time
        if (toTime) {
            newTimesSet.add(toTime);
        }
        
        const newTimes = Array.from(newTimesSet).sort((a, b) => TIMES_OF_DAY.indexOf(a) - TIMES_OF_DAY.indexOf(b));

        if (activeSchedule.startDate === effectiveDate) {
            activeSchedule.times = newTimes;
            if (activeSchedule.times.length === 0) {
                 endHabit(habit.id, effectiveDate);
                 return;
            }
        } else {
            activeSchedule.endDate = effectiveDate;
            if (newTimes.length > 0) {
                const newSchedule: HabitSchedule = {
                    ...activeSchedule,
                    startDate: effectiveDate,
                    endDate: undefined,
                    times: newTimes,
                };
                delete (newSchedule as any).endDate;
                habit.scheduleHistory.push(newSchedule);
            }
        }

        // NUCLEAR CLEANUP [2025-02-21]: 
        // Since we baked the effective state into the new permanent history, 
        // we MUST remove any overrides for this day.
        _cleanDailyOverrides(effectiveDate, habit.id);
        
        const dailyInfo = ensureHabitDailyInfo(effectiveDate, habit.id);
        if (dailyInfo) {
            const instanceData = dailyInfo.instances[fromTime];
            if (instanceData) {
                if (toTime) {
                    dailyInfo.instances[toTime] = instanceData;
                }
                delete dailyInfo.instances[fromTime];
            }
        }
        
        // Apply Reordering logic
        if (reorderTarget) {
            reorderHabit(habit.id, reorderTarget.id, reorderTarget.pos, false);
        }
        
        _finalizeScheduleUpdate(habit.id, true);
    };

    showConfirmationModal(
        confirmationText,
        fromNowOnAction,
        {
            title: confirmationTitle,
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: justTodayAction,
            hideCancel: true
        }
    );
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const date = state.selectedDate;
    const { name } = getHabitDisplayInfo(habit, date);
    
    const bodyText = t('confirmRemoveTime', { habitName: name, time: t(`filter${time}`) });
    
    showConfirmationModal(
        bodyText,
        () => {
            // Ação Principal: Remover este horário específico de agora em diante ou apenas hoje.
            // A função interna _removeTimeFromSchedule lida com a lógica de histórico vs override.
            _removeTimeFromSchedule(habit, date, time);
        },
        {
            title: t('modalRemoveTimeTitle'),
            confirmText: t('deleteButton'),
            confirmButtonStyle: 'danger'
        }
    );
}


export function saveHabitFromModal() {
    if (!state.editingHabit) return;

    // Destructure mutable variables
    let { isNew, habitId } = state.editingHabit;
    const { formData, targetDate } = state.editingHabit;
    
    // Validação básica
    if (!formData.name && !formData.nameKey) {
        alert(t('noticeNameCannotBeEmpty'));
        return;
    }

    // STRICT DUPLICATION CHECK [2025-02-19]: Prevent creating a habit in a time slot where it already exists.
    const nameToCheck = formData.name || (formData.nameKey ? t(formData.nameKey) : '');
    
    for (const h of state.habits) {
        if (!isNew && h.id === habitId) continue;

        const info = getHabitDisplayInfo(h);
        if (info.name.toLowerCase() === nameToCheck.toLowerCase()) {
            const lastSch = h.scheduleHistory[h.scheduleHistory.length - 1];
            if (!lastSch.endDate) {
                const activeTimes = lastSch.times;
                const overlappingTimes = formData.times.filter(time => activeTimes.includes(time));
                
                if (overlappingTimes.length > 0) {
                    const timeNames = overlappingTimes.map(tm => t(`filter${tm}`)).join(', ');
                    alert(t('noticeHabitAlreadyExistsInTime', { habitName: info.name, times: timeNames }));
                    return; 
                }
            }
        }
    }

    // LOGIC UPDATE [2025-02-17]: Revival / Unification Logic.
    if (isNew) {
        const existingMatch = state.habits.find(h => {
            const { name } = getHabitDisplayInfo(h);
            // Check display name OR nameKey match
            if (formData.nameKey && h.scheduleHistory.some(s => s.nameKey === formData.nameKey)) return true;
            return name === formData.name;
        });

        if (existingMatch) {
            console.log(`Reviving existing habit '${formData.name}' instead of creating new.`);
            isNew = false;
            habitId = existingMatch.id;
        }
    }

    if (isNew) {
        const newHabit: Habit = {
            id: generateUUID(),
            icon: formData.icon,
            color: formData.color,
            goal: formData.goal,
            createdOn: targetDate, // Cria a partir da data que estava vendo
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
    } else {
        const habit = state.habits.find(h => h.id === habitId);
        if (habit) {
            // HYGIENE [2025-02-21]: Priority Clean-up for daily overrides.
            // If the user edits the habit for this day, any "Just Today" override is likely obsolete.
            // We wipe it to ensure the new rule (from history) takes precedence.
            _cleanDailyOverrides(targetDate, habit.id);

            // Atualiza propriedades visuais globais
            habit.icon = formData.icon;
            habit.color = formData.color;
            habit.goal = formData.goal;
            
            // Gets the LAST schedule in history (could be ended or active)
            const lastSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
            
            // Check if we can modify the last schedule in-place or need a new entry
            const isSameStart = lastSchedule.startDate === targetDate;
            const isLastScheduleEnded = !!lastSchedule.endDate && lastSchedule.endDate <= targetDate;

            if (isSameStart && !isLastScheduleEnded) {
                // If we are reviving an ACTIVE habit with non-overlapping times (e.g. adding Evening to Morning):
                if (!isNew && state.editingHabit?.isNew) {
                     // This was a revival. We should merge times.
                     const mergedTimes = Array.from(new Set([...lastSchedule.times, ...formData.times]));
                     lastSchedule.times = mergedTimes;
                } else {
                     // Standard edit or revival of ended habit -> Set times directly
                     lastSchedule.times = formData.times;
                }
                
                lastSchedule.frequency = formData.frequency;
                lastSchedule.name = formData.name;
                lastSchedule.nameKey = formData.nameKey;
                lastSchedule.subtitleKey = formData.subtitleKey;
            } else {
                // Fork / Append logic
                
                // Only close the previous schedule if it wasn't already closed before this target date
                if (!lastSchedule.endDate || lastSchedule.endDate > targetDate) {
                    lastSchedule.endDate = targetDate;
                }

                // If reviving active habit with disjoint times, merge for the new schedule
                let newTimes = formData.times;
                if (!isNew && state.editingHabit?.isNew && !isLastScheduleEnded) {
                     newTimes = Array.from(new Set([...lastSchedule.times, ...formData.times]));
                }
                
                const newSchedule: HabitSchedule = {
                    // FIX: Corrected a typo where 'activeSchedule' was used instead of 'lastSchedule'.
                    ...lastSchedule,
                    startDate: targetDate,
                    endDate: undefined,
                    times: newTimes,
                };
                delete (newSchedule as any).endDate;
                habit.scheduleHistory.push(newSchedule);
            }
            
            // Clean graduation status if we are editing/reviving
            if (habit.graduatedOn) {
                habit.graduatedOn = undefined;
            }
            
            clearScheduleCache();
        }
    }

    // FIX [2025-03-04]: CLEANUP CACHE to prevent memory leaks if times changed.
    // Ensure we clear the specific habit cache so old time slots (DOM elements) are collected.
    if (!isNew && habitId) {
        removeHabitFromCache(habitId);
    }

    state.editingHabit = null;
    state.uiDirtyState.habitListStructure = true;
    
    // Invalida caches globais
    clearActiveHabitsCache();
    invalidateChartCache();
    
    saveState();
    closeModal(ui.editHabitModal);
    renderApp();
}

export function endHabit(habitId: string, dateISO: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // Localiza o agendamento ativo nesta data
    const activeSchedule = getScheduleForDate(habit, dateISO);
    if (!activeSchedule) return;

    // Salva estado para undo
    const removedSchedules = habit.scheduleHistory.filter(s => s.startDate > dateISO);
    
    // CLEANUP [2025-02-23]: Wipe ghost data from future AND CAPTURE IT.
    // This allows us to restore notes if the user undoes the action.
    const wipedData = _wipeFutureDailyDataForHabit(habitId, dateISO);

    state.lastEnded = {
        habitId,
        lastSchedule: JSON.parse(JSON.stringify(activeSchedule)), // Snapshot
        removedSchedules: JSON.parse(JSON.stringify(removedSchedules)), // Snapshot
        wipedDailyData: wipedData
    };

    // Remove agendamentos futuros
    habit.scheduleHistory = habit.scheduleHistory.filter(s => s.startDate <= dateISO);
    
    // Encerra ao final do dia ANTERIOR se a intenção é não fazer mais a partir de hoje
    // Mas se o usuário escolhe hoje, ele espera ver hoje.
    activeSchedule.endDate = dateISO;

    clearScheduleCache();
    clearActiveHabitsCache();
    invalidateChartCache();
    state.uiDirtyState.habitListStructure = true;
    
    saveState();
    renderApp();
    showUndoToast();
}

export function requestHabitEndingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit, state.selectedDate);
    
    // Formata a data para exibir na mensagem de forma amigável (ex: "21 de fevereiro")
    const dateObj = parseUTCIsoDate(state.selectedDate);
    const formattedDate = getDateTimeFormat(state.activeLanguageCode, { 
        day: 'numeric', 
        month: 'long', 
        timeZone: 'UTC' 
    }).format(dateObj);

    showConfirmationModal(
        t('confirmEndHabit', { habitName: name, date: formattedDate }),
        () => {
            endHabit(habitId, state.selectedDate);
            closeModal(ui.manageModal);
        },
        {
            title: t('modalEndHabitTitle'),
            confirmText: t('endButton'),
            confirmButtonStyle: 'danger'
        }
    );
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    // CHANGE [2025-02-17]: Uniform Deletion.
    // Instead of deleting just by ID, we delete ALL habits that share the same name.
    const { name: targetName } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmPermanentDelete', { habitName: targetName }),
        () => {
            // Identify all IDs to be removed for cache cleanup
            const idsToRemove: string[] = [];
            
            state.habits = state.habits.filter(h => {
                const { name } = getHabitDisplayInfo(h);
                if (name === targetName) {
                    idsToRemove.push(h.id);
                    return false; // Remove from state
                }
                return true; // Keep
            });
            
            // CLEANUP [2025-02-21]: Deep Clean of Daily Data.
            // Remove all daily records for these IDs so they don't haunt us if the ID is reused.
            _wipeDailyDataForHabits(idsToRemove);
            
            // Remove all variants from DOM cache
            idsToRemove.forEach(id => removeHabitFromCache(id));

            state.uiDirtyState.habitListStructure = true;
            clearActiveHabitsCache();
            invalidateChartCache();
            saveState();
            
            // Re-render modal list
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

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        const today = getTodayUTCIso();
        habit.graduatedOn = today;
        
        state.uiDirtyState.habitListStructure = true;
        // FIX [2025-02-21]: Must clear active cache so the habit disappears from the "Today" list immediately.
        clearActiveHabitsCache();
        saveState();
        
        // Re-render manage list if open
        if (ui.manageModal.classList.contains('visible')) {
            setupManageModal();
        }
        renderApp();
    }
}

export function resetApplicationData() {
    localStorage.clear();
    // Recarrega a página para reset limpo
    window.location.reload();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;
    const note = ui.notesTextarea.value.trim();

    const instanceData = ensureHabitInstanceData(date, habitId, time);
    instanceData.note = note;

    saveState();
    closeModal(ui.notesModal);
    
    // Atualiza UI
    renderHabitCardState(habitId, time);
}

export function reorderHabit(habitId: string, targetHabitId: string, position: 'before' | 'after', shouldSave: boolean = true) {
    const habitIndex = state.habits.findIndex(h => h.id === habitId);
    const targetIndex = state.habits.findIndex(h => h.id === targetHabitId);

    if (habitIndex === -1 || targetIndex === -1 || habitIndex === targetIndex) return;

    const [habit] = state.habits.splice(habitIndex, 1);
    
    // Recalculate target index because removal might have shifted indices
    const newTargetIndex = state.habits.findIndex(h => h.id === targetHabitId);
    
    const insertIndex = position === 'before' ? newTargetIndex : newTargetIndex + 1;
    state.habits.splice(insertIndex, 0, habit);

    if (shouldSave) {
        state.uiDirtyState.habitListStructure = true;
        clearActiveHabitsCache();
        saveState();
        renderApp();
    }
}

export function handleHabitDrop(
    habitId: string, 
    fromTime: TimeOfDay, 
    toTime: TimeOfDay,
    reorderTarget?: { id: string, pos: 'before' | 'after' }
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const date = state.selectedDate;
    const { name } = getHabitDisplayInfo(habit, date);
    
    const confirmTitle = t('moveHabitTitle');
    const confirmText = t('moveHabitBody', { 
        habitName: name,
        from: t(`filter${fromTime}`),
        to: t(`filter${toTime}`)
    });

    _requestFutureScheduleChange(
        habit,
        date,
        confirmText,
        confirmTitle,
        fromTime,
        toTime,
        reorderTarget
    );
}

export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    const activeHabits = getActiveHabitsForDate(dateISO);
    if (activeHabits.length === 0) return false;

    let changed = false;
    
    // Ensure daily info exists for all to prevent partial updates
    const dayRecord = getHabitDailyInfoForDate(dateISO); 

    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instanceData = ensureHabitInstanceData(dateISO, habit.id, time);
            if (instanceData.status !== status) {
                instanceData.status = status;
                changed = true;
            }
        });
        
        if (changed) {
            invalidateStreakCache(habit.id, dateISO);
        }
    });

    if (changed) {
        invalidateDaySummaryCache(dateISO);
        invalidateChartCache();
        
        if (state.selectedDate === dateISO) {
             state.uiDirtyState.habitListStructure = true;
        }
        state.uiDirtyState.calendarVisuals = true;
        
        saveState();
        return true;
    }
    return false;
}

// DEFINIÇÃO DE CABEÇALHOS PRE-TRADUZIDOS (PROMPT ENGINEERING)
const PROMPT_HEADERS = {
    pt: {
        projection: "O Horizonte (Praemeditatio)",
        insight: "O Diagnóstico Filosófico",
        system_low: "O Protocolo de Ação (Algoritmo)",
        system_high: "O Desafio da Excelência",
        action_low: "Micro-Ação (Mise-en-place)",
        action_high: "Micro-Ação (O Próximo Nível)",
        socratic: "A Questão Cortante",
        connection: "A Voz dos Antigos"
    },
    en: {
        projection: "The Horizon (Praemeditatio)",
        insight: "Philosophical Diagnosis",
        system_low: "Action Protocol (Algorithm)",
        system_high: "The Challenge of Excellence",
        action_low: "Micro-Action (Mise-en-place)",
        action_high: "Micro-Action (The Next Level)",
        socratic: "The Cutting Question",
        connection: "Voice of the Ancients"
    },
    es: {
        projection: "El Horizonte (Praemeditatio)",
        insight: "Diagnóstico Filosófico",
        system_low: "Protocolo de Acción (Algoritmo)",
        system_high: "El Desafío de la Excelencia",
        action_low: "Micro-Acción (Mise-en-place)",
        action_high: "Micro-Acción (El Siguiente Nivel)",
        socratic: "La Cuestión Cortante",
        connection: "La Voz de los Antiguos"
    }
};

// IMPLEMENTATION INTENTION TEMPLATES
const IMPLEMENTATION_TEMPLATES = {
    pt: "Quando [GATILHO], eu farei [AÇÃO].",
    en: "When [TRIGGER], I will [ACTION].",
    es: "Cuando [DESENCADENANTE], haré [ACCIÓN]."
};

// GOAL REDUCTION TEMPLATES
const RECALIBRATION_TEMPLATES = {
    pt: "Nova Meta: [NÚMERO] [UNIDADE] por dia.",
    en: "New Goal: [NUMBER] [UNIT] per day.",
    es: "Nueva Meta: [NÚMERO] [UNIDAD] por día."
};


// UPDATED [2025-02-23]: New Analysis Periods
export async function performAIAnalysis(analysisType: 'monthly' | 'quarterly' | 'historical') {
    closeModal(ui.aiOptionsModal);
    
    state.aiState = 'loading';
    state.hasSeenAIResult = false;
    renderAINotificationState();

    const today = parseUTCIsoDate(getTodayUTCIso());
    
    // INTELLIGENT START DATE LOGIC [2025-03-04]:
    // Determine the actual "System Start Date" (When the user actually started).
    // We calculate this upfront to ensure it applies to all analysis types.
    const todayISO = getTodayUTCIso();
    let systemEarliestISO = todayISO;

    // Check habits creation
    state.habits.forEach(h => {
        if (h.createdOn < systemEarliestISO) systemEarliestISO = h.createdOn;
    });

    // Check daily data (just in case there's data older than habit creation)
    const dailyKeys = Object.keys(state.dailyData);
    if (dailyKeys.length > 0) {
            const minDaily = dailyKeys.sort()[0];
            if (minDaily < systemEarliestISO) systemEarliestISO = minDaily;
    }

    const systemEarliestDate = parseUTCIsoDate(systemEarliestISO);
    
    // --- DETERMINE WINDOW ---
    let targetStartDate: Date;
    let periodNameKey: string;

    if (analysisType === 'monthly') {
        // "Revisão Mensal" = Last 30 days
        targetStartDate = addDays(today, -30);
        periodNameKey = 'aiPeriodMonthly';
    } else if (analysisType === 'quarterly') {
        // "Análise Trimestral" = Last 90 days
        targetStartDate = addDays(today, -90);
        periodNameKey = 'aiPeriodQuarterly';
    } else {
        // "Análise Histórica" = Desde o início dos tempos (capped at 3 years safety)
        targetStartDate = addDays(today, -1095);
        periodNameKey = 'aiPeriodHistorical';
    }

    // --- APPLY CLAMPING ---
    // Use the LATER of the two dates (Target Window vs. Actual Start).
    // This prevents analyzing empty days before the user even existed.
    // Example: Quarterly (-90d) vs User Started (-5d) -> Start Date = -5d.
    // Example: Historical (-3y) vs User Started (-5y) -> Start Date = -3y (Safety Cap).
    let startDate = targetStartDate;
    if (startDate < systemEarliestDate) {
        startDate = systemEarliestDate;
    }

    // Calculate actual days count for the prompt (+1 to include today)
    const daysCount = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    const periodName = t(periodNameKey);

    const langCode = state.activeLanguageCode || 'pt';
    const langMap: Record<string, string> = { 'pt': 'Portuguese', 'es': 'Spanish', 'en': 'English' };
    const targetLang = langMap[langCode];
    const headers = PROMPT_HEADERS[langCode as keyof typeof PROMPT_HEADERS] || PROMPT_HEADERS['pt'];
    
    // Default templates
    let implTemplate = IMPLEMENTATION_TEMPLATES[langCode as keyof typeof IMPLEMENTATION_TEMPLATES] || IMPLEMENTATION_TEMPLATES['en'];
    const recalibrationTemplate = RECALIBRATION_TEMPLATES[langCode as keyof typeof RECALIBRATION_TEMPLATES] || RECALIBRATION_TEMPLATES['en'];

    // Data Calculation structures
    const semanticLog: string[] = [];
    const dateList: string[] = [];
    
    // Stats per Habit
    const statsMap = new Map<string, { 
        scheduled: number, 
        completed: number, 
        snoozed: number, 
        missed: number, // Explicitly track simple failures
        notesCount: number, 
        habit: Habit,
        extraMiles: number, 
        bounces: number,
        accumulatedValue: number, 
        valueCount: number 
    }>();
    
    // Stats per Time of Day
    const timeOfDayStats = {
        Morning: { scheduled: 0, completed: 0 },
        Afternoon: { scheduled: 0, completed: 0 },
        Evening: { scheduled: 0, completed: 0 }
    };

    // Trend Analysis
    const midPoint = Math.floor(daysCount / 2);
    const trendStats = {
        firstHalf: { scheduled: 0, completed: 0 },
        secondHalf: { scheduled: 0, completed: 0 }
    };

    // Contextual Variance
    const contextStats = {
        weekday: { scheduled: 0, completed: 0 },
        weekend: { scheduled: 0, completed: 0 }
    };

    // Bad Day Analysis
    const failedHabitsOnBadDays: Record<string, number> = {};
    const previousDayStatus: Record<string, string> = {}; 

    let totalLogs = 0;
    let totalNotes = 0;

    // PERFORMANCE [2025-03-04]: Single mutable date object for loop iteration.
    // Avoids creating ~1000 Date objects during historical analysis.
    const iteratorDate = new Date(startDate);
    
    let dayIndex = 0;
    let redFlagDay = ""; 
    let sparklineHabitId: string | null = null;
    
    const dayFormatter = getDateTimeFormat(state.activeLanguageCode, { weekday: 'short' });
    
    const activeHabitsCount = state.habits.filter(h => !h.graduatedOn && !h.scheduleHistory[h.scheduleHistory.length-1].endDate).length;

    while (iteratorDate <= today) {
        const dateISO = toUTCIsoDateString(iteratorDate);
        dateList.push(dateISO);
        
        // This will seamlessly fetch from archives if needed due to 'startDate' going far back
        const activeHabits = getActiveHabitsForDate(dateISO);
        const dailyInfo = getHabitDailyInfoForDate(dateISO);
        
        let dayScheduled = 0;
        let dayCompleted = 0;
        
        const dayOfWeek = iteratorDate.getUTCDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        if (activeHabits.length > 0) {
            // Setup habit stats
            activeHabits.forEach(({ habit }) => {
                if (!statsMap.has(habit.id)) {
                    statsMap.set(habit.id, { 
                        scheduled: 0, completed: 0, snoozed: 0, missed: 0, notesCount: 0, 
                        habit, extraMiles: 0, bounces: 0,
                        accumulatedValue: 0, valueCount: 0
                    });
                }
            });

            const dayEntriesStrings: string[] = [];

            // Get aggregate status
            activeHabits.forEach(({ habit, schedule }) => {
                const stats = statsMap.get(habit.id)!;
                const { name } = getHabitDisplayInfo(habit, dateISO);

                schedule.forEach(time => {
                    const instance = dailyInfo[habit.id]?.instances?.[time];
                    const status = instance?.status || 'pending';
                    const hasNote = instance?.note && instance.note.trim().length > 0;
                    
                    // Update Habit Stats
                    totalLogs++;
                    stats.scheduled++;
                    dayScheduled++;
                    
                    if (isWeekend) contextStats.weekend.scheduled++;
                    else contextStats.weekday.scheduled++;

                    if (hasNote) {
                        totalNotes++;
                        stats.notesCount++;
                    }
                    
                    timeOfDayStats[time].scheduled++;

                    if (dayIndex < midPoint) {
                        trendStats.firstHalf.scheduled++;
                    } else {
                        trendStats.secondHalf.scheduled++;
                    }

                    const target = habit.goal.total || 0;
                    const actual = instance?.goalOverride ?? (status === 'completed' ? target : 0);
                    
                    if (status === 'completed' && actual > target && target > 0) {
                        stats.extraMiles++;
                    }
                    
                    if (actual > 0) {
                        stats.accumulatedValue += actual;
                        stats.valueCount++;
                    }

                    if (status === 'completed') {
                        stats.completed++;
                        dayCompleted++;
                        timeOfDayStats[time].completed++;
                        if (dayIndex < midPoint) trendStats.firstHalf.completed++;
                        else trendStats.secondHalf.completed++;
                        
                        if (isWeekend) contextStats.weekend.completed++;
                        else contextStats.weekday.completed++;

                        if (previousDayStatus[habit.id] && previousDayStatus[habit.id] !== 'completed') {
                            stats.bounces++;
                        }
                        previousDayStatus[habit.id] = 'completed';
                    }
                    else {
                        if (status === 'snoozed') stats.snoozed++;
                        else stats.missed++; 
                        
                        previousDayStatus[habit.id] = status; 
                    }

                    let symbol = '❌';
                    if (status === 'completed') symbol = '✅';
                    if (status === 'snoozed') symbol = '⏸️';
                    
                    let valStr = '';
                    if (actual > 0 && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
                        valStr = ` ${actual}/${target}`;
                    }
                    
                    let noteStr = '';
                    if (hasNote) {
                        noteStr = ` "${instance!.note}"`;
                    }
                    
                    dayEntriesStrings.push(`${name}(${symbol}${valStr}${noteStr})`);
                });
            });

            const dayName = dayFormatter.format(iteratorDate);
            semanticLog.push(`${dateISO.substring(5)} (${dayName}): ${dayEntriesStrings.join(', ')}`);

            // Bad Day Logic
            if (dayScheduled > 0) {
                const successRate = dayCompleted / dayScheduled;
                if (successRate < 0.5) {
                     redFlagDay = `${dayName} (${dateISO.substring(5)})`;
                }
                
                if (successRate < 0.5) {
                    activeHabits.forEach(({ habit, schedule }) => {
                        const daily = dailyInfo[habit.id]?.instances;
                        schedule.forEach(time => {
                            const s = daily?.[time]?.status || 'pending';
                            if (s !== 'completed' && s !== 'snoozed') {
                                 failedHabitsOnBadDays[getHabitDisplayInfo(habit, dateISO).name] = (failedHabitsOnBadDays[getHabitDisplayInfo(habit, dateISO).name] || 0) + 1;
                            }
                        });
                    });
                }
            }
        } else {
             const dayName = dayFormatter.format(iteratorDate);
             semanticLog.push(`${dateISO.substring(5)} (${dayName}): ▪️ (No habits scheduled)`);
        }
        
        // Mutate in place
        iteratorDate.setUTCDate(iteratorDate.getUTCDate() + 1);
        dayIndex++;
    }

    // Build Statistics
    let statsSummary = "";
    const mysteryHabits: string[] = []; 
    let totalExtraMiles = 0;
    let totalBounces = 0;
    
    let highestStreakHabitName = "";
    let highestStreakValue = 0;
    let nemesisName = "";
    let nemesisId = "";
    let highestSnoozeRate = -1;
    let highestMissRate = -1;
    let realityGapWarning = "";
    
    statsMap.forEach((data, id) => {
        const { name } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
        const rate = data.scheduled > 0 ? (data.completed / data.scheduled) : 0;
        const snoozeRate = data.scheduled > 0 ? (data.snoozed / data.scheduled) : 0;
        const missRate = data.scheduled > 0 ? (data.missed / data.scheduled) : 0;
        
        const streak = calculateHabitStreak(id, toUTCIsoDateString(today));
        const noteInfo = data.notesCount > 0 ? `${data.notesCount} notes` : "NO NOTES";
        
        totalExtraMiles += data.extraMiles;
        totalBounces += data.bounces;

        statsSummary += `- **${name}**: ${Math.round(rate * 100)}% Success. Streak: ${streak}. (Snoozed: ${Math.round(snoozeRate * 100)}%). Notes: ${noteInfo}\n`;

        if (rate < 0.6 && data.notesCount === 0) {
            mysteryHabits.push(name);
        }
        
        if (streak > highestStreakValue) {
            highestStreakValue = streak;
            highestStreakHabitName = name;
        }

        if ((snoozeRate + missRate) > (highestSnoozeRate + highestMissRate) && data.scheduled > 3) { 
            highestSnoozeRate = snoozeRate;
            highestMissRate = missRate;
            nemesisName = name;
            nemesisId = id;
        }

        if (data.habit.goal.type === 'pages' || data.habit.goal.type === 'minutes') {
            const target = data.habit.goal.total || 0;
            if (target > 0 && data.valueCount > 0) {
                const avgActual = data.accumulatedValue / data.valueCount;
                if (avgActual < target * 0.7) { 
                    const suggested = Math.floor(avgActual);
                    realityGapWarning += `Habit '${name}': Target ${target}, Avg Actual ${Math.round(avgActual)}. -> SUGGESTION: Lower goal to ${suggested}.\n`;
                }
            }
        }
    });
    
    // --- ADVANCED ANALYSIS: CORRELATION & FRICTION ---
    let correlationInfo = "No clear dependencies found.";
    let frictionDiagnosis = "";

    if (nemesisId) {
        // Friction Type Diagnosis
        if (highestSnoozeRate > 0.2) {
            frictionDiagnosis = `DIAGNOSIS: The user struggles with **Internal Resistance** (Fear/Procrastination) on '${nemesisName}'. They see the task but delay it (Snooze). ADVICE: Lower the emotional barrier. The goal is too scary.`;
        } else if (highestMissRate > 0.2) {
            frictionDiagnosis = `DIAGNOSIS: The user struggles with **Neglect/Visibility** on '${nemesisName}'. They forget or run out of time (Miss). ADVICE: Increase visibility or change the trigger time. The prompt is too weak.`;
        }

        // Domino Effect Analysis
        let dominoEffectFound = false;
        statsMap.forEach((data, otherId) => {
            if (otherId !== nemesisId && data.scheduled > 3) {
                const correlation = calculateCorrelation(nemesisId, otherId, dateList); // Just pass dateList
                if (correlation > 0.75) {
                    const { name: otherName } = getHabitDisplayInfo(data.habit, toUTCIsoDateString(today));
                    correlationInfo = `**CRITICAL CHAIN REACTION DETECTED:** When the user fails '${nemesisName}', there is a ${Math.round(correlation * 100)}% chance they will ALSO fail '${otherName}'. Fix '${nemesisName}' to save the day.`;
                    dominoEffectFound = true;
                }
            }
        });
        
        if (!dominoEffectFound) {
            correlationInfo = "Failures appear isolated. No strong domino effect detected.";
        }
    }

    if (!statsSummary) {
        statsSummary = "No active habits tracked yet.";
    }

    const nemesisInfo = nemesisName 
        ? `The Nemesis: **${nemesisName}**. ${frictionDiagnosis}` 
        : "No significant Nemesis.";

    let temporalSummary = "";
    let lowestPerfTime: TimeOfDay = 'Morning';
    let lowestPerfRate = 1.0;

    Object.entries(timeOfDayStats).forEach(([time, data]) => {
        const rate = data.scheduled > 0 ? Math.round((data.completed / data.scheduled) * 100) : 0;
        if (data.scheduled > 0) {
            temporalSummary += `- **${time}**: ${rate}% Success Rate (${data.completed}/${data.scheduled})\n`;
            
            // Find struggling time
            if ((data.completed / data.scheduled) < lowestPerfRate) {
                lowestPerfRate = data.completed / data.scheduled;
                lowestPerfTime = time as TimeOfDay;
            }
        }
    });

    const firstHalfRate = trendStats.firstHalf.scheduled > 0 ? Math.round((trendStats.firstHalf.completed / trendStats.firstHalf.scheduled) * 100) : 0;
    const secondHalfRate = trendStats.secondHalf.scheduled > 0 ? Math.round((trendStats.secondHalf.completed / trendStats.secondHalf.scheduled) * 100) : 0;
    const trendDiff = secondHalfRate - firstHalfRate;
    const trendDescription = trendDiff > 5 ? "RISING MOMENTUM 🚀" : (trendDiff < -5 ? "LOSING MOMENTUM 📉" : "STABLE ➖");
    
    const culpritEntry = Object.entries(failedHabitsOnBadDays).sort((a, b) => b[1] - a[1])[0];
    const culpritInfo = culpritEntry ? `Habit most often associated with 'Bad Days': **${culpritEntry[0]}**` : "None.";

    const noteDensity = totalLogs > 0 ? Math.round((totalNotes / totalLogs) * 100) : 0;
    
    const globalRate = (firstHalfRate + secondHalfRate) / 2;

    let dataQualityWarning = "Good context.";
    if (globalRate < 80 && mysteryHabits.length > 0) {
        dataQualityWarning = `MISSING CONTEXT WARNING: ${mysteryHabits.length} habits have low success (<60%) AND ZERO NOTES. Habits: ${mysteryHabits.join(', ')}. AI cannot diagnose 'why'. SUGGESTION: Ask user to add notes when failing these.`;
    }

    const prompt = `
    Analyze this user's habit data for the period: ${periodName} (${daysCount} days analyzed, User active since ${toUTCIsoDateString(systemEarliestDate)}).
    Language: ${targetLang}
    
    **DATA SUMMARY:**
    - Total Logs: ${totalLogs}
    - Note Density: ${noteDensity}% (Higher is better for diagnosis)
    - Trend: ${trendDescription} (First Half: ${firstHalfRate}% -> Second Half: ${secondHalfRate}%)
    - Active Habits: ${activeHabitsCount}
    
    **HABIT PERFORMANCE:**
    ${statsSummary}
    
    **TEMPORAL PATTERNS:**
    ${temporalSummary}
    
    **CRITICAL INSIGHTS:**
    - ${nemesisInfo}
    - ${correlationInfo}
    - Bad Day Trigger? ${culpritInfo}
    - Red Flag Day (Worst Performance): ${redFlagDay || "None"}
    - Resilience Score (Bounce Backs after failure): ${totalBounces}
    - "Extra Mile" Effort (Exceeding Goal): ${totalExtraMiles} times
    - Reality Check: ${realityGapWarning || "Goals seem realistic."}
    - Data Quality: ${dataQualityWarning}

    **DETAILED LOGS (Last ${Math.min(daysCount, 7)} Days for Context):**
    ${semanticLog.slice(-7).join('\n')}

    ---
    **INSTRUCTIONS:**
    Act as a Stoic Philosopher and Behavioral Scientist. 
    Using the data above, provide a structured evaluation in ${targetLang}.
    Use ONLY the provided headers. Do not invent new headers.
    
    Format:
    
    ### ${headers.projection}
    (Briefly analyze the trajectory. If they continue like this for 1 year, where will they be? Be brutally honest but encouraging.)

    ### ${headers.insight}
    (Identify the CORE philosophical weakness based on the data. Is it Akrasia (weakness of will)? Fear? Lack of Focus? Use the 'Nemesis' and 'Correlation' data here. If 'Nemesis' exists, analyze why.)

    ### ${headers.system_low}
    (Tactical fix for the WEAKEST point. Use the 'Lowest Performance Time' (${lowestPerfTime}) or the 'Nemesis' habit. Give a specific "Implementation Intention". 
    Template: "${implTemplate}". Fill the placeholders based on their specific struggle.)

    ### ${headers.system_high}
    (Challenge for their STRONGEST point/habit (${highestStreakHabitName}). How can they elevate it? Push for Excellence/Areté.)

    ### ${headers.socratic}
    (One single, powerful question for them to journal about tonight. Make it uncomfortable but necessary. Based on their specific failure pattern.)

    ### ${headers.connection}
    (A short, relevant quote from Seneca, Epictetus, or Marcus Aurelius that fits this exact situation. No generic quotes.)
    `;

    try {
        const response = await apiFetch('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({
                prompt,
                systemInstruction: `You are a Stoic mentor. Concise, wise, practical. No fluff.`
            }),
            timeout: 60000 // Increase timeout to 60s for Thinking models
        });

        const text = await response.text();
        state.lastAIResult = text;
        state.aiState = 'completed';
    } catch (error) {
        console.error("AI Analysis failed", error);
        state.aiState = 'error';
        state.lastAIError = t('aiError');
    }

    renderAINotificationState();
    
    if (state.aiState === 'completed') {
        ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult!);
        openModal(ui.aiModal);
    } else if (state.aiState === 'error') {
        alert(t('aiErrorGeneric')); 
    }
}
