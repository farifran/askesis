
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { 
    state, 
    AppState, 
    Habit, 
    HabitDailyInfo, 
    STATE_STORAGE_KEY, 
    APP_VERSION,
    getPersistableState 
} from '../state';
import { 
    toUTCIsoDateString, 
    parseUTCIsoDate, 
    addDays, 
    getTodayUTCIso 
} from '../utils';
import { migrateState } from './migration';

// ARCHIVE THRESHOLD [2025-02-23]: Data older than this (in days) moves to cold storage.
const ARCHIVE_THRESHOLD_DAYS = 90; 

// --- SYNC HANDLER ---
let syncHandler: ((state: AppState) => void) | null = null;

export function registerSyncHandler(handler: (state: AppState) => void) {
    syncHandler = handler;
}

// --- ARCHIVING & DATA HYGIENE ---

/**
 * ARCHIVE LOGIC: Moves old daily data to cold storage.
 * This runs periodically to keep the main state object small and responsive.
 * Data older than ARCHIVE_THRESHOLD_DAYS is stringified and moved to state.archives['YYYY'].
 */
function archiveOldData() {
    const runArchive = () => {
        const today = parseUTCIsoDate(getTodayUTCIso());
        const thresholdDate = addDays(today, -ARCHIVE_THRESHOLD_DAYS);
        const thresholdISO = toUTCIsoDateString(thresholdDate);
        
        let movedCount = 0;
        const yearBuckets: Record<string, Record<string, Record<string, HabitDailyInfo>>> = {};

        // 1. Identify and group old data
        // Optimization: Use Object.keys is fast, but we handle the state mutation carefully.
        const dates = Object.keys(state.dailyData);
        for (const dateStr of dates) {
            // Binary string comparison for ISO dates is faster than localeCompare
            if (dateStr < thresholdISO) {
                const year = dateStr.substring(0, 4);
                if (!yearBuckets[year]) yearBuckets[year] = {};
                yearBuckets[year][dateStr] = state.dailyData[dateStr];
                
                // Remove from hot storage
                delete state.dailyData[dateStr];
                movedCount++;
            }
        }

        if (movedCount === 0) return; // Nothing to archive

        // 2. Merge with existing archives
        Object.keys(yearBuckets).forEach(year => {
            let existingYearData: Record<string, Record<string, HabitDailyInfo>> = {};
            
            // PERFORMANCE [2025-03-16]: Check Warm Cache first.
            if (state.unarchivedCache.has(year)) {
                existingYearData = state.unarchivedCache.get(year)!;
            } else if (state.archives[year]) {
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
            
            // PERFORMANCE [2025-03-16]: Warm Cache Strategy.
            state.unarchivedCache.set(year, newYearData);
        });

        if (movedCount > 0) {
            console.log(`Archived ${movedCount} daily records to cold storage.`);
            saveState(); // Persist the architectural changes
        }
    };

    // ADVANCED OPTIMIZATION [2025-03-17]: Use requestIdleCallback.
    // Heavy JSON serialization should happen only when the browser is idle to avoid
    // blocking frame rendering or user interaction during startup.
    if ('requestIdleCallback' in window) {
        requestIdleCallback(runArchive, { timeout: 5000 });
    } else {
        setTimeout(runArchive, 2000);
    }
}

/**
 * DATA HYGIENE: Prunes daily data records for habits that no longer exist.
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

// --- PERSISTENCE OPERATIONS ---

export function saveState() {
    const stateToSave = getPersistableState();
    
    const saveToLocalStorage = (data: AppState) => {
        try {
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(data));
            // Trigger Sync via registered handler
            if (syncHandler) {
                syncHandler(data);
            }
        } catch (e: any) {
            if (e.name === 'QuotaExceededError') {
                console.warn("LocalStorage quota exceeded. Attempting to clear non-essential data.");
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
        
        // DATA INTEGRITY: Deduplication.
        const uniqueHabitsMap = new Map<string, Habit>();
        migrated.habits.forEach(h => {
            if (h.id && !uniqueHabitsMap.has(h.id)) {
                uniqueHabitsMap.set(h.id, h);
            }
        });
        const sanitizedHabits = Array.from(uniqueHabitsMap.values());

        // DATA INTEGRITY: Filter out corrupted habits & ENFORCE SORT ORDER
        const validHabits = sanitizedHabits.filter(h => {
            if (!h.scheduleHistory || h.scheduleHistory.length === 0) {
                console.warn(`Removing corrupted habit found in state: ${h.id}`);
                return false;
            }
            // OPTIMIZATION [2025-03-17]: Binary comparison is faster than localeCompare for dates
            h.scheduleHistory.sort((a, b) => (a.startDate > b.startDate ? 1 : -1));
            return true;
        });

        state.habits = validHabits;
        state.dailyData = migrated.dailyData || {};
        state.archives = migrated.archives || {}; 
        
        // HYGIENE: Clean up daily data.
        pruneOrphanedDailyData(state.habits, state.dailyData);

        state.notificationsShown = migrated.notificationsShown || [];
        state.pending21DayHabitIds = migrated.pending21DayHabitIds || [];
        state.pendingConsolidationHabitIds = migrated.pendingConsolidationHabitIds || [];
        
        // Reset runtime caches correctly using .clear() for stability
        state.streaksCache.clear();
        state.scheduleCache.clear();
        state.activeHabitsCache.clear();
        state.unarchivedCache.clear();
        state.habitAppearanceCache.clear();
        state.daySummaryCache.clear();
        
        // Force full UI refresh on load
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        state.uiDirtyState.chartData = true;
        
        // Initial cleanup of old data into archives - NOW ASYNC via IdleCallback
        archiveOldData();
    }
}

/**
 * Removes all local application data.
 * Used for full resets.
 */
export function clearLocalPersistence() {
    localStorage.removeItem(STATE_STORAGE_KEY);
}
