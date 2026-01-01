
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/persistence.ts
 * @description Camada de Persistência e Gerenciamento de Ciclo de Vida de Dados (Storage Engine).
 * 
 * [MAIN THREAD CONTEXT]:
 * Implementação baseada em IndexedDB (Assíncrono).
 * Substitui o localStorage bloqueante para permitir armazenamento virtualmente ilimitado e sem travamentos de UI.
 * 
 * ARQUITETURA (Pure I/O Layer):
 * - **Responsabilidade Única:** Leitura e Escrita no IndexedDB.
 * - **Zero Dependencies:** Não depende mais de `cloud.ts` ou Workers, quebrando ciclos de dependência.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Estrutura de dados.
 */

import { 
    state, 
    AppState, 
    Habit, 
    HabitDailyInfo, 
    APP_VERSION,
    getPersistableState 
} from '../state';
import { migrateState } from './migration';

// CONFIGURAÇÃO DO INDEXEDDB
const DB_NAME = 'AskesisDB';
const DB_VERSION = 1;
const STORE_NAME = 'app_state';

// CONSTANTS
const STATE_STORAGE_KEY = 'habitTrackerState_v1';
// FIX [2025-04-03]: Increased timeout from 3000ms to 15000ms to accommodate slower devices during high load.
const DB_OPEN_TIMEOUT_MS = 15000;

// --- IDB UTILS (Zero-Dependency Wrapper) ---

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            let isSettled = false;

            // Safety Timeout
            const timeoutId = setTimeout(() => {
                if (isSettled) return;
                isSettled = true;
                console.warn("IndexedDB connection timed out. Clearing cache to allow retry.");
                dbPromise = null; // CRITICAL FIX: Permite retry na próxima chamada
                reject(new Error("IndexedDB connection timed out"));
            }, DB_OPEN_TIMEOUT_MS);

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };

            request.onsuccess = (event) => {
                clearTimeout(timeoutId);
                const db = (event.target as IDBOpenDBRequest).result;

                if (isSettled) {
                    // Race Condition: Connection opened AFTER timeout. 
                    // Close it immediately to prevent leaks since the caller has already received an error.
                    console.warn("IndexedDB opened after timeout. Closing orphan connection.");
                    db.close();
                    return;
                }
                isSettled = true;

                // ROBUSTNESS [2025-03-27]: Tratamento de perda de conexão.
                // Se o navegador fechar a conexão (pressão de memória) ou houver upgrade de versão,
                // devemos limpar a promessa cacheada para forçar uma reconexão na próxima chamada.
                
                db.onclose = () => {
                    console.warn('IndexedDB connection closed unexpectedly. Resetting connection cache.');
                    dbPromise = null;
                };

                db.onversionchange = () => {
                    console.warn('IndexedDB version change detected. Closing connection to allow upgrade.');
                    db.close();
                    dbPromise = null;
                };

                resolve(db);
            };

            request.onerror = (event) => {
                clearTimeout(timeoutId);
                if (isSettled) return;
                isSettled = true;
                
                console.error("IDB Open Error", event);
                // CRITICAL FIX: Se a abertura falhar, não podemos cachear a promessa rejeitada para sempre.
                // Devemos limpar dbPromise para que a próxima chamada a getDB() tente abrir novamente.
                dbPromise = null; 
                reject((event.target as IDBOpenDBRequest).error);
            };

            request.onblocked = () => {
                console.warn("IndexedDB open request is blocked. Please close other tabs with this app open.");
            };
        });
    }
    return dbPromise;
}

// Helper para verificar erros de conexão e invalidar cache durante operações
function handleIDBError(e: any) {
    console.error("IndexedDB Operation Failed:", e);
    // Se o erro indicar que o banco foi fechado ou estado inválido, limpa a promessa para forçar reconexão.
    if (e && (e.name === 'InvalidStateError' || (e.message && e.message.includes('closed')))) {
        console.warn("Detected closed DB connection in operation. Resetting cache.");
        dbPromise = null;
    }
}

// Retry Helper Logic: Tenta operações IDB até 3 vezes (2 retries)
async function idbGet<T>(key: string, retries = 2): Promise<T | undefined> {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        if (retries > 0) {
            console.warn(`IndexedDB Get failed, retrying... (${retries} attempts left). Error:`, e);
            // Force reset dbPromise if it was a connection/state error to ensure fresh connection on retry
            if (e instanceof Error && (e.message.includes('timed out') || e.name === 'InvalidStateError')) {
                dbPromise = null;
            }
            return idbGet(key, retries - 1);
        }
        handleIDBError(e);
        return undefined; // Fail safe
    }
}

async function idbSet(key: string, value: any, retries = 2): Promise<void> {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(value, key);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        if (retries > 0) {
            console.warn(`IndexedDB Set failed, retrying... (${retries} attempts left). Error:`, e);
            if (e instanceof Error && (e.message.includes('timed out') || e.name === 'InvalidStateError')) {
                dbPromise = null;
            }
            return idbSet(key, value, retries - 1);
        }
        handleIDBError(e);
        // Não relançamos o erro para evitar crash da UI, mas o log acima alertará.
    }
}

async function idbDelete(key: string, retries = 2): Promise<void> {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(key);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        if (retries > 0) {
            console.warn(`IndexedDB Delete failed, retrying... (${retries} attempts left).`);
            if (e instanceof Error && (e.message.includes('timed out') || e.name === 'InvalidStateError')) {
                dbPromise = null;
            }
            return idbDelete(key, retries - 1);
        }
        handleIDBError(e);
    }
}

let syncHandler: ((state: AppState) => void) | null = null;

export function registerSyncHandler(handler: (state: AppState) => void) {
    syncHandler = handler;
}

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

export async function saveState(): Promise<void> {
    const stateToSave = getPersistableState();
    
    try {
        await idbSet(STATE_STORAGE_KEY, stateToSave);
        if (syncHandler) {
            syncHandler(stateToSave);
        }
    } catch (e) {
        console.error("Critical: Failed to save state to IDB", e);
    }
}

export async function persistStateLocally(appState: AppState): Promise<void> {
    try {
        await idbSet(STATE_STORAGE_KEY, appState);
    } catch (e) {
        console.error("Failed to persist state locally", e);
    }
}

export async function loadState(cloudState?: AppState): Promise<AppState | null> {
    let loadedState: AppState | null = cloudState || null;

    if (!loadedState) {
        try {
            loadedState = await idbGet<AppState>(STATE_STORAGE_KEY) || null;

            if (!loadedState) {
                const localStr = localStorage.getItem(STATE_STORAGE_KEY);
                if (localStr) {
                    console.log("Migrating data from LocalStorage to IndexedDB...");
                    try {
                        loadedState = JSON.parse(localStr);
                        if (loadedState) {
                            await idbSet(STATE_STORAGE_KEY, loadedState);
                            localStorage.removeItem(STATE_STORAGE_KEY);
                            console.log("Migration successful. LocalStorage cleared.");
                        }
                    } catch (e) {
                        console.error("Failed to parse legacy local state", e);
                    }
                }
            }
        } catch (e) {
            console.error("Failed to load state from DB", e);
        }
    }

    if (loadedState) {
        const migrated = migrateState(loadedState, APP_VERSION);
        
        const uniqueHabitsMap = new Map<string, Habit>();
        migrated.habits.forEach(h => {
            if (h.id && !uniqueHabitsMap.has(h.id)) {
                uniqueHabitsMap.set(h.id, h);
            }
        });
        const sanitizedHabits = Array.from(uniqueHabitsMap.values());

        const validHabits = sanitizedHabits.filter(h => {
            if (!h.scheduleHistory || h.scheduleHistory.length === 0) {
                console.warn(`Removing corrupted habit found in state: ${h.id}`);
                return false;
            }
            h.scheduleHistory.sort((a, b) => (a.startDate > b.startDate ? 1 : -1));
            return true;
        });

        state.habits = validHabits;
        state.dailyData = migrated.dailyData || {};
        state.archives = migrated.archives || {}; 
        
        pruneOrphanedDailyData(state.habits, state.dailyData);

        state.notificationsShown = migrated.notificationsShown || [];
        state.pending21DayHabitIds = migrated.pending21DayHabitIds || [];
        state.pendingConsolidationHabitIds = migrated.pendingConsolidationHabitIds || [];
        
        state.streaksCache.clear();
        state.scheduleCache.clear();
        state.activeHabitsCache.clear();
        state.unarchivedCache.clear();
        state.habitAppearanceCache.clear();
        state.daySummaryCache.clear();
        
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        state.uiDirtyState.chartData = true;
        
        return migrated;
    }
    return null;
}

export async function clearLocalPersistence(): Promise<void> {
    await idbDelete(STATE_STORAGE_KEY);
    localStorage.removeItem(STATE_STORAGE_KEY);
}
