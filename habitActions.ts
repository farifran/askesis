
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
    ensureHabitInstanceData, HabitStatus, clearScheduleCache,
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
            const updatedSchedule = updateFn({ ...activeSchedule });
            // BUGFIX: Não sobrescrever o endDate definido pela função de atualização.
            // A função `updateFn` é agora a única fonte da verdade para o novo estado do cronograma.
            history[activeIndex] = updatedSchedule;
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
        // 1. Migração de Dados Legados (Notes/Override)
        const info = ensureHabitDailyInfo(target, ctx.habitId), sch = [...getEffectiveScheduleForHabitOnDate(habit, target)];
        const fIdx = sch.indexOf(ctx.fromTime);
        if (fIdx > -1) sch.splice(fIdx, 1);
        if (!sch.includes(ctx.toTime)) sch.push(ctx.toTime);
        
        if (info.instances[ctx.fromTime]) { 
            // CLEANUP: Move apenas dados relevantes, remove 'status' para evitar "Ghost Data"
            const movedData = { ...info.instances[ctx.fromTime] };
            delete (movedData as any).status; // Remove status legado
            info.instances[ctx.toTime] = movedData as HabitDayData; 
            delete info.instances[ctx.fromTime]; 
        }
        info.dailySchedule = sch;

        // 2. Migração de Status Bitmask (ZC-Architecture)
        const currentBit = HabitService.getStatus(ctx.habitId, target, ctx.fromTime);
        if (currentBit !== HABIT_STATE.NULL) {
            HabitService.setStatus(ctx.habitId, target, ctx.toTime, currentBit);
            HabitService.setStatus(ctx.habitId, target, ctx.fromTime, HABIT_STATE.NULL);
        }

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
    
    // 1. Migração de Dados Legados (Notes/Override) para o dia atual
    if (info.instances[ctx.fromTime]) { 
        const movedData = { ...info.instances[ctx.fromTime] };
        delete (movedData as any).status; // Remove status legado
        info.instances[ctx.toTime] = movedData as HabitDayData; 
        delete info.instances[ctx.fromTime]; 
    }
    
    // 2. Migração de Status Bitmask para o dia atual (ZC-Architecture)
    const currentBit = HabitService.getStatus(ctx.habitId, target, ctx.fromTime);
    if (currentBit !== HABIT_STATE.NULL) {
        HabitService.setStatus(ctx.habitId, target, ctx.toTime, currentBit);
        HabitService.setStatus(ctx.habitId, target, ctx.fromTime, HABIT_STATE.NULL);
    }

    if (ctx.reorderInfo) reorderHabit(ctx.habitId, ctx.reorderInfo.id, ctx.reorderInfo.pos, true);

    _requestFutureScheduleChange(ctx.habitId, target, (s) => {
        const times = curOverride || [...s.times], fIdx = times.indexOf(ctx.fromTime);
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

    // --- CORREÇÃO: Limpar rastro do Bitmask (Novo) ---
    // Remove todas as entradas de meses vinculadas a este ID
    if (state.monthlyLogs) {
        const keysToRemove: string[] = [];
        state.monthlyLogs.forEach((_, key) => {
            if (key.startsWith(ctx.habitId + '_')) {
                keysToRemove.push(key);
            }
        });
        keysToRemove.forEach(k => state.monthlyLogs.delete(k));
    }
    // -------------------------------------------------

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

    // CRÍTICO: Cria cópias profundas dos dados do formulário para evitar mutações de referência.
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
            // LÓGICA DE SOBRESCRITA
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
            // LÓGICA DE CRIAÇÃO
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
        // LÓGICA DE EDIÇÃO
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

/**
 * ZC-ARCHITECTURE: Toggles status using Bitmask as the ONLY source of truth.
 * Legacy `dailyData` is NOT touched, preventing object creation for simple checks.
 */
export function toggleHabitStatus(habitId: string, time: TimeOfDay, date: string) {
    const h = state.habits.find(x => x.id === habitId);
    if (!h) return;

    // 1. LEITURA (Fonte: Bitmask) - Com otimização de objeto
    const currentBit = HabitService.getStatus(habitId, date, time, h);
    
    // 2. LÓGICA DE ROTAÇÃO (3 Estados: Pendente -> Feito -> Adiado -> Pendente)
    let nextBit: number;
    
    if (currentBit === HABIT_STATE.NULL) {
        nextBit = HABIT_STATE.DONE;
    } else if (currentBit === HABIT_STATE.DONE || currentBit === HABIT_STATE.DONE_PLUS) {
        nextBit = HABIT_STATE.DEFERRED;
    } else { // DEFERRED
        nextBit = HABIT_STATE.NULL;
    }

    // 3. ESCRITA (Destino: Bitmask)
    HabitService.setStatus(habitId, date, time, nextBit);

    // 4. GARBAGE COLLECTION [ZERO-COST]
    // Se o novo estado é nulo e não há metadados (notas/override), removemos o objeto do JSON.
    if (nextBit === HABIT_STATE.NULL) {
        try {
            const dayData = getHabitDailyInfoForDate(date);
            const habitInfo = dayData[habitId];
            if (habitInfo) {
                const instance = habitInfo.instances[time];
                if (instance && instance.note === undefined && instance.goalOverride === undefined) {
                    delete state.dailyData[date][habitId].instances[time];
                    if (Object.keys(state.dailyData[date][habitId].instances).length === 0) {
                        delete state.dailyData[date][habitId];
                    }
                }
            }
        } catch (e) {
            // Ignora erros de `getHabitDailyInfoForDate` (ex: data carregando)
        }
    }

    // 5. SIDE EFFECTS
    if (nextBit === HABIT_STATE.DONE) {
        _checkStreakMilestones(h, date);
        triggerHaptic('light');
    } else if (nextBit === HABIT_STATE.DEFERRED) {
        triggerHaptic('medium');
    } else {
        triggerHaptic('selection');
    }

    document.dispatchEvent(new CustomEvent('card-status-changed', { 
        detail: { habitId, time, date } 
    }));
    
    _notifyPartialUIRefresh(date, [habitId]);
}

/**
 * ZC-ARCHITECTURE: Batch update using Bitmask exclusively.
 */
export function markAllHabitsForDate(dateISO: string, status: HabitStatus): boolean {
    if (_isBatchOpActive || isDateLoading(dateISO)) return false;
    _isBatchOpActive = true;
    
    // We don't need to instantiate dailyData just to set bitmasks!
    const dateObj = parseUTCIsoDate(dateISO);
    let changed = false; 
    BATCH_IDS_POOL.length = 0; 
    BATCH_HABITS_POOL.length = 0;

    try {
        state.habits.forEach(h => {
            if (!shouldHabitAppearOnDate(h, dateISO, dateObj)) return;
            const sch = getEffectiveScheduleForHabitOnDate(h, dateISO); 
            if (!sch.length) return;
            
            // Map string status to bit status
            let bitStatus: number = (status === 'completed') ? HABIT_STATE.DONE : HABIT_STATE.DEFERRED;

            sch.forEach(t => {
                // Verificamos se o status já é o pretendido via Bitmask
                if (HabitService.getStatus(h.id, dateISO, t, h) !== bitStatus) {
                    // ESCRITA DIRETA NO BITMASK
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
    // 1. Limpa memória RAM
    state.habits = []; 
    state.dailyData = {}; 
    state.archives = {}; 
    state.notificationsShown = []; 
    state.pending21DayHabitIds = []; 
    state.pendingConsolidationHabitIds = [];
    
    // --- CORREÇÃO: Limpar Bitmask ---
    state.monthlyLogs = new Map();
    // -------------------------------

    try { 
        // 2. Força salvar o estado VAZIO no disco (sobrescreve dados antigos)
        // Isso garante que, mesmo se clearLocalPersistence falhar em limpar a chave nova,
        // o banco terá um Map vazio salvo.
        await saveState();

        // 3. Tenta limpar a persistência completamente
        await clearLocalPersistence(); 
    } finally { 
        clearKey(); 
        location.reload(); 
    } 
}

export function handleSaveNote() { if (!state.editingNoteFor) return; const { habitId, date, time } = state.editingNoteFor, val = ui.notesTextarea.value.trim(), inst = ensureHabitInstanceData(date, habitId, time); if ((inst.note || '') !== val) { inst.note = val || undefined; state.uiDirtyState.habitListStructure = true; saveState(); document.dispatchEvent(new CustomEvent('render-app')); } closeModal(ui.notesModal); }

export function setGoalOverride(habitId: string, d: string, t: TimeOfDay, v: number) { 
    try {
        const h = state.habits.find(x => x.id === habitId);
        if (!h) return;

        // Grava o valor numérico (Necessário JSON)
        ensureHabitInstanceData(d, habitId, t).goalOverride = v;

        // STATE PROTECTION [2025-06-03]: 
        // Alterar o número NÃO deve alterar o status automaticamente se estiver Pendente.
        // Apenas atualizamos se já estiver Concluído (para gerenciar o estado 'Arete/Plus').
        
        const currentStatus = HabitService.getStatus(habitId, d, t, h);
        
        if (currentStatus === HABIT_STATE.DONE || currentStatus === HABIT_STATE.DONE_PLUS) {
             const props = getHabitPropertiesForDate(h, d);
             // Verifica se a nova meta numérica supera o total definido (Arete)
             if (props?.goal?.total && v > props.goal.total) {
                 if (currentStatus !== HABIT_STATE.DONE_PLUS) {
                     HabitService.setStatus(habitId, d, t, HABIT_STATE.DONE_PLUS);
                 }
             } else {
                 // Se caiu abaixo da meta de superação, volta para DONE normal
                 if (currentStatus !== HABIT_STATE.DONE) {
                     HabitService.setStatus(habitId, d, t, HABIT_STATE.DONE);
                 }
             }
        }

        // Notificações UI
        document.dispatchEvent(new CustomEvent('card-goal-changed', { detail: { habitId, time: t, date: d } })); 
        // Refresh UI para atualizar o número no cartão
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
export function exportData() { const blob = new Blob([JSON.stringify(getPersistableState(), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `askesis-backup-${getTodayUTCIso()}.json`; a.click(); URL.revokeObjectURL(url); }
export function handleDayTransition() { const today = getTodayUTCIso(); clearActiveHabitsCache(); state.uiDirtyState.calendarVisuals = state.uiDirtyState.habitListStructure = state.uiDirtyState.chartData = true; state.calendarDates = []; if (state.selectedDate !== today) state.selectedDate = today; document.dispatchEvent(new CustomEvent('render-app')); }
