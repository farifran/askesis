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
    getHabitDailyInfoForDate, AppState, isDateLoading, HabitDailyInfo, LANGUAGES
} from './state';
import { saveState, loadState, clearLocalPersistence } from './services/persistence';
import { PREDEFINED_HABITS } from './data/predefinedHabits';
import { 
    getEffectiveScheduleForHabitOnDate, isHabitNameDuplicate, clearSelectorInternalCaches,
    calculateHabitStreak, shouldHabitAppearOnDate, getHabitDisplayInfo
} from './services/selectors';
import { 
    generateUUID, getTodayUTCIso, parseUTCIsoDate, triggerHaptic,
    getSafeDate, addDays, toUTCIsoDateString
} from './utils';
import { 
    closeModal, showConfirmationModal, openEditModal, renderAINotificationState,
    clearHabitDomCache, renderStoicQuote
} from './render';
import { ui } from './render/ui';
import { t, getTimeOfDayName, formatDate } from './i18n'; 
import { runWorkerTask } from './services/cloud';
import { apiFetch, clearKey } from './services/api';

// --- CONSTANTS ---
const ARCHIVE_DAYS_THRESHOLD = 90;
const BATCH_IDS_POOL: string[] = [];
const BATCH_HABITS_POOL: Habit[] = [];

// --- CONCURRENCY CONTROL ---
const _analysisInFlight = new Map<string, Promise<void>>();
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

const _getAiLang = () => t(LANGUAGES.find(l => l.code === state.activeLanguageCode)?.nameKey || 'langEnglish');

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
    const idx = history.findIndex(s => targetDate >= s.startDate && (!s.endDate || targetDate < s.endDate));

    if (idx !== -1) {
        const cur = history[idx];
        if (cur.startDate === targetDate) {
            history[idx] = updateFn({ ...cur });
        } else {
            cur.endDate = targetDate;
            history.push(updateFn({ ...cur, startDate: targetDate, endDate: undefined }));
        }
    } else {
        const last = history[history.length - 1];
        if (last) {
            if (last.endDate && last.endDate > targetDate) last.endDate = targetDate;
            history.push(updateFn({ ...last, startDate: targetDate, endDate: undefined }));
        }
    }
    history.sort((a, b) => a.startDate.localeCompare(b.startDate));
    habit.graduatedOn = undefined;
    _notifyChanges(true);
}

function _updateHabitInstanceStatus(habit: Habit, instance: HabitDayData, newStatus: HabitStatus): boolean {
    if (instance.status === newStatus) return false;
    instance.status = newStatus;
    if (habit.goal.type === 'check') instance.goalOverride = (newStatus === 'completed') ? 1 : undefined;
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
    closeModal(ui.manageModal);
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
    state.habits.push({ id: generateUUID(), icon: t.icon, color: t.color, goal: t.goal, createdOn: getTodayUTCIso(), philosophy: t.philosophy,
        scheduleHistory: [{ startDate: getTodayUTCIso(), nameKey: t.nameKey, subtitleKey: t.subtitleKey, times: t.times, frequency: t.frequency, scheduleAnchor: getTodayUTCIso() }]
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
    if (!formData.name && !formData.nameKey) return;
    if (isHabitNameDuplicate(formData.nameKey ? t(formData.nameKey) : formData.name!, habitId)) return;

    if (isNew) {
        state.habits.push({ id: generateUUID(), icon: formData.icon, color: formData.color, goal: formData.goal, createdOn: targetDate, philosophy: formData.philosophy,
            scheduleHistory: [{ startDate: targetDate, times: formData.times, frequency: formData.frequency, name: formData.name, nameKey: formData.nameKey, subtitleKey: formData.subtitleKey, scheduleAnchor: targetDate }]
        });
        _notifyChanges(true);
    } else {
        const h = state.habits.find(x => x.id === habitId);
        if (!h) return;
        Object.assign(h, { icon: formData.icon, color: formData.color, goal: formData.goal });
        if (formData.philosophy) h.philosophy = formData.philosophy;
        ensureHabitDailyInfo(targetDate, h.id).dailySchedule = undefined;
        const first = h.scheduleHistory[0];
        if (targetDate < first.startDate) { Object.assign(first, { startDate: targetDate, name: formData.name, nameKey: formData.nameKey, times: formData.times, frequency: formData.frequency, scheduleAnchor: targetDate }); _notifyChanges(true); }
        else _requestFutureScheduleChange(h.id, targetDate, (s) => ({ ...s, name: formData.name, nameKey: formData.nameKey, times: formData.times, frequency: formData.frequency }));
    }
    closeModal(ui.editHabitModal);
}

export async function checkAndAnalyzeDayContext(dateISO: string) {
    if (state.dailyDiagnoses[dateISO] || _analysisInFlight.has(dateISO)) return state.dailyDiagnoses[dateISO] ? renderStoicQuote() : _analysisInFlight.get(dateISO);
    const task = async () => {
        let notes = ''; const day = getHabitDailyInfoForDate(dateISO);
        Object.keys(day).forEach(id => Object.keys(day[id].instances).forEach(t => { const n = day[id].instances[t as TimeOfDay]?.note; if (n) notes += `- ${n}\n`; }));
        if (!notes.trim() || !navigator.onLine) return;
        try {
            const { prompt, systemInstruction } = await runWorkerTask<any>('build-quote-analysis-prompt', { notes, themeList: t('aiThemeList'), languageName: _getAiLang(), translations: { aiPromptQuote: t('aiPromptQuote'), aiSystemInstructionQuote: t('aiSystemInstructionQuote') } });
            const res = await apiFetch('/api/analyze', { method: 'POST', body: JSON.stringify({ prompt, systemInstruction }) });
            const json = JSON.parse((await res.text()).replace(/```json|```/g, '').trim());
            if (json?.analysis) { state.dailyDiagnoses[dateISO] = { level: json.analysis.determined_level, themes: json.relevant_themes, timestamp: Date.now() }; saveState(); renderStoicQuote(); }
        } catch (e) { console.error(e); } finally { _analysisInFlight.delete(dateISO); }
    };
    const p = task(); _analysisInFlight.set(dateISO, p); return p;
}

export async function performAIAnalysis(type: 'monthly' | 'quarterly' | 'historical') {
    if (state.aiState === 'loading') return;
    const id = ++state.aiReqId; state.aiState = 'loading'; state.hasSeenAIResult = false;
    renderAINotificationState(); closeModal(ui.aiOptionsModal);
    try {
        const trans: Record<string, string> = { promptTemplate: t(type === 'monthly' ? 'aiPromptMonthly' : (type === 'quarterly' ? 'aiPromptQuarterly' : 'aiPromptGeneral')), aiDaysUnit: t('unitDays', { count: 2 }) };
        ['aiPromptGraduatedSection', 'aiPromptNoData', 'aiPromptNone', 'aiSystemInstruction', 'aiPromptHabitDetails', 'aiVirtue', 'aiDiscipline', 'aiSphere', 'stoicVirtueWisdom', 'stoicVirtueCourage', 'stoicVirtueJustice', 'stoicVirtueTemperance', 'stoicDisciplineDesire', 'stoicDisciplineAction', 'stoicDisciplineAssent', 'governanceSphereBiological', 'governanceSphereStructural', 'governanceSphereSocial', 'governanceSphereMental', 'aiPromptNotesSectionHeader', 'aiStreakLabel', 'aiSuccessRateLabelMonthly', 'aiSuccessRateLabelQuarterly', 'aiSuccessRateLabelHistorical'].forEach(k => trans[k] = t(k));
        PREDEFINED_HABITS.forEach(h => trans[h.nameKey] = t(h.nameKey));
        const { prompt, systemInstruction } = await runWorkerTask<any>('build-ai-prompt', { analysisType: type, habits: state.habits, dailyData: state.dailyData, archives: state.archives, languageName: _getAiLang(), translations: trans, todayISO: getTodayUTCIso() });
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
        if (_updateHabitInstanceStatus(h, inst, getNextStatus(inst.status))) {
            invalidateCachesForDateChange(date, [habitId]);
            if (inst.status === 'completed') _checkStreakMilestones(h, date);
            _notifyChanges(false);
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
            let hChanged = false; sch.forEach(t => { day[h.id].instances[t] ??= { status: 'pending', goalOverride: undefined, note: undefined }; if (_updateHabitInstanceStatus(h, day[h.id].instances[t]!, status)) hChanged = changed = true; });
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
export function requestHabitEditingFromModal(habitId: string) { const h = state.habits.find(x => x.id === habitId); if (h) { closeModal(ui.manageModal); openEditModal(h); } }
export function graduateHabit(habitId: string) { const h = state.habits.find(x => x.id === habitId); if (h) { h.graduatedOn = getSafeDate(state.selectedDate); _notifyChanges(true); closeModal(ui.manageModal); triggerHaptic('success'); } }
export async function resetApplicationData() { state.habits = []; state.dailyData = {}; state.archives = {}; state.notificationsShown = state.pending21DayHabitIds = state.pendingConsolidationHabitIds = []; try { await clearLocalPersistence(); } finally { clearKey(); location.reload(); } }
export function handleSaveNote() { if (!state.editingNoteFor) return; const { habitId, date, time } = state.editingNoteFor, val = ui.notesTextarea.value.trim(), inst = ensureHabitInstanceData(date, habitId, time); if ((inst.note || '') !== val) { inst.note = val || undefined; state.uiDirtyState.habitListStructure = true; saveState(); document.dispatchEvent(new CustomEvent('render-app')); } closeModal(ui.notesModal); }
export function setGoalOverride(habitId: string, d: string, t: TimeOfDay, v: number) { try { ensureHabitInstanceData(d, habitId, t).goalOverride = v; invalidateCachesForDateChange(d, [habitId]); _notifyChanges(false); } catch (e) { console.error(e); } }
export function requestHabitTimeRemoval(habitId: string, time: TimeOfDay) { const h = _lockActionHabit(habitId), target = getSafeDate(state.selectedDate); if (!h) return; ActionContext.removal = { habitId, time, targetDate: target }; showConfirmationModal(t('confirmRemoveTimePermanent', { habitName: getHabitDisplayInfo(h, target).name, time: getTimeOfDayName(time) }), () => { ensureHabitDailyInfo(target, habitId).dailySchedule = undefined; _requestFutureScheduleChange(habitId, target, s => ({ ...s, times: s.times.filter(x => x !== time) })); ActionContext.reset(); }, { title: t('modalRemoveTimeTitle'), confirmText: t('deleteButton'), confirmButtonStyle: 'danger' }); }
export function exportData() { const blob = new Blob([JSON.stringify(getPersistableState(), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `askesis-backup-${getTodayUTCIso()}.json`; a.click(); URL.revokeObjectURL(url); }
export function handleDayTransition() { const today = getTodayUTCIso(); clearActiveHabitsCache(); state.uiDirtyState.calendarVisuals = state.uiDirtyState.habitListStructure = state.uiDirtyState.chartData = true; state.calendarDates = []; if (state.selectedDate !== today) state.selectedDate = today; document.dispatchEvent(new CustomEvent('render-app')); }
