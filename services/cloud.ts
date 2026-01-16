/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/cloud.ts
 * @description Orquestrador de Sincronização na Nuvem (Cloud Sync Orchestrator).
 * ARQUITETURA: Inline Blob Worker (Zero-Dependency Load).
 * VERSÃO: Safe-Mode (Sem comentários internos que possam quebrar a string).
 */

import { AppState, state, getPersistableState } from '../state';
import { persistStateLocally } from './persistence';
import { generateUUID } from '../utils';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch, clearKey } from './api';

const DEBOUNCE_DELAY = 2000;
const WORKER_TIMEOUT_MS = 45000;
const MAX_RETRIES = 3;

let syncTimeout: any = null;
let isSyncInProgress = false;
let pendingSyncState: AppState | null = null;
let syncFailCount = 0;
let syncWorker: Worker | null = null;
const workerCallbacks = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void, timer: any }>();

// --- INTERNAL HELPERS ---

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
                try { map.set(k, BigInt(v)); } catch (e) { }
            }
        });
    }
    return map;
}

// ==================================================================================
// 🧠 INLINE WORKER SOURCE CODE
// ATENÇÃO: Código Javascript Puro injetado no Blob.
// Comentários removidos para evitar erros de sintaxe em ambientes minificados.
// ==================================================================================
const WORKER_CODE = `
const HEX_LUT = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    const chunks = [];
    const CHUNK_SIZE = 8192;
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, len);
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, end)));
    }
    return btoa(chunks.join(''));
}

function base64ToArrayBuffer(base64) {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
    return bytes.buffer;
}

async function compressToBuffer(data) {
    const stream = new Blob([data]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
    return new Response(compressedStream).arrayBuffer().then(b => new Uint8Array(b));
}

async function decompressFromBuffer(compressed) {
    const buffer = (compressed instanceof Uint8Array) ? compressed : new Uint8Array(compressed);
    const stream = new Blob([buffer]).stream();
    const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
    return new Response(decompressedStream).text();
}

async function decompressString(base64Data) {
    const buffer = base64ToArrayBuffer(base64Data);
    return decompressFromBuffer(buffer);
}

const SALT_LEN = 16;
const IV_LEN = 12;
const encoder = new TextEncoder();

async function deriveKey(password, salt) {
    if (!crypto.subtle) throw new Error("Crypto API unavailable. Use HTTPS or localhost.");
    const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
}

async function encrypt(data, password) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(password, salt);
    let dataBuffer = typeof data === 'string' ? encoder.encode(data) : data;
    const encryptedContent = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataBuffer);
    const result = new Uint8Array(SALT_LEN + IV_LEN + encryptedContent.byteLength);
    result.set(salt, 0);
    result.set(iv, SALT_LEN);
    result.set(new Uint8Array(encryptedContent), SALT_LEN + IV_LEN);
    return result;
}

async function decryptToBuffer(data, password) {
    if (typeof data === 'string') {
        try { return await _legacyDecrypt(JSON.parse(data), password); } catch(e) { throw new Error("Invalid format"); }
    }
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const salt = input.subarray(0, SALT_LEN);
    const iv = input.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const ciphertext = input.subarray(SALT_LEN + IV_LEN);
    const key = await deriveKey(password, salt);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

function mergeDayRecord(localDay, mergedDay) {
    let isDirty = false;
    for (const habitId in localDay) {
        if (!mergedDay[habitId]) {
            mergedDay[habitId] = localDay[habitId];
            isDirty = true;
            continue;
        }
        const localHabitData = localDay[habitId];
        const mergedHabitData = mergedDay[habitId];
        
        if (localHabitData.dailySchedule !== undefined) {
             if (JSON.stringify(localHabitData.dailySchedule) !== JSON.stringify(mergedHabitData.dailySchedule)) {
                mergedHabitData.dailySchedule = localHabitData.dailySchedule;
                isDirty = true;
             }
        }
        
        const localInstances = localHabitData.instances || {};
        const mergedInstances = mergedHabitData.instances || {};
        
        for (const time in localInstances) {
            const localInst = localInstances[time];
            const mergedInst = mergedInstances[time];
            if (!localInst) continue;
            
            if (!mergedInst) {
                mergedInstances[time] = localInst;
                isDirty = true;
            } else {
                if (mergedInst.goalOverride === undefined && localInst.goalOverride !== undefined) {
                    mergedInst.goalOverride = localInst.goalOverride;
                    isDirty = true;
                }
                const lNoteLen = localInst.note ? localInst.note.length : 0;
                const mNoteLen = mergedInst.note ? mergedInst.note.length : 0;
                if (lNoteLen > mNoteLen) {
                    if (mergedInst.note !== localInst.note) {
                        mergedInst.note = localInst.note;
                        isDirty = true;
                    }
                }
            }
        }
    }
    return isDirty;
}

async function hydrateArchive(content) {
    try {
        if (content instanceof Uint8Array) return JSON.parse(await decompressFromBuffer(content));
        if (typeof content === 'string') {
            if (content.startsWith('GZIP:')) return JSON.parse(await decompressString(content.substring(5)));
            return JSON.parse(content);
        }
        return {};
    } catch { return {}; }
}

async function mergeStates(local, incoming) {
    const merged = structuredClone(incoming);
    
    const incomingIds = new Set(incoming.habits.map(h => h.id));
    local.habits.forEach(h => { if (!incomingIds.has(h.id)) merged.habits.push(h); });

    for (const date in local.dailyData) {
        if (!merged.dailyData[date]) merged.dailyData[date] = local.dailyData[date];
        else mergeDayRecord(local.dailyData[date], merged.dailyData[date]);
    }

    if (local.archives) {
        merged.archives = merged.archives || {};
        for (const year in local.archives) {
            if (!merged.archives[year]) {
                merged.archives[year] = local.archives[year];
            } else {
                try {
                    const localY = await hydrateArchive(local.archives[year]);
                    const mergedY = await hydrateArchive(merged.archives[year]);
                    let isDirty = false;
                    for (const d in localY) {
                        if (!mergedY[d]) { mergedY[d] = localY[d]; isDirty = true; }
                        else if (mergeDayRecord(localY[d], mergedY[d])) isDirty = true;
                    }
                    if (isDirty) merged.archives[year] = await compressToBuffer(JSON.stringify(mergedY));
                } catch {}
            }
        }
    }
    
    merged.lastModified = Date.now();
    merged.version = Math.max(local.version || 0, incoming.version || 0);
    const mergeList = (a, b) => Array.from(new Set([...(a||[]), ...(b||[])]));
    merged.notificationsShown = mergeList(incoming.notificationsShown, local.notificationsShown);
    merged.pending21DayHabitIds = mergeList(incoming.pending21DayHabitIds, local.pending21DayHabitIds);
    merged.pendingConsolidationHabitIds = mergeList(incoming.pendingConsolidationHabitIds, local.pendingConsolidationHabitIds);
    
    return merged;
}

self.onmessage = async (e) => {
    const { id, type, payload, key } = e.data;
    let result;
    try {
        if (type === 'encrypt') {
            const jsonStr = JSON.stringify(payload, (k, v) => {
                if (v instanceof Uint8Array) {
                    return 'B64:' + arrayBufferToBase64(new Uint8Array(v));
                }
                return v;
            });
            const compressed = await compressToBuffer(jsonStr);
            const encrypted = await encrypt(compressed, key);
            result = arrayBufferToBase64(encrypted);
        }
        else if (type === 'decrypt') {
            const inputBuffer = new Uint8Array(base64ToArrayBuffer(payload));
            const decryptedBuffer = await decryptToBuffer(inputBuffer, key);
            const decompressedJSON = await decompressFromBuffer(decryptedBuffer);
            result = JSON.parse(decompressedJSON, (k, v) => {
                if (typeof v === 'string' && v.startsWith('B64:')) {
                    return new Uint8Array(base64ToArrayBuffer(v.substring(4)));
                }
                return v;
            });
        }
        else if (type === 'merge') {
            result = await mergeStates(payload.local, payload.incoming);
        }
        else { throw new Error('Unknown task: ' + type); }
        
        self.postMessage({ id, status: 'success', result });
    } catch (err) {
        self.postMessage({ id, status: 'error', error: err.message || err.toString() });
    }
};
`;

// ==================================================================================

function terminateWorker(reason: string) {
    if (syncWorker) {
        syncWorker.terminate();
        syncWorker = null;
    }
    workerCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error(`Worker Reset: ${reason}`)); });
    workerCallbacks.clear();
}

function getWorker(): Worker {
    if (!syncWorker) {
        console.log("[Cloud] Instantiating Inline Worker...");
        try {
            const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);
            syncWorker = new Worker(workerUrl);
            
            syncWorker.onmessage = (e) => {
                const { id, status, result, error } = e.data;
                const cb = workerCallbacks.get(id);
                if (!cb) return;
                clearTimeout(cb.timer);
                workerCallbacks.delete(id);
                
                if (status === 'success') cb.resolve(result);
                else cb.reject(new Error(error));
            };
            
            syncWorker.onerror = (e) => {
                console.error("[Cloud] Inline Worker Crashed:", e);
                terminateWorker("Crash");
            };
        } catch (e) {
            console.error("[Cloud] Critical: Failed to create blob worker", e);
            throw e;
        }
    }
    return syncWorker;
}

export function runWorkerTask<T>(type: string, payload: any, key?: string): Promise<T> {
    const id = generateUUID();
    let worker: Worker;
    
    try {
        worker = getWorker();
    } catch (e) {
        return Promise.reject(e);
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (workerCallbacks.has(id)) {
                workerCallbacks.delete(id);
                reject(new Error("Worker Timeout"));
                terminateWorker("Timeout");
            }
        }, WORKER_TIMEOUT_MS);

        workerCallbacks.set(id, { resolve, reject, timer });
        worker.postMessage({ id, type, payload, key });
    });
}

// --- SYNC ORCHESTRATION ---

export function prewarmWorker() {
    if (window.requestIdleCallback) window.requestIdleCallback(() => { try { getWorker(); } catch {} });
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
    state.syncLastError = "Auth Invalid (401)";
    setSyncStatus('syncError');
}

async function resolveConflictWithServerState(serverData: any) {
    try {
        const key = _getAuthKey();
        if (!key) return;

        const serverStateRaw = await runWorkerTask<any>('decrypt', serverData.state, key);
        
        let serverLogs = new Map<string, bigint>();
        if (serverStateRaw.monthlyLogsSerialized) {
             serverLogs = _deserializeLogsInternal(serverStateRaw.monthlyLogsSerialized);
             delete serverStateRaw.monthlyLogsSerialized;
        }
        serverStateRaw.monthlyLogs = serverLogs;

        const localState = getPersistableState();
        const { monthlyLogs: localLogsRef, ...localStateSafe } = localState as any;
        
        const mergedJSON = await runWorkerTask<AppState>('merge', { 
            local: localStateSafe, 
            incoming: serverStateRaw 
        });

        const mergedLogs = new Map<string, bigint>(state.monthlyLogs || new Map());
        serverLogs.forEach((val, key) => {
            const localVal = mergedLogs.get(key) || 0n;
            mergedLogs.set(key, localVal | val);
        });

        Object.assign(state, mergedJSON);
        state.monthlyLogs = mergedLogs;
        
        await persistStateLocally(state as unknown as AppState);
        document.dispatchEvent(new CustomEvent('render-app'));
        syncStateWithCloud(state as unknown as AppState);

    } catch (e: any) {
        console.error("[Cloud] Conflict Resolution Failed:", e);
        state.syncLastError = "Merge: " + e.message;
        setSyncStatus('syncError');
    }
}

async function _performSync(currentState: AppState) {
    const key = _getAuthKey();
    if (!key) return;
    
    try {
        isSyncInProgress = true;
        setSyncStatus('syncing');

        const rawState = getPersistableState();
        const { monthlyLogs, ...cleanState } = rawState as any;
        const serializedLogs = _serializeLogsInternal(monthlyLogs || state.monthlyLogs);
        
        const stateToSend = {
            ...cleanState,
            monthlyLogsSerialized: serializedLogs 
        };

        const encryptedState = await runWorkerTask<string>('encrypt', stateToSend, key);

        const payload = {
            updatedAt: new Date().toISOString(),
            deviceId: (currentState as any).deviceId || 'unknown',
            state: encryptedState
        };

        // Adicionei logs para você ver qual URL está sendo chamada
        // console.log("Enviando para API: /api/sync"); 
        
        const res = await apiFetch('/api/sync', { method: 'POST', body: JSON.stringify(payload) }, true);

        if (res.ok) {
            setSyncStatus('syncSynced');
            state.syncLastError = null;
            syncFailCount = 0;
            if (!pendingSyncState) terminateWorker("Idle");
        } else if (res.status === 409) {
            const serverData = await res.json();
            await resolveConflictWithServerState(serverData);
        } else if (res.status === 401) {
            clearLocalAuth();
        } else {
            throw new Error(`Server Error: ${res.status}`);
        }

    } catch (e: any) {
        console.error("[Cloud] Sync Failed:", e);
        
        // Melhora a detecção de erro para o usuário
        let msg = e.message || "Unknown";
        if (msg.includes("Failed to fetch")) {
            msg = "Falha de Conexão (Servidor Offline?)";
        }
        
        syncFailCount++;
        state.syncLastError = msg;
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

// --- PUBLIC API ---

export async function fetchStateFromCloud(): Promise<AppState | null> {
    if (!hasLocalSyncKey()) return null;
    const key = _getAuthKey();
    if (!key) return null;

    try {
        setSyncStatus('syncing');
        const res = await apiFetch('/api/sync', { method: 'GET' }, true);
        
        if (!res.ok) {
            if (res.status === 404) return null; 
            if (res.status === 401) { clearLocalAuth(); return null; }
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!data.state) return null;

        const decryptedRaw = await runWorkerTask<any>('decrypt', data.state, key);
        
        if (decryptedRaw.monthlyLogsSerialized) {
            const logsSerialized = decryptedRaw.monthlyLogsSerialized;
            delete decryptedRaw.monthlyLogsSerialized;
            decryptedRaw.monthlyLogs = _deserializeLogsInternal(logsSerialized);
        }

        setSyncStatus('syncSynced');
        return decryptedRaw as AppState;

    } catch (e: any) {
        console.error("[Cloud] Fetch Failed:", e);
        
        let msg = "Erro na Nuvem";
        if (e.message.includes("Failed to fetch")) msg = "Offline / Servidor Indisponível";
        
        state.syncLastError = msg;
        setSyncStatus('syncError');
        return null;
    }
}

export async function syncStateWithCloud(currentState: AppState) {
    if (!hasLocalSyncKey()) return;
    if (isSyncInProgress) { pendingSyncState = currentState; return; }
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => _performSync(currentState), DEBOUNCE_DELAY);
}

const _getAuthKey = () => {
    const k = getSyncKey();
    if (!k) { setSyncStatus('syncError'); }
    return k;
};