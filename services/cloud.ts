
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/cloud.ts
 * @description Orquestrador de Sincronização na Nuvem (Cloud Sync Orchestrator).
 * CORREÇÃO FINAL: Sanitização completa em _performSync E resolveConflictWithServerState.
 */

import { AppState, state, getPersistableState } from '../state';
import { persistStateLocally } from './persistence';
import { generateUUID } from '../utils';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch, clearKey } from './api';

const DEBOUNCE_DELAY = 2000;
const WORKER_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

let syncTimeout: any = null;
let isSyncInProgress = false;
let pendingSyncState: AppState | null = null;
let syncFailCount = 0;
let syncWorker: Worker | null = null;
const workerCallbacks = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void, timer: any }>();

// --- INTERNAL HELPERS (Evita dependência circular e isola BigInts) ---

function _serializeLogsInternal(map: Map<string, bigint> | undefined): string[][] {
    if (!map || !(map instanceof Map)) return [];
    return Array.from(map.entries()).map(([k, v]) => [k, '0x' + v.toString(16)]);
}

function _deserializeLogsInternal(arr: any): Map<string, bigint> {
    const map = new Map<string, bigint>();
    if (Array.isArray(arr)) {
        arr.forEach((item) => {
            if (Array.isArray(item) && item.length === 2) {
                const [k, v] = item;
                try { 
                    map.set(k, BigInt(v)); 
                } catch (e) { }
            }
        });
    }
    return map;
}

// --- WORKER MANAGEMENT ---

function terminateWorker(reason: string) {
    syncWorker?.terminate();
    syncWorker = null;
    workerCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error(`Worker Reset: ${reason}`)); });
    workerCallbacks.clear();
}

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

        // 1. Decripta dados do servidor
        const serverStateRaw = await runWorkerTask<any>('decrypt', serverData.state, key);
        
        // 2. Extrai e preserva os Logs Binários do Servidor (BigInt)
        // IMPORTANTE: NÃO injetar isso de volta no serverStateRaw antes do merge!
        let serverLogs = new Map<string, bigint>();
        if (serverStateRaw.monthlyLogsSerialized) {
             serverLogs = _deserializeLogsInternal(serverStateRaw.monthlyLogsSerialized);
             delete serverStateRaw.monthlyLogsSerialized; // Remove para deixar o objeto limpo
        }
        // Nota: serverStateRaw agora é JSON puro (sem BigInts)

        // 3. Prepara Estado Local (Sanitização)
        const localState = getPersistableState();
        // Garante que não enviamos BigInt para o worker de Merge
        const { monthlyLogs: localLogsRef, ...localStateSafe } = localState as any;
        
        // 4. Merge JSON no Worker (Seguro: Apenas objetos simples)
        const mergedJSON = await runWorkerTask<AppState>('merge', { 
            local: localStateSafe, 
            incoming: serverStateRaw 
        });

        // 5. Merge Binário (Manual na Thread Principal)
        // Unimos os bits locais com os bits do servidor
        const mergedLogs = new Map<string, bigint>(state.monthlyLogs || new Map());
        serverLogs.forEach((val, key) => {
            const localVal = mergedLogs.get(key) || 0n;
            mergedLogs.set(key, localVal | val); // Bitwise OR Union (Unifica Checkmarks)
        });

        // 6. Aplica e Salva
        Object.assign(state, mergedJSON);
        state.monthlyLogs = mergedLogs;
        
        // Ensure timestamp is bumped
        if ((state as any).lastModified <= serverData.updatedAt) (state as any).lastModified = Date.now();
        
        await persistStateLocally(state as unknown as AppState);
        document.dispatchEvent(new CustomEvent('render-app'));
        
        // Força uma nova sincronização para subir o estado mesclado
        syncStateWithCloud(state as unknown as AppState);

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
        if (!data.state) return null;

        // Decripta
        const decryptedRaw = await runWorkerTask<any>('decrypt', data.state, key);
        
        // Reconstrói BigInts
        if (decryptedRaw.monthlyLogsSerialized) {
            const logsSerialized = decryptedRaw.monthlyLogsSerialized;
            delete decryptedRaw.monthlyLogsSerialized;
            decryptedRaw.monthlyLogs = _deserializeLogsInternal(logsSerialized);
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
    
    try {
        isSyncInProgress = true;
        setSyncStatus('syncing');

        // 1. PREPARAÇÃO (Sanitização BigInt)
        const rawState = getPersistableState();
        
        // Remove monthlyLogs (Map<BigInt>) que quebra o JSON.stringify
        const { monthlyLogs, ...cleanState } = rawState as any;

        // Serializa logs localmente
        const serializedLogs = _serializeLogsInternal(monthlyLogs || state.monthlyLogs);
        
        const stateToSend = {
            ...cleanState,
            monthlyLogsSerialized: serializedLogs 
        };

        // 2. ENCRIPTÇÃO
        const encryptedState = await runWorkerTask<string>('encrypt', stateToSend, key);

        const payload = {
            updatedAt: new Date().toISOString(),
            lastModified: currentState.lastModified,
            deviceId: (currentState as any).deviceId || 'unknown',
            state: encryptedState
        };

        // 3. ENVIO
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
