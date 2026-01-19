/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * VERSÃO: Classic Logic (Estável)
 */

import { AppState, state, getPersistableState } from '../state';
import { persistStateLocally } from './persistence';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch } from './api';
import { encrypt, decrypt } from './crypto';
import { mergeStates } from './dataMerge';
import { generateUUID } from '../utils';

const DEBOUNCE_DELAY = 2000;
let syncTimeout: any = null;
let isSyncInProgress = false;

// --- UTILS ---

function _serializeLogs(map: Map<string, bigint> | undefined): any {
    if (!map) return {};
    return Object.fromEntries(map);
}

function _deserializeLogs(obj: any): Map<string, bigint> {
    const map = new Map<string, bigint>();
    if (obj) {
        Object.entries(obj).forEach(([k, v]) => map.set(k, BigInt(v as any)));
    }
    return map;
}

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial' | 'syncing') {
    state.syncState = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    const displayKey = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    
    if (ui.syncStatus) ui.syncStatus.textContent = t(displayKey);
    
    if (statusKey === 'syncError' && ui.syncErrorMsg) {
        ui.syncErrorMsg.classList.remove('hidden');
    } else if (ui.syncErrorMsg) {
        ui.syncErrorMsg.classList.add('hidden');
    }
}

// --- WORKER INFRASTRUCTURE (Legacy Support for AI/Archival) ---
// Mantemos o Worker apenas para tarefas não-críticas de Sync para evitar quebrar habitActions.ts
const WORKER_CODE = `
self.onmessage = async (e) => {
    const { id, type, payload } = e.data;
    // Minimal fallback for non-sync tasks if needed
    self.postMessage({ id, status: 'error', error: 'Worker task not implemented in Lite mode' });
};
`;

let syncWorker: Worker | null = null;
const workerCallbacks = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void }>();

function getWorker(): Worker {
    if (!syncWorker) {
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        syncWorker = new Worker(URL.createObjectURL(blob));
        syncWorker.onmessage = (e) => {
            const { id, status, result, error } = e.data;
            const cb = workerCallbacks.get(id);
            if (cb) {
                workerCallbacks.delete(id);
                status === 'success' ? cb.resolve(result) : cb.reject(new Error(error));
            }
        };
    }
    return syncWorker;
}

export function runWorkerTask<T>(type: string, payload: any): Promise<T> {
    // Fallback: Executa tarefas críticas na main thread se possível, ou rejeita.
    // Para simplificar esta versão "Classic", focamos no Sync.
    return Promise.reject(new Error("Advanced Worker tasks disabled in Classic Mode."));
}

export function prewarmWorker() { /* No-op */ }

// --- CORE SYNC FUNCTIONS ---

/**
 * Baixa dados da nuvem para inspeção (sem mesclar).
 * Usado pelo listeners/sync.ts para decidir sobre overwrite.
 */
export async function downloadRemoteState(key: string): Promise<AppState | null> {
    try {
        const res = await apiFetch('/api/sync', { method: 'GET' }, true);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (!data || !data.state) return null;

        const jsonString = await decrypt(data.state, key);
        const incomingState = JSON.parse(jsonString);

        if (incomingState.monthlyLogs && !(incomingState.monthlyLogs instanceof Map)) {
            incomingState.monthlyLogs = _deserializeLogs(incomingState.monthlyLogs);
        }
        return incomingState;
    } catch (e) {
        console.error("Cloud check failed:", e);
        throw e;
    }
}

export async function fetchStateFromCloud(): Promise<AppState | null> {
    if (!hasLocalSyncKey()) return null;
    const key = getSyncKey();
    if (!key) return null;

    try {
        setSyncStatus('syncing');
        const remoteState = await downloadRemoteState(key);
        
        if (!remoteState) {
            console.log("Nuvem vazia (Novo usuário)");
            setSyncStatus('syncSynced');
            return null;
        }

        // Merge Strategy
        const currentLocalState = getPersistableState();
        const mergedState = await mergeStates(currentLocalState, remoteState);

        Object.assign(state, mergedState);
        await persistStateLocally(mergedState);
        document.dispatchEvent(new CustomEvent('render-app'));

        setSyncStatus('syncSynced');
        return mergedState;

    } catch (e) {
        console.error("Erro ao baixar da nuvem:", e);
        setSyncStatus('syncError');
        return null;
    }
}

async function _performSync() {
    const key = getSyncKey();
    if (!key) return;

    try {
        isSyncInProgress = true;
        setSyncStatus('syncing');

        const rawState = getPersistableState();
        const stateToSend = {
            ...rawState,
            monthlyLogs: _serializeLogs(state.monthlyLogs)
        };

        const encryptedData = await encrypt(JSON.stringify(stateToSend), key);

        const payload = {
            lastModified: Date.now(),
            state: encryptedData
        };

        const res = await apiFetch('/api/sync', {
            method: 'POST',
            body: JSON.stringify(payload)
        }, true);

        if (res.status === 409) {
            console.warn("Conflito detectado. Baixando versão mais recente...");
            await fetchStateFromCloud();
        } else if (!res.ok) {
            throw new Error(`Erro API: ${res.status}`);
        } else {
            setSyncStatus('syncSynced');
        }

    } catch (e) {
        console.error("Erro no Sync:", e);
        setSyncStatus('syncError');
    } finally {
        isSyncInProgress = false;
    }
}

export function syncStateWithCloud(currentState?: AppState) {
    if (!hasLocalSyncKey()) return;
    
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => _performSync(), DEBOUNCE_DELAY);
}

// Inicializa checando se tem dados
if (hasLocalSyncKey()) {
    fetchStateFromCloud();
}