
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

// FASE 3: SPLIT STORAGE KEYS
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
        // CHAOS DEFENSE: Reseta a conexão em caso de erro para não travar a sessão.
        dbPromise = null; 
        if (retries > 0) return performIDB(mode, op, retries - 1);
        return undefined;
    }
}

/**
 * [ZERO-COST PERSISTENCE]
 * Salva o estado separando dados estruturados de dados binários.
 * Usa uma transação para garantir atomicidade.
 */
async function saveSplitState(main: AppState, logs: Map<string, ArrayBuffer>): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
        store.put(main, STATE_JSON_KEY);
        store.put(logs, STATE_BINARY_KEY);
        
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

let syncHandler: ((state: AppState) => void) | null = null;
export const registerSyncHandler = (h: (s: AppState) => void) => syncHandler = h;

/**
 * Poda de dados órfãos: remove registros de hábitos deletados para economizar espaço e RAM.
 */
// @fix: Accept `readonly Habit[]` to be compatible with `AppState.habits`.
function pruneOrphanedDailyData(habits: readonly Habit[], dailyData: Record<string, Record<string, HabitDailyInfo>>) {
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

async function saveStateInternal() {
    // 1. Full State (Structured JSON Data Only)
    // O getPersistableState já remove monthlyLogsSerialized, mantendo apenas metadados leves.
    const structuredData = getPersistableState();
    
    // 2. Binary Logs (Raw Bytes)
    // Extrai o Map<string, ArrayBuffer> para salvar como BLOB nativo.
    const binaryLogs = HabitService.packBinaryLogs();
    
    try {
        await saveSplitState(structuredData, binaryLogs);
    } catch (e) { 
        console.error("IDB Save Failed:", e); 
    }
    
    // 3. Trigger Sync
    // O Sync Worker receberá o structuredData e solicitará o packBinaryLogs novamente se necessário para criptografia.
    syncHandler?.(structuredData);
}

export async function flushSaveBuffer(): Promise<void> {
    if (saveTimeout !== undefined) {
        clearTimeout(saveTimeout);
        saveTimeout = undefined;
        await saveStateInternal();
    }
}

export async function saveState(): Promise<void> {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = self.setTimeout(saveStateInternal, IDB_SAVE_DEBOUNCE_MS);
}

export const persistStateLocally = (data: AppState) => {
    // Save immediate split state (e.g. after migration or merge)
    const binaryLogs = HabitService.packBinaryLogs();
    return saveSplitState(data, binaryLogs);
};

export async function loadState(cloudState?: AppState): Promise<AppState | null> {
    // 1. Load Split State (Main + Binary Logs)
    let mainState = cloudState;
    let binaryLogs: Map<string, ArrayBuffer> | undefined;

    if (!mainState) {
        // Parallel fetch of main state and logs
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
                tx.onerror = () => resolve(); // Fail gracefully
            });
        } catch (e) {
            console.warn("[Persistence] Failed to read split state from IDB", e);
        }
    }

    // 2. Fallback to Legacy Key (Migration Path)
    if (!mainState) {
        mainState = await performIDB<AppState>('readonly', s => s.get(LEGACY_STORAGE_KEY));
        // Check localStorage fallback
        if (!mainState) {
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy) {
                try { mainState = JSON.parse(legacy); } catch {}
            }
        }
    }

    if (mainState) {
        // @fix: Cannot assign to 'habits' because it is a read-only property.
        let migrated = migrateState(mainState, APP_VERSION);
        migrated = {
            ...migrated,
            habits: (migrated.habits || []).filter(h => h && h.id && h.scheduleHistory?.length > 0)
        };
        
        // PERFORMANCE & INTEGRITY: Pruning rodando fora do caminho crítico do boot.
        const runCleanup = () => pruneOrphanedDailyData(migrated.habits, migrated.dailyData || {});
        if ('requestIdleCallback' in window) requestIdleCallback(runCleanup);
        else setTimeout(runCleanup, 3000);
        
        // @fix: Assign properties individually and create a mutable copy of habits to resolve readonly type mismatch.
        state.habits = [...migrated.habits];
        state.dailyData = migrated.dailyData || {};
        state.archives = migrated.archives || {};
        // @fix: The type 'readonly string[]' is 'readonly' and cannot be assigned to the mutable type 'string[]'.
        state.notificationsShown = [...(migrated.notificationsShown || [])];
        // @fix: The type 'readonly string[]' is 'readonly' and cannot be assigned to the mutable type 'string[]'.
        state.pending21DayHabitIds = [...(migrated.pending21DayHabitIds || [])];
        // @fix: The type 'readonly string[]' is 'readonly' and cannot be assigned to the mutable type 'string[]'.
        state.pendingConsolidationHabitIds = [...(migrated.pendingConsolidationHabitIds || [])];
        
        // --- HIDRATAÇÃO DO BITMASK (PRIORIDADE BINÁRIA) ---
        if (binaryLogs instanceof Map) {
            // [A] Fast Path: Restaura direto do binário (Zero Copy / Zero String Parsing)
            HabitService.unpackBinaryLogs(binaryLogs);
            //console.log(`[Persistence] Bitmasks binários carregados: ${binaryLogs.size} meses.`);
        } else if ((migrated as any).monthlyLogsSerialized && Array.isArray((migrated as any).monthlyLogsSerialized)) {
            // [B] Cloud Sync/Legacy Path: Importa do JSON (Hex Strings)
            // Isso acontece quando carregamos dados vindos da nuvem (via loadState(cloudState)) ou primeira migração.
            console.log("[Persistence] Migrando logs legados/nuvem para binário...");
            HabitService.deserializeLogsFromCloud((migrated as any).monthlyLogsSerialized);
            // Cleanup memory immediate
            delete (migrated as any).monthlyLogsSerialized;
        } else {
            // Init empty
            state.monthlyLogs = new Map();
        }

        ['streaksCache', 'scheduleCache', 'activeHabitsCache', 'unarchivedCache', 'habitAppearanceCache', 'daySummaryCache'].forEach(k => (state as any)[k].clear());
        Object.assign(state.uiDirtyState, { calendarVisuals: true, habitListStructure: true, chartData: true });
        return migrated;
    }
    return null;
}

export const clearLocalPersistence = () => Promise.all([
    performIDB('readwrite', s => {
        s.delete(STATE_JSON_KEY);
        s.delete(STATE_BINARY_KEY);
        s.delete(LEGACY_STORAGE_KEY);
        return {} as any; // Dummy
    }), 
    localStorage.removeItem(LEGACY_STORAGE_KEY)
]);

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => { flushSaveBuffer(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaveBuffer(); });
}