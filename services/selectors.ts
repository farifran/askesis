

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, Habit, TimeOfDay, HabitSchedule, getHabitDailyInfoForDate, STREAK_LOOKBACK_DAYS, PredefinedHabit, HABIT_STATE } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, MS_PER_DAY, getTodayUTCIso } from '../utils';
import { t } from '../i18n';
import { HabitService } from './HabitService';

const _anchorDateCache = new Map<string, Date>();
const MAX_ANCHOR_CACHE_SIZE = 365;

function _getMemoizedDate(dateISO: string): Date {
    let date = _anchorDateCache.get(dateISO);
    if (!date) {
        if (_anchorDateCache.size > MAX_ANCHOR_CACHE_SIZE) _anchorDateCache.clear();
        date = parseUTCIsoDate(dateISO);
        _anchorDateCache.set(dateISO, date);
    }
    return date;
}

export const clearSelectorInternalCaches = () => _anchorDateCache.clear();

/**
 * [PERFORMANCE-CRITICAL & MEMOIZED]
 * Retrieves the effective HabitSchedule for a specific date by searching the habit's history.
 * Results are cached in `state.scheduleCache` to ensure subsequent lookups for the same
 * habit and date are O(1). The cache is invalidated in `habitActions.ts` upon habit modification.
 * @param habit The habit object.
 * @param dateISO The target date in 'YYYY-MM-DD' format.
 * @returns The active HabitSchedule or null if none is found.
 */
export function getScheduleForDate(habit: Habit, dateISO: string): HabitSchedule | null {
    // 1. Cache Lookup (Fast Path)
    let subCache = state.scheduleCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.scheduleCache.set(habit.id, subCache);
    } else {
        const cached = subCache.get(dateISO);
        if (cached !== undefined) {
            return cached;
        }
    }

    // 2. Data Integrity Guard (Robustness)
    const history = habit.scheduleHistory;
    if (!history || !Array.isArray(history) || history.length === 0) {
        subCache.set(dateISO, null); // Cache the failure to avoid re-computation
        return null;
    }

    // 3. Computation (Slow Path)
    // OPTIMIZATION: Iterate backwards. Since history is sorted ascending and queries are often for recent dates,
    // starting from the end is generally faster.
    let schedule: HabitSchedule | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
        const s = history[i];
        // The first entry from the end where the date is on or after its start date must be the correct one.
        if (dateISO >= s.startDate) {
            // Further check if the schedule has an end date and if we are before it.
            if (!s.endDate || dateISO < s.endDate) {
                schedule = s;
            }
            // Since history is sorted and entries are contiguous, we can break after finding the valid range.
            break; 
        }
    }
    
    // 4. Cache & Return
    subCache.set(dateISO, schedule);
    return schedule;
}

// @fix: Changed return type to `readonly TimeOfDay[]` to match the types of `dailySchedule` and `schedule.times`.
export function getEffectiveScheduleForHabitOnDate(habit: Habit, dateISO: string): readonly TimeOfDay[] {
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    if (dailyInfo?.dailySchedule) {
        return dailyInfo.dailySchedule;
    }
    const schedule = getScheduleForDate(habit, dateISO);
    return schedule?.times || [];
}

export function getHabitPropertiesForDate(habit: Habit, dateISO: string): HabitSchedule | null {
    // This function provides the habit's properties for a given date.
    // If the date is before the habit's creation, it falls back to the last known schedule
    // to provide a "preview" of the habit, which is useful for UI rendering.
    if (!habit?.scheduleHistory || !Array.isArray(habit.scheduleHistory) || habit.scheduleHistory.length === 0) {
        return null;
    }
    const schedule = getScheduleForDate(habit, dateISO);
    return schedule || habit.scheduleHistory[habit.scheduleHistory.length - 1];
}

export function getHabitDisplayInfo(habit: Habit | PredefinedHabit, dateISO?: string): { name: string, subtitle: string } {
    let source: any = habit;
    if ('scheduleHistory' in habit && habit.scheduleHistory.length > 0) {
        const effectiveDate = dateISO || getTodayUTCIso();
        source = getHabitPropertiesForDate(habit as Habit, effectiveDate) || habit.scheduleHistory[habit.scheduleHistory.length-1];
    }
    return {
        name: source.nameKey ? t(source.nameKey) : (source.name || ''),
        subtitle: source.subtitleKey ? t(source.subtitleKey) : (source.subtitle || '')
    };
}

/**
 * [MEMOIZED] Checks if a habit is scheduled to appear on a given date.
 * Relies on the cached result of `getScheduleForDate`. Caches its own boolean result
 * in `state.habitAppearanceCache` for maximum performance in loops (e.g., calendar rendering).
 */
export function shouldHabitAppearOnDate(habit: Habit, dateISO: string, preParsedDate?: Date): boolean {
    let subCache = state.habitAppearanceCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.habitAppearanceCache.set(habit.id, subCache);
    }

    const cached = subCache.get(dateISO);
    if (cached !== undefined) return cached;

    const schedule = getScheduleForDate(habit, dateISO);
    if (!schedule || habit.graduatedOn) {
        subCache.set(dateISO, false);
        return false;
    }

    const { frequency } = schedule;
    const date = preParsedDate || parseUTCIsoDate(dateISO);
    let appears = false;

    switch (frequency.type) {
        case 'daily': appears = true; break;
        case 'specific_days_of_week':
            appears = frequency.days.includes(date.getUTCDay());
            break;
        case 'interval':
            const anchorDate = _getMemoizedDate(schedule.scheduleAnchor || schedule.startDate);
            const diffDays = Math.round((date.getTime() - anchorDate.getTime()) / MS_PER_DAY);
            if (frequency.unit === 'days') {
                appears = diffDays >= 0 && (diffDays % frequency.amount === 0);
            } else {
                appears = diffDays >= 0 && date.getUTCDay() === anchorDate.getUTCDay() && (Math.floor(diffDays / 7) % frequency.amount === 0);
            }
            break;
    }

    subCache.set(dateISO, appears);
    return appears;
}

function _isHabitConsistentlyDone(habit: Habit, dateISO: string): boolean {
    const schedule = getEffectiveScheduleForHabitOnDate(habit, dateISO);
    if (schedule.length === 0) return true;
    
    // MUDANÇA: Usando HabitService (Bitmask) em vez de dailyData direto
    for (let i = 0; i < schedule.length; i++) {
        const time = schedule[i];
        const status = HabitService.getStatus(habit.id, dateISO, time);
        
        // Verifica se é DONE (1) ou DEFERRED (2) ou DONE_PLUS (3)
        if (status !== HABIT_STATE.DONE && status !== HABIT_STATE.DEFERRED && status !== HABIT_STATE.DONE_PLUS) return false;
    }
    return true;
}

/**
 * [PERFORMANCE-CRITICAL & MEMOIZED]
 * Calculates the current streak for a habit ending on a specific date.
 * Implements a dynamic programming approach: the streak for a date is calculated based on
 * the cached streak of the previous day, making subsequent calculations O(1).
 * Cache is stored in `state.streaksCache` and invalidated on habit data changes.
 */
export function calculateHabitStreak(habitOrId: string | Habit, endDateISO: string): number {
    const habit = typeof habitOrId === 'string' ? state.habits.find(h => h.id === habitOrId) : habitOrId;
    if (!habit) return 0;

    let subCache = state.streaksCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.streaksCache.set(habit.id, subCache);
    }

    const cached = subCache.get(endDateISO);
    if (cached !== undefined) return cached;

    const endDateObj = parseUTCIsoDate(endDateISO);
    if (isNaN(endDateObj.getTime())) return 0; 

    const yesterdayISO = toUTCIsoDateString(new Date(endDateObj.getTime() - MS_PER_DAY));
    const cachedYesterday = subCache.get(yesterdayISO);

    if (cachedYesterday !== undefined) {
        const res = !shouldHabitAppearOnDate(habit, endDateISO, endDateObj) ? cachedYesterday : (_isHabitConsistentlyDone(habit, endDateISO) ? cachedYesterday + 1 : 0);
        subCache.set(endDateISO, res);
        return res;
    }

    let streak = 0;
    let currentTs = endDateObj.getTime();
    const iterDate = new Date();
    
    for (let i = 0; i < STREAK_LOOKBACK_DAYS; i++) {
        iterDate.setTime(currentTs);
        const iso = toUTCIsoDateString(iterDate);
        if (iso < habit.createdOn) break;
        if (shouldHabitAppearOnDate(habit, iso, iterDate)) {
            if (_isHabitConsistentlyDone(habit, iso)) streak++;
            else break;
        }
        currentTs -= MS_PER_DAY;
    }
    subCache.set(endDateISO, streak);
    return streak;
}

export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    const schedule = getHabitPropertiesForDate(habit, dateISO);
    if (!schedule) return 1;
    
    if (schedule.goal.type === 'check' || !schedule.goal.total) return 1;
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    
    // 1. Explicit Override for this specific date takes precedence
    if (dailyInfo?.instances[time]?.goalOverride !== undefined) return dailyInfo.instances[time].goalOverride!;
    
    const baseGoal = schedule.goal.total;
    const targetTs = parseUTCIsoDate(dateISO).getTime();
    
    // --- SMART ADAPTATION LOGIC (Historical Lookback) ---
    const todayTs = parseUTCIsoDate(getTodayUTCIso()).getTime();
    let searchTs = (targetTs > todayTs) ? todayTs : (targetTs - MS_PER_DAY);
    let iterDate = new Date(searchTs);
    
    let consistentValue: number | null = null;
    let matchesFound = 0;
    
    for (let i = 0; i < 14; i++) {
        const iterISO = toUTCIsoDateString(iterDate);
        if (iterISO < habit.createdOn) break;
        
        if (shouldHabitAppearOnDate(habit, iterISO, iterDate)) {
            const pastInfo = getHabitDailyInfoForDate(iterISO)[habit.id];
            const instance = pastInfo?.instances?.[time];
            const isToday = iterISO === getTodayUTCIso();
            
            if (!instance || instance.status === 'pending') {
                if (!isToday) break; 
            } else if (instance.status === 'snoozed') {
                break;
            } else if (instance.status === 'completed') {
                if (instance.goalOverride !== undefined) {
                    if (consistentValue === null) {
                        consistentValue = instance.goalOverride;
                        matchesFound++;
                    } else if (consistentValue === instance.goalOverride) {
                        matchesFound++;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
        
        if (matchesFound >= 2) return consistentValue!;
        iterDate.setTime(iterDate.getTime() - MS_PER_DAY);
    }

    // Rule 2: Progressive Overload (Streak Bonus) - Fallback
    const streak = calculateHabitStreak(habit, toUTCIsoDateString(new Date(targetTs - MS_PER_DAY)));
    return Math.max(5, baseGoal + (Math.floor(streak / 7) * 5));
}

export function getCurrentGoalForInstance(habit: Habit, dateISO: string, time: TimeOfDay): number {
    return getHabitDailyInfoForDate(dateISO)[habit.id]?.instances[time]?.goalOverride ?? getSmartGoalForHabit(habit, dateISO, time);
}

/**
 * [MEMOIZED] Gets all habits that should appear on a given date.
 * Results are cached in `state.activeHabitsCache` to speed up rendering of the main habit list.
 */
export function getActiveHabitsForDate(dateISO: string, preParsedDate?: Date): Array<{ habit: Habit, schedule: TimeOfDay[] }> {
    const cached = state.activeHabitsCache.get(dateISO);
    if (cached) return cached;
    const dateObj = preParsedDate || parseUTCIsoDate(dateISO);
    const active: Array<{ habit: Habit, schedule: TimeOfDay[] }> = [];
    for (let i = 0; i < state.habits.length; i++) {
        const h = state.habits[i];
        if (shouldHabitAppearOnDate(h, dateISO, dateObj)) {
            const sch = getEffectiveScheduleForHabitOnDate(h, dateISO);
            if (sch.length > 0) active.push({ habit: h, schedule: sch as TimeOfDay[] });
        }
    }
    state.activeHabitsCache.set(dateISO, active);
    return active;
}

/**
 * [PERFORMANCE-CRITICAL & MEMOIZED]
 * Calculates a summary of habit statuses (completed, pending, etc.) for a given day.
 * Results are cached in `state.daySummaryCache`, making repeated calls for the same day O(1)
 * (e.g., from calendar rendering and chart rendering).
 * The cache is invalidated when habit data for that day changes.
 */
export function calculateDaySummary(dateISO: string, preParsedDate?: Date) {
    const cached = state.daySummaryCache.get(dateISO);
    if (cached) return cached;

    let total = 0, completed = 0, snoozed = 0, pending = 0;
    const dateObj = preParsedDate || parseUTCIsoDate(dateISO);

    // Track potentially upgradable habits for the Plus calculation
    const activeHabitsForPlusCheck: { habit: Habit, time: TimeOfDay }[] = [];

    for (let i = 0; i < state.habits.length; i++) {
        const h = state.habits[i];
        if (!shouldHabitAppearOnDate(h, dateISO, dateObj)) continue;
        const sch = getEffectiveScheduleForHabitOnDate(h, dateISO);
        const scheduleProps = getHabitPropertiesForDate(h, dateISO);
        
        for (let j = 0; j < sch.length; j++) {
            const t = sch[j];
            
            // MUDANÇA: Leitura via HabitService (Bitmask Priority)
            const status = HabitService.getStatus(h.id, dateISO, t);
            
            total++;
            
            if (status === HABIT_STATE.DONE || status === HABIT_STATE.DONE_PLUS) {
                completed++;
                // Track habits that track quantity (not simple checks) for intensity increase
                if (scheduleProps && scheduleProps.goal.type !== 'check' && scheduleProps.goal.total) {
                    activeHabitsForPlusCheck.push({ habit: h, time: t });
                }
            } else if (status === HABIT_STATE.DEFERRED) {
                snoozed++;
            } else {
                pending++;
            }
        }
    }
    
    let hasPlus = false;

    // RULE 1: All scheduled habits for today must be completed (100% score)
    if (total > 0 && completed === total) {
        
        // RULE 2: The previous 2 days must also have been perfect (100% score)
        const d1 = toUTCIsoDateString(new Date(dateObj.getTime() - MS_PER_DAY));
        const d2 = toUTCIsoDateString(new Date(dateObj.getTime() - MS_PER_DAY * 2));

        const sum1 = calculateDaySummary(d1);
        const sum2 = calculateDaySummary(d2);

        if (sum1.total > 0 && sum1.completed === sum1.total && 
            sum2.total > 0 && sum2.completed === sum2.total) {
            
            // RULE 3: Progressive Overload
            for (const item of activeHabitsForPlusCheck) {
                const { habit, time } = item;
                const scheduleProps = getHabitPropertiesForDate(habit, dateISO);
                if (!scheduleProps?.goal.total) continue;
                
                // NOTA: Para valores numéricos (Goals), mantemos a leitura legada por enquanto
                const valToday = getCurrentGoalForInstance(habit, dateISO, time);
                const valD1 = getCurrentGoalForInstance(habit, d1, time);
                const valD2 = getCurrentGoalForInstance(habit, d2, time);

                if (valToday > scheduleProps.goal.total && valToday > valD1 && valToday > valD2) {
                    hasPlus = true;
                    break; 
                }
            }
        }
    }
    
    const res = { total, completed, snoozed, pending, completedPercent: total ? (completed / total) * 100 : 0, snoozedPercent: total ? (snoozed / total) * 100 : 0, showPlusIndicator: hasPlus };
    state.daySummaryCache.set(dateISO, res);
    return res;
}