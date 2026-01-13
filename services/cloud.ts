
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { AppState, state, getPersistableState } from '../state';
import { loadState, persistStateLocally } from './persistence';
import { generateUUID } from '../utils';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch } from './api';
import { mergeStates } from './dataMerge';

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
    console.warn(`[Cloud] Terminating worker: ${reason}`);
    syncWorker?.terminate();
    syncWorker = null;
    workerCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error(`Worker Reset: ${reason}`)); });
    workerCallbacks.clear();
}

function getWorker(): Worker {
    if (!syncWorker) {
        // FIX: Caminho relativo ('sync-worker.js') para evitar erros 404/MIME type 
        // quando o app não está na raiz do domínio.
        syncWorker = new Worker('sync-worker.js', { type: 'module' });
        
        syncWorker.onmessage = (e) => {
            const { id, status, result, error } = e.data;
            const cb = workerCallbacks.get(id);
            if (!cb) return;
            clearTimeout(cb.timer);
            status === 'success' ? cb.resolve(result) : cb.reject(new Error(error));
            workerCallbacks.delete(id);
        };
        
        syncWorker.onerror = (e: any) => {
            let msg = 'Unknown Worker Error';
            if (e instanceof ErrorEvent) {
                msg = e.message || e.error?.message || 'Script Error';
            } else if (e instanceof Event) {
                msg = 'Worker Script Load Failed (Check network/path)';
            }
            console.error(`[Cloud] Worker Error: ${msg}`, e);
            terminateWorker("Crash");
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
        const timer = setTimeout(() => { if (workerCallbacks.has(id)) terminateWorker(`Timeout:${type}`); }, WORKER_TIMEOUT_MS);
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

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial') {
    state.syncState = statusKey;
    if (ui.syncStatus) ui.syncStatus.textContent = t(statusKey);
    
    if (ui.syncErrorMsg) {
        if (statusKey === 'syncError' && state.syncLastError) {
            ui.syncErrorMsg.textContent = state.syncLastError;
            ui.syncErrorMsg.classList.remove('hidden');
        } else {
            ui.syncErrorMsg.classList.add('hidden');
        }
    }
}

async function resolveConflictWithServerState(serverPayload: { lastModified: number; state: string }) {
    console.log("[Cloud] Resolving conflict...");
    const key = _getAuthKey();
    if (!key) return;
    try {
        const serverState = await runWorkerTask<AppState>('decrypt', serverPayload.state, key);
        const merged = await runWorkerTask<AppState>('merge', { local: getPersistableState(), incoming: serverState });
        
        if (merged.lastModified <= serverPayload.lastModified) merged.lastModified = serverPayload.lastModified + 1;
        
        await persistStateLocally(merged);
        await loadState(merged);
        document.dispatchEvent(new CustomEvent('render-app'));
        setSyncStatus('syncSynced');
        document.dispatchEvent(new CustomEvent('habitsChanged'));
        
        console.log("[Cloud] Conflict resolved via Merge.");
    } catch (e) {
        console.error("[Cloud] Conflict resolution failed:", e);
        state.syncLastError = "Merge Failed";
        setSyncStatus('syncError');
    }
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    if (!hasLocalSyncKey()) return undefined;
    const key = _getAuthKey();
    if (!key) return undefined;

    try {
        const res = await apiFetch('/api/sync', { method: 'GET' }, true);
        if (res.status === 401) {
            clearLocalAuth();
            return undefined;
        }
        
        const data = await res.json();
        if (!data || !data.state) return undefined;

        try {
            return await runWorkerTask<AppState>('decrypt', data.state, key);
        } catch (e) {
            console.error("Decrypt failed during fetch:", e);
            state.syncLastError = "Decryption Failed";
            setSyncStatus('syncError');
            return undefined;
        }
    } catch (e: any) {
        console.warn("[Cloud] Fetch failed:", e);
        return undefined;
    }
}

function clearLocalAuth() {
    state.syncLastError = "Auth Invalid";
    setSyncStatus('syncError');
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
    setSyncStatus('syncSaving');
    
    try {
        const encryptedState = await runWorkerTask<string>('encrypt', currentState, key);
        
        const payload = {
            lastModified: currentState.lastModified,
            state: encryptedState
        };

        const res = await apiFetch('/api/sync', {
            method: 'POST',
            body: JSON.stringify(payload)
        }, true);

        if (res.ok) {
            setSyncStatus('syncSynced');
            state.syncLastError = null;
            syncFailCount = 0;
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
            console.log(`[Cloud] Retrying in ${delay}ms...`);
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
