/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [2025-02-23]: Implementado "Cold Storage" (Arquivamento) para otimização de performance de longo prazo.
// [2025-02-23]: Arquitetura Desacoplada. 'state.ts' não depende mais de 'cloud.ts'.

import { addDays, getTodayUTC, getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate } from './utils';
import { icons } from './render/icons';
import { migrateState } from './services/migration';
import { calculateDaySummary, shouldHabitAppearOnDate, getEffectiveScheduleForHabitOnDate } from './services/selectors';

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
// MEMORY OPTIMIZATION [2025-01-21]: Max cache size aumented to 3000.
export const MAX_CACHE_SIZE = 3000;
// CONSTANT [2025-02-23]: Limit for streak calculation lookback (2 years).
export const STREAK_LOOKBACK_DAYS = 730;
// ARCHIVE THRESHOLD [2025-02-23]: Data older than this (in days) moves to cold storage.
const ARCHIVE_THRESHOLD_DAYS = 90; 

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

// Predefined habits now use keys for localization
export const PREDEFINED_HABITS: PredefinedHabit[] = [
    { nameKey: 'predefinedHabitReadName', subtitleKey: 'predefinedHabitReadSubtitle', icon: icons.read, color: '#e74c3c', times: ['Evening'], goal: { type: 'pages', total: 10, unitKey: 'unitPage' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitMeditateName', subtitleKey: 'predefinedHabitMeditateSubtitle', icon: icons.meditate, color: '#f1c40f', times: ['Morning'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitWaterName', subtitleKey: 'predefinedHabitWaterSubtitle', icon: icons.water, color: '#3498db', times: ['Morning', 'Afternoon', 'Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' }, isDefault: true },
    { nameKey: 'predefinedHabitExerciseName', subtitleKey: 'predefinedHabitExerciseSubtitle', icon: icons.exercise, color: '#2ecc71', times: ['Afternoon'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitStretchName', subtitleKey: 'predefinedHabitStretchSubtitle', icon: icons.stretch, color: '#7f8c8d', times: ['Morning'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitJournalName', subtitleKey: 'predefinedHabitJournalSubtitle', icon: icons.journal, color: '#9b59b6', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitLanguageName', subtitleKey: 'predefinedHabitLanguageSubtitle', icon: icons.language, color: '#1abc9c', times: ['Afternoon'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitOrganizeName', subtitleKey: 'predefinedHabitOrganizeSubtitle', icon: icons.organize, color: '#34495e', times: ['Evening'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitWalkName', subtitleKey: 'predefinedHabitWalkSubtitle', icon: icons.walk, color: '#27ae60', times: ['Afternoon'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPlanDayName', subtitleKey: 'predefinedHabitPlanDaySubtitle', icon: icons.planDay, color: '#007aff', times: ['Morning'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitCreativeHobbyName', subtitleKey: 'predefinedHabitCreativeHobbySubtitle', icon: icons.creativeHobby, color: '#e84393', times: ['Afternoon'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitGratitudeName', subtitleKey: 'predefinedHabitGratitudeSubtitle', icon: icons.gratitude, color: '#f39c12', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitEatFruitName', subtitleKey: 'predefinedHabitEatFruitSubtitle', icon: icons.eatFruit, color: '#c0392b', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitTalkFriendName', subtitleKey: 'predefinedHabitTalkFriendSubtitle', icon: icons.talkFriend, color: '#3498db', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitScreenBreakName', subtitleKey: 'predefinedHabitScreenBreakSubtitle', icon: icons.screenBreak, color: '#9b59b6', times: ['Afternoon'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitInstrumentName', subtitleKey: 'predefinedHabitInstrumentSubtitle', icon: icons.instrument, color: '#e67e22', times: ['Evening'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPlantsName', subtitleKey: 'predefinedHabitPlantsSubtitle', icon: icons.plants, color: '#2ecc71', times: ['Morning'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitFinancesName', subtitleKey: 'predefinedHabitFinancesSubtitle', icon: icons.finances, color: '#34495e', times: ['Evening'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitTeaName', subtitleKey: 'predefinedHabitTeaSubtitle', icon: icons.tea, color: '#1abc9c', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPodcastName', subtitleKey: 'predefinedHabitPodcastSubtitle', icon: icons.podcast, color: '#007aff', times: ['Afternoon'], goal: { type: 'minutes', total: 25, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitEmailsName', subtitleKey: 'predefinedHabitEmailsSubtitle', icon: icons.emails, color: '#f1c40f', times: ['Morning'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitSkincareName', subtitleKey: 'predefinedHabitSkincareSubtitle', icon: icons.skincare, color: '#e84393', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitSunlightName', subtitleKey: 'predefinedHabitSunlightSubtitle', icon: icons.sunlight, color: '#f39c12', times: ['Morning'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitDisconnectName', subtitleKey: 'predefinedHabitDisconnectSubtitle', icon: icons.disconnect, color: '#2980b9', times: ['Evening'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitDrawName', subtitleKey: 'predefinedHabitDrawSubtitle', icon: icons.draw, color: '#8e44ad', times: ['Afternoon'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitFamilyTimeName', subtitleKey: 'predefinedHabitFamilyTimeSubtitle', icon: icons.familyTime, color: '#f1c40f', times: ['Evening'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitNewsName', subtitleKey: 'predefinedHabitNewsSubtitle', icon: icons.news, color: '#7f8c8d', times: ['Morning'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitCookHealthyName', subtitleKey: 'predefinedHabitCookHealthySubtitle', icon: icons.cookHealthy, color: '#27ae60', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitLearnSkillName', subtitleKey: 'predefinedHabitLearnSkillSubtitle', icon: icons.learnSkill, color: '#3498db', times: ['Afternoon'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitPhotographyName', subtitleKey: 'predefinedHabitPhotographySubtitle', icon: icons.photography, color: '#34495e', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitVolunteerName', subtitleKey: 'predefinedHabitVolunteerSubtitle', icon: icons.gratitude, color: '#e74c3c', times: ['Afternoon'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitYogaName', subtitleKey: 'predefinedHabitYogaSubtitle', icon: icons.yoga, color: '#9b59b6', times: ['Morning'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitReflectDayName', subtitleKey: 'predefinedHabitReflectDaySubtitle', icon: icons.reflectDay, color: '#2980b9', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitNoComplaintName', subtitleKey: 'predefinedHabitNoComplaintSubtitle', icon: icons.disconnect, color: '#e67e22', times: ['Morning', 'Afternoon', 'Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitReviewDayName', subtitleKey: 'predefinedHabitReviewDaySubtitle', icon: icons.journal, color: '#7f8c8d', times: ['Evening'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } },
    { nameKey: 'predefinedHabitStoicismName', subtitleKey: 'predefinedHabitStoicismSubtitle', icon: icons.meditate, color: '#34495e', times: ['Morning'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily' } }
];

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
    
    // PERFORMANCE [2025-01-22]: Migração de Record para Map para caches.
    streaksCache: Map<string, number>;
    // Chave: `${habitId}|${dateISO}`. Valor: boolean.
    habitAppearanceCache: Map<string, boolean>;
    scheduleCache: Map<string, HabitSchedule | null>;
    activeHabitsCache: Map<string, Array<{ habit: Habit; schedule: TimeOfDay[] }>>;
    daySummaryCache: Map<string, any>;
    // MELHORIA DE ROBUSTEZ [2024-10-06]: A estrutura de `lastEnded` foi aprimorada para incluir `removedSchedules`.
    // UPDATE [2025-02-23]: Incluído `wipedDailyData` para permitir restauração completa de dados futuros no undo.
    lastEnded: { 
        habitId: string;
        // FIX [2025-03-05]: Store the original habit object for a perfect undo.
        originalHabit: Habit;
        wipedDailyData?: Record<string, HabitDailyInfo>;
    } | null;
    undoTimeout: number | null;
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
    lastEnded: null,
    undoTimeout: null,
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

// --- SYNC HANDLER ---
// DECOUPLING [2025-02-23]: Allows injecting the sync logic (from cloud.ts) without importing it.
let syncHandler: ((state: AppState) => void) | null = null;

export function registerSyncHandler(handler: (state: AppState) => void) {
    syncHandler = handler;
}

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


// --- STATE-DEPENDENT HELPERS ---

/**
 * ARCHIVE LOGIC [2025-02-23]: Moves old daily data to cold storage.
 * This runs periodically to keep the main state object small and responsive.
 * Data older than ARCHIVE_THRESHOLD_DAYS is stringified and moved to state.archives['YYYY'].
 */
function archiveOldData() {
    const today = parseUTCIsoDate(getTodayUTCIso());
    const thresholdDate = addDays(today, -ARCHIVE_THRESHOLD_DAYS);
    const thresholdISO = toUTCIsoDateString(thresholdDate);
    
    let movedCount = 0;
    const yearBuckets: Record<string, Record<string, Record<string, HabitDailyInfo>>> = {};

    // 1. Identify and group old data
    Object.keys(state.dailyData).forEach(dateStr => {
        if (dateStr < thresholdISO) {
            const year = dateStr.substring(0, 4);
            if (!yearBuckets[year]) yearBuckets[year] = {};
            yearBuckets[year][dateStr] = state.dailyData[dateStr];
            
            // Remove from hot storage
            delete state.dailyData[dateStr];
            movedCount++;
        }
    });

    if (movedCount === 0) return; // Nothing to archive

    // 2. Merge with existing archives
    Object.keys(yearBuckets).forEach(year => {
        let existingYearData = {};
        if (state.archives[year]) {
            try {
                existingYearData = JSON.parse(state.archives[year]);
            } catch (e) {
                console.error(`Failed to parse archive for year ${year}`, e);
            }
        }
        
        // Merge new archive candidates with existing archive
        const newYearData = { ...existingYearData, ...yearBuckets[year] };
        
        // Store as compressed string
        state.archives[year] = JSON.stringify(newYearData);
        
        // Invalidate runtime cache for this year to ensure consistency
        state.unarchivedCache.delete(year);
    });

    console.log(`Archived ${movedCount} daily records to cold storage.`);
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

export function saveState() {
    // OPTIMIZATION [2025-03-03]: Removed redundant 'archiveOldData()' call.
    // It is already called on loadState(). Running it here caused unnecessary 
    // JSON.parse/stringify thrashing when editing historical habits.

    const stateToSave = getPersistableState();
    
    const saveToLocalStorage = (data: AppState) => {
        try {
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(data));
            // DECOUPLING [2025-02-23]: Call the registered handler instead of importing cloud module directly.
            if (syncHandler) {
                syncHandler(data);
            }
        } catch (e: any) {
            if (e.name === 'QuotaExceededError') {
                console.warn("LocalStorage quota exceeded. Attempting to clear non-essential data.");
                // FAIL-SAFE: Limpa dados não essenciais para tentar liberar espaço
                state.lastEnded = null; // Remove histórico de desfazer
                
                try {
                    console.error("Critical: Unable to save state due to storage quota.");
                } catch (retryError) {
                    console.error("Failed retry save", retryError);
                }
            } else {
                console.error("Failed to save state", e);
            }
        }
    };

    saveToLocalStorage(stateToSave);
}

/**
 * Persists the current state to local storage WITHOUT updating the lastModified timestamp
 * and WITHOUT triggering a cloud sync.
 * Used when receiving data from the cloud to ensure local consistency.
 */
export function persistStateLocally(appState: AppState) {
    try {
        localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(appState));
    } catch (e) {
        console.error("Failed to persist state locally", e);
    }
}


/**
 * DATA HYGIENE [2025-02-21]: Prunes daily data records for habits that no longer exist.
 * This removes "zombie" data that can cause ghosts or syncing bloat.
 */
function pruneOrphanedDailyData(habits: Habit[], dailyData: Record<string, Record<string, HabitDailyInfo>>) {
    const validHabitIds = new Set(habits.map(h => h.id));
    let cleanedCount = 0;

    Object.keys(dailyData).forEach(date => {
        const dayRecord = dailyData[date];
        if (!dayRecord) return;

        const habitIds = Object.keys(dayRecord);
        let dayModified = false;

        habitIds.forEach(id => {
            if (!validHabitIds.has(id)) {
                delete dayRecord[id];
                dayModified = true;
                cleanedCount++;
            }
        });

        if (dayModified && Object.keys(dayRecord).length === 0) {
            delete dailyData[date];
        }
    });

    if (cleanedCount > 0) {
        console.log(`Pruned ${cleanedCount} orphaned habit records from daily data.`);
    }
}

export function loadState(cloudState?: AppState) {
    let loadedState: AppState | null = cloudState || null;

    if (!loadedState) {
        const localStr = localStorage.getItem(STATE_STORAGE_KEY);
        if (localStr) {
            try {
                loadedState = JSON.parse(localStr);
            } catch (e) {
                console.error("Failed to parse local state", e);
            }
        }
    }

    if (loadedState) {
        const migrated = migrateState(loadedState, APP_VERSION);
        
        // DATA INTEGRITY [2025-02-21]: Deduplication.
        // Ensure strictly unique habit IDs. If duplicates exist, keep the first one.
        const uniqueHabitsMap = new Map<string, Habit>();
        migrated.habits.forEach(h => {
            if (h.id && !uniqueHabitsMap.has(h.id)) {
                uniqueHabitsMap.set(h.id, h);
            }
        });
        const sanitizedHabits = Array.from(uniqueHabitsMap.values());

        // DATA INTEGRITY: Filter out corrupted habits without schedule history.
        const validHabits = sanitizedHabits.filter(h => {
            if (!h.scheduleHistory || h.scheduleHistory.length === 0) {
                console.warn(`Removing corrupted habit found in state: ${h.id}`);
                return false;
            }
            return true;
        });

        state.habits = validHabits;
        state.dailyData = migrated.dailyData || {};
        state.archives = migrated.archives || {}; // Load archives
        
        // HYGIENE: Clean up daily data for habits that were removed or filtered out.
        pruneOrphanedDailyData(state.habits, state.dailyData);

        state.notificationsShown = migrated.notificationsShown || [];
        state.pending21DayHabitIds = migrated.pending21DayHabitIds || [];
        state.pendingConsolidationHabitIds = migrated.pendingConsolidationHabitIds || [];
        
        // Reinicializa caches como Maps
        state.streaksCache = new Map();
        state.scheduleCache = new Map();
        state.activeHabitsCache = new Map();
        state.unarchivedCache = new Map(); // Clear runtime archive cache
        state.habitAppearanceCache.clear();
        state.daySummaryCache.clear();
        state.lastEnded = null;
        
        // Force full UI refresh on load
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        state.uiDirtyState.chartData = true;
        
        // Initial cleanup of old data into archives
        archiveOldData();
    }
}

/**
 * REFACTOR [2025-03-05]: Invalidação de Cache Unificada.
 * Limpa todos os caches que dependem do histórico de agendamento.
 * Como uma mudança de agendamento sempre afeta os hábitos ativos, esta função limpa ambos
 * os caches principais (`scheduleCache`, `activeHabitsCache`) e todos os caches derivados
 * (`habitAppearanceCache`, `daySummaryCache`, `chartDataDirty`) de uma só vez, eliminando redundância.
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
 * Usado para operações como reordenar, onde a estrutura da lista muda, mas a lógica de agendamento permanece a mesma.
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
    
    // Invalidate streak for today and tomorrow
    habitIds.forEach(id => {
        state.streaksCache.delete(`${id}|${dateISO}`);
        const tomorrow = toUTCIsoDateString(addDays(parseUTCIsoDate(dateISO), 1));
        state.streaksCache.delete(`${id}|${tomorrow}`);
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
