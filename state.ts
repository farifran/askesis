
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file state.ts
 * @description Definição do Estado Global e Estruturas de Dados (Single Source of Truth).
 */

import { addDays, getTodayUTC, getTodayUTCIso, decompressString } from './utils';

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
  sphere: GovernanceSphere;
  level: StoicLevel;
  virtue: StoicVirtue;
  discipline: StoicDiscipline;
  nature: HabitNature;
  conscienceKey: string;
  stoicConcept: string;
  masterQuoteId: string;
}

// --- TYPES & INTERFACES ---
export type HabitStatus = 'completed' | 'snoozed' | 'pending';

export type Frequency =
    | { type: 'daily' }
    | { type: 'interval'; unit: 'days' | 'weeks'; amount: number }
    | { type: 'specific_days_of_week'; days: number[] };

export interface HabitDayData {
    status: HabitStatus;
    goalOverride: number | undefined;
    note: string | undefined;
}

export type HabitDailyInstances = Partial<Record<TimeOfDay, HabitDayData>>;

export interface HabitDailyInfo {
    instances: HabitDailyInstances;
    dailySchedule: TimeOfDay[] | undefined;
}

export interface HabitSchedule {
    startDate: string;
    endDate?: string;
    name?: string;
    subtitle?: string;
    nameKey?: string;
    subtitleKey?: string;
    times: TimeOfDay[];
    frequency: Frequency;
    scheduleAnchor: string;
}

export interface Habit {
    id: string;
    icon: string;
    color: string;
    goal: { 
        type: 'pages' | 'minutes' | 'check'; 
        total?: number; 
        unitKey?: string;
    };
    createdOn: string;
    graduatedOn?: string;
    philosophy?: HabitPhilosophy;
    scheduleHistory: HabitSchedule[];
}

export type PredefinedHabit = {
    nameKey: string;
    subtitleKey: string;
    icon: string;
    color: string;
    times: TimeOfDay[];
    goal: {
        type: 'pages' | 'minutes' | 'check';
        total?: number;
        unitKey: string;
    };
    frequency: Frequency;
    isDefault?: boolean;
    philosophy?: HabitPhilosophy;
};

export type HabitTemplate = {
    icon: string;
    color: string;
    times: TimeOfDay[];
    goal: Habit['goal'];
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
    level: StoicLevel;
    themes: string[];
    timestamp: number;
}

export interface QuoteDisplayState {
    currentId: string;
    displayedAt: number;
    lockedContext: string;
}

export interface AppState {
    version: number;
    lastModified: number;
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    archives: Record<string, string>; 
    dailyDiagnoses: Record<string, DailyStoicDiagnosis>;
    notificationsShown: string[];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
    quoteState?: QuoteDisplayState;
    aiState?: 'idle' | 'loading' | 'completed' | 'error';
    lastAIResult?: string | null;
    lastAIError?: string | null;
    hasSeenAIResult?: boolean;
}

// --- CONSTANTS ---
export const APP_VERSION = 6; 
export const DAYS_IN_CALENDAR = 61;
export const STREAK_SEMI_CONSOLIDATED = 21;
export const STREAK_CONSOLIDATED = 66;
export const STREAK_LOOKBACK_DAYS = 730;

// MEMORY GUARDS: Previne OOM e lentidão em sessões longas.
const MAX_UNARCHIVED_CACHE_SIZE = 3; // Mantém no máximo 3 anos arquivados em memória.
const MAX_SELECTOR_CACHE_SIZE = 365; // Cache de streaks/resumos limitado a 1 ano.

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

const STATUS_TRANSITIONS = Object.freeze({
    pending: 'completed',
    completed: 'snoozed',
    snoozed: 'pending',
} as const);

const _createMonomorphicDailyInfo = (): HabitDailyInfo => ({
    instances: {},
    dailySchedule: undefined
});

const _createMonomorphicInstance = (): HabitDayData => ({
    status: 'pending',
    goalOverride: undefined,
    note: undefined
});

export function getNextStatus(currentStatus: HabitStatus): HabitStatus {
    return STATUS_TRANSITIONS[currentStatus];
}

// --- APPLICATION STATE ---
export const state: {
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    archives: Record<string, string>;
    dailyDiagnoses: Record<string, DailyStoicDiagnosis>;
    unarchivedCache: Map<string, Record<string, Record<string, HabitDailyInfo>>>;
    streaksCache: Map<string, Map<string, number>>;
    habitAppearanceCache: Map<string, Map<string, boolean>>;
    scheduleCache: Map<string, Map<string, HabitSchedule | null>>;
    activeHabitsCache: Map<string, Array<{ habit: Habit; schedule: TimeOfDay[] }>>;
    daySummaryCache: Map<string, any>;
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
    fullCalendar: {
        year: number;
        month: number;
    };
    uiDirtyState: {
        calendarVisuals: boolean;
        habitListStructure: boolean;
        chartData: boolean;
    };
} = {
    habits: [],
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
    fullCalendar: {
        year: new Date().getFullYear(),
        month: new Date().getMonth(),
    },
    uiDirtyState: {
        calendarVisuals: true,
        habitListStructure: true,
        chartData: true,
    }
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
    return {
        version: APP_VERSION,
        lastModified: Date.now(),
        habits: state.habits,
        dailyData: state.dailyData,
        archives: state.archives,
        dailyDiagnoses: state.dailyDiagnoses,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds,
        quoteState: state.quoteState
    };
}

/**
 * CACHE NUKE: Limpa TODOS os caches de renderização e seletores.
 * Essencial após operações de Sincronização ou Restauração de Backup para
 * garantir que a UI reflita os novos dados e não um estado fantasma anterior.
 */
export function resetAllCaches() {
    state.scheduleCache.clear();
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.unarchivedCache.clear();
    
    // Force UI Re-render
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.chartData = true;
}

export function clearScheduleCache() {
    resetAllCaches();
}

export function clearActiveHabitsCache() {
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.uiDirtyState.chartData = true;
}

/**
 * MEMORY GUARD: Evita vazamento de memória em sessões longas.
 */
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
    if (rawArchive && typeof rawArchive === 'string') {
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
