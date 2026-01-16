/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/habitActions.ts
 * @description Controlador de Ações de Hábito (Business Logic Controller).
 * Responsável por orquestrar a mudança de estado e persistência.
 */

import { 
    state, Habit, HabitSchedule, TimeOfDay, ensureHabitDailyInfo, 
    ensureHabitInstanceData, clearScheduleCache,
    clearActiveHabitsCache, invalidateCachesForDateChange, getPersistableState,
    HabitDayData, STREAK_SEMI_CONSOLIDATED, STREAK_CONSOLIDATED,
    getHabitDailyInfoForDate, AppState, isDateLoading, HabitDailyInfo, HABIT_STATE
} from './state';
import { saveState, loadState, clearLocalPersistence } from './services/persistence';
import { PREDEFINED_HABITS } from './data/predefinedHabits';
import { 
    getEffectiveScheduleForHabitOnDate, clearSelectorInternalCaches,
    calculateHabitStreak, shouldHabitAppearOnDate, getHabitDisplayInfo, getHabitPropertiesForDate
} from './services/selectors';
import { 
    generateUUID, getTodayUTCIso, parseUTCIsoDate, triggerHaptic,
    getSafeDate, addDays, toUTCIsoDateString
} from './utils';
import { 
    closeModal, showConfirmationModal, renderAINotificationState,
    clearHabitDomCache, renderApp
} from './render';
import { ui } from './render/ui';
import { t, getTimeOfDayName, formatDate, getAiLanguageName, formatList } from './i18n'; 
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

/**
 * REFACTOR [GREENFIELD]: Move instância copiando apenas metadados válidos.
 * MICRO-OPTIMIZATION [V8]: Usa adição condicional para evitar transições de classe oculta (delete).
 */
function _moveHabitInstanceForDay(habitId: string, date: string, fromTime: TimeOfDay, toTime: TimeOfDay) {
    // 1. Move Metadados Ricos (JSON)
    try {
        const info = ensureHabitDailyInfo(date, habitId);
        const sourceData = info.instances[fromTime];

        if (sourceData) {
            // PUREZA DE DADOS: Copia apenas o que é oficial na interface HabitDayData v7.
            const cleanData: HabitDayData = {};
            
            // Só adiciona a chave se o valor existir. O objeto nasce e cresce limpo.
            if (sourceData.goalOverride !== undefined) cleanData.goalOverride = sourceData.goalOverride;
            if (sourceData.note !== undefined) cleanData.note = sourceData.note;

            // Só atribui se houver dados reais (evita poluir o JSON com objetos vazios)
            if (Object.keys(cleanData).length > 0) {
                info.instances[toTime] = cleanData;
            }
            
            // Limpa a origem para evitar duplicação
            delete info.instances[fromTime];
        }
    } catch (e) {
        // Ignora erros se os dados estiverem sendo hidratados
    }

    // 2. Move o Status Binário (Fonte da Verdade Soberana).
    const currentBit = HabitService.getStatus(habitId, date, fromTime);
    if (currentBit !== HABIT_STATE.NULL) {
        HabitService.setStatus(habitId, date, toTime, currentBit);
        HabitService.setStatus(habitId, date, fromTime, HABIT_STATE.NULL);
    }
}

// --- CONFIRMATION HANDLERS ---

const _applyDropJustToday = () => {
    const ctx = ActionContext.drop, target = getSafeDate(state.selectedDate);
    if (!ctx || isDateLoading(target)) return ActionContext.reset();
    
    const habit = state.habits.find(h => h.id === ctx.habitId);
    if (habit) {
        // Cria um agendamento específico para hoje (override).
        const info = ensureHabitDailyInfo(target, ctx.habitId);
        const sch = [...getEffectiveScheduleForHabitOnDate(habit, target)];
        const fIdx = sch.indexOf(ctx.fromTime);
        if (fIdx > -1) sch.splice(fIdx, 1);
        if (!sch.includes(ctx.toTime)) sch.push(ctx.toTime);
        info.dailySchedule = sch;

        // Move a instância e seu status para o novo horário.
        _moveHabitInstanceForDay(ctx.habitId, target, ctx.fromTime, ctx.toTime);

        if (ctx.reorderInfo) reorderHabit(ctx.habitId, ctx.reorderInfo.id, ctx.reorderInfo.pos, true);
        _notifyChanges(false);
    }
    ActionContext.reset();
};

const _applyDropFromNowOn = () => {
    const ctx = ActionContext.drop, target = getSafeDate(state.selectedDate);
    if (!ctx || isDateLoading(target)) return ActionContext.reset();

    // Verifica se existe um override para o dia de hoje, para ser usado como base para a mudança.
    const info = ensureHabitDailyInfo(target, ctx.habitId);
    const curOverride = info.dailySchedule ? [...info.dailySchedule] : null;
    info.dailySchedule = undefined; // Limpa o override do dia específico.

    // Move a instância de hoje para o novo horário.
    _moveHabitInstanceForDay(ctx.habitId, target, ctx.fromTime, ctx.toTime);

    if (ctx.reorderInfo) reorderHabit(ctx.habitId, ctx.reorderInfo.id, ctx.reorderInfo.pos, true);

    // Solicita a mudança de agendamento para o futuro.
    _requestFutureScheduleChange(ctx.habitId, target, (s) => {
        const times = curOverride || [...s.times]; // Usa o override de hoje como base, se existir.
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

    // --- CORREÇÃO: Limpar rastro do Bitmask (Zero-Lixo) ---
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
 * Ciclo: Vazio (0) -> Feito (1) -> Vazio (0)
 * (Nota: Se você tiver estados extras como "Adiado", ajuste a lógica aqui)
 */
export function toggleHabitStatus(habitId: string, time: TimeOfDay, dateISO: string) {
    // 1. LEITURA: Pergunta ao Bitmask qual o estado atual
    const currentStatus = HabitService.getStatus(habitId, dateISO, time);
    
    // 2. LÓGICA: Define o próximo estado
    // Se estava FEITO ou FEITO+, vira NULL (ou Adiado se o app suportar).
    // Aqui usamos o ciclo padrão do aplicativo: NULL -> DONE -> DEFERRED -> NULL.
    let nextStatus: number = HABIT_STATE.DONE;
    if (currentStatus === HABIT_STATE.DONE || currentStatus === HABIT_STATE.DONE_PLUS) {
        nextStatus = HABIT_STATE.DEFERRED;
    } else if (currentStatus === HABIT_STATE.DEFERRED) {
        nextStatus = HABIT_STATE.NULL;
    }
    
    // 3. ESCRITA: Grava no Bitmask (Map<BigInt>)
    HabitService.setStatus(habitId, dateISO, time, nextStatus);
    
    // 4. PERSISTÊNCIA & UI
    saveState(); // Agenda o salvamento do Map no IndexedDB
    
    // Side Effects & Haptics
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
    
    // 5. Atualizar UI
    _notifyPartialUIRefresh(dateISO, [habitId]);
}

/**
 * ZC-ARCHITECTURE: Batch update using Bitmask exclusively.
 */
export function markAllHabitsForDate(dateISO: string, status: 'completed' | 'snoozed'): boolean {
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
                if (HabitService.getStatus(h.id, dateISO, t) !== bitStatus) {
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
        
        const currentStatus = HabitService.getStatus(habitId, d, t);
        
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

        saveState();

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

export function exportData() {
    // FIX [2025-06-05]: DATA LOSS PREVENTION
    // Manually serialize the Bitmask Map (monthlyLogs) to Array of Hex tuples.
    // JSON.stringify ignores Maps by default, which would wipe all habit history.
    const stateToExport = getPersistableState();
    
    // CRITICAL: Injeta os logs binários convertidos para Hex (Legível/Portátil)
    // Isso garante que o backup restaure o histórico corretamente.
    const logs = HabitService.serializeLogsForCloud(); // Retorna [["ID_DATA", "0x1A..."], ...]
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

export function handleDayTransition() { const today = getTodayUTCIso(); clearActiveHabitsCache(); state.uiDirtyState.calendarVisuals = state.uiDirtyState.habitListStructure = state.uiDirtyState.chartData = true; state.calendarDates = []; if (state.selectedDate !== today) state.selectedDate = today; document.dispatchEvent(new CustomEvent('render-app')); }

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