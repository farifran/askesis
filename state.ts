
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file state.ts
 * @description Definição do Estado Global e Estruturas de Dados (Single Source of Truth).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo reside na thread principal e mantém o objeto de estado mutável.
 * 
 * ARQUITETURA (Mutable Singleton & Hierarchical Storage):
 * - **Cold Storage Compression:** Suporte a arquivos comprimidos GZIP.
 * - **Lazy Async Hydration:** Se um arquivo comprimido for solicitado, o sistema retorna um objeto vazio
 *   enquanto dispara a descompressão em background, re-renderizando a UI quando pronto.
 * - **V8 Optimization (Monomorphism):** Uso estrito de Factories para garantir formas de objeto estáveis.
 * - **LRU Cache Protection:** Gerenciamento de memória para evitar OOM em sessões longas.
 */

import { addDays, getTodayUTC, getTodayUTCIso, decompressString } from './utils';

// --- TYPES & INTERFACES ---
export type HabitStatus = 'completed' | 'snoozed' | 'pending';

export type Frequency =
    | { type: 'daily' }
    | { type: 'interval'; unit: 'days' | 'weeks'; amount: number }
    | { type: 'specific_days_of_week'; days: number[] }; // Sun=0, Mon=1, ...

// PERF: Shape Stability Interface
// Todas as instâncias devem ter TODAS as chaves inicializadas (mesmo undefined)
// para garantir Monomorfismo no V8.
export interface HabitDayData {
    status: HabitStatus;
    goalOverride: number | undefined; // Smi (Small Integer) preferred
    note: string | undefined;
}

export type HabitDailyInstances = Partial<Record<TimeOfDay, HabitDayData>>;

// The data for a single habit on a single day
export interface HabitDailyInfo {
    instances: HabitDailyInstances;
    dailySchedule: TimeOfDay[] | undefined; // Override for habit.times for this day
}

// CRITICAL LOGIC: Time-Travel Structure.
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
    // Histórico linear ordenado cronologicamente. O último item é o estado "atual".
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
    // PERFORMANCE: Hot Storage. Acesso direto O(1).
    dailyData: Record<string, Record<string, HabitDailyInfo>>; // HOT STORAGE (Last 90 days)
    // PERFORMANCE: Cold Storage. GZIP Strings (Prefix: "GZIP:") or Legacy JSON Strings.
    archives: Record<string, string>; 
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
// PERF: Bitwise compatible integers where possible.
export const APP_VERSION = 6; 
export const DAYS_IN_CALENDAR = 61;
export const STREAK_SEMI_CONSOLIDATED = 21;
export const STREAK_CONSOLIDATED = 66;
export const STREAK_LOOKBACK_DAYS = 730;
// MEMORY GUARD: Limit unarchived years in memory to prevent OOM on mobile.
// Mantém ~3 anos de histórico em memória + ano atual. O resto é evictado.
const MAX_UNARCHIVED_CACHE_SIZE = 3;

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

// --- V8 OPTIMIZATION HELPERS ---

// PERF: Static Lookup Table (Frozen) for O(1) transitions.
// Eliminates object allocation on every function call.
const STATUS_TRANSITIONS = Object.freeze({
    pending: 'completed',
    completed: 'snoozed',
    snoozed: 'pending',
} as const);

// PERF: Monomorphic Factory for HabitDailyInfo.
// Ensures all objects have the exact same hidden class by initializing all fields.
const _createMonomorphicDailyInfo = (): HabitDailyInfo => ({
    instances: {},
    dailySchedule: undefined
});

// PERF: Monomorphic Factory for HabitDayData.
// Critical: Pre-allocates optional fields as undefined to prevent
// hidden class transitions when these fields are set later.
const _createMonomorphicInstance = (): HabitDayData => ({
    status: 'pending',
    goalOverride: undefined,
    note: undefined
});

// --- HELPERS ---
export function getNextStatus(currentStatus: HabitStatus): HabitStatus {
    // PERF: Fast LUT access.
    return STATUS_TRANSITIONS[currentStatus];
}

// --- APPLICATION STATE ---
export const state: {
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>; // HOT STORAGE (Last 90 days)
    archives: Record<string, string>; // COLD STORAGE (GZIP/JSON Strings)
    // RUNTIME CACHE [2025-02-23]: Holds parsed archive data in memory.
    unarchivedCache: Map<string, Record<string, Record<string, HabitDailyInfo>>>;
    
    // PERFORMANCE [2025-03-15]: Nested Maps for O(1) access.
    streaksCache: Map<string, Map<string, number>>;
    habitAppearanceCache: Map<string, Map<string, boolean>>;
    scheduleCache: Map<string, Map<string, HabitSchedule | null>>;
    
    // Flat caches
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
    aiState: 'idle' | 'loading' | 'completed' | 'error';
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
    unarchivedCache: new Map(),
    streaksCache: new Map(),
    habitAppearanceCache: new Map(),
    scheduleCache: new Map(),
    activeHabitsCache: new Map(),
    daySummaryCache: new Map(),
    // PERF: Pre-allocate array size? Not worth for dynamic resizing logic, kept standard.
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
        state.uiDirtyState.chartData = false;
    }
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
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds
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

export function invalidateCachesForDateChange(dateISO: string, habitIds: string[]) {
    state.uiDirtyState.chartData = true;
    state.daySummaryCache.delete(dateISO);
    
    // Optimized Loop: forEach is slightly slower than for..of but mostly negligible for small arrays.
    for (const id of habitIds) {
        state.streaksCache.delete(id);
    }
}

// PERF: Freeze empty object to ensure reference equality checks pass quickly
const EMPTY_DAILY_INFO = Object.freeze({});

/**
 * Checks if the data for a given date is ready to be written to.
 * Returns true if the data is currently being fetched (decompressing) from archives.
 * Used to prevent race conditions where a write operation could overwrite archived data
 * that hasn't been loaded yet.
 */
export function isDateLoading(date: string): boolean {
    const year = date.substring(0, 4);
    const pendingKey = `${year}_pending`;
    // If it's archiving (pending key exists), it's not ready.
    if (state.unarchivedCache.has(pendingKey)) return true;
    
    return false;
}

/**
 * LAZY LOADING ACCESSOR [2025-02-23]:
 * Recupera dados diários com suporte a GZIP Async.
 * 
 * CRITICAL LOGIC: Lazy Hydration & LRU Protection.
 * Se o arquivo estiver comprimido, dispara a descompressão.
 * Implementa LRU (Least Recently Used) para evitar vazamento de memória.
 */
export function getHabitDailyInfoForDate(date: string): Record<string, HabitDailyInfo> {
    // 1. Check Hot Storage (Fastest)
    const hotData = state.dailyData[date];
    if (hotData) {
        return hotData;
    }

    // 2. Check Archive
    // PERF: Substring is faster than date parsing
    const year = date.substring(0, 4);
    
    // Warm Cache (Memory)
    const cachedYear = state.unarchivedCache.get(year);
    if (cachedYear) {
        // LRU Promotion: Move accessed year to end (most recent)
        // Deleting and re-setting moves it to the end of Map iteration order
        state.unarchivedCache.delete(year);
        state.unarchivedCache.set(year, cachedYear);
        return cachedYear[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
    }

    // Cold Storage Check
    const rawArchive = state.archives[year];
    // CORRUPTION GUARD: Ensure rawArchive is actually a string before string ops
    if (rawArchive && typeof rawArchive === 'string') {
        // NEW: GZIP Handling (Async Hydration)
        if (rawArchive.startsWith('GZIP:')) {
            const pendingKey = `${year}_pending`;
            
            // Check Lock: Se já estamos descomprimindo, não inicia outra promessa.
            if (!state.unarchivedCache.has(pendingKey)) {
                // Set Lock
                state.unarchivedCache.set(pendingKey, {});
                
                console.log(`Decompressing archive for year ${year} in background...`);
                
                // Fire and Forget (Async)
                decompressString(rawArchive.substring(5)).then(json => {
                    try {
                        const parsedYearData = JSON.parse(json);
                        
                        // MEMORY PROTECTION: LRU Eviction before setting new data
                        // If cache is full, remove the oldest entry (first in Map)
                        if (state.unarchivedCache.size >= MAX_UNARCHIVED_CACHE_SIZE + 1) { // +1 accounts for pending key
                            const keysIterator = state.unarchivedCache.keys();
                            // Skip pending keys or current target if possible (simple heuristic: first valid year)
                            for (const k of keysIterator) {
                                if (k !== pendingKey && !k.includes('_pending')) {
                                    console.log(`[LRU] Evicting archive year ${k} from memory`);
                                    state.unarchivedCache.delete(k);
                                    break;
                                }
                            }
                        }

                        // Save to Cache
                        state.unarchivedCache.set(year, parsedYearData);
                        // Remove Lock
                        state.unarchivedCache.delete(pendingKey);
                        
                        // Force Re-render to show data
                        console.log(`Archive ${year} hydrated. Re-rendering.`);
                        document.dispatchEvent(new CustomEvent('render-app'));
                    } catch (e) {
                        console.error(`Failed to parse archive ${year}`, e);
                        state.unarchivedCache.set(year, {}); 
                        state.unarchivedCache.delete(pendingKey);
                    }
                }).catch(e => {
                    console.error(`Failed to decompress archive ${year}`, e);
                    state.unarchivedCache.set(year, {}); 
                    state.unarchivedCache.delete(pendingKey);
                });
            }
            
            // Return empty while loading
            return (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
        } 
        else {
            // Legacy JSON (Synchronous)
            try {
                // PERFORMANCE WARNING: JSON.parse on main thread for large files.
                // Only happens for old archives not yet converted to GZIP.
                const parsedYearData = JSON.parse(rawArchive) as Record<string, Record<string, HabitDailyInfo>>;
                
                // LRU Check for synchronous load too
                if (state.unarchivedCache.size >= MAX_UNARCHIVED_CACHE_SIZE) {
                    const firstKey = state.unarchivedCache.keys().next().value;
                    if(firstKey) state.unarchivedCache.delete(firstKey);
                }

                state.unarchivedCache.set(year, parsedYearData);
                return parsedYearData[date] || (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
            } catch (e) {
                console.error(`Error parsing legacy archive for ${year}`, e);
            }
        }
    }

    return (EMPTY_DAILY_INFO as Record<string, HabitDailyInfo>);
}

export function ensureHabitDailyInfo(date: string, habitId: string): HabitDailyInfo {
    // RACE CONDITION GUARD (Stage 1): Prevent initializing if known loading state.
    if (isDateLoading(date)) {
        console.warn(`[DATA SAFETY] Blocked write to ${date} because archive is loading.`);
        return _createMonomorphicDailyInfo(); // Dummy return
    }

    // Check key existence directly to avoid prototype chain lookup overhead
    if (!Object.prototype.hasOwnProperty.call(state.dailyData, date)) {
        // Tenta buscar do arquivo. Se for GZIP, isso vai disparar o carregamento E setar o flag de pending.
        const archivedDay = getHabitDailyInfoForDate(date);
        
        if (archivedDay !== EMPTY_DAILY_INFO) {
            // Thaw: Copy from archive to hot storage
            state.dailyData[date] = structuredClone(archivedDay);
        } else {
            // RACE CONDITION GUARD (Stage 2): Double Check Locking.
            // Se getHabitDailyInfoForDate acabou de iniciar um carregamento, isDateLoading será true AGORA.
            // Nesse caso, NÃO podemos inicializar um dia vazio, pois sobrescreveria os dados que estão chegando.
            if (isDateLoading(date)) {
                console.warn(`[DATA SAFETY] Triggered hydration for ${date}. Write blocked.`);
                return _createMonomorphicDailyInfo();
            }
            
            // New day (Safe to initialize empty)
            state.dailyData[date] = {};
        }
    }

    const dayData = state.dailyData[date];
    if (!dayData[habitId]) {
        // PERF: Use Factory for Shape Stability
        dayData[habitId] = _createMonomorphicDailyInfo();
    }
    return dayData[habitId];
}

export function ensureHabitInstanceData(date: string, habitId: string, time: TimeOfDay): HabitDayData {
    // Inlined call to ensureHabitDailyInfo logic for Hot Path optimization? 
    // No, keep modular for readability unless profiling shows significant overhead.
    const habitInfo = ensureHabitDailyInfo(date, habitId);
    
    if (!habitInfo.instances[time]) {
        // PERF: Use Factory for Shape Stability
        habitInfo.instances[time] = _createMonomorphicInstance();
    }
    return habitInfo.instances[time]!;
}
