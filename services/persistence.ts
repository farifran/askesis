
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/persistence.ts
 * @description Camada de Persistência e Gerenciamento de Ciclo de Vida de Dados (Storage Engine).
 */

import { state, AppState, Habit, HabitDailyInfo, APP_VERSION, getPersistableState, resetAllCaches } from '../state';
import { migrateState } from './migration';

const DB_NAME = 'AskesisDB', DB_VERSION = 1, STORE_NAME = 'app_state', STATE_STORAGE_KEY = 'habitTrackerState_v1', DB_OPEN_TIMEOUT_MS = 15000, IDB_SAVE_DEBOUNCE_MS = 500;
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
        // CHAOS DEFENSE: Reseta a conexão em caso de erro para não travar a sessão.
        dbPromise = null; 
        if (retries > 0) return performIDB(mode, op, retries - 1);
        return undefined;
    }
}

let syncHandler: ((state: AppState) => void) | null = null;
export const registerSyncHandler = (h: (s: AppState) => void) => syncHandler = h;

/**
 * Poda de dados órfãos: remove registros de hábitos deletados para economizar espaço e RAM.
 */
function pruneOrphanedDailyData(habits: Habit[], dailyData: Record<string, Record<string, HabitDailyInfo>>) {
    if (habits.length === 0) return; 
    const validIds = new Set(habits.map(h => h.id));
    let prunedCount = 0;
    for (const date in dailyData) {
        for (const id in dailyData[date]) {
            if (!validIds.has(id)) {
                delete dailyData[date][id];
                prunedCount++;
            }
        }
        if (Object.keys(dailyData[date]).length === 0) delete dailyData[date];
    }
    if (prunedCount > 0) console.log(`[Persistence] ${prunedCount} registros órfãos podados.`);
}

export async function flushSaveBuffer(): Promise<void> {
    if (saveTimeout !== undefined) {
        clearTimeout(saveTimeout);
        saveTimeout = undefined;
        const data = getPersistableState();
        try {
            await performIDB('readwrite', s => s.put(data, STATE_STORAGE_KEY));
            syncHandler?.(data);
        } catch (e) {
            console.error("Flush failed:", e);
        }
    }
}

export async function saveState(): Promise<void> {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = self.setTimeout(async () => {
        saveTimeout = undefined;
        const data = getPersistableState();
        try {
            await performIDB('readwrite', s => s.put(data, STATE_STORAGE_KEY));
        } catch (e) { 
            console.error("IDB Save Failed:", e); 
        }
        syncHandler?.(data);
    }, IDB_SAVE_DEBOUNCE_MS);
}

export const persistStateLocally = (data: AppState) => performIDB('readwrite', s => s.put(data, STATE_STORAGE_KEY));

export async function loadState(cloudState?: AppState): Promise<AppState | null> {
    let loaded: AppState | null = cloudState || await performIDB<AppState>('readonly', s => s.get(STATE_STORAGE_KEY)) || null;
    if (!loaded) {
        const legacy = localStorage.getItem(STATE_STORAGE_KEY);
        if (legacy) {
            try {
                loaded = JSON.parse(legacy);
                if (loaded) { 
                    await performIDB('readwrite', s => s.put(loaded!, STATE_STORAGE_KEY)); 
                    localStorage.removeItem(STATE_STORAGE_KEY); 
                }
            } catch (e) { console.error("Legacy Corrupt", e); }
        }
    }

    if (loaded) {
        const migrated = migrateState(loaded, APP_VERSION);
        migrated.habits = (migrated.habits || []).filter(h => h && h.id && h.scheduleHistory?.length > 0);
        
        // PERFORMANCE & INTEGRITY: Pruning rodando fora do caminho crítico do boot.
        const runCleanup = () => pruneOrphanedDailyData(migrated.habits, migrated.dailyData || {});
        if ('requestIdleCallback' in window) requestIdleCallback(runCleanup);
        else setTimeout(runCleanup, 3000);
        
        Object.assign(state, { 
            habits: migrated.habits, dailyData: migrated.dailyData || {}, archives: migrated.archives || {},
            notificationsShown: migrated.notificationsShown || [], pending21DayHabitIds: migrated.pending21DayHabitIds || [],
            pendingConsolidationHabitIds: migrated.pendingConsolidationHabitIds || []
        });
        
        // CRITICAL FIX: Ensure all caches are invalidated to prevent stale data in UI
        resetAllCaches();
        return migrated;
    }
    return null;
}

export const clearLocalPersistence = () => Promise.all([performIDB('readwrite', s => s.delete(STATE_STORAGE_KEY)), localStorage.removeItem(STATE_STORAGE_KEY)]);

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => { flushSaveBuffer(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaveBuffer(); });
}
