/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/persistence.ts
 * @description Camada de Persistência e Gerenciamento de Ciclo de Vida de Dados (Storage Engine).
 */

import { state, AppState, Habit, HabitDailyInfo, APP_VERSION, getPersistableState } from '../state';
import { migrateState } from './migration';
import { HabitService } from './HabitService';

const DB_NAME = 'AskesisDB', DB_VERSION = 1, STORE_NAME = 'app_state';
const LEGACY_STORAGE_KEY = 'habitTrackerState_v1';

const STATE_JSON_KEY = 'askesis_core_json';
const STATE_BINARY_KEY = 'askesis_logs_binary';

const DB_OPEN_TIMEOUT_MS = 15000, IDB_SAVE_DEBOUNCE_MS = 500;
let dbPromise: Promise<IDBDatabase> | null = null, saveTimeout: number | undefined;

function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => { dbPromise = null; reject(new Error("Timeout IDB")); }, DB_OPEN_TIMEOUT_MS);
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = (e.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            };
            request.onsuccess = (e) => {
                clearTimeout(timeoutId);
                const db = (e.target as IDBOpenDBRequest).result;
                db.onclose = db.onversionchange = () => dbPromise = null;
                resolve(db);
            };
            request.onerror = () => { clearTimeout(timeoutId); dbPromise = null; reject(request.error); };
        });
    }
    return dbPromise;
}

async function performIDB<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>, retries = 2): Promise<T | undefined> {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode), request = op(tx.objectStore(STORE_NAME));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        dbPromise = null; 
        if (retries > 0) return performIDB(mode, op, retries - 1);
        return undefined;
    }
}

async function saveSplitState(main: AppState, logs: any): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
        const { monthlyLogs, ...jsonState } = main as any;
        store.put(jsonState, STATE_JSON_KEY);
        
        if (logs && logs.size > 0) {
            store.put(logs, STATE_BINARY_KEY);
        }
        
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Handler signature updated to support 'immediate' flag for flush operations
let syncHandler: ((state: AppState, immediate?: boolean) => void) | null = null;
export const registerSyncHandler = (h: (s: AppState, immediate?: boolean) => void) => syncHandler = h;

function pruneOrphanedDailyData(habits: readonly Habit[], dailyData: Record<string, Record<string, HabitDailyInfo>>) {
    if (habits.length === 0) return; 
    const validIds = new Set(habits.map(h => h.id));
    for (const date in dailyData) {
        for (const id in dailyData[date]) {
            if (!validIds.has(id)) {
                delete dailyData[date][id];
            }
        }
        if (Object.keys(dailyData[date]).length === 0) delete dailyData[date];
    }
}

async function saveStateInternal(immediate = false) {
    const structuredData = getPersistableState();
    try {
        await saveSplitState(structuredData, state.monthlyLogs);
    } catch (e) { 
        console.error("IDB Save Failed:", e); 
    }
    // Pass the immediate flag to the sync handler (cloud.ts)
    syncHandler?.(structuredData, immediate);
}

export async function flushSaveBuffer(): Promise<void> {
    if (saveTimeout !== undefined) {
        clearTimeout(saveTimeout);
        saveTimeout = undefined;
        // Trigger immediate save and immediate sync
        await saveStateInternal(true);
    }
}

export async function saveState(): Promise<void> {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = self.setTimeout(saveStateInternal, IDB_SAVE_DEBOUNCE_MS);
}

export const persistStateLocally = (data: AppState) => {
    return saveSplitState(data, data.monthlyLogs || state.monthlyLogs);
};

export async function loadState(cloudState?: AppState): Promise<AppState | null> {
    let mainState = cloudState;
    let binaryLogs: any;

    if (!mainState) {
        try {
            const db = await getDB();
            await new Promise<void>((resolve) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                
                const reqMain = store.get(STATE_JSON_KEY);
                const reqLogs = store.get(STATE_BINARY_KEY);
                
                tx.oncomplete = () => {
                    mainState = reqMain.result;
                    binaryLogs = reqLogs.result;
                    resolve();
                };
                tx.onerror = () => resolve();
            });
        } catch (e) {
            console.warn("[Persistence] Failed to read split state from IDB", e);
        }
    }

    if (mainState) {
        let migrated = migrateState(mainState, APP_VERSION);
        migrated = {
            ...migrated,
            habits: (migrated.habits || []).filter(h => h && h.id && h.scheduleHistory?.length > 0)
        };
        
        const runCleanup = () => pruneOrphanedDailyData(migrated.habits, migrated.dailyData || {});
        
        if ('scheduler' in window && (window as any).scheduler) {
             (window as any).scheduler.postTask(runCleanup, { priority: 'background' });
        } else if ('requestIdleCallback' in window) {
             requestIdleCallback(runCleanup);
        } else {
             setTimeout(runCleanup, 3000);
        }
        
        state.habits = [...migrated.habits];
        if (migrated.lastModified) {
            state.lastModified = migrated.lastModified;
        }
        
        state.dailyData = migrated.dailyData || {};
        state.archives = migrated.archives || {};
        state.notificationsShown = [...(migrated.notificationsShown || [])];
        state.pending21DayHabitIds = [...(migrated.pending21DayHabitIds || [])];
        state.pendingConsolidationHabitIds = [...(migrated.pendingConsolidationHabitIds || [])];
        
        if (binaryLogs instanceof Map && binaryLogs.size > 0) {
            const firstVal = binaryLogs.values().next().value;
            if (typeof firstVal === 'bigint') {
                 state.monthlyLogs = binaryLogs as Map<string, bigint>;
            } 
            else if (firstVal instanceof ArrayBuffer) {
                 HabitService.unpackBinaryLogs(binaryLogs as Map<string, ArrayBuffer>);
            } else {
                 state.monthlyLogs = binaryLogs as any;
            }
        } 
        else if (migrated.monthlyLogs instanceof Map && migrated.monthlyLogs.size > 0) {
            state.monthlyLogs = migrated.monthlyLogs;
        } else if ((migrated as any).monthlyLogsSerialized && Array.isArray((migrated as any).monthlyLogsSerialized)) {
            HabitService.deserializeLogsFromCloud((migrated as any).monthlyLogsSerialized);
            delete (migrated as any).monthlyLogsSerialized;
        } else {
            if (!state.monthlyLogs) {
                state.monthlyLogs = new Map();
            }
        }

        ['streaksCache', 'scheduleCache', 'activeHabitsCache', 'unarchivedCache', 'habitAppearanceCache', 'daySummaryCache'].forEach(k => (state as any)[k].clear());
        Object.assign(state.uiDirtyState, { calendarVisuals: true, habitListStructure: true, chartData: true });
        
        document.dispatchEvent(new CustomEvent('render-app'));
        return migrated;
    }
    return null;
}

export const clearLocalPersistence = () => Promise.all([
    performIDB('readwrite', s => {
        s.delete(STATE_JSON_KEY);
        s.delete(STATE_BINARY_KEY);
        s.delete(LEGACY_STORAGE_KEY);
        return {} as any; 
    }), 
    localStorage.removeItem(LEGACY_STORAGE_KEY),
    (state.monthlyLogs = new Map())
]);

if (typeof window !== 'undefined') {
    // TRIGGER: Flush sync queue on close/hide
    window.addEventListener('beforeunload', () => { flushSaveBuffer(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaveBuffer(); });
}