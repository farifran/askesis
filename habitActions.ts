/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file habitActions.ts
 * @description Controlador de Lógica de Negócios (Business Logic Controller).
 */

import { 
    state, Habit, HabitSchedule, TimeOfDay, ensureHabitDailyInfo, 
    ensureHabitInstanceData, getNextStatus, HabitStatus, clearScheduleCache,
    clearActiveHabitsCache, invalidateCachesForDateChange, getPersistableState,
    HabitDayData, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED,
    getHabitDailyInfoForDate, AppState, isDateLoading, HabitDailyInfo, LANGUAGES, HABIT_STATE, PERIOD_OFFSET
} from './state';
import { saveState, loadState, clearLocalPersistence } from './services/persistence';
import { PREDEFINED_HABITS } from './data/predefinedHabits';
import { 
    getEffectiveScheduleForHabitOnDate, clearSelectorInternalCaches,
    calculateHabitStreak, shouldHabitAppearOnDate, getHabitDisplayInfo, getScheduleForDate, getHabitPropertiesForDate
} from './services/selectors';
import { 
    generateUUID, getTodayUTCIso, parseUTCIsoDate, triggerHaptic,
    getSafeDate, addDays, toUTCIsoDateString
} from './utils';
import { 
    closeModal, showConfirmationModal, openEditModal, renderAINotificationState,
    clearHabitDomCache
} from './render';
import { ui } from './render/ui';
import { t, getTimeOfDayName, formatDate, getAiLanguageName } from './i18n'; 
import { runWorkerTask } from './services/cloud';
import { apiFetch, clearKey } from './services/api';
import { HabitService } from './services/HabitService';

// --- CONSTANTS ---
const ARCHIVE_DAYS_THRESHOLD = 90;
const BATCH_IDS_POOL: string[] = [];
const BATCH_HABITS_POOL: Habit[] = [];

// --- CONCURRENCY CONTROL ---
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
    // NOTA: state.uiDirtyState.habitListStructure não é definido como true aqui.
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

    // Encontra o cronograma ativo na data alvo
    const activeIndex = history.findIndex(s => targetDate >= s.startDate && (!s.endDate || targetDate < s.endDate));

    if (activeIndex !== -1) {
        // A mudança ocorre dentro de um segmento de cronograma existente
        const activeSchedule = history[activeIndex];
        
        // Se a mudança começar no mesmo dia que o segmento, basta atualizá-lo.
        if (activeSchedule.startDate === targetDate) {
            const originalEndDate = activeSchedule.endDate;
            const updatedSchedule = updateFn({ ...activeSchedule });
            // Preserva o endDate original para não sobrescrever o futuro
            history[activeIndex] = { ...updatedSchedule, endDate: originalEndDate };
        } else {
            // Divide o segmento
            const originalEndDate = activeSchedule.endDate;
            // 1. Termina o segmento antigo
            activeSchedule.endDate = targetDate;
            // 2. Insere o novo segmento, preservando o endDate original
            const newSchedule = updateFn({ ...activeSchedule, startDate: targetDate, endDate: originalEndDate });
            history.push(newSchedule);
        }
    } else {
        // A mudança está fora de qualquer segmento atual (antes do primeiro ou depois do último)
        // Encontra onde inseri-lo cronologicamente
        const insertionIndex = history.findIndex(s => targetDate < s.startDate);

        if (insertionIndex === -1) {
            // Insere no final. O novo cronograma executa indefinidamente.
            const lastSchedule = history[history.length - 1];
            // Termina o último cronograma anterior se ele estava em aberto
            if (lastSchedule && !lastSchedule.endDate) {
                lastSchedule.endDate = targetDate;
            }
            // Cria o novo cronograma baseado no último (ou vazio se for o primeiro)
            history.push(updateFn({ ...(lastSchedule || {} as any), startDate: targetDate, endDate: undefined }));
        } else {
            // Insere no meio ou no início
            const nextSchedule = history[insertionIndex];
            const prevSchedule = history[insertionIndex - 1];

            // O novo cronograma deve terminar onde o próximo começa
            const newEndDate = nextSchedule.startDate;
            // Baseia as propriedades do novo cronograma no anterior (se existir), senão no próximo.
            const baseSchedule = prevSchedule || nextSchedule; 
            
            history.push(updateFn({ ...baseSchedule, startDate: targetDate, endDate: newEndDate }));
            
            // Termina o cronograma anterior se ele estava em aberto
            if (prevSchedule && !prevSchedule.endDate) {
                prevSchedule.endDate = targetDate;
            }
        }
    }

    // Garante que a história esteja sempre ordenada
    history.sort((a, b) => a.startDate.localeCompare(b.startDate));
    // Qualquer mudança no cronograma invalida uma graduação
    habit.graduatedOn = undefined;
    _notifyChanges(true);
}

// @fix: Added date parameter to correctly fetch schedule and goal.
function _updateHabitInstanceStatus(habit: Habit, instance: HabitDayData, newStatus: HabitStatus, date: string): boolean {
    if (instance.status === newStatus) return false;
    instance.status = newStatus;
    const schedule = getScheduleForDate(habit, date);
    if (schedule?.goal.type === 'check') instance.goalOverride = (newStatus === 'completed') ? 1 : undefined;
    return true;
}

function _checkStreakMilestones(habit: Habit, dateISO: string) {
    const streak = calculateHabitStreak(habit, dateISO);
    const m = streak === STREAK_SEMI_CONSOLIDATED ? state.pending21DayHabitIds : (streak === STREAK_CONSOLIDATED ? state.pendingConsolidationHabitIds : null);
    if (m && !state.notificationsShown.includes(`${habit.id}-${streak}`) && !m.includes(habit.id)) {
        m.push(habit.id);
        renderAINotificationState();
    }
}

// --- CONFIRMATION HANDLERS ---

const _applyDropJustToday = () => {
    const ctx = ActionContext.drop, target = getSafeDate(state.selectedDate);
    if (!ctx || isDateLoading(target)) return ActionContext.reset();
    
    const habit = state.habits.find(h => h.id === ctx.habitId);
    if (habit) {
        const info = ensureHabitDailyInfo(target, ctx.habitId), sch = [...getEffectiveScheduleForHabitOnDate(habit, target)];
        const fIdx = sch.indexOf(ctx.fromTime);
        if (fIdx > -1) sch.splice(fIdx, 1);
        if (!sch.includes(ctx.toTime)) sch.push(ctx.toTime);
        if (info.instances[ctx.fromTime]) { info.instances[ctx.toTime] = info.instances[ctx.fromTime]; delete info.instances[ctx.fromTime]; }
        info.dailySchedule = sch;
        if (ctx.reorderInfo) reorderHabit(ctx.habitId, ctx.reorderInfo.id, ctx.reorderInfo.pos, true);
        _notifyChanges(false);
    }
    ActionContext.reset();
};

const _applyDropFromNowOn = () => {
    const ctx = ActionContext.drop, target = getSafeDate(state.selectedDate);
    if (!ctx || isDateLoading(target)) return ActionContext.reset();

    const info = ensureHabitDailyInfo(target, ctx.habitId), curOverride = info.dailySchedule ? [...info.dailySchedule] : null;
    info.dailySchedule = undefined;
    if (info.instances[ctx.fromTime]) { info.instances[ctx.toTime] = info.instances[ctx.fromTime]; delete info.instances[ctx.fromTime]; }
    if (ctx.reorderInfo) reorderHabit(ctx.habitId, ctx.reorderInfo.id, ctx.reorderInfo.pos, true);

    _requestFutureScheduleChange(ctx.habitId, target, (s) => {
        const times = curOverride || [...s.times], fIdx = times.indexOf(ctx.fromTime);
        if (fIdx > -1) times.splice(fIdx, 1);
        if (!times.includes(ctx.toTime)) times.push(ctx.toTime);
        return { ...s, times };
    });
    ActionContext.reset();
};

const _applyHabitDeletion = async () => {
    const ctx = ActionContext.deletion;
    if (!ctx) return;
    const h = state.habits.find(x => x.id === ctx.habitId);
    if (!h) return ActionContext.reset();

    state.habits = state.habits.filter(x => x.id !== ctx.habitId);
    Object.keys(state.dailyData).forEach(d => delete state.dailyData[d][ctx.habitId]);

    const startYear = parseInt((h.scheduleHistory[0]?.startDate || h.createdOn).substring(0, 4), 10);
    try {
        const up = await runWorkerTask<AppState['archives']>('prune-habit', { habitId: ctx.habitId, archives: state.archives, startYear });
        Object.keys(up).forEach(y => { if (up[y] === "") delete state.archives[y]; else state.archives[y] = up[y]; state.unarchivedCache.delete(y); });
    } catch (e) { console.error(e); }
    
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
    // @fix: Moved icon, color, goal, and philosophy into the scheduleHistory object to match the Habit type.
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

    if (isNew) {
        // Procure por um hábito ativo existente com o mesmo nome.
        const existingHabit = state.habits.find(h => {
            const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
            if (h.graduatedOn || (lastSchedule.endDate && targetDate >= lastSchedule.endDate)) {
                return false; // Não fundir com hábitos arquivados/encerrados
            }
            const info = getHabitDisplayInfo(h, targetDate);
            return info.name.trim().toLowerCase() === nameToUse.trim().toLowerCase();
        });

        if (existingHabit) {
            // LÓGICA DE SOBRESCRITA: Atualiza o hábito existente a partir da data alvo.
            const newTimes = formData.times;

            // @fix: Removed Object.assign that was incorrectly modifying the Habit object. Properties are now passed into _requestFutureScheduleChange.
            
            _requestFutureScheduleChange(existingHabit.id, targetDate, (s) => ({
                ...s,
                // @fix: Added icon, color, goal, and philosophy to the schedule update.
                icon: formData.icon,
                color: formData.color,
                goal: formData.goal,
                philosophy: formData.philosophy ?? s.philosophy,
                name: formData.name,
                nameKey: formData.nameKey,
                subtitleKey: formData.subtitleKey,
                times: newTimes,
                frequency: formData.frequency,
            }));
        } else {
            // LÓGICA DE CRIAÇÃO: Cria um novo hábito.
            state.habits.push({ 
                id: generateUUID(), 
                createdOn: targetDate, 
                // @fix: Moved icon, color, goal, and philosophy into the scheduleHistory object.
                scheduleHistory: [{ 
                    startDate: targetDate, 
                    times: formData.times, 
                    frequency: formData.frequency, 
                    name: formData.name, 
                    nameKey: formData.nameKey, 
                    subtitleKey: formData.subtitleKey, 
                    scheduleAnchor: targetDate,
                    icon: formData.icon,
                    color: formData.color,
                    goal: formData.goal,
                    philosophy: formData.philosophy
                }]
            });
            _notifyChanges(true);
        }
    } else {
        // LÓGICA DE EDIÇÃO: Sobrescreve o horário do hábito existente.
        const h = state.habits.find(x => x.id === habitId);
        if (!h) return;
        
        // @fix: Removed Object.assign and direct property setting; properties are now updated in _requestFutureScheduleChange.
        
        ensureHabitDailyInfo(targetDate, h.id).dailySchedule = undefined;
        if (targetDate < h.createdOn) h.createdOn = targetDate;

        _requestFutureScheduleChange(h.id, targetDate, (s) => ({ 
            ...s, 
            // @fix: Added icon, color, goal, and philosophy to the schedule update.
            icon: formData.icon,
            color: formData.color,
            goal: formData.goal,
            philosophy: formData.philosophy ?? s.philosophy,
            name: formData.name, 
            nameKey: formData.nameKey, 
            subtitleKey: formData.subtitleKey, 
            times: formData.times, 
            frequency: formData.frequency 
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
        const { prompt, systemInstruction } = await runWorkerTask<any>('build-ai-prompt', { analysisType: type, habits: state.habits, dailyData: state.dailyData, archives: state.archives, languageName: getAiLanguageName(), translations: trans, todayISO: getTodayUTCIso() });
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

export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const h = state.habits.find(x => x.id === habitId);
    if (h) {
        const inst = ensureHabitInstanceData(date, habitId, time);
        const nextStatusString = getNextStatus(inst.status); // Pega o próximo status (string)
        
        // --- 1. ESCRITA NO SISTEMA LEGADO (MANTIDO) ---
        // @fix: Pass date to _updateHabitInstanceStatus.
        if (_updateHabitInstanceStatus(h, inst, nextStatusString, date)) {
            if (inst.status === 'completed') _checkStreakMilestones(h, date);
            
            // --- 2. ESCRITA NO SISTEMA NOVO (ADICIONADO) ---
            // Mapeamento: string -> number (Bitmask)
            // @fix: Explicitly cast bitStatus to number to avoid literal type narrowing from HABIT_STATE members (0, 1, 2)
            let bitStatus: number = HABIT_STATE.NULL as number;
            if (nextStatusString === 'completed') bitStatus = HABIT_STATE.DONE;
            else if (nextStatusString === 'snoozed') bitStatus = HABIT_STATE.DEFERRED;
            
            // Gravação segura no BigInt
            HabitService.setStatus(habitId, date, time, bitStatus);
            // ------------------------------------------------

            // Dispara evento UI
            document.dispatchEvent(new CustomEvent('card-status-changed', { 
                detail: { habitId, time, date } 
            }));
            
            _notifyPartialUIRefresh(date, [habitId]);
        }
    }
}

export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    if (_isBatchOpActive || isDateLoading(dateISO)) return false;
    _isBatchOpActive = true;
    const dateObj = parseUTCIsoDate(dateISO); if (!state.dailyData[dateISO]) state.dailyData[dateISO] = structuredClone(getHabitDailyInfoForDate(dateISO) || {});
    const day = state.dailyData[dateISO]; let changed = false; BATCH_IDS_POOL.length = BATCH_HABITS_POOL.length = 0;
    try {
        state.habits.forEach(h => {
            if (!shouldHabitAppearOnDate(h, dateISO, dateObj)) return;
            const sch = getEffectiveScheduleForHabitOnDate(h, dateISO); if (!sch.length) return;
            day[h.id] ??= { instances: {}, dailySchedule: undefined };
            let hChanged = false;
            sch.forEach(t => {
                day[h.id].instances[t] ??= { status: 'pending', goalOverride: undefined, note: undefined };
                if (_updateHabitInstanceStatus(h, day[h.id].instances[t]!, status, dateISO)) {
                    hChanged = changed = true;
            
                    // --- ESCRITA NOVA (ADICIONADO) ---
                    // @fix: Explicitly cast bitStatus to number to avoid literal type narrowing
                    let bitStatus: number = HABIT_STATE.NULL as number;
                    if (status === 'completed') bitStatus = HABIT_STATE.DONE;
                    else if (status === 'snoozed') bitStatus = HABIT_STATE.DEFERRED;
            
                    HabitService.setStatus(h.id, dateISO, t, bitStatus);
                    // ---------------------------------
                }
            });
            if (hChanged) { BATCH_IDS_POOL.push(h.id); BATCH_HABITS_POOL.push(h); }
        });
        if (changed) { invalidateCachesForDateChange(dateISO, BATCH_IDS_POOL); if (status === 'completed') BATCH_HABITS_POOL.forEach(h => _checkStreakMilestones(h, dateISO)); _notifyChanges(false); }
    } finally { _isBatchOpActive = false; }
    return changed;
}

export function handleHabitDrop(habitId: string, fromTime: TimeOfDay, toTime: TimeOfDay, reorderInfo?: any) {
    const h = _lockActionHabit(habitId); if (!h) return;
    ActionContext.drop = { habitId, fromTime, toTime, reorderInfo };
    showConfirmationModal(t('confirmHabitMove', { habitName: getHabitDisplayInfo(h, state.selectedDate).name, oldTime: getTimeOfDayName(fromTime), newTime: getTimeOfDayName(toTime) }), 
        _applyDropFromNowOn, { title: t('modalMoveHabitTitle'), confirmText: t('buttonFromNowOn'), editText: t('buttonJustToday'), onEdit: _applyDropJustToday });
}

export function requestHabitEndingFromModal(habitId: string) {
    const h = _lockActionHabit(habitId), target = getSafeDate(state.selectedDate); if (!h) return;
    ActionContext.ending = { habitId, targetDate: target };
    showConfirmationModal(t('confirmEndHabit', { habitName: getHabitDisplayInfo(h, target).name, date: formatDate(parseUTCIsoDate(target), { day: 'numeric', month: 'long', timeZone: 'UTC' }) }), 
        () => { _requestFutureScheduleChange(habitId, target, s => ({ ...s, endDate: target })); ActionContext.reset(); }, { confirmButtonStyle: 'danger', confirmText: t('endButton') });
}

export function requestHabitPermanentDeletion(habitId: string) { if (_lockActionHabit(habitId)) { ActionContext.deletion = { habitId }; showConfirmationModal(t('confirmPermanentDelete', { habitName: getHabitDisplayInfo(state.habits.find(x => x.id === habitId)!).name }), _applyHabitDeletion, { confirmButtonStyle: 'danger', confirmText: t('deleteButton') }); } }
export function graduateHabit(habitId: string) { const h = state.habits.find(x => x.id === habitId); if (h) { h.graduatedOn = getSafeDate(state.selectedDate); _notifyChanges(true); triggerHaptic('success'); } }
export async function resetApplicationData() { state.habits = []; state.dailyData = {}; state.archives = {}; state.notificationsShown = state.pending21DayHabitIds = state.pendingConsolidationHabitIds = []; try { await clearLocalPersistence(); } finally { clearKey(); location.reload(); } }
export function handleSaveNote() { if (!state.editingNoteFor) return; const { habitId, date, time } = state.editingNoteFor, val = ui.notesTextarea.value.trim(), inst = ensureHabitInstanceData(date, habitId, time); if ((inst.note || '') !== val) { inst.note = val || undefined; state.uiDirtyState.habitListStructure = true; saveState(); document.dispatchEvent(new CustomEvent('render-app')); } closeModal(ui.notesModal); }
export function setGoalOverride(habitId: string, d: string, t: TimeOfDay, v: number) { 
    try { 
        // 1. Escrita Legada (JSON)
        ensureHabitInstanceData(d, habitId, t).goalOverride = v; 
        
        // 2. Escrita Bitmask (NOVO - Lógica Arete)
        const h = state.habits.find(x => x.id === habitId);
        if (h) {
            let newBitStatus: number = HABIT_STATE.DONE; // Padrão
            
            // Verifica se superou a meta
            const props = getHabitPropertiesForDate(h, d);
            if (props?.goal?.total && v > props.goal.total) {
                newBitStatus = HABIT_STATE.DONE_PLUS;
            }
            
            // Grava o bit (1 ou 3)
            HabitService.setStatus(habitId, d, t, newBitStatus);
        }

        // Notificações UI
        document.dispatchEvent(new CustomEvent('card-goal-changed', { detail: { habitId, time: t, date: d } })); 
        _notifyPartialUIRefresh(d, [habitId]); 
    } catch (e) { 
        console.error(e); 
    } 
}
export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) { const h = _lockActionHabit(habitId), target = getSafeDate(state.selectedDate); if (!h) return; ActionContext.removal = { habitId, time, targetDate: target }; showConfirmationModal(t('confirmRemoveTimePermanent', { habitName: getHabitDisplayInfo(h, target).name, time: getTimeOfDayName(time) }), () => { ensureHabitDailyInfo(target, habitId).dailySchedule = undefined; _requestFutureScheduleChange(habitId, target, s => ({ ...s, times: s.times.filter(x => x !== time) })); ActionContext.reset(); }, { title: t('modalRemoveTimeTitle'), confirmText: t('deleteButton'), confirmButtonStyle: 'danger' }); }
export function exportData() { const blob = new Blob([JSON.stringify(getPersistableState(), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `askesis-backup-${getTodayUTCIso()}.json`; a.click(); URL.revokeObjectURL(url); }
export function handleDayTransition() { const today = getTodayUTCIso(); clearActiveHabitsCache(); state.uiDirtyState.calendarVisuals = state.uiDirtyState.habitListStructure = state.uiDirtyState.chartData = true; state.calendarDates = []; if (state.selectedDate !== today) state.selectedDate = today; document.dispatchEvent(new CustomEvent('render-app')); }

// ============================================================================
// ÁREA DE DEBUG & MIGRAÇÃO (FINAL DO ARQUIVO)
// ============================================================================

declare global {
    interface Window {
        auditIntegrity: () => void;
        migrateLegacyToBitmask: () => void;
    }
}

// 1. AUDITORIA DE INTEGRIDADE
// @ts-ignore
window.auditIntegrity = () => {
    console.group("🕵️ Iniciando Auditoria de Integridade (Legacy vs Bitmask)");
    let errors = 0;
    let checked = 0;

    if (!state.monthlyLogs || state.monthlyLogs.size === 0) {
        console.warn("⚠️ monthlyLogs vazio (Lazy Load). Interaja com o app para carregar.");
    }

    const allDates = Object.keys(state.dailyData);
    
    allDates.forEach(date => {
        state.habits.forEach(habit => {
            // Verifica Morning (0), Afternoon (2), Evening (4)
            ([0, 2, 4] as const).forEach(offset => {
                let time: TimeOfDay = 'Morning';
                if (offset === 2) time = 'Afternoon';
                if (offset === 4) time = 'Evening';
                
                // Legado
                const legacyInfo = state.dailyData[date]?.[habit.id]?.instances[time];
                // @fix: Explicitly type as number to prevent literal type narrowing to 0
                let legacyStatus: number = HABIT_STATE.NULL;
                if (legacyInfo?.status === 'completed') legacyStatus = HABIT_STATE.DONE;
                if (legacyInfo?.status === 'snoozed') legacyStatus = HABIT_STATE.DEFERRED;

                // Bitmask
                const logKey = `${habit.id}_${date.substring(0, 7)}`;
                const log = state.monthlyLogs.get(logKey);
                // @fix: Explicitly type as number to prevent literal type narrowing to 0
                let bitStatus: number = HABIT_STATE.NULL;
                
                if (log !== undefined) {
                    const day = parseInt(date.substring(8, 10), 10);
                    const bitPos = BigInt(((day - 1) * 6) + offset);
                    bitStatus = Number((log >> bitPos) & 0b11n);
                }

                if (legacyStatus !== bitStatus) {
                    if (legacyStatus === HABIT_STATE.NULL && bitStatus === 0) return;
                    //console.error(`❌ DISCREPÂNCIA ${date} [${habit.id}]: L=${legacyStatus} vs B=${bitStatus}`);
                    errors++;
                }
                checked++;
            });
        });
    });

    console.log(`Auditoria: ${checked} pontos verificados.`);
    if (errors === 0) console.log("%c✅ INTEGRIDADE PERFEITA!", "color: green; font-weight: bold;");
    else console.log(`%c⚠️ ${errors} erros encontrados.`, "color: red; font-weight: bold;");
    console.groupEnd();
};

// 2. MIGRAÇÃO DE DADOS (BACKFILL)
// @ts-ignore
window.migrateLegacyToBitmask = () => {
    console.group("🚀 Iniciando Migração de Histórico (JSON -> Bitmask)");
    const startTime = performance.now();
    let migratedCount = 0;
    
    const allDates = Object.keys(state.dailyData);
    console.log(`📅 Processando ${allDates.length} dias...`);

    allDates.forEach(dateISO => {
        const dayData = state.dailyData[dateISO];
        if (!dayData) return;

        Object.keys(dayData).forEach(habitId => {
            const habitInfo = dayData[habitId];
            if (!habitInfo || !habitInfo.instances) return;

            (['Morning', 'Afternoon', 'Evening'] as TimeOfDay[]).forEach(time => {
                const instance = habitInfo.instances[time];
                if (!instance) return;

                // @fix: Explicitly type as number to prevent literal type narrowing to 0
                let targetStatus: number = HABIT_STATE.NULL;
                if (instance.status === 'completed') targetStatus = HABIT_STATE.DONE;
                else if (instance.status === 'snoozed') targetStatus = HABIT_STATE.DEFERRED;

                if (targetStatus !== HABIT_STATE.NULL) {
                    HabitService.setStatus(habitId, dateISO, time, targetStatus);
                    migratedCount++;
                }
            });
        });
    });

    saveState(); // Salva no disco
    
    console.log(`✅ Migração Concluída (${(performance.now() - startTime).toFixed(0)}ms).`);
    console.log(`💾 ${migratedCount} registros migrados.`);
    
    // Roda auditoria para confirmar
    window.auditIntegrity();
    console.groupEnd();
};
