
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
 * Como são chamadas centenas de vezes por ciclo de renderização (ex: em loops de calendário), a performance é crítica.
 * 
 * ARQUITETURA (Memoization & Caching):
 * - **Responsabilidade Única:** Centralizar a lógica de "leitura". Nenhuma função aqui deve mutar o estado.
 * - **Multilayer Caching:** Implementa caches em memória (Maps aninhados) para resultados de cálculos caros.
 * - **Zero-Allocation Strategies:** Utiliza loops crus e evita closures para reduzir pressão no GC.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Fonte da verdade.
 * - `utils.ts`: Parsers de data.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Raw Loops (BCE):** Loops `for` com cache de tamanho para Bound Checks Elimination no V8.
 * 2. **Smi Math:** Uso de `| 0` para garantir operações com Small Integers.
 */

import { state, Habit, TimeOfDay, HabitSchedule, getHabitDailyInfoForDate, STREAK_LOOKBACK_DAYS, PredefinedHabit } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, addDays, getTodayUTCIso } from '../utils';
import { t } from '../i18n';

// --- Internal Cache for Static Dates ---
// Cache estático para datas de âncora. Evita `new Date()` em loops quentes.
const _anchorDateCache = new Map<string, Date>();

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
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
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
            // Constante mágica hoistada (ms por dia)
            const MS_PER_DAY = 86400000; 
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
 * JIT OPTIMIZATION: Inlined checks, no closures.
 */
function _isHabitConsistentlyDone(habit: Habit, dateISO: string, dailyInfoMap?: Record<string, any>): boolean {
    const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
    const len = schedule.length;
    if (len === 0) return true;

    // Use injected map or fetch
    const dailyInfo = (dailyInfoMap || getHabitDailyInfoForDate(dateISO))[habit.id];
    
    // Raw Loop instead of .every() for BCE
    for (let i = 0; i < len; i = (i + 1) | 0) {
        const time = schedule[i];
        const status = dailyInfo?.instances[time]?.status;
        // Conditional Check order: Most likely first
        if (status !== 'completed' && status !== 'snoozed') {
            return false;
        }
    }
    return true;
}

/**
 * Calcula a sequência (streak).
 * SOPA UPDATE: Incremental Caching com Fallback Iterativo Otimizado.
 */
export function calculateHabitStreak(habitId: string, endDateISO: string): number {
    let subCache = state.streaksCache.get(habitId);
    if (!subCache) {
        subCache = new Map();
        state.streaksCache.set(habitId, subCache);
    }

    const cached = subCache.get(endDateISO);
    if (cached !== undefined) {
        return cached;
    }

    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return 0;

    // 1. Incremental Check (Ontem + Hoje)
    const endDateObj = parseUTCIsoDate(endDateISO);
    const yesterdayISO = toUTCIsoDateString(addDays(endDateObj, -1));
    
    const cachedYesterday = subCache.get(yesterdayISO);

    if (cachedYesterday !== undefined) {
        // Fast Path: O(1)
        if (!shouldHabitAppearOnDate(habit, endDateISO, endDateObj)) {
            // Pausa natural (não aparece hoje) -> Mantém streak
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

    // 2. Iterative Full Calculation (Slow Path)
    let streak = 0;
    const iteratorDate = new Date(endDateObj); // Clone

    // Raw Loop with Hard Limit
    for (let i = 0; i < STREAK_LOOKBACK_DAYS; i = (i + 1) | 0) {
        const currentDateISO = toUTCIsoDateString(iteratorDate);
        // Break if before creation
        if (currentDateISO < habit.createdOn) break;

        if (shouldHabitAppearOnDate(habit, currentDateISO, iteratorDate)) {
            if (_isHabitConsistentlyDone(habit, currentDateISO)) {
                streak = (streak + 1) | 0;
            } else {
                break; // Broken
            }
        }
        // Mutate Date (Backwards)
        iteratorDate.setUTCDate(iteratorDate.getUTCDate() - 1);
    }
    
    subCache.set(endDateISO, streak);
    return streak;
}

export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    if (habit.goal.type === 'check' || !habit.goal.total) {
        return 1;
    }

    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    const override = dailyInfo?.instances[time]?.goalOverride;
    if (override !== undefined) {
        return override;
    }
    
    const baseGoal = habit.goal.total;
    const targetDate = parseUTCIsoDate(dateISO);

    // Optimized Loop for 3-day lookback
    let validIncreases = 0;
    let minIncrease = 999999; // Arbitrary high number

    for (let i = 1; i <= 3; i = (i + 1) | 0) {
        const pastDate = addDays(targetDate, -i);
        const pastISO = toUTCIsoDateString(pastDate);
        const pastDailyInfo = getHabitDailyInfoForDate(pastISO)[habit.id];
        const pastInstance = pastDailyInfo?.instances?.[time];

        if (pastInstance?.status === 'completed') {
            const val = pastInstance.goalOverride ?? baseGoal;
            if (val > baseGoal) {
                validIncreases = (validIncreases + 1) | 0;
                if (val < minIncrease) minIncrease = val;
            } else {
                break; // Not consecutive increase
            }
        } else {
            break; // Streak broken or not completed
        }
    }

    if (validIncreases === 3) {
        return minIncrease;
    }

    // Default Progressive Logic
    const yesterdayISO = toUTCIsoDateString(addDays(targetDate, -1));
    const streak = calculateHabitStreak(habit.id, yesterdayISO);
    // Integer division hack: (a / b) | 0
    const streakBonus = ((streak / 7) | 0) * 5; 
    
    const calculated = baseGoal + streakBonus;
    return calculated > 5 ? calculated : 5; // Math.max(5, ...)
}

export function getCurrentGoalForInstance(habit: Habit, dateISO: string, time: TimeOfDay): number {
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    // Optional chaining + Nullish coalescing is optimized in modern V8
    return dailyInfo?.instances[time]?.goalOverride ?? getSmartGoalForHabit(habit, dateISO, time);
}

/**
 * Retorna uma lista de hábitos ativos.
 * SOPA UPDATE: Single-Pass Allocation com Loop Raw.
 * Substitui filter/map chain por um único loop.
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
            // Get effective schedule (may call getScheduleForDate internally)
            const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
            
            if (schedule.length > 0) {
                // Allocation is necessary here as this is the result shape
                activeHabits.push({ habit, schedule });
            }
        }
    }
    
    state.activeHabitsCache.set(dateISO, activeHabits);
    return activeHabits;
}

/**
 * Calcula resumo do dia.
 * SOPA UPDATE: Hoisting de Mapa Diário + Loop Raw.
 */
export function calculateDaySummary(dateISO: string, preParsedDate?: Date) {
    const cached = state.daySummaryCache.get(dateISO);
    if (cached) return cached;

    const activeHabits = getActiveHabitsForDate(dateISO, preParsedDate);
    
    // Initialize counters (Smi)
    let total = 0;
    let completed = 0;
    let snoozed = 0;
    let pending = 0;
    let hasNumericOverachieved = false;

    // Hoist map lookup out of loop
    const dailyInfoMap = getHabitDailyInfoForDate(dateISO);
    const activeLen = activeHabits.length;

    // BCE Loop over active habits
    for (let i = 0; i < activeLen; i = (i + 1) | 0) {
        const entry = activeHabits[i];
        const habit = entry.habit;
        const schedule = entry.schedule;
        const schedLen = schedule.length;
        
        const dailyInfo = dailyInfoMap[habit.id];
        
        // Inner BCE Loop over time slots
        for (let j = 0; j < schedLen; j = (j + 1) | 0) {
            const time = schedule[j];
            total = (total + 1) | 0;
            
            // Safe access
            const instance = dailyInfo?.instances[time];
            const status = instance ? instance.status : 'pending';
            
            if (status === 'completed') {
                completed = (completed + 1) | 0;
                
                // Numeric Overachievement Check
                const gType = habit.goal.type;
                if ((gType === 'pages' || gType === 'minutes') && habit.goal.total) {
                     const currentGoal = getCurrentGoalForInstance(habit, dateISO, time);
                     if (currentGoal > habit.goal.total) {
                         // Check streaks only if needed
                         const prevDate = preParsedDate || parseUTCIsoDate(dateISO);
                         // Note: We use a utility here that might allocate a Date, but it's rare (only on overachievement)
                         const yesterdayISO = toUTCIsoDateString(addDays(prevDate, -1));
                         const currentStreak = calculateHabitStreak(habit.id, yesterdayISO);
                         
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
