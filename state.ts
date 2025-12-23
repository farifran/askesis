
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [2025-02-23]: Implementado "Cold Storage" (Arquivamento) para otimização de performance de longo prazo.
// [2025-02-23]: Arquitetura Desacoplada. 'state.ts' não depende mais de 'cloud.ts'.
// [2025-03-12]: Dados estáticos (PREDEFINED_HABITS) movidos para 'data/predefinedHabits.ts'.
// [2025-03-12]: Lógica de persistência movida para 'services/persistence.ts'.

import { addDays, getTodayUTC, getTodayUTCIso } from './utils';

// --- TYPES & INTERFACES ---
export type HabitStatus = 'completed' | 'snoozed' | 'pending';

export type Frequency =
    | { type: 'daily' }
    | { type: 'interval'; unit: 'days' | 'weeks'; amount: number }
    | { type: 'specific_days_of_week'; days: number[] }; // Sun=0, Mon=1, ...

export interface HabitDayData {
    status: HabitStatus;
    goalOverride?: number;
    note?: string;
}

export type HabitDailyInstances = Partial<Record<TimeOfDay, HabitDayData>>;

// The data for a single habit on a single day
export interface HabitDailyInfo {
    instances: HabitDailyInstances;
    dailySchedule?: TimeOfDay[]; // Override for habit.times for this day
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
};

/**
 * Represents the data needed to create a new habit.
 * It can be a predefined habit (identified by nameKey) or a custom one (identified by name).
 */
export type HabitTemplate = {
    icon: string;
    color: string;
    times: TimeOfDay[];
    goal: Habit['goal'];
    frequency: Frequency;
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


// Nova interface para o estado completo da aplicação
export interface AppState {
    version: number;
    lastModified: number;
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>; // HOT STORAGE (Last 90 days)
    archives: Record<string, string>; // COLD STORAGE: Key="YYYY", Value=JSON String of dailyData. Optimized for parsing speed.
    notificationsShown: string[];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
    // Propriedades do estado da IA
    aiState?: 'idle' | 'loading' | 'completed' | 'error';
    lastAIResult?: string | null;
    lastAIError?: string | null;
    hasSeenAIResult?: boolean;
}


// --- CONSTANTS ---
export const STATE_STORAGE_KEY = 'habitTrackerState_v1';
export const APP_VERSION = 6; // Increased version for scheduleHistory refactor
export const DAYS_IN_CALENDAR = 61;
export const STREAK_SEMI_CONSOLIDATED = 21;
export const STREAK_CONSOLIDATED = 66;
// CONSTANT [2025-02-23]: Limit for streak calculation lookback (2 years).
export const STREAK_LOOKBACK_DAYS = 730;

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

// --- HELPERS ---
export function getNextStatus(currentStatus: HabitStatus): HabitStatus {
    const transitions: Record<HabitStatus, HabitStatus> = {
        pending: 'completed',
        completed: 'snoozed',
        snoozed: 'pending',
    };
    return transitions[currentStatus];
}

// --- APPLICATION STATE ---
export const state: {
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>; // HOT STORAGE (Last 90 days)
    archives: Record<string, string>; // COLD STORAGE (JSON Strings)
    // RUNTIME CACHE [2025-02-23]: Holds parsed archive data in memory to avoid repetitive JSON.parse.
    // Key: Year (e.g., "2023"), Value: Parsed daily data map.
    unarchivedCache: Map<string, Record<string, Record<string, HabitDailyInfo>>>;
    
    // PERFORMANCE [2025-03-15]: Nested Maps for O(1) access without string allocation overhead.
    // Structure: Map<HabitID, Map<DateISO, Value>>
    streaksCache: Map<string, Map<string, number>>;
    habitAppearanceCache: Map<string, Map<string, boolean>>;
    scheduleCache: Map<string, Map<string, HabitSchedule | null>>;
    
    // Flat caches (Key: DateISO)
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
        habitId?: string; // For existing habits
        originalData?: Habit; // For comparing changes
        // A template-like object for the form
        formData: HabitTemplate;
        targetDate: string; // [2025-02-04] Snapshot of the date being edited to prevent context drift
    } | null;
    aiState: 'idle' | 'loading' | 'completed' | 'error';
    hasSeenAIResult: boolean;
    lastAIResult: string | null;
    lastAIError: string | null;
    syncState: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial';
    fullCalendar: {
        year: number;
        month: number;
    };
    // PERFORMANCE [2025-01-26]: Dirty flags para controle granular de renderização UI.
    uiDirtyState: {
        calendarVisuals: boolean; // Verdadeiro se a seleção de data ou o intervalo de dias mudou.
        habitListStructure: boolean; // Verdadeiro se a ordem, quantidade ou conteúdo textual dos hábitos mudou.
        chartData: boolean;
    };
} = {
    habits: [],
    dailyData: {},
    archives: {},
    unarchivedCache: new Map(),
    streaksCache: new Map(),
    habitAppearanceCache: new Map(),
    scheduleCache: new Map(),
    activeHabitsCache: new Map(),
    daySummaryCache: new Map(),
    // LOGIC UPDATE [2025-02-05]: Calendar range centered on today (30 past + Today + 30 future).
    // i=30 corresponds to Today (addDays(Today, 0)).
    calendarDates: Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => addDays(getTodayUTC(), i - 30)),
    selectedDate: getTodayUTCIso(),
    activeLanguageCode: 'pt',
    pending21DayHabitIds: [],
    pendingConsolidationHabitIds: [],
    notificationsShown: [],
    confirmAction: null,
    confirmEditAction: null,
    editingNoteFor: null,
    editingHabit: null,
    aiState: 'idle',
    hasSeenAIResult: true,
    lastAIResult: null,
    lastAIError: null,
    syncState: 'syncInitial',
    fullCalendar: {
        year: new Date().getFullYear(),
        month: new Date().getMonth(),
    },
    // PERFORMANCE: Inicializa como true para garantir a primeira renderização completa.
    uiDirtyState: {
        calendarVisuals: true,
        habitListStructure: true,
        chartData: true,
    }
};

// --- CACHE MANAGEMENT ---
export function isChartDataDirty(): boolean {
    const wasDirty = state.uiDirtyState.chartData;
    if (wasDirty) {
        state.uiDirtyState.chartData = false; // Consome a flag
    }
    return wasDirty;
}

// FIX: Add and export missing invalidateChartCache function to manage chart UI state.
export function invalidateChartCache() {
    state.uiDirtyState.chartData = true;
}

/**
 * REFACTOR [2025-03-04]: Centralized AppState Snapshot.
 * Creates a clean, persistable object from the current runtime state.
 * Eliminates duplication across saveState, exportData, and cloud sync logic (DRY Principle).
 */
export function getPersistableState(): AppState {
    return {
        version: APP_VERSION,
        lastModified: Date.now(),
        habits: state.habits,
        dailyData: state.dailyData,
        archives: state.archives,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds
    };
}

/**
 * REFACTOR [2025-03-05]: Invalidação de Cache Unificada.
 * Limpa todos os caches que dependem do histórico de agendamento.
 */
export function clearScheduleCache() {
    state.scheduleCache.clear();
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.uiDirtyState.chartData = true;
}

/**
 * REFACTOR [2025-03-05]: Invalidação de Cache de Visão.
 * Limpa caches que afetam a visualização diária, mas não o histórico de agendamento.
 */
export function clearActiveHabitsCache() {
    state.activeHabitsCache.clear();
    state.habitAppearanceCache.clear();
    state.streaksCache.clear();
    state.daySummaryCache.clear();
    state.uiDirtyState.chartData = true;
}


/**
 * DRY REFACTOR: Centralizes cache invalidation for daily data changes.
 */
export function invalidateCachesForDateChange(dateISO: string, habitIds: string[]) {
    state.uiDirtyState.chartData = true;
    state.daySummaryCache.delete(dateISO);
    
    habitIds.forEach(id => {
        // BUGFIX [2025-03-15]: Streak Integrity.
        // Changing a past or present status can affect streak calculations for all future dates.
        // We must invalidate the ENTIRE streak cache for this habit, not just the current day.
        state.streaksCache.delete(id);
    });
}

// GC OPTIMIZATION [2025-01-23]: Singleton empty object for daily info.
const EMPTY_DAILY_INFO = Object.freeze({});

/**
 * LAZY LOADING ACCESSOR [2025-02-23]:
 * Retrieves daily data for a specific date. 
 * 1. Checks HOT STORAGE (`dailyData`).
 * 2. If missing, checks if it exists in COLD STORAGE (`archives`).
 * 3. If in cold storage, lazy-parses the year chunk into memory cache (`unarchivedCache`).
 */
export function getHabitDailyInfoForDate(date: string): Record<string, HabitDailyInfo> {
    // 1. Check Hot Storage (Fastest)
    if (state.dailyData[date]) {
        return state.dailyData[date];
    }

    // 2. Check Archive
    const year = date.substring(0, 4);
    
    // Check if we already unarchived this year in this session
    if (state.unarchivedCache.has(year)) {
        const yearData = state.unarchivedCache.get(year)!;
        return yearData[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
    }

    // Check if it exists in the raw archive strings
    if (state.archives[year]) {
        try {
            console.log(`Lazy loading archive for year ${year}...`);
            const parsedYearData = JSON.parse(state.archives[year]) as Record<string, Record<string, HabitDailyInfo>>;
            // Cache it in memory for subsequent accesses
            state.unarchivedCache.set(year, parsedYearData);
            return parsedYearData[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
        } catch (e) {
            console.error(`Error parsing archive for ${year}`, e);
        }
    }

    return (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
}

/**
 * REATORAÇÃO [2024-10-04]: Nova função auxiliar para centralizar a criação do objeto HabitDailyInfo,
 * seguindo o mesmo padrão de ensureHabitInstanceData para consistência e robustez.
 * Garante que a estrutura de dados diários para um hábito exista e retorna uma referência direta a ela.
 */
export function ensureHabitDailyInfo(date: string, habitId: string): HabitDailyInfo {
    // If the data is archived, we must move it back to HOT storage to allow editing.
    // getHabitDailyInfoForDate returns a reference, but if it came from archive cache, modifying it implies updating the cache but not the state.dailyData.
    // For consistency, we "thaw" the day into dailyData.
    
    if (!state.dailyData[date]) {
        // Check if we have it in archives
        const archivedDay = getHabitDailyInfoForDate(date);
        
        if (archivedDay !== EMPTY_DAILY_INFO) {
            // Thaw: Copy from archive to hot storage
            // MODERNIZATION [2025-03-08]: Use structuredClone instead of JSON.parse/stringify for better performance.
            state.dailyData[date] = structuredClone(archivedDay);
        } else {
            // New day
            state.dailyData[date] = {};
        }
    }

    state.dailyData[date][habitId] ??= { instances: {} };
    return state.dailyData[date][habitId];
}

export function ensureHabitInstanceData(date: string, habitId: string, time: TimeOfDay): HabitDayData {
    // Ensure day exists in HOT storage
    ensureHabitDailyInfo(date, habitId);
    
    state.dailyData[date][habitId].instances[time] ??= { status: 'pending' };
    return state.dailyData[date][habitId].instances[time]!;
}
