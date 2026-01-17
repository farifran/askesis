/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/cloud.ts
 * @description Orquestrador de Sincronização.
 * ARQUITETURA FINAL: Time-Based Authority with Weighted Content Preservation.
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
// 🧠 INLINE WORKER SOURCE CODE (WEIGHTED MERGE LOGIC)
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
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const salt = input.subarray(0, SALT_LEN);
    const iv = input.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const ciphertext = input.subarray(SALT_LEN + IV_LEN);
    const key = await deriveKey(password, salt);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

// --- WEIGHTED MERGE LOGIC ---
// Merge 'loser' (older) data INTO 'winner' (newer) data, preserving rich content.
function mergeDailyRecord(winnerDay, loserDay) {
    for (const habitId in loserDay) {
        if (!winnerDay[habitId]) {
            // Preservation Rule: If habit data exists in loser but not winner, keep it.
            winnerDay[habitId] = loserDay[habitId];
            continue;
        }

        const winHabit = winnerDay[habitId];
        const loseHabit = loserDay[habitId];

        // 1. Instances (Notes & Goals) - High Weight
        const winInst = winHabit.instances || {};
        const loseInst = loseHabit.instances || {};

        for (const time in loseInst) {
            if (!winInst[time]) {
                // If loser has data and winner is empty, keep loser's data.
                winInst[time] = loseInst[time];
            } else {
                // CONFLICT: Both have data. Apply Weights.
                const wData = winInst[time];
                const lData = loseInst[time];

                // Rule A: Note Preservation (Content > Empty)
                if (!wData.note && lData.note) {
                    wData.note = lData.note;
                } else if (wData.note && lData.note) {
                    // If both have notes, prefer longer (richer) note as tie-breaker
                    if (lData.note.length > wData.note.length) {
                        wData.note = lData.note;
                    }
                }

                // Rule B: Goal Override Preservation
                if (wData.goalOverride === undefined && lData.goalOverride !== undefined) {
                    wData.goalOverride = lData.goalOverride;
                }
            }
        }
        winHabit.instances = winInst; // Reassign to ensure structure

        // 2. Daily Schedule
        // Prefer newer, but if newer is undefined/null, take older.
        if (!winHabit.dailySchedule && loseHabit.dailySchedule) {
            winHabit.dailySchedule = loseHabit.dailySchedule;
        }
    }
}

async function mergeStates(local, incoming) {
    // 1. Determine Newest vs Oldest
    const localTs = local.lastModified || 0;
    const incomingTs = incoming.lastModified || 0;
    
    // Default: Newest Wins
    let winner = localTs > incomingTs ? local : incoming;
    let loser = localTs > incomingTs ? incoming : local;
    
    // Deep Clone Winner to avoid mutations
    const merged = structuredClone(winner);

    // 2. UNION HABITS (Merge Arrays by ID)
    // Even if one state is older, we don't want to delete habits created on the other device.
    const mergedHabitIds = new Set(merged.habits.map(h => h.id));
    loser.habits.forEach(h => {
        if (!mergedHabitIds.has(h.id)) {
            merged.habits.push(h);
        }
    });

    // 3. WEIGHTED MERGE for Daily Data
    // We iterate over the 'loser' (older data) and try to inject its content 
    // into the 'winner' if the winner is empty/missing that specific data point.
    for (const date in loser.dailyData) {
        if (!merged.dailyData[date]) {
            merged.dailyData[date] = loser.dailyData[date];
        } else {
            mergeDailyRecord(merged.dailyData[date], loser.dailyData[date]);
        }
    }

    // 4. Merge Metadata Lists (Union)
    const mergeSet = (a, b) => Array.from(new Set([...(a||[]), ...(b||[])]));
    merged.notificationsShown = mergeSet(merged.notificationsShown, loser.notificationsShown);
    merged.pending21DayHabitIds = mergeSet(merged.pending21DayHabitIds, loser.pending21DayHabitIds);
    
    // 5. Update Timestamp
    // The result is a NEW state (merged), so it gets a fresh timestamp.
    merged.lastModified = Date.now();
    
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

function handleAuthError() {
    // ROBUSTNESS FIX: Do NOT clear the key automatically.
    // Allow the user to retry or fix the key manually.
    // Auto-clearing causes "Sync Loss" on temporary network/server glitches.
    state.syncLastError = "Erro de Autenticação. Verifique sua chave.";
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

/**
 * Baixa dados da nuvem, mescla com os dados locais e salva.
 */
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
            if (res.status === 401) { handleAuthError(); return null; }
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!data || !data.state) return null;

        console.log("[Cloud] Decriptando...");
        const decryptedRaw = await runWorkerTask<any>('decrypt', data.state, key);
        
        // 1. Decodifica Logs da Nuvem (Bitmask)
        let cloudLogs = new Map<string, bigint>();
        if (decryptedRaw.monthlyLogsSerialized) {
            cloudLogs = _deserializeLogsInternal(decryptedRaw.monthlyLogsSerialized);
            delete decryptedRaw.monthlyLogsSerialized;
        } else if (decryptedRaw.monthlyLogs && !(decryptedRaw.monthlyLogs instanceof Map)) {
             try { Object.entries(decryptedRaw.monthlyLogs).forEach(([k, v]) => cloudLogs.set(k, BigInt(v as any))); } catch {}
        }

        // 2. Obtém Estado Local Atual (Snapshot)
        const localState = getPersistableState();

        // 3. FUSÃO ESTRUTURAL (Via Worker - JSON)
        // Isso combina hábitos, configurações e notas usando a lógica de pesos e timestamp.
        console.log("[Cloud] Mesclando estruturas (Newest Wins + Weighted Content)...");
        const mergedState = await runWorkerTask<AppState>('merge', { 
            local: localState, 
            incoming: decryptedRaw 
        });

        // 4. FUSÃO DE LOGS (Bitwise OR na Main Thread)
        // Combina o histórico de checks. Aditivo: se existe em um, existe no final.
        console.log("[Cloud] Mesclando logs (Bitmask)...");
        const mergedLogs = new Map<string, bigint>(state.monthlyLogs || new Map());
        
        cloudLogs.forEach((cloudVal, key) => {
            const localVal = mergedLogs.get(key) || 0n;
            // Operador OR (|) combina os bits dos dois mundos.
            mergedLogs.set(key, localVal | cloudVal);
        });

        // CLOCK SKEW FIX:
        // Captura o timestamp do servidor para garantir que o nosso novo estado seja "o futuro".
        const serverTs = data.lastModified || 0;
        // Se o relógio local estiver atrasado em relação ao servidor, forçamos o relógio para frente.
        const safeNextTs = Math.max(Date.now(), serverTs + 1);

        // 5. RECONSTRUÇÃO DO ESTADO FINAL
        const finalState: AppState = {
            ...mergedState,
            version: mergedState.version,
            // IMPORTANTE: Atualiza o lastModified para garantir que este estado mesclado
            // seja considerado o mais recente em futuras sincronizações.
            lastModified: safeNextTs, 
            monthlyLogs: mergedLogs
        };

        // 6. PERSISTÊNCIA ATÔMICA
        await persistStateLocally(finalState);
        
        // 7. ATUALIZAÇÃO DA MEMÓRIA
        Object.assign(state, finalState);
        
        // 8. RENDERIZAÇÃO
        document.dispatchEvent(new CustomEvent('render-app'));

        setSyncStatus('syncSynced');
        console.log("[Cloud] ✅ Sincronização e Fusão Completas!");
        return finalState;

    } catch (e: any) {
        console.error("[Cloud] Fetch Failed:", e);
        state.syncLastError = formatNetworkError(e);
        setSyncStatus('syncError');
        return null;
    }
}

async function resolveConflictWithServerState(serverData: any) {
    console.warn("[Cloud] Conflito de versão detectado. Forçando Pull & Merge...");
    await fetchStateFromCloud();
    if (state.habits.length > 0) {
        syncStateWithCloud(getPersistableState());
    }
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
            // Envia o lastModified do objeto estado, garantindo coerência com a lógica de newest wins
            lastModified: currentState.lastModified, 
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
                handleAuthError();
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