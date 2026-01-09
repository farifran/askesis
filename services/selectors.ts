/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, Habit, TimeOfDay, HabitSchedule, getHabitDailyInfoForDate, STREAK_LOOKBACK_DAYS, PredefinedHabit } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, MS_PER_DAY, getTodayUTCIso } from '../utils';
import { t } from '../i18n';

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

export function getScheduleForDate(habit: Habit, dateISO: string): HabitSchedule | null {
    let subCache = state.scheduleCache.get(habit.id);
    if (!subCache) {
        subCache = new Map();
        state.scheduleCache.set(habit.id, subCache);
    }
    
    const cached = subCache.get(dateISO);
    if (cached !== undefined) return cached;
    
    const history = habit.scheduleHistory;
    let schedule: HabitSchedule | null = null;

    for (let i = 0; i < history.length; i++) {
        const s = history[i];
        if (dateISO >= s.startDate && (!s.endDate || dateISO < s.endDate)) {
            schedule = s;
            break;
        }
    }

    subCache.set(dateISO, schedule);
    return schedule;
}

export function getHabitDisplayInfo(habit: Habit | PredefinedHabit, dateISO?: string): { name: string, subtitle: string } {
    let source: any = habit;
    if ('scheduleHistory' in habit && habit.scheduleHistory.length > 0) {
        const sched = dateISO ? getScheduleForDate(habit as Habit, dateISO) : null;
        source = sched || habit.scheduleHistory[habit.scheduleHistory.length - 1];
    }
    return {
        name: source.nameKey ? t(source.nameKey) : (source.name || ''),
        subtitle: source.subtitleKey ? t(source.subtitleKey) : (source.subtitle || '')
    };
}

export function getEffectiveScheduleForHabitOnDate(habit: Habit, dateISO: string): TimeOfDay[] {
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    return dailyInfo?.dailySchedule || getScheduleForDate(habit, dateISO)?.times || [];
}

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
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    if (!dailyInfo) return false;
    for (let i = 0; i < schedule.length; i++) {
        const status = dailyInfo.instances[schedule[i]]?.status;
        if (status !== 'completed' && status !== 'snoozed') return false;
    }
    return true;
}

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
    if (habit.goal.type === 'check' || !habit.goal.total) return 1;
    const dailyInfo = getHabitDailyInfoForDate(dateISO)[habit.id];
    if (dailyInfo?.instances[time]?.goalOverride !== undefined) return dailyInfo.instances[time].goalOverride!;
    
    const baseGoal = habit.goal.total;
    const targetTs = parseUTCIsoDate(dateISO).getTime();
    let validIncreases = 0;
    let minIncrease = 999999;
    const iterDate = new Date();

    for (let i = 1; i <= 3; i++) {
        iterDate.setTime(targetTs - (MS_PER_DAY * i));
        const past = getHabitDailyInfoForDate(toUTCIsoDateString(iterDate))[habit.id]?.instances?.[time];
        if (past?.status === 'completed') {
            const val = past.goalOverride ?? baseGoal;
            if (val > baseGoal) {
                validIncreases++;
                if (val < minIncrease) minIncrease = val;
            } else break;
        } else break;
    }

    if (validIncreases === 3) return minIncrease;
    const streak = calculateHabitStreak(habit, toUTCIsoDateString(new Date(targetTs - MS_PER_DAY)));
    return Math.max(5, baseGoal + (Math.floor(streak / 7) * 5));
}

export function getCurrentGoalForInstance(habit: Habit, dateISO: string, time: TimeOfDay): number {
    return getHabitDailyInfoForDate(dateISO)[habit.id]?.instances[time]?.goalOverride ?? getSmartGoalForHabit(habit, dateISO, time);
}

export function getActiveHabitsForDate(dateISO: string, preParsedDate?: Date): Array<{ habit: Habit, schedule: TimeOfDay[] }> {
    const cached = state.activeHabitsCache.get(dateISO);
    if (cached) return cached;
    const dateObj = preParsedDate || parseUTCIsoDate(dateISO);
    const active: Array<{ habit: Habit, schedule: TimeOfDay[] }> = [];
    for (let i = 0; i < state.habits.length; i++) {
        const h = state.habits[i];
        if (shouldHabitAppearOnDate(h, dateISO, dateObj)) {
            const sch = getEffectiveScheduleForHabitOnDate(h, dateISO);
            if (sch.length > 0) active.push({ habit: h, schedule: sch });
        }
    }
    state.activeHabitsCache.set(dateISO, active);
    return active;
}

export function calculateDaySummary(dateISO: string, preParsedDate?: Date) {
    const cached = state.daySummaryCache.get(dateISO);
    if (cached) return cached;

    let total = 0, completed = 0, snoozed = 0, pending = 0, hasPlus = false;
    const dayData = getHabitDailyInfoForDate(dateISO);
    const dateObj = preParsedDate || parseUTCIsoDate(dateISO);

    for (let i = 0; i < state.habits.length; i++) {
        const h = state.habits[i];
        if (!shouldHabitAppearOnDate(h, dateISO, dateObj)) continue;
        const sch = getEffectiveScheduleForHabitOnDate(h, dateISO);
        const info = dayData[h.id];
        for (let j = 0; j < sch.length; j++) {
            const t = sch[j];
            const status = info?.instances[t]?.status || 'pending';
            total++;
            if (status === 'completed') {
                completed++;
                if (h.goal.type !== 'check' && h.goal.total) {
                    if (getCurrentGoalForInstance(h, dateISO, t) > h.goal.total && calculateHabitStreak(h, toUTCIsoDateString(new Date(dateObj.getTime() - MS_PER_DAY))) >= 2) hasPlus = true;
                }
            } else if (status === 'snoozed') snoozed++;
            else pending++;
        }
    }
    
    const res = { total, completed, snoozed, pending, completedPercent: total ? (completed / total) * 100 : 0, snoozedPercent: total ? (snoozed / total) * 100 : 0, showPlusIndicator: hasPlus };
    state.daySummaryCache.set(dateISO, res);
    return res;
}

export function isHabitNameDuplicate(name: string, currentHabitId?: string): boolean {
    const norm = name.trim().toLowerCase();
    if (!norm) return false;
    const today = getTodayUTCIso();
    for (let i = 0; i < state.habits.length; i++) {
        const h = state.habits[i];
        if (h.id !== currentHabitId && getHabitDisplayInfo(h, today).name.trim().toLowerCase() === norm) return true;
    }
    return false;
}
