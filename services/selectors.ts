
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/selectors.ts
 * @description Camada de Leitura Otimizada e Lógica Derivada (Selectors / Query Layer).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo contém funções puras que transformam o estado bruto (`state.ts`) em dados consumíveis pela UI.
 * 
 * ARQUITETURA FASE 4 (Kernel Abstraction):
 * - **Unified Access:** Todas as leituras de status/metas passam pelos métodos do `kernel`.
 * - **Zero-Allocation:** Loops críticos otimizados, mas sem exposição de detalhes de implementação de memória (Atomics).
 */

import { 
    state, 
    Habit, 
    TimeOfDay, 
    HabitSchedule, 
    STREAK_LOOKBACK_DAYS, 
    PredefinedHabit, 
    kernel, 
    KernelHabitStatus, 
    HabitStatus
} from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, getTodayUTCIso } from '../utils';
import { t } from '../i18n';

// --- Internal Cache for Static Dates ---
// Cache estático para datas de âncora. Evita `new Date()` em loops quentes.
const _anchorDateCache = new Map<string, Date>();

// PERF: Constante mágica hoistada (ms por dia)
const MS_PER_DAY = 86400000;

function _getMemoizedDate(dateISO: string): Date {
    let date = _anchorDateCache.get(dateISO);
    if (!date) {
        date = parseUTCIsoDate(dateISO);
        _anchorDateCache.set(dateISO, date);
    }
    return date;
}

/**
 * Limpa caches internos que não são gerenciados pelo `state.ts`.
 */
export function clearSelectorInternalCaches() {
    _anchorDateCache.clear();
}

// --- Seletores de Agendamento (Schedule Selectors) ---

/**
 * Encontra o agendamento específico de um hábito que estava ativo em uma determinada data.
 * Utiliza cache aninhado (Habit -> Date) para otimizar buscas repetidas sem alocação de strings.
 */
export function getScheduleForDate(habit: Habit, dateISO: string): HabitSchedule | null {
    // PERFORMANCE: Acesso a Map aninhado é O(1).
    let subCache = state.scheduleCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.scheduleCache.set(habit.id, subCache);
    }
    
    // Fast path: Check cache
    const cached = subCache.get(dateISO);
    if (cached !== undefined) {
        return cached;
    }
    
    // CRITICAL LOGIC: Time-Travel. Encontra o registro histórico válido.
    // JIT OPTIMIZATION: Raw Loop instead of .find() to avoid closure allocation.
    const history = habit.scheduleHistory;
    const len = history.length;
    let schedule: HabitSchedule | null = null;

    for (let i = 0; i < len; i = (i + 1) | 0) {
        const s = history[i];
        // String comparison is fast in JS engines (interned strings)
        if (dateISO >= s.startDate && (!s.endDate || dateISO < s.endDate)) {
            schedule = s;
            break;
        }
    }

    subCache.set(dateISO, schedule);
    return schedule;
}

/**
 * Resolve o nome e subtítulo de exibição de um hábito para uma data específica.
 */
export function getHabitDisplayInfo(habit: Habit | PredefinedHabit, dateISO?: string): { name: string, subtitle: string } {
    let source: any = habit;
    
    // Duck typing check for Habit vs PredefinedHabit (Habit has scheduleHistory)
    if ('scheduleHistory' in habit && habit.scheduleHistory.length > 0) {
        if (dateISO) {
            // Re-use optimized selector
            const sched = getScheduleForDate(habit, dateISO);
            source = sched || habit.scheduleHistory[habit.scheduleHistory.length - 1];
        } else {
            source = habit.scheduleHistory[habit.scheduleHistory.length - 1];
        }
    }

    // Monomorphic return shape
    if (source.nameKey) {
        return {
            name: t(source.nameKey),
            subtitle: source.subtitleKey ? t(source.subtitleKey) : ''
        };
    }
    return {
        name: source.name || '',
        subtitle: source.subtitleKey ? t(source.subtitleKey) : (source.subtitle || '')
    };
}

/**
 * Retorna o array de horários do dia para um hábito em uma data específica.
 */
export function getEffectiveScheduleForHabitOnDate(habit: Habit, dateISO: string): TimeOfDay[] {
    // 1. Hot Path: Verifica Hot Storage para override diário (O(1) dictionary access)
    // NOTE: This access hydrates the object wrapper but DOES NOT trigger Proxy creation for instances yet.
    // Access direct raw object to avoid Proxy overhead if possible
    const dailyInfo = state.dailyData[dateISO]?.[habit.id];
    if (dailyInfo && dailyInfo.dailySchedule) {
        return dailyInfo.dailySchedule;
    }
    // 2. Fallback: Regra Geral (Histórico)
    const schedule = getScheduleForDate(habit, dateISO);
    return schedule ? schedule.times : [];
}

/**
 * Determina se um hábito deve aparecer em uma data específica.
 * PERFORMANCE: Hot Path crítico. Otimizado para evitar alocação de objetos Date.
 */
export function shouldHabitAppearOnDate(habit: Habit, dateISO: string, preParsedDate?: Date): boolean {
    // 1. Cache Layer O(1)
    let subCache = state.habitAppearanceCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.habitAppearanceCache.set(habit.id, subCache);
    }

    const cached = subCache.get(dateISO);
    if (cached !== undefined) {
        return cached;
    }

    // 2. Logic Layer
    const schedule = getScheduleForDate(habit, dateISO);
    // Fail fast: Sem agendamento ou graduado
    if (!schedule || habit.graduatedOn) {
        subCache.set(dateISO, false);
        return false;
    }

    const frequency = schedule.frequency;
    let appears = false;

    // Switch Monomórfico
    switch (frequency.type) {
        case 'daily':
            appears = true;
            break;
        case 'specific_days_of_week':
            // OPTIMIZATION: Use preParsedDate if available
            const d = preParsedDate || parseUTCIsoDate(dateISO);
            // Array.includes é rápido o suficiente para arrays pequenos (max 7)
            appears = frequency.days.includes(d.getUTCDay());
            break;
        case 'interval':
            const date = preParsedDate || parseUTCIsoDate(dateISO);
            // Math Heavy: Use Memoized Anchor Date
            const anchorDate = _getMemoizedDate(schedule.scheduleAnchor || schedule.startDate);
            // Integer Arithmetic: diffTime pode ser float, arredondamos.
            const diffTime = date.getTime() - anchorDate.getTime();
            
            const diffDays = Math.round(diffTime / MS_PER_DAY) | 0; // Force int32

            if (frequency.unit === 'days') {
                appears = diffDays >= 0 && (diffDays % frequency.amount === 0);
            } else { // weeks
                const diffWeeks = (diffDays / 7) | 0; // Truncate to int
                // Verifica mesmo dia da semana E intervalo de semanas
                appears = diffDays >= 0 && 
                          date.getUTCDay() === anchorDate.getUTCDay() && 
                          (diffWeeks % frequency.amount === 0);
            }
            break;
    }

    subCache.set(dateISO, appears);
    return appears;
}


// --- Seletores de Dados e Estatísticas (Data & Stats Selectors) ---

/**
 * Verifica consistência do hábito.
 * HFT UPDATE [2025-04-22]: Phase 4 Unified Kernel Access.
 */
function _isHabitConsistentlyDone(habit: Habit, dateISO: string): boolean {
    const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
    const len = schedule.length;
    if (len === 0) return true;

    // Raw Loop with Unified Accessor
    for (let i = 0; i < len; i = (i + 1) | 0) {
        const time = schedule[i];
        
        // UNIFIED KERNEL READ: Handles Hot/Cold switching internally
        const kStatus = kernel.getDailyStatus(habit.id, dateISO, time);
        
        if (kStatus !== KernelHabitStatus.COMPLETED && kStatus !== KernelHabitStatus.SNOOZED) {
            return false;
        }
    }
    return true;
}

/**
 * Calcula a sequência (streak).
 * FASE 4: Algoritmo Unificado via Kernel.
 * Remove a lógica duplicada de verificação de range e acesso direto a Atomics.
 */
export function calculateHabitStreak(habitOrId: string | Habit, endDateISO: string): number {
    // Resolve Habit Object
    let habit: Habit | undefined;
    let habitId: string;

    if (typeof habitOrId === 'string') {
        habitId = habitOrId;
        habit = state.habits.find(h => h.id === habitId);
    } else {
        habit = habitOrId;
        habitId = habit.id;
    }

    if (!habit) return 0;

    let subCache = state.streaksCache.get(habitId);
    if (!subCache) {
        subCache = new Map();
        state.streaksCache.set(habitId, subCache);
    }

    const cached = subCache.get(endDateISO);
    if (cached !== undefined) {
        return cached;
    }

    // 1. Incremental Check (Fast Path)
    const endDateObj = parseUTCIsoDate(endDateISO);
    const endTime = endDateObj.getTime();
    
    const yesterdayTimestamp = endTime - MS_PER_DAY;
    const yesterdayISO = toUTCIsoDateString(new Date(yesterdayTimestamp));
    const cachedYesterday = subCache.get(yesterdayISO);

    if (cachedYesterday !== undefined) {
        if (!shouldHabitAppearOnDate(habit, endDateISO, endDateObj)) {
            subCache.set(endDateISO, cachedYesterday);
            return cachedYesterday;
        }

        if (_isHabitConsistentlyDone(habit, endDateISO)) {
            const newStreak = (cachedYesterday + 1) | 0;
            subCache.set(endDateISO, newStreak);
            return newStreak;
        } else {
            subCache.set(endDateISO, 0);
            return 0;
        }
    }

    // 2. Iterative Full Calculation
    let streak = 0;
    let currentTimestamp = endTime;
    
    // Reuse Date object
    const iteratorDate = new Date(currentTimestamp);
    const creationISO = habit.createdOn;

    for (let i = 0; i < STREAK_LOOKBACK_DAYS; i = (i + 1) | 0) {
        iteratorDate.setTime(currentTimestamp);
        const currentDateISO = toUTCIsoDateString(iteratorDate);

        if (currentDateISO < creationISO) break;

        if (shouldHabitAppearOnDate(habit, currentDateISO, iteratorDate)) {
            const schedule = getEffectiveScheduleForHabitOnDate(habit, currentDateISO);
            let consistent = true;
            
            for (const time of schedule) {
                // UNIFIED KERNEL READ: Eliminates manual hot/cold branching in this complex loop
                const kStatus = kernel.getDailyStatus(habitId, currentDateISO, time);
                
                if (kStatus !== KernelHabitStatus.COMPLETED && kStatus !== KernelHabitStatus.SNOOZED) {
                    consistent = false;
                    break;
                }
            }

            if (consistent) {
                streak = (streak + 1) | 0;
            } else {
                break; // Broken
            }
        }
        
        currentTimestamp -= MS_PER_DAY;
    }
    
    subCache.set(endDateISO, streak);
    return streak;
}

/**
 * Calcula a meta inteligente para um hábito.
 * FASE 4: Leitura de Goal Override via Kernel Unificado.
 */
export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    if (habit.goal.type === 'check' || !habit.goal.total) {
        return 1;
    }

    // 1. Unified DMA Lookup for Goal Override
    const kGoal = kernel.getDailyGoal(habit.id, dateISO, time);
    if (kGoal > 0) return kGoal; // 0 in kernel logic means "no override / unset"
    
    // 2. Smart Calculation Logic (Unchanged)
    const baseGoal = habit.goal.total;
    const targetDate = parseUTCIsoDate(dateISO);
    const targetTime = targetDate.getTime();

    let validIncreases = 0;
    let minIncrease = 999999;
    const tempDate = new Date(targetTime);

    // Lookback logic...
    for (let i = 1; i <= 3; i = (i + 1) | 0) {
        tempDate.setTime(targetTime - (MS_PER_DAY * i));
        const pastISO = toUTCIsoDateString(tempDate);
        
        let status: HabitStatus = 'pending';
        let pastGoalValue = baseGoal;

        // Unified Kernel Read
        const kStatus = kernel.getDailyStatus(habit.id, pastISO, time);
        if (kStatus === KernelHabitStatus.COMPLETED) status = 'completed';
        
        const kPastGoal = kernel.getDailyGoal(habit.id, pastISO, time);
        if (kPastGoal > 0) pastGoalValue = kPastGoal;

        if (status === 'completed') {
            if (pastGoalValue > baseGoal) {
                validIncreases = (validIncreases + 1) | 0;
                if (pastGoalValue < minIncrease) minIncrease = pastGoalValue;
            } else {
                break; 
            }
        } else {
            break; 
        }
    }

    if (validIncreases === 3) {
        return minIncrease;
    }

    const yesterdayISO = toUTCIsoDateString(new Date(targetTime - MS_PER_DAY));
    const streak = calculateHabitStreak(habit, yesterdayISO);
    const streakBonus = ((streak / 7) | 0) * 5; 
    
    const calculated = baseGoal + streakBonus;
    return calculated > 5 ? calculated : 5;
}

export function getCurrentGoalForInstance(habit: Habit, dateISO: string, time: TimeOfDay): number {
    return getSmartGoalForHabit(habit, dateISO, time);
}

/**
 * Retorna uma lista de hábitos ativos.
 */
export function getActiveHabitsForDate(dateISO: string, preParsedDate?: Date): Array<{ habit: Habit, schedule: TimeOfDay[] }> {
    const cached = state.activeHabitsCache.get(dateISO);
    if (cached) return cached;
    
    const activeHabits: Array<{ habit: Habit, schedule: TimeOfDay[] }> = [];
    const habits = state.habits;
    const len = habits.length;

    // BCE Loop
    for (let i = 0; i < len; i = (i + 1) | 0) {
        const habit = habits[i];
        
        if (shouldHabitAppearOnDate(habit, dateISO, preParsedDate)) {
            const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
            
            if (schedule.length > 0) {
                activeHabits.push({ habit, schedule });
            }
        }
    }
    
    state.activeHabitsCache.set(dateISO, activeHabits);
    return activeHabits;
}

/**
 * Calcula resumo do dia.
 * FASE 4: Full Unified Kernel Implementation.
 */
export function calculateDaySummary(dateISO: string, preParsedDate?: Date) {
    const cached = state.daySummaryCache.get(dateISO);
    if (cached) return cached;

    let total = 0;
    let completed = 0;
    let snoozed = 0;
    let pending = 0;
    let hasNumericOverachieved = false;

    const habits = state.habits;
    const habitsLen = habits.length;
    
    const dateObj = preParsedDate || parseUTCIsoDate(dateISO);

    // Fused Loop (All Habits)
    for (let i = 0; i < habitsLen; i = (i + 1) | 0) {
        const habit = habits[i];
        
        if (!shouldHabitAppearOnDate(habit, dateISO, dateObj)) {
            continue;
        }
        
        const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
        const schedLen = schedule.length;
        if (schedLen === 0) continue;
        
        // Time Slot Loop
        for (let j = 0; j < schedLen; j = (j + 1) | 0) {
            const time = schedule[j];
            total = (total + 1) | 0;
            
            let status: HabitStatus = 'pending';
            let currentGoalVal = 0; // 0 means default/not set

            // Unified Kernel Read
            const kStatus = kernel.getDailyStatus(habit.id, dateISO, time);
            if (kStatus === KernelHabitStatus.COMPLETED) status = 'completed';
            else if (kStatus === KernelHabitStatus.SNOOZED) status = 'snoozed';
            
            // Read Goal (Only relevant if completed)
            if (status === 'completed') {
                currentGoalVal = kernel.getDailyGoal(habit.id, dateISO, time);
            }
            
            if (status === 'completed') {
                completed = (completed + 1) | 0;
                
                // Numeric Overachievement Check
                const gType = habit.goal.type;
                if ((gType === 'pages' || gType === 'minutes') && habit.goal.total) {
                     // Normalize goal value (0 in kernel means no override, fetch smart goal)
                     const effectiveGoal = currentGoalVal > 0 ? currentGoalVal : getSmartGoalForHabit(habit, dateISO, time);
                     
                     if (effectiveGoal > habit.goal.total) {
                         // PERF: Integer math for yesterday
                         const yesterdayISO = toUTCIsoDateString(new Date(dateObj.getTime() - MS_PER_DAY));
                         const currentStreak = calculateHabitStreak(habit, yesterdayISO);
                         
                         if (currentStreak >= 2) {
                             hasNumericOverachieved = true;
                         }
                     }
                }
            } else if (status === 'snoozed') {
                snoozed = (snoozed + 1) | 0;
            } else {
                pending = (pending + 1) | 0;
            }
        }
    }
    
    const summary = {
        total,
        completed,
        snoozed,
        pending,
        completedPercent: total > 0 ? (completed / total) * 100 : 0,
        snoozedPercent: total > 0 ? (snoozed / total) * 100 : 0,
        showPlusIndicator: hasNumericOverachieved
    };
    
    state.daySummaryCache.set(dateISO, summary);
    return summary;
}

export function isHabitNameDuplicate(name: string, currentHabitId?: string): boolean {
    const normalizedNewName = name.trim().toLowerCase();
    if (!normalizedNewName) return false;

    const todayISO = getTodayUTCIso();
    const habits = state.habits;
    const len = habits.length;

    for (let i = 0; i < len; i = (i + 1) | 0) {
        const habit = habits[i];
        if (habit.id === currentHabitId) continue;
        
        const { name: existingHabitName } = getHabitDisplayInfo(habit, todayISO);
        if (existingHabitName.trim().toLowerCase() === normalizedNewName) {
            return true;
        }
    }
    return false;
}
