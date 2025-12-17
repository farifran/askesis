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
    getPersistableState, // REFACTOR [2025-03-04]: Importado para DRY
    LANGUAGES
} from './state';
import { ui } from './render/ui';
import { 
    renderApp, renderHabits, openEditModal, 
    closeModal, showConfirmationModal, showUndoToast, renderAINotificationState, renderHabitCardState,
    renderCalendarDayPartial, setupManageModal, removeHabitFromCache, openModal
} from './render';
// FIX: Import getTimeOfDayName to resolve missing name errors.
import { t, getHabitDisplayInfo, getTimeOfDayName } from './i18n';
import { 
    toUTCIsoDateString, parseUTCIsoDate, generateUUID, 
    getTodayUTCIso, addDays, getDateTimeFormat, simpleMarkdownToHTML
} from './utils';
import { mergeStates } from './services/dataMerge';
import { runWorkerTask, syncStateWithCloud } from './cloud';

// --- HELPERS ---

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
function _finalizeScheduleUpdate(clearHistoryCache: boolean) {
    // REFACTOR [2025-03-05]: The call to `removeHabitFromCache` was removed.
    // The reconciliation logic in `renderHabits` now handles cache cleanup automatically
    // when a DOM element is removed, which is a more robust and centralized approach.

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
    input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        // Se o arquivo for muito grande, o navegador pode travar. Adicionamos um limite de segurança.
        if (file.size > 5 * 1024 * 1024) { // 5MB limit
            alert(t('importError'));
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target?.result as string;
                const importedState: AppState = JSON.parse(text);

                // VALIDAÇÃO BÁSICA: Verifica se o objeto importado se parece com nosso estado.
                if (typeof importedState.version !== 'number' || !Array.isArray(importedState.habits)) {
                    throw new Error("Invalid state structure");
                }

                persistStateLocally(importedState);
                alert(t('importSuccess'));
                window.location.reload();
            } catch (error) {
                console.error("Error processing imported file:", error);
                alert(t('importError'));
            }
        };
        reader.onerror = () => {
            console.error("Error reading file");
            alert(t('importError'));
        };
        reader.readAsText(file);
        input.remove();
    };
    input.click();
}


export function createDefaultHabit() {
    const defaultHabitTemplate = PREDEFINED_HABITS.find(h => h.isDefault);
    if (!defaultHabitTemplate) return;

    addHabit(defaultHabitTemplate, getTodayUTCIso());
}

export function addHabit(template: { nameKey: string; name?: never } | { name: string; nameKey?: never }, targetDate: string) {
    const nowISO = getTodayUTCIso();
    const startDate = targetDate > nowISO ? targetDate : nowISO;

    const newSchedule: HabitSchedule = {
        startDate: startDate,
        name: ('name' in template && template.name) ? template.name : undefined,
        nameKey: ('nameKey' in template && template.nameKey) ? template.nameKey : undefined,
        subtitleKey: (template as any).subtitleKey,
        times: (template as any).times,
        frequency: (template as any).frequency,
        scheduleAnchor: startDate,
    };

    const newHabit: Habit = {
        id: generateUUID(),
        icon: (template as any).icon,
        color: (template as any).color,
        goal: (template as any).goal,
        createdOn: startDate,
        scheduleHistory: [newSchedule],
    };
    
    state.habits.push(newHabit);
}

export function reorderHabit(draggedHabitId: string, targetHabitId: string, position: 'before' | 'after') {
    const draggedHabit = state.habits.find(h => h.id === draggedHabitId);
    if (!draggedHabit) return;

    const fromIndex = state.habits.indexOf(draggedHabit);
    state.habits.splice(fromIndex, 1);

    const toIndex = state.habits.findIndex(h => h.id === targetHabitId);
    const newIndex = position === 'before' ? toIndex : toIndex + 1;

    state.habits.splice(newIndex, 0, draggedHabit);

    _finalizeScheduleUpdate(false);
}

export function handleHabitDrop(
    habitId: string, 
    fromTime: TimeOfDay, 
    toTime: TimeOfDay,
    reorderInfo?: { id: string, pos: 'before' | 'after' }
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const targetDate = state.selectedDate;

    // A. Lógica "Apenas Hoje"
    const applyJustToday = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        
        let currentSchedule = getEffectiveScheduleForHabitOnDate(habit, targetDate);

        // Se estamos usando um override, precisamos da cópia, não da referência.
        if (dailyInfo.dailySchedule) {
            currentSchedule = [...currentSchedule];
        }

        const fromIndex = currentSchedule.indexOf(fromTime);
        if (fromIndex > -1) {
            currentSchedule.splice(fromIndex, 1);
        }
        
        let toIndex = currentSchedule.indexOf(toTime);
        if (toIndex === -1) {
            currentSchedule.push(toTime);
        }

        dailyInfo.dailySchedule = currentSchedule;
        
        // Reordering logic
        if (reorderInfo) {
            const reorderTargetHabit = state.habits.find(h => h.id === reorderInfo.id);
            if (reorderTargetHabit) reorderHabit(habitId, reorderInfo.id, reorderInfo.pos);
        }
        
        _finalizeScheduleUpdate(false);
    };

    // B. Lógica "De Agora em Diante"
    const applyFromNowOn = () => {
        _requestFutureScheduleChange(habitId, targetDate, (currentSchedule) => {
            const fromIndex = currentSchedule.times.indexOf(fromTime);
            if (fromIndex > -1) {
                currentSchedule.times.splice(fromIndex, 1);
            }
            if (!currentSchedule.times.includes(toTime)) {
                currentSchedule.times.push(toTime);
            }
            return currentSchedule;
        });
        
        if (reorderInfo) {
            reorderHabit(habitId, reorderInfo.id, reorderInfo.pos);
        }
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

function _requestFutureScheduleChange(
    habitId: string, 
    targetDate: string,
    changeFn: (schedule: HabitSchedule) => HabitSchedule
) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    _cleanDailyOverrides(targetDate, habitId);

    const activeScheduleIndex = _findActiveScheduleIndex(habit, targetDate);
    const scheduleToSplit = habit.scheduleHistory[activeScheduleIndex];

    const newSchedule = changeFn(JSON.parse(JSON.stringify(scheduleToSplit)));
    newSchedule.startDate = targetDate;
    newSchedule.endDate = undefined; 
    
    // Truncate the old schedule
    scheduleToSplit.endDate = targetDate;

    // Remove any future schedules that are now obsolete
    const removedSchedules = habit.scheduleHistory.splice(activeScheduleIndex + 1);

    // Add the new schedule
    habit.scheduleHistory.push(newSchedule);
    
    _finalizeScheduleUpdate(true);
    return { newSchedule, removedSchedules };
}

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.status = getNextStatus(instance.status);

    invalidateStreakCache(habitId, date);
    invalidateDaySummaryCache(date);
    invalidateChartCache();
    renderHabitCardState(habitId, time);
    renderCalendarDayPartial(date);
    document.dispatchEvent(new CustomEvent('habitsChanged'));
    saveState();
}

export function setGoalOverride(habitId: string, date: string, time: TimeOfDay, newGoal: number) {
    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.goalOverride = newGoal;
    
    invalidateDaySummaryCache(date);
    invalidateChartCache();
    document.dispatchEvent(new CustomEvent('habitsChanged'));
    saveState();
}

export function handleSaveNote() {
    if (!state.editingNoteFor) return;
    const { habitId, date, time } = state.editingNoteFor;

    const instance = ensureHabitInstanceData(date, habitId, time);
    instance.note = ui.notesTextarea.value.trim();
    
    closeModal(ui.notesModal);
    renderHabitCardState(habitId, time);
    saveState();
}

export function requestHabitEditingFromModal(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    closeModal(ui.manageModal);
    openEditModal(habit);
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;
    
    const { isNew, habitId, originalData, formData, targetDate } = state.editingHabit;
    
    const finalName = ('name' in formData && formData.name) ? formData.name : t(formData.nameKey);

    const formNoticeEl = ui.editHabitForm.querySelector<HTMLElement>('.form-notice')!;
    formNoticeEl.classList.remove('visible');

    if (!finalName || formData.times.length === 0) {
        formNoticeEl.textContent = t('modalEditFormNotice');
        formNoticeEl.classList.add('visible');
        return;
    }

    const newSchedule: HabitSchedule = {
        startDate: targetDate,
        name: ('name' in formData && formData.name) ? formData.name : undefined,
        nameKey: ('nameKey' in formData && formData.nameKey) ? formData.nameKey : undefined,
        subtitleKey: formData.subtitleKey,
        times: formData.times,
        frequency: formData.frequency,
        scheduleAnchor: targetDate,
    };
    
    if (isNew) {
        addHabit(formData, targetDate);
    } else if (habitId) {
        _requestFutureScheduleChange(habitId, targetDate, () => newSchedule);
        
        const habit = state.habits.find(h => h.id === habitId)!;
        habit.icon = formData.icon;
        habit.color = formData.color;
        habit.goal = formData.goal;
    }

    closeModal(ui.editHabitModal);
    _finalizeScheduleUpdate(true);
}


function _removeTimeFromSchedule(habitId: string, timeToRemove: TimeOfDay, targetDate: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    // A. "Just Today" Logic
    const applyJustToday = () => {
        const dailyInfo = ensureHabitDailyInfo(targetDate, habitId);
        let currentSchedule = getEffectiveScheduleForHabitOnDate(habit, targetDate);

        // If an override exists, we need a mutable copy.
        if (dailyInfo.dailySchedule) {
            currentSchedule = [...currentSchedule];
        }

        const fromIndex = currentSchedule.indexOf(timeToRemove);
        if (fromIndex > -1) {
            currentSchedule.splice(fromIndex, 1);
        }
        
        dailyInfo.dailySchedule = currentSchedule;

        _finalizeScheduleUpdate(false);
    };

    // B. "From Now On" Logic
    const applyFromNowOn = () => {
        _requestFutureScheduleChange(habitId, targetDate, (currentSchedule) => {
            const indexToRemove = currentSchedule.times.indexOf(timeToRemove);
            if (indexToRemove > -1) {
                currentSchedule.times.splice(indexToRemove, 1);
            }
            return currentSchedule;
        });
    };
    
    const habitName = getHabitDisplayInfo(habit, targetDate).name;
    const timeName = getTimeOfDayName(timeToRemove);

    showConfirmationModal(
        t('confirmRemoveTime', { habitName, time: timeName }),
        applyFromNowOn,
        {
            title: t('modalRemoveTimeTitle'),
            confirmText: t('buttonFromNowOn'),
            editText: t('buttonJustToday'),
            onEdit: applyJustToday
        }
    );
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    
    const schedule = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);

    if (schedule.length > 1) {
        _removeTimeFromSchedule(habitId, time, state.selectedDate);
    } else {
        requestHabitEndingFromModal(habitId, state.selectedDate);
    }
}

export function requestHabitEndingFromModal(habitId: string, date: string = state.selectedDate) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    const { name } = getHabitDisplayInfo(habit, date);
    const formattedDate = getDateTimeFormat(state.activeLanguageCode, {
        day: 'numeric', month: 'long', timeZone: 'UTC'
    }).format(parseUTCIsoDate(date));

    showConfirmationModal(
        t('confirmEndHabit', { habitName: name, date: formattedDate }),
        () => {
            const habit = state.habits.find(h => h.id === habitId);
            if (!habit) return;

            // FIX: Create a deep copy of the habit *before* it's mutated, for the undo action.
            const originalHabitForUndo = JSON.parse(JSON.stringify(habit));
            
            const activeScheduleIndex = _findActiveScheduleIndex(habit, date);
            const activeSchedule = habit.scheduleHistory[activeScheduleIndex];
            
            if (date === activeSchedule.startDate) {
                habit.scheduleHistory.splice(activeScheduleIndex);
                if (habit.scheduleHistory.length > 0) {
                    const previousSchedule = habit.scheduleHistory[habit.scheduleHistory.length - 1];
                    previousSchedule.endDate = undefined;
                } else {
                    state.habits = state.habits.filter(h => h.id !== habitId);
                }
            } else {
                activeSchedule.endDate = date;
                habit.scheduleHistory.splice(activeScheduleIndex + 1);
            }
            
            // FIX: Store the original habit object for a perfect undo state.
            state.lastEnded = { habitId, originalHabit: originalHabitForUndo };
            state.lastEnded.wipedDailyData = _wipeFutureDailyDataForHabit(habitId, date);
            
            _finalizeScheduleUpdate(true);
            showUndoToast();
        },
        { 
            title: t('modalEndHabitTitle'), 
            confirmText: t('endButton'),
            confirmButtonStyle: 'danger'
        }
    );
}

export function undoLastEnd() {
    if (!state.lastEnded) return;

    // FIX: Use the complete originalHabit object to restore the state perfectly.
    const { habitId, originalHabit, wipedDailyData } = state.lastEnded;

    const habitIndex = state.habits.findIndex(h => h.id === habitId);

    if (habitIndex > -1) {
        // If the habit was only modified (e.g., an endDate was added), replace it in-place.
        state.habits[habitIndex] = originalHabit;
    } else {
        // If the habit was completely removed, add it back to the list.
        state.habits.push(originalHabit);
    }
    
    // Restore wiped data
    if(wipedDailyData) {
        for (const dateKey in wipedDailyData) {
            state.dailyData[dateKey] = state.dailyData[dateKey] || {};
            state.dailyData[dateKey][habitId] = wipedDailyData[dateKey];
        }
    }

    state.lastEnded = null;
    if (state.undoTimeout) clearTimeout(state.undoTimeout);
    ui.undoToast.classList.remove('visible');
    
    _finalizeScheduleUpdate(true);
}

export function requestHabitPermanentDeletion(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;
    const { name } = getHabitDisplayInfo(habit);

    showConfirmationModal(
        t('confirmPermanentDelete', { habitName: name }),
        () => {
            state.habits = state.habits.filter(h => h.id !== habitId);
            _wipeDailyDataForHabits([habitId]);
            removeHabitFromCache(habitId); // Purge from DOM cache
            clearScheduleCache();
            clearActiveHabitsCache();
            
            state.uiDirtyState.habitListStructure = true;
            saveState();
            renderApp();
            setupManageModal(); // Refresh modal list
        },
        { 
            title: t('modalDeleteHabitTitle'), 
            confirmText: t('deleteButton'), 
            confirmButtonStyle: 'danger'
        }
    );
}

export function graduateHabit(habitId: string) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) {
        habit.graduatedOn = getTodayUTCIso();
        _finalizeScheduleUpdate(true);
        setupManageModal();
    }
}

export function resetApplicationData() {
    state.habits = [];
    state.dailyData = {};
    state.archives = {};
    _wipeDailyDataForHabits(state.habits.map(h => h.id)); // Clean up any orphans
    createDefaultHabit();
    saveState();
    renderApp();
    closeModal(ui.manageModal);
}

export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    const activeHabits = getActiveHabitsForDate(dateISO);
    if (activeHabits.length === 0) return false;

    activeHabits.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            const instance = ensureHabitInstanceData(dateISO, habit.id, time);
            instance.status = status;
        });
        invalidateStreakCache(habit.id, dateISO);
    });

    invalidateDaySummaryCache(dateISO);
    invalidateChartCache();
    document.dispatchEvent(new CustomEvent('habitsChanged'));
    saveState();
    return true;
}

export async function performAIAnalysis(analysisType: 'monthly' | 'quarterly' | 'historical') {
    closeModal(ui.aiOptionsModal);
    
    state.aiState = 'loading';
    state.hasSeenAIResult = true; // Hide notification dot immediately
    renderAINotificationState();

    try {
        const todayISO = getTodayUTCIso();

        let promptTemplateKey: string;
        let promptTemplate: string;
        switch (analysisType) {
            case 'quarterly':
                promptTemplateKey = 'aiPromptMonthly';
                promptTemplate = t(promptTemplateKey)
                    .replace('30 dias', '90 dias')
                    .replace('30-Day', '90-Day')
                    .replace('último mês', 'último trimestre');
                break;
            case 'monthly':
                promptTemplateKey = 'aiPromptMonthly';
                promptTemplate = t(promptTemplateKey);
                break;
            case 'historical':
            default:
                promptTemplateKey = 'aiPromptGeneral';
                promptTemplate = t(promptTemplateKey);
                break;
        }

        const langMap: Record<string, string> = { pt: 'Português', en: 'English', es: 'Español' };
        const languageName = langMap[state.activeLanguageCode as keyof typeof langMap] || 'English';

        const payloadForWorker = {
            analysisType,
            habits: state.habits,
            dailyData: state.dailyData,
            archives: state.archives,
            languageName,
            translations: {
                promptTemplate,
                aiPromptGraduatedSection: t('aiPromptGraduatedSection'),
                aiPromptNoData: t('aiPromptNoData'),
                aiPromptNone: t('aiPromptNone'),
                aiSystemInstruction: t('aiSystemInstruction'),
                ...Object.fromEntries(PREDEFINED_HABITS.map(h => [h.nameKey, t(h.nameKey)]))
            },
            todayISO
        };
        
        const { prompt, systemInstruction } = await runWorkerTask<{ prompt: string; systemInstruction: string }>('build-ai-prompt', payloadForWorker);

        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, systemInstruction }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${t('aiErrorPrefix')}: ${errorText}`);
        }

        const result = await response.text();
        state.lastAIResult = result;
        state.aiState = 'completed';
    } catch (e: any) {
        console.error("AI analysis failed:", e);
        state.lastAIResult = `${t('aiErrorGeneric')}\n\n*${e.message}*`;
        state.aiState = 'error';
    } finally {
        state.hasSeenAIResult = false;
        renderAINotificationState();
        saveState();
        
        ui.aiResponse.innerHTML = simpleMarkdownToHTML(state.lastAIResult || t('aiErrorUnknown'));
        openModal(ui.aiModal, undefined, () => {
            state.hasSeenAIResult = true;
            renderAINotificationState();
        });
    }
}