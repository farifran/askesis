
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file state.ts
 * @description Definição do Estado Global e Estruturas de Dados (Single Source of Truth).
 */

import { getTodayUTCIso, decompressString, decompressFromBuffer } from './utils';

// --- ERROR TYPES ---
export class DataLoadingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DataLoadingError";
    }
}

// --- STOIC TAXONOMY ---
export type StoicVirtue = 'Wisdom' | 'Courage' | 'Justice' | 'Temperance';
export type StoicLevel = 1 | 2 | 3;
export type StoicDiscipline = 'Desire' | 'Action' | 'Assent';
export type GovernanceSphere = 'Biological' | 'Structural' | 'Social' | 'Mental';
export type HabitNature = 'Addition' | 'Subtraction';

export interface HabitPhilosophy {
  readonly sphere: GovernanceSphere;
  readonly level: StoicLevel;
  readonly virtue: StoicVirtue;
  readonly discipline: StoicDiscipline;
  readonly nature: HabitNature;
  readonly conscienceKey: string;
  readonly stoicConcept: string;
  readonly masterQuoteId: string;
}

// --- TYPES & INTERFACES ---

export type Frequency =
    | { readonly type: 'daily' }
    | { readonly type: 'interval'; readonly unit: 'days' | 'weeks'; readonly amount: number }
    | { readonly type: 'specific_days_of_week'; readonly days: readonly number[] };

export interface HabitDayData {
    goalOverride?: number;
    note?: string;
}

export type HabitDailyInstances = Partial<Record<TimeOfDay, HabitDayData>>;

export interface HabitDailyInfo {
    instances: HabitDailyInstances;
    dailySchedule: TimeOfDay[] | undefined;
}

export interface HabitGoal { 
    readonly type: 'pages' | 'minutes' | 'check'; 
    readonly total?: number; 
    readonly unitKey?: string;
}

export interface HabitSchedule {
    readonly startDate: string;
    endDate?: string; 
    readonly icon: string;
    readonly color: string;
    readonly goal: HabitGoal;
    readonly philosophy?: HabitPhilosophy;
    readonly name?: string;
    readonly subtitle?: string;
    readonly nameKey?: string;
    readonly subtitleKey?: string;
    readonly times: readonly TimeOfDay[];
    readonly frequency: Frequency;
    readonly scheduleAnchor: string;
}

export interface Habit {
    readonly id: string;
    createdOn: string; 
    graduatedOn?: string; 
    scheduleHistory: HabitSchedule[];
}

export type PredefinedHabit = {
    readonly nameKey: string;
    readonly subtitleKey: string;
    readonly icon: string;
    readonly color: string;
    readonly times: readonly TimeOfDay[];
    readonly goal: HabitGoal;
    readonly frequency: Frequency;
    readonly isDefault?: boolean;
    readonly philosophy?: HabitPhilosophy;
};

export type HabitTemplate = {
    icon: string;
    color: string;
    times: TimeOfDay[];
    goal: HabitGoal;
    frequency: Frequency;
    philosophy?: HabitPhilosophy;
} & ({
    nameKey: string;
    subtitleKey: string;
    name?: never;
    subtitle?: never;
} | {
    name: string;
    subtitleKey: string;
    nameKey?: never;
    subtitle?: never;
});

export interface DailyStoicDiagnosis {
    readonly level: StoicLevel;
    readonly themes: readonly string[];
    readonly timestamp: number;
}

export interface QuoteDisplayState {
    readonly currentId: string;
    readonly displayedAt: number;
    readonly lockedContext: string;
}

export interface DaySummary {
    readonly total: number;
    readonly completed: number;
    readonly snoozed: number;
    readonly pending: number;
    readonly completedPercent: number;
    readonly snoozedPercent: number;
    readonly showPlusIndicator: boolean;
}

// --- BITMASK STRUCTURES ---
export const PERIOD_OFFSET = { Morning: 0, Afternoon: 2, Evening: 4 } as const;
export const HABIT_STATE = { NULL: 0, DONE: 1, DEFERRED: 2, DONE_PLUS: 3 } as const;

export interface MonthlyHabitLog {
    habitId: string;
    monthKey: string; 
    data: bigint;     
}

export interface AppState {
    readonly version: number;
    lastModified: number; 
    readonly habits: readonly Habit[];
    readonly dailyData: Readonly<Record<string, Readonly<Record<string, HabitDailyInfo>>>>;
    readonly archives: Readonly<Record<string, string | Uint8Array>>; 
    readonly dailyDiagnoses: Readonly<Record<string, DailyStoicDiagnosis>>;
    readonly notificationsShown: readonly string[];
    readonly pending21DayHabitIds: readonly string[];
    readonly pendingConsolidationHabitIds: readonly string[];
    readonly quoteState?: QuoteDisplayState;
    monthlyLogs?: Map<string, bigint>;
}

// --- CONSTANTS ---
export const APP_VERSION = 7; 
export const STREAK_SEMI_CONSOLIDATED = 21;
export const STREAK_CONSOLIDATED = 66;
export const STREAK_LOOKBACK_DAYS = 730;

const MAX_UNARCHIVED_CACHE_SIZE = 3; 
const MAX_SELECTOR_CACHE_SIZE = 365; 

export const TIMES_OF_DAY = ['Morning', 'Afternoon', 'Evening'] as const;
export type TimeOfDay = typeof TIMES_OF_DAY[number];

export const LANGUAGES = [
    { code: 'pt', nameKey: 'langPortuguese' },
    { code: 'en', nameKey: 'langEnglish' },
    { code: 'es', nameKey: 'langSpanish' }
] as const;
export type Language = typeof LANGUAGES[number];

export const FREQUENCIES = [
    { labelKey: 'freqDaily', value: { type: 'daily' } },
    { labelKey: 'freqEvery', value: { type: 'interval', unit: 'days', amount: 2 } },
    { labelKey: 'freqSpecificDaysOfWeek', value: { type: 'specific_days_of_week', days: [] } }
] as const;

const _createMonomorphicDailyInfo = (): HabitDailyInfo => ({
    instances: {},
    dailySchedule: undefined
});

const _createMonomorphicInstance = (): HabitDayData => ({
    goalOverride: undefined,
    note: undefined
});

// --- APPLICATION STATE ---
export const state: {
    habits: Habit[];
    lastModified: number;
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    archives: Record<string, string | Uint8Array>;
    dailyDiagnoses: Record<string, DailyStoicDiagnosis>;
    unarchivedCache: Map<string, Record<string, Record<string, HabitDailyInfo>>>;
    streaksCache: Map<string, Map<string, number>>;
    habitAppearanceCache: Map<string, Map<string, boolean>>;
    scheduleCache: Map<string, Map<string, HabitSchedule | null>>;
    activeHabitsCache: Map<string, Array<{ habit: Habit; schedule: TimeOfDay[] }>>;
    daySummaryCache: Map<string, DaySummary>;
    calendarDates: Date[];
    selectedDate: string;
    activeLanguageCode: Language['code'];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
    notificationsShown: string[];
    confirmAction: (() => void) | null;
    confirmEditAction: (() => void) | null;
    editingNoteFor: { habitId: string; date: string; time: TimeOfDay; } | null;
    editingHabit: {
        isNew: boolean;
        habitId?: string;
        originalData?: Habit;
        formData: HabitTemplate;
        targetDate: string;
    } | null;
    quoteState?: QuoteDisplayState;
    aiState: 'idle' | 'loading' | 'completed' | 'error';
    aiReqId: number;
    hasSeenAIResult: boolean;
    lastAIResult: string | null;
    lastAIError: string | null;
    syncState: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial';
    syncLastError: string | null;
    fullCalendar: {
        year: number;
        month: number;
    };
    uiDirtyState: {
        calendarVisuals: boolean;
        habitListStructure: boolean;
        chartData: boolean;
    };
    monthlyLogs: Map<string, bigint>;
} = {
    habits: [],
    lastModified: Date.now(),
    dailyData: {},
    archives: {},
    dailyDiagnoses: {},
    unarchivedCache: new Map(),
    streaksCache: new Map(),
    habitAppearanceCache: new Map(),
    scheduleCache: new Map(),
    activeHabitsCache: new Map(),
    daySummaryCache: new Map(),
    calendarDates: [],
    selectedDate: getTodayUTCIso(),
    activeLanguageCode: 'pt',
    pending21DayHabitIds: [],
    pendingConsolidationHabitIds: [],
    notificationsShown: [],
    confirmAction: null,
    confirmEditAction: null,
    editingNoteFor: null,
    editingHabit: null,
    quoteState: undefined,
    aiState: 'idle',
    aiReqId: 0,
    hasSeenAIResult: true,
    lastAIResult: null,
    lastAIError: null,
    syncState: 'syncInitial',
    syncLastError: null,
    fullCalendar: {
        year: new Date().getFullYear(),
        month: new Date().getMonth(),
    },
    uiDirtyState: {
        calendarVisuals: true,
        habitListStructure: true,
        chartData: true,
    },
    monthlyLogs: new Map<string, bigint>(),
};

// --- CACHE MANAGEMENT ---
export function isChartDataDirty(): boolean {
    const wasDirty = state.uiDirtyState.chartData;
    if (wasDirty) state.uiDirtyState.chartData = false;
    return wasDirty;
}

export function invalidateChartCache() {
    state.uiDirtyState.chartData = true;
}

export function getPersistableState(): AppState {
    // MONOTONIC CLOCK LOGIC: Ensure lastModified always moves forward.
    // If the system clock is behind the last known state (due to clock skew or device switch),
    // we increment manually to guarantee the server accepts the update as newer.
    const now = Date.now();
    if (now > state.lastModified) {
        state.lastModified = now;
    } else {
        state.lastModified = state.lastModified + 1;
    }

    return {
        version: APP_VERSION,
        lastModified: state.lastModified,
        habits: state.habits,
        dailyData: state.dailyData,
        archives: state.archives,
        dailyDiagnoses: state.dailyDiagnoses,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds,
        quoteState: state.quoteState,
    };
}

export function clearScheduleCache() {
    state.scheduleCache.clear();
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.uiDirtyState.chartData = true;
}

export function clearActiveHabitsCache() {
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.uiDirtyState.chartData = true;
}

function pruneSelectorCaches() {
    if (state.daySummaryCache.size > MAX_SELECTOR_CACHE_SIZE) {
        clearActiveHabitsCache();
    }
}

export function invalidateCachesForDateChange(dateISO: string, habitIds: string[]) {
    state.uiDirtyState.chartData = true;
    state.daySummaryCache.delete(dateISO);
    for (const id of habitIds) {
        state.streaksCache.delete(id);
    }
}

const EMPTY_DAILY_INFO = Object.freeze({});

function _enforceCacheLimit(exemptKey?: string) {
    if (state.unarchivedCache.size > MAX_UNARCHIVED_CACHE_SIZE) {
        for (const k of state.unarchivedCache.keys()) {
            if (k !== exemptKey && !k.endsWith('_pending')) {
                state.unarchivedCache.delete(k);
                return;
            }
        }
    }
}

export function isDateLoading(date: string): boolean {
    return state.unarchivedCache.has(`${date.substring(0, 4)}_pending`);
}

export function getHabitDailyInfoForDate(date: string): Record<string, HabitDailyInfo> {
    pruneSelectorCaches();
    const hotData = state.dailyData[date];
    if (hotData) return hotData;

    const year = date.substring(0, 4);
    const cachedYear = state.unarchivedCache.get(year);
    if (cachedYear) {
        state.unarchivedCache.delete(year);
        state.unarchivedCache.set(year, cachedYear);
        return cachedYear[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
    }

    const rawArchive = state.archives[year];
    if (rawArchive) {
        if (rawArchive instanceof Uint8Array) {
            const pendingKey = `${year}_pending`;
            if (!state.unarchivedCache.has(pendingKey)) {
                state.unarchivedCache.set(pendingKey, {});
                decompressFromBuffer(rawArchive).then(json => {
                    try {
                        const parsedYearData = JSON.parse(json);
                        _enforceCacheLimit(pendingKey);
                        state.unarchivedCache.set(year, parsedYearData);
                        state.unarchivedCache.delete(pendingKey);
                        document.dispatchEvent(new CustomEvent('render-app'));
                    } catch {
                        state.unarchivedCache.set(year, {}); 
                        state.unarchivedCache.delete(pendingKey);
                    }
                }).catch(() => {
                    state.unarchivedCache.set(year, {}); 
                    state.unarchivedCache.delete(pendingKey);
                });
            }
            return (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
        }
        
        else if (typeof rawArchive === 'string') {
            if (rawArchive.startsWith('GZIP:')) {
                const pendingKey = `${year}_pending`;
                if (!state.unarchivedCache.has(pendingKey)) {
                    state.unarchivedCache.set(pendingKey, {});
                    decompressString(rawArchive.substring(5)).then(json => {
                        try {
                            const parsedYearData = JSON.parse(json);
                            _enforceCacheLimit(pendingKey);
                            state.unarchivedCache.set(year, parsedYearData);
                            state.unarchivedCache.delete(pendingKey);
                            document.dispatchEvent(new CustomEvent('render-app'));
                        } catch {
                            state.unarchivedCache.set(year, {}); 
                            state.unarchivedCache.delete(pendingKey);
                        }
                    }).catch(() => {
                        state.unarchivedCache.set(year, {}); 
                        state.unarchivedCache.delete(pendingKey);
                    });
                }
                return (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
            } else {
                try {
                    const parsedYearData = JSON.parse(rawArchive);
                    _enforceCacheLimit(year);
                    state.unarchivedCache.set(year, parsedYearData);
                    return parsedYearData[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
                } catch {
                    console.error(`Error parsing legacy archive for ${year}`);
                }
            }
        }
    }
    return (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
}

export function ensureHabitDailyInfo(date: string, habitId: string): HabitDailyInfo {
    if (isDateLoading(date)) {
        throw new DataLoadingError(`Data for ${date} is hydrating.`);
    }

    if (!Object.prototype.hasOwnProperty.call(state.dailyData, date)) {
        const archivedDay = getHabitDailyInfoForDate(date);
        if (archivedDay !== EMPTY_DAILY_INFO) {
            state.dailyData[date] = structuredClone(archivedDay);
        } else {
            if (isDateLoading(date)) throw new DataLoadingError(`Hydration triggered.`);
            state.dailyData[date] = {};
        }
    }

    const dayData = state.dailyData[date];
    if (!dayData[habitId]) {
        dayData[habitId] = _createMonomorphicDailyInfo();
    }
    return dayData[habitId];
}

export function ensureHabitInstanceData(date: string, habitId: string, time: TimeOfDay): HabitDayData {
    const habitInfo = ensureHabitDailyInfo(date, habitId);
    if (!habitInfo.instances[time]) {
        habitInfo.instances[time] = _createMonomorphicInstance();
    }
    return habitInfo.instances[time]!;
}
