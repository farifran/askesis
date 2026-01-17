/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/cloud.ts
 * @description Orquestrador de Sincronização.
 * VERSÃO FINAL: Smart Merge (Fusão Inteligente de Dados e Logs).
 */

import { AppState, state, getPersistableState } from '../state';
import { persistStateLocally } from './persistence';
import { generateUUID } from '../utils';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch, clearKey } from './api';

const DEBOUNCE_DELAY = 2000;
const WORKER_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

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

const SALT_LEN = 16;
const IV_LEN = 12;
const encoder = new TextEncoder();

async function deriveKey(password, salt) {
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

// --- MERGE LOGIC ---
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
        
        // Merge Schedule
        if (localHabitData.dailySchedule !== undefined) {
             if (JSON.stringify(localHabitData.dailySchedule) !== JSON.stringify(mergedHabitData.dailySchedule)) {
                mergedHabitData.dailySchedule = localHabitData.dailySchedule;
                isDirty = true;
             }
        }
        // Merge Instances
        const localInstances = localHabitData.instances || {};
        const mergedInstances = mergedHabitData.instances || {};
        
        for (const time in localInstances) {
            if (!mergedInstances[time]) {
                mergedInstances[time] = localInstances[time];
                isDirty = true;
            }
        }
    }
    return isDirty;
}

async function mergeStates(local, incoming) {
    const merged = structuredClone(incoming);
    
    // 1. Merge Habits (Union by ID)
    const incomingIds = new Set(incoming.habits.map(h => h.id));
    local.habits.forEach(h => { 
        if (!incomingIds.has(h.id)) merged.habits.push(h); 
    });

    // 2. Merge Settings/Metadata (Newest Wins or Union)
    merged.lastModified = Date.now();
    merged.version = Math.max(local.version || 0, incoming.version || 0);
    
    // Merge Lists (Sets)
    const mergeList = (a, b) => Array.from(new Set([...(a||[]), ...(b||[])]));
    merged.notificationsShown = mergeList(incoming.notificationsShown, local.notificationsShown);
    merged.pending21DayHabitIds = mergeList(incoming.pending21DayHabitIds, local.pending21DayHabitIds);
    
    // NOTA: Os MonthlyLogs são tratados na Main Thread devido à complexidade do BigInt/Map
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

function formatNetworkError(e: any): string {
    const msg = e ? (e.message || e.toString()) : "Unknown";
    if (msg.includes("TypeError") || msg.includes("Failed to fetch")) return "Erro de Conexão";
    if (msg.includes("404")) return "Erro 404: API não encontrada";
    if (msg.includes("401")) return "Chave Inválida";
    return "Erro: " + msg;
}

// --- CORE FUNCTIONS (SMART MERGE) ---

export async function fetchStateFromCloud(): Promise<AppState | null> {
    if (!hasLocalSyncKey()) return null;
    const key = getSyncKey();
    if (!key) return null;

    try {
        setSyncStatus('syncing');
        console.log("[Cloud] Buscando atualizações...");
        const res = await apiFetch('/api/sync', { method: 'GET' }, true);
        
        if (!res.ok) {
            if (res.status === 404) { console.warn("[Cloud] Vazia."); return null; }
            if (res.status === 401) { clearLocalAuth(); return null; }
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!data || !data.state) return null;

        console.log("[Cloud] Decriptando...");
        const decryptedRaw = await runWorkerTask<any>('decrypt', data.state, key);
        
        // 1. Trata os LOGS (Bitmask) separadamente
        let cloudLogs = new Map<string, bigint>();
        if (decryptedRaw.monthlyLogsSerialized) {
            cloudLogs = _deserializeLogsInternal(decryptedRaw.monthlyLogsSerialized);
            delete decryptedRaw.monthlyLogsSerialized;
        } else if (decryptedRaw.monthlyLogs && !(decryptedRaw.monthlyLogs instanceof Map)) {
             try { Object.entries(decryptedRaw.monthlyLogs).forEach(([k, v]) => cloudLogs.set(k, BigInt(v as any))); } catch {}
        }

        // 2. Prepara estado LOCAL para merge
        const localState = getPersistableState();

        // 3. FUSÃO (MERGE) DOS ESTADOS ESTRUTURAIS (Via Worker)
        console.log("[Cloud] Mesclando estruturas...");
        const mergedState = await runWorkerTask<AppState>('merge', { 
            local: localState, 
            incoming: decryptedRaw 
        });

        // 4. FUSÃO (MERGE) DOS LOGS (Bitwise OR na Main Thread)
        // Isso garante que marcas feitas no local E na nuvem sejam preservadas
        console.log("[Cloud] Mesclando logs (Bitmask)...");
        const mergedLogs = new Map<string, bigint>(state.monthlyLogs || new Map());
        
        cloudLogs.forEach((cloudVal, key) => {
            const localVal = mergedLogs.get(key) || 0n;
            // A MÁGICA: Operador OR (|) combina os bits dos dois mundos
            mergedLogs.set(key, localVal | cloudVal);
        });

        // 5. APLICAÇÃO ATÔMICA
        Object.assign(state, mergedState);
        state.monthlyLogs = mergedLogs;

        // Persiste e Renderiza
        await persistStateLocally(state);
        document.dispatchEvent(new CustomEvent('render-app'));

        setSyncStatus('syncSynced');
        console.log("[Cloud] ✅ Sincronização Inteligente Completa!");
        return state;

    } catch (e: any) {
        console.error("[Cloud] Fetch Failed:", e);
        state.syncLastError = formatNetworkError(e);
        setSyncStatus('syncError');
        return null;
    }
}

async function resolveConflictWithServerState(serverData: any) {
    console.warn("[Cloud] Conflito detectado. Iniciando Smart Merge...");
    // Em vez de reload cego, chama a função de fetch que agora sabe fazer merge
    await fetchStateFromCloud();
}

async function _performSync(currentState: AppState) {
    const key = getSyncKey();
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

        const res = await apiFetch('/api/sync', { method: 'POST', body: JSON.stringify(payload) }, true);

        if (res.ok) {
            setSyncStatus('syncSynced');
            state.syncLastError = null;
            syncFailCount = 0;
        } else {
            if (res.status === 404) throw new Error("404 (API Missing)");
            if (res.status === 409) {
                const serverData = await res.json();
                await resolveConflictWithServerState(serverData);
            } else if (res.status === 401) {
                clearLocalAuth();
            } else {
                throw new Error(`Server Error: ${res.status}`);
            }
        }

    } catch (e: any) {
        console.error("[Cloud] Sync Failed:", e);
        syncFailCount++;
        state.syncLastError = formatNetworkError(e);
        setSyncStatus('syncError');
        
        if (syncFailCount <= MAX_RETRIES) {
            syncTimeout = setTimeout(() => _performSync(currentState), 5000);
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

export async function syncStateWithCloud(currentState: AppState) {
    if (!hasLocalSyncKey()) return;
    if (isSyncInProgress) { pendingSyncState = currentState; return; }
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => _performSync(currentState), DEBOUNCE_DELAY);
}

prewarmWorker();
(window as any).forceRestore = fetchStateFromCloud;