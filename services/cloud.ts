
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
const MAX_PAYLOAD_SIZE = 1000000;
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
        // FIX: Path relative to enable correct loading in subdirectories/dev environments
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
                // Frequentemente causado por 404 (Script load failed)
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
    
    // UI FEEDBACK: Show/Hide detailed error message
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
        
        console.log