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
    syncWorker?.terminate();
    syncWorker = null;
    workerCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error(`Worker Reset: ${reason}`)); });
    workerCallbacks.clear();
}

function getWorker(): Worker {
    if (!syncWorker) {
        syncWorker = new Worker('./sync-worker.js', { type: 'module' });
        syncWorker.onmessage = (e) => {
            const { id, status, result, error } = e.data;
            const cb = workerCallbacks.get(id);
            if (!cb) return;
            clearTimeout(cb.timer);
            status === 'success' ? cb.resolve(result) : cb.reject(new Error(error));
            workerCallbacks.delete(id);
        };
        syncWorker.onerror = () => terminateWorker("Crash");
    }
    return syncWorker;
}

const _getAuthKey = () => {
    const k = getSyncKey();
    if (!k) setSyncStatus('syncError');
    return k;
};

export const prewarmWorker = () => getWorker();

export function runWorkerTask<T>(type: string, payload: any, key?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = generateUUID();
        const timer = setTimeout(() => { if (workerCallbacks.has(id)) terminateWorker(`Timeout:${type}`); }, WORKER_TIMEOUT_MS);
        workerCallbacks.set(id, { resolve, reject, timer });
        getWorker().postMessage({ id, type, payload, key });
    });
}

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial') {
    state.syncState = statusKey;
    if (ui.syncStatus) ui.syncStatus.textContent = t(statusKey);
}

async function resolveConflictWithServerState(serverPayload: { lastModified: number; state: string }) {
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
        syncStateWithCloud(merged, true);
    } catch { setSyncStatus('syncError'); }
}

async function performSync() {
    if (isSyncInProgress || !pendingSyncState) return;
    const key = _getAuthKey();
    const appState = pendingSyncState;
    if (!key) { isSyncInProgress = false; return; }
    
    isSyncInProgress = true;
    pendingSyncState = null;
    try {
        const encrypted = await runWorkerTask<string>('encrypt', appState, key);
        if (encrypted.length > MAX_PAYLOAD_SIZE) throw new Error("Size limit");

        const res = await apiFetch('/api/sync', {
            method: 'POST',
            body: JSON.stringify({ lastModified: appState.lastModified, state: encrypted }),
        }, true);

        if (res.status === 409) await resolveConflictWithServerState(await res.json());
        else { setSyncStatus('syncSynced'); document.dispatchEvent(new CustomEvent('habitsChanged')); }
        syncFailCount = 0;
    } catch {
        setSyncStatus('syncError');
        if (++syncFailCount < MAX_RETRIES) pendingSyncState = appState;
    } finally {
        isSyncInProgress = false;
        if (pendingSyncState && syncFailCount < MAX_RETRIES) performSync();
    }
}

export function syncStateWithCloud(appState: AppState, immediate = false) {
    if (!hasLocalSyncKey()) return;
    pendingSyncState = appState;
    setSyncStatus('syncSaving');
    clearTimeout(syncTimeout);
    if (isSyncInProgress) return;
    if (immediate) performSync();
    else syncTimeout = setTimeout(performSync, DEBOUNCE_DELAY);
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    const key = _getAuthKey();
    if (!key) return;
    prewarmWorker();
    try {
        const res = await apiFetch('/api/sync', {}, true);
        const data = await res.json();
        if (data?.state) {
            const appState = await runWorkerTask<AppState>('decrypt', data.state, key);
            setSyncStatus('syncSynced');
            return appState;
        }
        if (state.habits.length) syncStateWithCloud(getPersistableState(), true);
    } catch (e) { setSyncStatus('syncError'); throw e; }
}
