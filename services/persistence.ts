
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
 * ARQUITETURA (Hot/Cold Storage & IDB):
 * - **IndexedDB Wrapper:** Implementação "Zero-Dependency" de um wrapper Promise-based para o IDB.
 * - **GZIP Archiving:** Dados históricos ("Cold Storage") são comprimidos (GZIP) antes de salvar,
 *   reduzindo uso de espaço e banda de sincronização.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Estrutura de dados.
 * - `utils.ts`: Funções utilitárias de data.
 */

import { 
    state, 
    AppState, 
    Habit, 
    HabitDailyInfo, 
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
import { runWorkerTask } from './cloud';

// CONFIGURAÇÃO DO INDEXEDDB
const DB_NAME = 'AskesisDB';
const DB_VERSION = 1;
const STORE_NAME = 'app_state';

// CONSTANTS
const STATE_STORAGE_KEY = 'habitTrackerState_v1';
const DB_OPEN_TIMEOUT_MS = 3000;

// --- IDB UTILS (Zero-Dependency Wrapper) ---

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            // Safety Timeout
            const timeoutId = setTimeout(() => {
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
                console.error("IDB Open Error", event);
                dbPromise = null; // CRITICAL FIX: Permite retry na próxima chamada se a abertura falhar
                reject((event.target as IDBOpenDBRequest).error);
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

async function idbGet<T>(key: string): Promise<T | undefined> {
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
        handleIDBError(e);
        return undefined; // Fail safe
    }
}

async function idbSet(key: string, value: any): Promise<void> {
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
        handleIDBError(e);
        // Não relançamos o erro para evitar crash da UI, mas o log acima alertará.
    }
}

async function idbDelete(key: string): Promise<void> {
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
        handleIDBError(e);
    }
}

// --- ARCHIVING & DATA HYGIENE ---

// ARCHIVE THRESHOLD [2025-02-23]: Data older than this (in days) moves to cold storage.
const ARCHIVE_THRESHOLD_DAYS = 90; 

let syncHandler: ((state: AppState) => void) | null = null;

export function registerSyncHandler(handler: (state: AppState) => void) {
    syncHandler = handler;
}

/**
 * ARCHIVE LOGIC: Moves old daily data to cold storage.
 * [MAIN THREAD - IDLE]: Preparação leve.
 * A Main Thread agora apenas coleta os dados e delega a compressão/merge para o Worker.
 */
function archiveOldData() {
    const runArchive = async () => {
        const today = parseUTCIsoDate(getTodayUTCIso());
        const thresholdDate = addDays(today, -ARCHIVE_THRESHOLD_DAYS);
        const thresholdISO = toUTCIsoDateString(thresholdDate);
        
        // 1. Identificar candidatos (Scan leve)
        const yearBuckets: Record<string, { additions: Record<string, Record<string, HabitDailyInfo>>, base?: any }> = {};
        const keysToRemove: string[] = [];

        const dates = Object.keys(state.dailyData);
        for (const dateStr of dates) {
            if (dateStr < thresholdISO) {
                const year = dateStr.substring(0, 4);
                if (!yearBuckets[year]) {
                    yearBuckets[year] = { additions: {} };
                    
                    // Prepara a base (dados existentes) para enviar ao worker
                    // Prioridade: Warm Cache (Objeto) > Cold Storage (GZIP String)
                    if (state.unarchivedCache.has(year)) {
                        yearBuckets[year].base = state.unarchivedCache.get(year);
                    } else if (state.archives[year]) {
                        yearBuckets[year].base = state.archives[year];
                    }
                }
                
                yearBuckets[year].additions[dateStr] = state.dailyData[dateStr];
                keysToRemove.push(dateStr);
            }
        }

        if (keysToRemove.length === 0) return;

        // 2. Offload para Worker (CPU Heavy)
        // O Worker fará: Decompressão (se GZIP) -> Merge -> Compressão -> Retorno GZIP
        try {
            console.log(`Offloading archive task for ${keysToRemove.length} days to worker...`);
            
            // Definição de tipo manual para retorno do worker
            type ArchiveOutput = Record<string, string>; // Ano -> GZIP
            
            const newArchives = await runWorkerTask<ArchiveOutput>('archive', yearBuckets);

            // 3. Aplicação Atômica das Mudanças (Main Thread)
            // Só alteramos o estado se o worker retornou com sucesso.
            for (const year in newArchives) {
                // Atualiza o Cold Storage
                state.archives[year] = newArchives[year];
                // Invalida o Warm Cache para garantir consistência (ou poderíamos atualizar, mas é mais seguro limpar)
                // Se o usuário pedir esse ano de novo, o sistema vai descomprimir o novo GZIP atualizado.
                state.unarchivedCache.delete(year);
            }

            // Remove do Hot Storage
            keysToRemove.forEach(k => delete state.dailyData[k]);

            console.log(`Archiving complete. Moved ${keysToRemove.length} records.`);
            await saveState(); // Persist changes async

        } catch (e) {
            console.error("Archive task failed in worker:", e);
            // Em caso de erro, não faz nada. Os dados continuam no dailyData e tentaremos novamente no próximo idle.
        }
    };

    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => { runArchive().catch(console.error); }, { timeout: 10000 });
    } else {
        setTimeout(() => { runArchive().catch(console.error); }, 5000);
    }
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
        
        archiveOldData();

        return migrated;
    }
    return null;
}

export async function clearLocalPersistence(): Promise<void> {
    await idbDelete(STATE_STORAGE_KEY);
    localStorage.removeItem(STATE_STORAGE_KEY);
}
