
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/habitActions.ts
 * @description Controlador de Ações de Hábito (Business Logic Controller).
 * Localização: src/services/habitActions.ts
 */

// Imports sobem um nível (../) para acessar State e Utils
import { 
    state, Habit, HabitSchedule, TimeOfDay, ensureHabitDailyInfo, 
    ensureHabitInstanceData, clearScheduleCache,
    clearActiveHabitsCache, invalidateCachesForDateChange, getPersistableState,
    HabitDayData, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED,
    HABIT_STATE, AppState
} from '../state';

import { 
    generateUUID, getTodayUTCIso, parseUTCIsoDate, triggerHaptic,
    getSafeDate, addDays, toUTCIsoDateString
} from '../utils';

// Imports sobem um nível (../) para acessar Render e i18n
import { 
    closeModal, showConfirmationModal, renderAINotificationState,
    clearHabitDomCache
} from '../render';
import { ui } from '../render/ui';
import { t, getTimeOfDayName, formatDate, getAiLanguageName, formatList } from '../i18n'; 

// Imports no mesmo nível (./) pois agora são vizinhos de pasta
import { saveState, loadState, clearLocalPersistence } from './persistence';
import { 
    getEffectiveScheduleForHabitOnDate, clearSelectorInternalCaches,
    calculateHabitStreak, shouldHabitAppearOnDate, getHabitDisplayInfo, getHabitPropertiesForDate
} from './selectors';
import { runWorkerTask } from './cloud';
import { apiFetch, clearKey } from './api';
import { HabitService } from './HabitService';

import { PREDEFINED_HABITS } from '../data/predefinedHabits'; 

const ARCHIVE_DAYS_THRESHOLD = 90;
const BATCH_IDS_POOL: string[] = [];
const BATCH_HABITS_POOL: Habit[] = [];

let _isBatchOpActive = false;

const ActionContext = {
    isLocked: false,
    drop: null as any,
    removal: null as any,
    ending: null as any,
    deletion: null as any,
    reset() {
        this.isLocked = false;
        this.drop = this.removal = this.ending = this.deletion = null;
    }
};

// --- PRIVATE HELPERS ---

function _notifyChanges(fullRebuild = false) {
    if (fullRebuild) {
        clearScheduleCache();
        clearHabitDomCache();
        clearSelectorInternalCaches();
    } else {
        clearActiveHabitsCache();
    }
    state.uiDirtyState.habitListStructure = state.uiDirtyState.calendarVisuals = true;
    saveState();
    ['render-app', 'habitsChanged'].forEach(ev => document.dispatchEvent(new CustomEvent(ev)));
}

function _notifyPartialUIRefresh(date: string, habitIds: string[]) {
    invalidateCachesForDateChange(date, habitIds);
    state.uiDirtyState.calendarVisuals = true;
    saveState();
    ['render-app', 'habitsChanged'].forEach(ev => document.dispatchEvent(new CustomEvent(ev)));
}

function _lockActionHabit(habitId: string): Habit | null {
    if (ActionContext.isLocked) return null;
    ActionContext.isLocked = true;
    const h = state.habits.find(x => x.id === habitId);
    if (!h) ActionContext.reset();
    return h;
}

function _requestFutureScheduleChange(habitId: string, targetDate: string, updateFn: (s: HabitSchedule) => HabitSchedule) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return;

    const history = habit.scheduleHistory;
    const activeIndex = history.findIndex(s => targetDate >= s.startDate && (!s.endDate || targetDate < s.endDate));

    if (activeIndex !== -1) {
        const activeSchedule = history[activeIndex];
        
        if (activeSchedule.startDate === targetDate) {
            const updatedSchedule = updateFn({ ...activeSchedule });
            history[activeIndex] = updatedSchedule;
        } else {
            const originalEndDate = activeSchedule.endDate;
            activeSchedule.endDate = targetDate;
            const newSchedule = updateFn({ ...activeSchedule, startDate: targetDate, endDate: originalEndDate });
            history.push(newSchedule);
        }
    } else {
        const insertionIndex = history.findIndex(s => targetDate < s.startDate);

        if (insertionIndex === -1) {
            const lastSchedule = history[history.length - 1];
            if (lastSchedule && !lastSchedule.endDate) {
                lastSchedule.endDate = targetDate;
            }
            history.push(updateFn({ ...(lastSchedule || {} as any), startDate: targetDate, endDate: undefined }));
        } else {
            const nextSchedule = history[insertionIndex];
            const prevSchedule = history[insertionIndex - 1];
            const newEndDate = nextSchedule.startDate;
            const baseSchedule = prevSchedule || nextSchedule; 
            
            history.push(updateFn({ ...baseSchedule, startDate: targetDate, endDate: newEndDate }));
            
            if (prevSchedule && !prevSchedule.endDate) {
                prevSchedule.endDate = targetDate;
            }
        }
    }

    history.sort((a, b) => a.startDate.localeCompare(b.startDate));
    habit.graduatedOn = undefined;
    _notifyChanges(true);
}

function _checkStreakMilestones(habit: Habit, dateISO: string) {
    const streak = calculateHabitStreak(habit, dateISO);
    const m = streak === STREAK_SEMI_CONSOLIDATED ? state.pending21DayHabitIds : (streak === STREAK_CONSOLIDATED ? state.pendingConsolidationHabitIds : null);
    if (m && !state.notificationsShown.includes(`${habit.id}-${streak}`) && !m.includes(habit.id)) {
        m.push(habit.id);
        renderAINotificationState();
    }
}

function _moveHabitInstanceForDay(habitId: string, date: string, fromTime: TimeOfDay, toTime: TimeOfDay) {
    // 1. Move Metadados Ricos (JSON)
    try {
        const info = ensureHabitDailyInfo(date, habitId);
        const sourceData = info.instances[fromTime];

        if (sourceData) {
            const cleanData: HabitDayData = {};
            if (sourceData.goalOverride !== undefined) cleanData.goalOverride = sourceData.goalOverride;
            if (sourceData.note !== undefined) cleanData.note = sourceData.note;

            if (Object.keys(cleanData).length > 0) {
                info.instances[toTime] = cleanData;
            }
            delete info.instances[fromTime];
        }
    } catch (e) {
        // Ignora erros de hidratação
    }

    // 2. Move o Status Binário (Bitmask)
    const currentBit = HabitService.getStatus(habitId, date, fromTime);
    if (currentBit !== HABIT_STATE.NULL) {
        HabitService.setStatus(habitId, date, toTime, currentBit);
        HabitService.setStatus(habitId, date, fromTime, HABIT_STATE.NULL);
    }
}

// --- CONFIRMATION HANDLERS ---

const _applyDropJustToday = () => {
    const ctx = ActionContext.drop, target = getSafeDate(state.selectedDate);
    if (!ctx || !target) return ActionContext.reset(); // Proteção extra contra data nula
    
    const habit = state.habits.find(h => h.id === ctx.habitId);
    if (habit) {
        const info = ensureHabitDailyInfo(target, ctx.habitId);
        const sch = [...getEffectiveScheduleForHabitOnDate(habit, target)];
        const fIdx = sch.indexOf(ctx.fromTime);
        if (fIdx > -1) sch.splice(fIdx, 1);
        if (!sch.includes(ctx.toTime)) sch.push(ctx.toTime);
        info.dailySchedule = sch;

        _moveHabitInstanceForDay(ctx.habitId, target, ctx.fromTime, ctx.toTime);

        if (ctx.reorderInfo) reorderHabit(ctx.habitId, ctx.reorderInfo.id, ctx.reorderInfo.pos, true);
        _notifyChanges(false);
    }
    ActionContext.reset();
};

const _applyDropFromNowOn = () => {
    const ctx = ActionContext.drop, target = getSafeDate(state.selectedDate);
    if (!ctx || !target) return ActionContext.reset();

    const info = ensureHabitDailyInfo(target, ctx.habitId);
    const curOverride = info.dailySchedule ? [...info.dailySchedule] : null;
    info.dailySchedule = undefined;

    _moveHabitInstanceForDay(ctx.habitId, target, ctx.fromTime, ctx.toTime);

    if (ctx.reorderInfo) reorderHabit(ctx.habitId, ctx.reorderInfo.id, ctx.reorderInfo.pos, true);

    _requestFutureScheduleChange(ctx.habitId, target, (s) => {
        const times = curOverride || [...s.times];
        const fIdx = times.indexOf(ctx.fromTime);
        if (fIdx > -1) times.splice(fIdx, 1);
        if (!times.includes(ctx.toTime)) times.push(ctx.toTime);
        return { ...s, times: times as readonly TimeOfDay[] };
    });
    ActionContext.reset();
};

const _applyHabitDeletion = async () => {
    const ctx = ActionContext.deletion;
    if (!ctx) return ActionContext.reset();

    const index = state.habits.findIndex(x => x.id === ctx.habitId);
    if (index === -1) {
        console.warn(`[Action] Habit deletion failed: Habit with ID ${ctx.habitId} not found.`);
        return ActionContext.reset();
    }

    const [deletedHabit] = state.habits.splice(index, 1);

    Object.keys(state.dailyData).forEach(d => delete state.dailyData[d][ctx.habitId]);

    // Limpeza de Bitmask
    if (state.monthlyLogs) {
        const keysToRemove: string[] = [];
        state.monthlyLogs.forEach((_, key) => {
            if (key.startsWith(ctx.habitId + '_')) {
                keysToRemove.push(key);
            }
        });
        keysToRemove.forEach(k => state.monthlyLogs.delete(k));
    }

    const startYear = parseInt((deletedHabit.scheduleHistory[0]?.startDate || deletedHabit.createdOn).substring(0, 4), 10);
    try {
        const up = await runWorkerTask<AppState['archives']>('prune-habit', { habitId: ctx.habitId, archives: state.archives, startYear });
        Object.keys(up).forEach(y => {
            if (up[y] === "") delete state.archives[y];
            else state.archives[y] = up[y];
            state.unarchivedCache.delete(y);
        });
    } catch (e) {
        console.error(e);
    }

    _notifyChanges(true);
    ActionContext.reset();
};

// --- PUBLIC ACTIONS ---

export function performArchivalCheck() {
    const run = async () => {
        const threshold = toUTCIsoDateString(addDays(parseUTCIsoDate(getTodayUTCIso()), -ARCHIVE_DAYS_THRESHOLD)), buckets: Record<string, any> = {}, toRem: string[] = [];
        Object.keys(state.dailyData).forEach(d => {
            if (d < threshold) {
                const y = d.substring(0, 4);
                buckets[y] ??= { additions: {}, base: state.unarchivedCache.get(y) || state.archives[y] };
                buckets[y].additions[d] = state.dailyData[d];
                toRem.push(d);
            }
        });
        if (toRem.length === 0) return;
        try {
            const up = await runWorkerTask<Record<string, string>>('archive', buckets);
            Object.keys(up).forEach(y => { state.archives[y] = up[y]; state.unarchivedCache.delete(y); Object.keys(buckets[y].additions).forEach(k => delete state.dailyData[k]); });
            await saveState();
        } catch (e) { console.error(e); }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(() => run()); else setTimeout(run, 5000);
}

export function createDefaultHabit() {
    const t = PREDEFINED_HABITS.find(h => h.isDefault);
    if (!t) return;
    
    state.habits.push({ id: generateUUID(), createdOn: getTodayUTCIso(),
        scheduleHistory: [{ startDate: getTodayUTCIso(), nameKey: t.nameKey, subtitleKey: t.subtitleKey, times: t.times, frequency: t.frequency, scheduleAnchor: getTodayUTCIso(), icon: t.icon, color: t.color, goal: t.goal, philosophy: t.philosophy }]
    });
    _notifyChanges(true);
}

export function reorderHabit(movedHabitId: string, targetHabitId: string, pos: 'before' | 'after', skip = false) {
    const h = state.habits, mIdx = h.findIndex(x => x.id === movedHabitId), tIdx = h.findIndex(x => x.id === targetHabitId);
    if (mIdx === -1 || tIdx === -1) return;
    const [item] = h.splice(mIdx, 1);
    h.splice(pos === 'before' ? (mIdx < tIdx ? tIdx - 1 : tIdx) : (mIdx < tIdx ? tIdx : tIdx + 1), 0, item);
    if (!skip) _notifyChanges(false);
}

export function saveHabitFromModal() {
    if (!state.editingHabit) return;
    const { isNew, habitId, formData, targetDate } = state.editingHabit;

    if (formData.name) formData.name = formData.name.replace(/[<>{}]/g, '').trim();
    const nameToUse = formData.nameKey ? t(formData.nameKey) : formData.name!;
    if (!nameToUse) return;

    const cleanFormData = {
        ...formData,
        times: [...formData.times],
        goal: { ...formData.goal },
        frequency: formData.frequency.type === 'specific_days_of_week'
            ? { ...formData.frequency, days: [...formData.frequency.days] }
            : { ...formData.frequency }
    };

    if (isNew) {
        const existingHabit = state.habits.find(h => {
            const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
            if (h.graduatedOn || (lastSchedule.endDate && targetDate >= lastSchedule.endDate)) {
                return false;
            }
            const info = getHabitDisplayInfo(h, targetDate);
            return info.name.trim().toLowerCase() === nameToUse.trim().toLowerCase();
        });

        if (existingHabit) {
            _requestFutureScheduleChange(existingHabit.id, targetDate, (s) => ({
                ...s,
                icon: cleanFormData.icon,
                color: cleanFormData.color,
                goal: cleanFormData.goal,
                philosophy: cleanFormData.philosophy ?? s.philosophy,
                name: cleanFormData.name,
                nameKey: cleanFormData.nameKey,
                subtitleKey: cleanFormData.subtitleKey,
                times: cleanFormData.times as readonly TimeOfDay[],
                frequency: cleanFormData.frequency,
            }));
        } else {
            state.habits.push({ 
                id: generateUUID(), 
                createdOn: targetDate, 
                scheduleHistory: [{ 
                    startDate: targetDate, 
                    times: cleanFormData.times as readonly TimeOfDay[], 
                    frequency: cleanFormData.frequency, 
                    name: cleanFormData.name, 
                    nameKey: cleanFormData.nameKey, 
                    subtitleKey: cleanFormData.subtitleKey, 
                    scheduleAnchor: targetDate,
                    icon: cleanFormData.icon,
                    color: cleanFormData.color,
                    goal: cleanFormData.goal,
                    philosophy: cleanFormData.philosophy
                }]
            });
            _notifyChanges(true);
        }
    } else {
        const h = state.habits.find(x => x.id === habitId);
        if (!h) return;
        
        ensureHabitDailyInfo(targetDate, h.id).dailySchedule = undefined;
        if (targetDate < h.createdOn) h.createdOn = targetDate;

        _requestFutureScheduleChange(h.id, targetDate, (s) => ({ 
            ...s, 
            icon: cleanFormData.icon,
            color: cleanFormData.color,
            goal: cleanFormData.goal,
            philosophy: cleanFormData.philosophy ?? s.philosophy,
            name: cleanFormData.name, 
            nameKey: cleanFormData.nameKey, 
            subtitleKey: cleanFormData.subtitleKey, 
            times: cleanFormData.times as readonly TimeOfDay[], 
            frequency: cleanFormData.frequency 
        }));
    }

    closeModal(ui.editHabitModal);
}

export async function performAIAnalysis(type: 'monthly' | 'quarterly' | 'historical') {
    if (state.aiState === 'loading') return;
    const id = ++state.aiReqId; state.aiState = 'loading'; state.hasSeenAIResult = false;
    renderAINotificationState(); closeModal(ui.aiOptionsModal);
    try {
        const trans: Record<string, string> = { promptTemplate: t(type === 'monthly' ? 'aiPromptMonthly' : (type === 'quarterly' ? 'aiPromptQuarterly' : 'aiPromptGeneral')), aiDaysUnit: t('unitDays', { count: 2 }) };
        ['aiPromptGraduatedSection', 'aiPromptNoData', 'aiPromptNone', 'aiSystemInstruction', 'aiPromptHabitDetails', 'aiVirtue', 'aiDiscipline', 'aiSphere', 'stoicVirtueWisdom', 'stoicVirtueCourage', 'stoicVirtueJustice', 'stoicVirtueTemperance', 'stoicDisciplineDesire', 'stoicDisciplineAction', 'stoicDisciplineAssent', 'governanceSphereBiological', 'governanceSphereStructural', 'governanceSphereSocial', 'governanceSphereMental', 'aiPromptNotesSectionHeader', 'aiStreakLabel', 'aiSuccessRateLabelMonthly', 'aiSuccessRateLabelQuarterly', 'aiSuccessRateLabelHistorical', 'aiHistoryChange', 'aiHistoryChangeFrequency', 'aiHistoryChangeGoal', 'aiHistoryChangeTimes'].forEach(k => trans[k] = t(k));
        PREDEFINED_HABITS.forEach(h => trans[h.nameKey] = t(h.nameKey));
        const { prompt, systemInstruction } = await runWorkerTask<any>('build-ai-prompt', { analysisType: type, habits: state.habits, dailyData: state.dailyData, archives: state.archives, monthlyLogs: state.monthlyLogs, languageName: getAiLanguageName(), translations: trans, todayISO: getTodayUTCIso() });
        if (id !== state.aiReqId) return;
        const res = await apiFetch('/api/analyze', { method: 'POST', body: JSON.stringify({ prompt, systemInstruction }) });
        if (id === state.aiReqId) { state.lastAIResult = await res.text(); state.aiState = 'completed'; }
    } catch (e) { if (id === state.aiReqId) { state.lastAIError = String(e); state.aiState = 'error'; state.lastAIResult = t('aiErrorGeneric'); } }
    finally { if (id === state.aiReqId) { saveState(); renderAINotificationState(); } }
}

export function importData() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json';
    input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data.habits && data.version) { await loadState(data); await saveState(); ['render-app', 'habitsChanged'].forEach(ev => document.dispatchEvent(new CustomEvent(ev))); closeModal(ui.manageModal); showConfirmationModal(t('importSuccess'), () => {}, { title: t('privacyLabel'), confirmText: 'OK', hideCancel: true }); }
            else throw 0;
        } catch { showConfirmationModal(t('importError'), () => {}, { title: t('importError'), confirmText: 'OK', hideCancel: true, confirmButtonStyle: 'danger' }); }
    };
    input.click();
}

/**
 * Alterna o estado do hábito (Check/Uncheck).
 * Ciclo: Vazio (0) -> Feito (1) -> Adiado (2) -> Vazio (0)
 */
export function toggleHabitStatus(habitId: string, time: TimeOfDay, dateISO: string) {
    const currentStatus = HabitService.getStatus(habitId, dateISO, time);
    
    let nextStatus: number = HABIT_STATE.DONE;
    if (currentStatus === HABIT_STATE.DONE || currentStatus === HABIT_STATE.DONE_PLUS) {
        nextStatus = HABIT_STATE.DEFERRED;
    } else if (currentStatus === HABIT_STATE.DEFERRED) {
        nextStatus = HABIT_STATE.NULL;
    }
    
    HabitService.setStatus(habitId, dateISO, time, nextStatus);
    saveState(); 
    
    const h = state.habits.find(x => x.id === habitId);
    if (nextStatus === HABIT_STATE.DONE) {
        if (h) _checkStreakMilestones(h, dateISO);
        triggerHaptic('light');
    } else if (nextStatus === HABIT_STATE.DEFERRED) {
        triggerHaptic('medium');
    } else {
        triggerHaptic('selection');
    }

    document.dispatchEvent(new CustomEvent('card-status-changed', { 
        detail: { habitId, time, date: dateISO } 
    }));
    
    _notifyPartialUIRefresh(dateISO, [habitId]);
}

export function markAllHabitsForDate(dateISO: string, status: 'completed' | 'snoozed'): boolean {
    if (_isBatchOpActive || (state.unarchivedCache.has(`${dateISO.substring(0, 4)}_pending`))) return false;
    _isBatchOpActive = true;
    
    const dateObj = parseUTCIsoDate(dateISO);
    let changed = false; 
    BATCH_IDS_POOL.length = 0; 
    BATCH_HABITS_POOL.length = 0;

    try {
        state.habits.forEach(h => {
            if (!shouldHabitAppearOnDate(h, dateISO, dateObj)) return;
            const sch = getEffectiveScheduleForHabitOnDate(h, dateISO); 
            if (!sch.length) return;
            
            let bitStatus: number = (status === 'completed') ? HABIT_STATE.DONE : HABIT_STATE.DEFERRED;

            sch.forEach(t => {
                if (HabitService.getStatus(h.id, dateISO, t) !== bitStatus) {
                    HabitService.setStatus(h.id, dateISO, t, bitStatus);
                    changed = true;
                }
            });

            if (changed) { 
                BATCH_IDS_POOL.push(h.id); 
                BATCH_HABITS_POOL.push(h); 
            }
        });
        
        if (changed) { 
            invalidateCachesForDateChange(dateISO, BATCH_IDS_POOL); 
            if (status === 'completed') BATCH_HABITS_POOL.forEach(h => _checkStreakMilestones(h, dateISO)); 
            _notifyChanges(false); 
        }
    } finally { _isBatchOpActive = false; }
    return changed;
}

export function handleHabitDrop(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay, reorderInfo?: any) {
    const h = _lockActionHabit(habitId); if (!h) return;
    ActionContext.drop = { habitId, fromTime, toTime, reorderInfo };
    showConfirmationModal(t('confirmHabitMove', { habitName: getHabitDisplayInfo(h, state.selectedDate).name, oldTime: getTimeOfDayName(fromTime), newTime: getTimeOfDayName(toTime) }), 
        _applyDropFromNowOn, { title: t('modalMoveHabitTitle'), confirmText: t('buttonFromNowOn'), editText: t('buttonJustToday'), onEdit: _applyDropJustToday, onCancel: () => ActionContext.reset() });
}

export function requestHabitEndingFromModal(habitId: string) {
    const h = _lockActionHabit(habitId), target = getSafeDate(state.selectedDate); if (!h) return;
    ActionContext.ending = { habitId, targetDate: target };
    showConfirmationModal(t('confirmEndHabit', { habitName: getHabitDisplayInfo(h, target).name, date: formatDate(parseUTCIsoDate(target), { day: 'numeric', month: 'long', timeZone: 'UTC' }) }), 
        () => { _requestFutureScheduleChange(habitId, target, s => ({ ...s, endDate: target })); ActionContext.reset(); }, { confirmButtonStyle: 'danger', confirmText: t('endButton'), onCancel: () => ActionContext.reset() });
}

export function requestHabitPermanentDeletion(habitId: string) {
    if (_lockActionHabit(habitId)) {
        ActionContext.deletion = { habitId };
        showConfirmationModal(
            t('confirmPermanentDelete', { habitName: getHabitDisplayInfo(state.habits.find(x => x.id === habitId)!).name }),
            _applyHabitDeletion,
            { 
                confirmButtonStyle: 'danger', 
                confirmText: t('deleteButton'), 
                onCancel: () => ActionContext.reset() 
            }
        );
    }
}
export function graduateHabit(habitId: string) { const h = state.habits.find(x => x.id === habitId); if (h) { h.graduatedOn = getSafeDate(state.selectedDate); _notifyChanges(true); triggerHaptic('success'); } }

export async function resetApplicationData() { 
    // 1. Visually reset UI immediately (Feedback)
    state.habits = []; 
    state.dailyData = {}; 
    state.archives = {}; 
    state.notificationsShown = []; 
    state.pending21DayHabitIds = []; 
    state.pendingConsolidationHabitIds = [];
    state.monthlyLogs = new Map();
    
    // Dispara atualização para limpar a tela antes do reload
    document.dispatchEvent(new CustomEvent('render-app'));

    try { 
        // 2. Nuke persistence (Atomic & Blocking)
        await clearLocalPersistence(); 
    } catch (e) {
        console.error("Reset failed partially", e);
    } finally { 
        // 3. Nuke Key
        clearKey(); 
        // 4. Force Reload
        window.location.reload(); 
    } 
}

export function handleSaveNote() { 
    if (!state.editingNoteFor) return; 
    
    const { habitId, date, time } = state.editingNoteFor;
    const val = ui.notesTextarea.value.trim();
    const inst = ensureHabitInstanceData(date, habitId, time);
    
    if ((inst.note || '') !== val) { 
        inst.note = val || undefined; 
        state.uiDirtyState.habitListStructure = true; 
        saveState(); 
        document.dispatchEvent(new CustomEvent('render-app')); 
    } 
    closeModal(ui.notesModal); 
}

export function setGoalOverride(habitId: string, d: string, t: TimeOfDay, v: number) { 
    try {
        const h = state.habits.find(x => x.id === habitId);
        if (!h) return;

        ensureHabitInstanceData(d, habitId, t).goalOverride = v;
        
        const currentStatus = HabitService.getStatus(habitId, d, t);
        
        if (currentStatus === HABIT_STATE.DONE || currentStatus === HABIT_STATE.DONE_PLUS) {
             const props = getHabitPropertiesForDate(h, d);
             if (props?.goal?.total && v > props.goal.total) {
                 if (currentStatus !== HABIT_STATE.DONE_PLUS) {
                     HabitService.setStatus(habitId, d, t, HABIT_STATE.DONE_PLUS);
                 }
             } else {
                 if (currentStatus !== HABIT_STATE.DONE) {
                     HabitService.setStatus(habitId, d, t, HABIT_STATE.DONE);
                 }
             }
        }

        saveState();
        document.dispatchEvent(new CustomEvent('card-goal-changed', { detail: { habitId, time: t, date: d } })); 
        _notifyPartialUIRefresh(d, [habitId]); 
    } catch (e) { 
        console.error(e); 
    } 
}

export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) {
    const h = _lockActionHabit(habitId), target = getSafeDate(state.selectedDate); if (!h) return;
    ActionContext.removal = { habitId, time, targetDate: target };
    showConfirmationModal(
        t('confirmRemoveTimePermanent', { habitName: getHabitDisplayInfo(h, target).name, time: getTimeOfDayName(time) }), 
        () => { 
            ensureHabitDailyInfo(target, habitId).dailySchedule = undefined; 
            _requestFutureScheduleChange(habitId, target, s => ({ ...s, times: s.times.filter(x => x !== time) as readonly TimeOfDay[] })); 
            ActionContext.reset(); 
        }, 
        { 
            title: t('modalRemoveTimeTitle'), 
            confirmText: t('deleteButton'), 
            confirmButtonStyle: 'danger', 
            onCancel: () => ActionContext.reset() 
        }
    );
}

export function exportData() {
    const stateToExport = getPersistableState();
    // Serializa manualmente o Map de Bitmasks para Array de Hex, 
    // pois JSON.stringify ignora Maps e isso perderia o histórico.
    const logs = HabitService.serializeLogsForCloud(); 
    if (logs.length > 0) {
        (stateToExport as any).monthlyLogsSerialized = logs;
    }

    const blob = new Blob([JSON.stringify(stateToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `askesis-backup-${getTodayUTCIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

export function handleDayTransition() { 
    const today = getTodayUTCIso(); 
    
    clearActiveHabitsCache(); 
    
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.chartData = true; 
    state.calendarDates = []; 
    
    if (state.selectedDate !== today) {
        state.selectedDate = today; 
    }
    
    document.dispatchEvent(new CustomEvent('render-app')); 
}

function _processAndFormatCelebrations(
    pendingIds: string[], 
    translationKey: 'aiCelebration21Day' | 'aiCelebration66Day',
    streakMilestone: number
): string {
    if (pendingIds.length === 0) return '';
    
    const habitNamesList = pendingIds
        .map(id => state.habits.find(h => h.id === id))
        .filter(Boolean)
        .map(h => getHabitDisplayInfo(h!).name);
    
    const habitNames = formatList(habitNamesList);
        
    pendingIds.forEach(id => {
        const celebrationId = `${id}-${streakMilestone}`;
        if (!state.notificationsShown.includes(celebrationId)) {
            state.notificationsShown.push(celebrationId);
        }
    });

    return t(translationKey, { count: pendingIds.length, habitNames });
};

export function consumeAndFormatCelebrations(): string {
    const celebration21DayText = _processAndFormatCelebrations(state.pending21DayHabitIds, 'aiCelebration21Day', STREAK_SEMI_CONSOLIDATED);
    const celebration66DayText = _processAndFormatCelebrations(state.pendingConsolidationHabitIds, 'aiCelebration66Day', STREAK_CONSOLIDATED);
    const allCelebrations = [celebration66DayText, celebration21DayText].filter(Boolean).join('\n\n');

    if (allCelebrations) {
        state.pending21DayHabitIds = [];
        state.pendingConsolidationHabitIds = [];
        saveState();
    }
    
    return allCelebrations;
}
