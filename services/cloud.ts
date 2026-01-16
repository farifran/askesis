
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/cloud.ts
 * @description Orquestrador de Sincronização na Nuvem (Cloud Sync Orchestrator).
 * CORREÇÃO: Sanitização agressiva de BigInts antes do envio ao Worker.
 */

import { AppState, state, getPersistableState } from '../state';
import { loadState, persistStateLocally } from './persistence';
import { generateUUID, arrayBufferToBase64 } from '../utils';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch, clearKey } from './api';
import { HabitService } from './HabitService';

const DEBOUNCE_DELAY = 2000;
const WORKER_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

let syncTimeout: any = null;
let isSyncInProgress = false;
let pendingSyncState: AppState | null = null;
let syncFailCount = 0;
let syncWorker: Worker | null = null;
const workerCallbacks = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void, timer: any }>();

function terminateWorker(reason: string) {
    syncWorker?.terminate();
    syncWorker = null;
    workerCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error(`Worker Reset: ${reason}`)); });
    workerCallbacks.clear();
}

// --- WORKER MANAGEMENT ---

function getWorker(): Worker {
    if (!syncWorker) {
        // FIX: Usar construtor URL com import.meta.url garante que o bundler (Vite/ESBuild)
        // resolva o caminho relativo corretamente, evitando erros 404 em produção.
        syncWorker = new Worker(new URL('./sync.worker.ts', import.meta.url), { type: 'module' });
        
        syncWorker.onmessage = (e) => {
            const { id, status, result, error } = e.data;
            const cb = workerCallbacks.get(id);
            if (!cb) return;
            clearTimeout(cb.timer);
            status === 'success' ? cb.resolve(result) : cb.reject(new Error(error));
            workerCallbacks.delete(id);
        };
        
        syncWorker.onerror = (e: any) => {
            // ZERO-KNOWLEDGE LOGGING: Não expor detalhes sensíveis, apenas o tipo de erro.
            const msg = (e instanceof ErrorEvent) ? (e.message || 'Script Error') : 'Worker Load Failed';
            console.error(`[Cloud] Worker Fault: ${msg}`);
            terminateWorker("Crash/Error");
        };
    }
    return syncWorker;
}

const _getAuthKey = () => {
    const k = getSyncKey();
    if (!k) {
        console.warn("[Cloud] No sync key found locally.");
        setSyncStatus('syncError');
    }
    return k;
};

export const prewarmWorker = () => getWorker();

export function runWorkerTask<T>(type: string, payload: any, key?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = generateUUID();
        const timer = setTimeout(() => { 
            if (workerCallbacks.has(id)) {
                workerCallbacks.delete(id);
                reject(new Error("Worker Timeout"));
                terminateWorker(`Timeout:${type}`);
            }
        }, WORKER_TIMEOUT_MS);
        
        workerCallbacks.set(id, { resolve, reject, timer });
        
        try {
            getWorker().postMessage({ id, type, payload, key });
        } catch (e) {
            clearTimeout(timer);
            workerCallbacks.delete(id);
            reject(e);
        }
    });
}

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial' | 'syncing') {
    state.syncState = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    
    // Mapeia status internos para chaves de tradução
    const displayKey = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    
    if (ui.syncStatus) ui.syncStatus.textContent = t(displayKey);
    
    if (ui.syncErrorMsg) {
        if (statusKey === 'syncError' && state.syncLastError) {
            ui.syncErrorMsg.textContent = state.syncLastError;
            ui.syncErrorMsg.classList.remove('hidden');
        } else {
            ui.syncErrorMsg.classList.add('hidden');
        }
    }
}

function clearLocalAuth() {
    clearKey();
    state.syncLastError = "Auth Invalid";
    setSyncStatus('syncError');
}

async function resolveConflictWithServerState(serverData: any) {
    try {
        const key = _getAuthKey();
        if (!key) return;

        // 1. Decrypt (Any type because it might contain Hex Strings)
        const serverStateRaw = await runWorkerTask<any>('decrypt', serverData.state, key);
        
        // 2. HYDRATION: Convert Hex Logs from Server to BigInt Map
        let serverLogs = new Map<string, bigint>();
        if (serverStateRaw.monthlyLogsSerialized) {
             const logs = serverStateRaw.monthlyLogsSerialized;
             delete serverStateRaw.monthlyLogsSerialized;
             if (Array.isArray(logs)) {
                 logs.forEach(([k, v]: [string, string]) => {
                     try { serverLogs.set(k, BigInt(v.startsWith('0x') ? v : '0x' + v)); } catch {}
                 });
             }
        } else if (serverStateRaw.monthlyLogs instanceof Map) {
             // Caso raro onde o worker já retornou um Map
             serverLogs = serverStateRaw.monthlyLogs;
        }
        serverStateRaw.monthlyLogs = serverLogs;

        const localState = getPersistableState();
        if (!localState.monthlyLogs) localState.monthlyLogs = state.monthlyLogs || new Map();

        // 3. Merge
        // CRÍTICO: Removemos monthlyLogs (Map de BigInt) antes de enviar para o worker 'merge'
        // para evitar erro de serialização se o worker usar JSON.stringify.
        const { monthlyLogs: localLogsRef, ...cleanLocalState } = localState as any;
        
        const mergedJSON = await runWorkerTask<AppState>('merge', { 
            local: cleanLocalState, 
            incoming: serverStateRaw 
        });

        // 4. Merge Binário (Bitwise OR Manual)
        const mergedLogs = new Map<string, bigint>(state.monthlyLogs);
        serverLogs.forEach((val, key) => {
            const localVal = mergedLogs.get(key) || 0n;
            mergedLogs.set(key, localVal | val);
        });

        // Aplica e Salva
        Object.assign(state, mergedJSON);
        state.monthlyLogs = mergedLogs;
        
        // FIX: Construct proper AppState object instead of trying to cast/modify `state` singleton.
        const finalState: AppState = {
            ...mergedJSON,
            monthlyLogs: mergedLogs
        };
        
        // Ensure the resolved state has a newer timestamp than the conflicting server state
        if (finalState.lastModified <= serverData.lastModified) {
            finalState.lastModified = Date.now();
        }
        
        await persistStateLocally(finalState);
        document.dispatchEvent(new CustomEvent('render-app'));
        syncStateWithCloud(finalState);

    } catch (e: any) {
        console.error("[Cloud] Merge failed:", e);
        state.syncLastError = "Merge Failed";
        setSyncStatus('syncError');
    }
}

export async function fetchStateFromCloud(): Promise<AppState | null> {
    if (!hasLocalSyncKey()) return null;
    const key = _getAuthKey();
    if (!key) return null;

    try {
        setSyncStatus('syncing');
        const res = await apiFetch('/api/sync', { method: 'GET' }, true);
        
        if (!res.ok) {
            if (res.status === 404) return null;
            if (res.status === 401) {
                clearLocalAuth();
                return null;
            }
            throw new Error(`Fetch failed: ${res.status}`);
        }

        const data = await res.json();
        if (!data || !data.state) return null;

        // 1. DECRIPTAÇÃO (Worker)
        const decryptedRaw = await runWorkerTask<any>('decrypt', data.state, key);
        
        // 2. RECONSTRUÇÃO DE DADOS (Deserialização BigInt)
        if (decryptedRaw.monthlyLogsSerialized) {
            const logsSerialized = decryptedRaw.monthlyLogsSerialized;
            delete decryptedRaw.monthlyLogsSerialized; // Limpa o transitório
            
            // Recria o Map
            const map = new Map<string, bigint>();
            if (Array.isArray(logsSerialized)) {
                logsSerialized.forEach(([k, v]: [string, string]) => {
                    try { map.set(k, BigInt(v.startsWith('0x') ? v : '0x' + v)); } catch {}
                });
            }
            decryptedRaw.monthlyLogs = map;
        }

        setSyncStatus('syncSynced');
        return decryptedRaw as AppState;

    } catch (e: any) {
        console.error("[Cloud] Fetch failed:", e);
        state.syncLastError = "Decryption Failed";
        setSyncStatus('syncError');
        return null;
    }
}

export async function syncStateWithCloud(currentState: AppState, force = false) {
    if (!hasLocalSyncKey()) return;

    if (isSyncInProgress) {
        pendingSyncState = currentState;
        return;
    }

    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => _performSync(currentState), DEBOUNCE_DELAY);
}

async function _performSync(currentState: AppState) {
    const key = _getAuthKey();
    if (!key) return;

    isSyncInProgress = true;
    setSyncStatus('syncing');
    
    try {
        // 1. PREPARAÇÃO DE DADOS (Sanitização BigInt)
        const rawState = getPersistableState();
        
        // --- CIRURGIA DE REMOÇÃO DE BIGINT ---
        // Extraímos monthlyLogs (o Map problemático) e ficamos com o resto limpo.
        // O "as any" é necessário porque monthlyLogs é opcional na interface AppState.
        const { monthlyLogs, ...cleanState } = rawState as any;

        // Serializa os Logs Binários para Array de Strings (Seguro para JSON)
        const serializedLogs = HabitService.serializeLogsForCloud();
        
        // Cria payload garantidamente livre de BigInts
        const stateToSend = {
            ...cleanState,
            monthlyLogsSerialized: serializedLogs 
        };

        // 2. ENCRIPTÇÃO (Worker)
        const encryptedState = await runWorkerTask<string>('encrypt', stateToSend, key);

        const payload = {
            updatedAt: new Date().toISOString(),
            lastModified: currentState.lastModified,
            deviceId: (currentState as any).deviceId || 'unknown',
            state: encryptedState
        };

        // 3. ENVIO (API)
        const res = await apiFetch('/api/sync', {
            method: 'POST',
            body: JSON.stringify(payload)
        }, true);

        if (res.ok) {
            setSyncStatus('syncSynced');
            state.syncLastError = null;
            syncFailCount = 0;
            if (!pendingSyncState) terminateWorker("Sync Complete");
        } else if (res.status === 409) {
            const serverData = await res.json();
            await resolveConflictWithServerState(serverData);
        } else if (res.status === 401) {
            clearLocalAuth();
        } else {
            throw new Error(`Server status: ${res.status}`);
        }

    } catch (e: any) {
        console.error("[Cloud] Sync failed:", e);
        
        syncFailCount++;
        state.syncLastError = e.message || "Network Error";
        setSyncStatus('syncError');
        
        if (syncFailCount <= MAX_RETRIES) {
            const delay = 5000 * Math.pow(2, syncFailCount - 1);
            syncTimeout = setTimeout(() => _performSync(currentState), delay);
        }
    } finally {
        isSyncInProgress = false;
        if (pendingSyncState) {
            const next = pendingSyncState;
            pendingSyncState = null;
            syncStateWithCloud(next);
        }
    }
}
