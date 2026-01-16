/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/cloud.ts
 * @description Orquestrador de Sincronização - VERSÃO FORENSE DE DEBUG.
 * Use este arquivo para identificar a causa exata da falha de sincronização.
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

// --- DIAGNOSTIC TOOLS (Novidade) ---

/**
 * Varre o objeto recursivamente procurando tipos ilegais para o Worker.
 * Se encontrar um BigInt, grita no console.
 */
function probeForIllegalTypes(obj: any, path: string = 'root'): string | null {
    if (obj === null || obj === undefined) return null;
    
    const type = typeof obj;
    if (type === 'bigint') return `🚨 CRÍTICO: BigInt encontrado em '${path}'`;
    if (type === 'function') return `⚠️ AVISO: Função encontrada em '${path}'`;
    if (type === 'symbol') return `⚠️ AVISO: Symbol encontrado em '${path}'`;

    if (type === 'object') {
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                const res = probeForIllegalTypes(obj[i], `${path}[${i}]`);
                if (res) return res;
            }
        } else {
            // Verifica se é um objeto especial que não pode ser clonado
            if (obj instanceof Map) return `🚨 CRÍTICO: Map encontrado em '${path}' (JSON não suporta)`;
            if (obj instanceof Set) return `🚨 CRÍTICO: Set encontrado em '${path}' (JSON não suporta)`;
            if (obj instanceof HTMLElement) return `🚨 CRÍTICO: Elemento DOM encontrado em '${path}'`;

            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    const res = probeForIllegalTypes(obj[key], `${path}.${key}`);
                    if (res) return res;
                }
            }
        }
    }
    return null;
}

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

// --- WORKER MANAGEMENT ---

function terminateWorker(reason: string) {
    console.warn(`[Cloud] Resetando Worker. Motivo: ${reason}`);
    syncWorker?.terminate();
    syncWorker = null;
    workerCallbacks.forEach(cb => { clearTimeout(cb.timer); cb.reject(new Error(`Worker Reset: ${reason}`)); });
    workerCallbacks.clear();
}

function getWorker(): Worker {
    if (!syncWorker) {
        console.log("[Cloud] Inicializando Worker...");
        try {
            syncWorker = new Worker(new URL('./sync.worker.ts', import.meta.url), { type: 'module' });
            
            syncWorker.onmessage = (e) => {
                const { id, status, result, error } = e.data;
                const cb = workerCallbacks.get(id);
                if (!cb) return;
                clearTimeout(cb.timer);
                if (status === 'success') {
                    cb.resolve(result);
                } else {
                    console.error("[Cloud] Erro devolvido pelo Worker:", error);
                    cb.reject(new Error(error));
                }
                workerCallbacks.delete(id);
            };
            
            syncWorker.onerror = (e: any) => {
                const msg = (e instanceof ErrorEvent) ? (e.message || 'Script Error') : 'Worker Load Failed';
                console.error(`[Cloud] ❌ FALHA NO WORKER (onerror): ${msg}`);
                console.error("DICA: Verifique se o arquivo sync.worker.ts está na pasta correta e acessível via rede.");
                terminateWorker("Crash/Error");
            };
        } catch (initError) {
            console.error("[Cloud] Erro ao instanciar Worker:", initError);
            throw initError;
        }
    }
    return syncWorker;
}

const _getAuthKey = () => {
    const k = getSyncKey();
    if (!k) {
        console.warn("[Cloud] Sem chave de sincronização.");
        setSyncStatus('syncError');
    }
    return k;
};

export const prewarmWorker = () => { try { getWorker(); } catch (e) { console.error(e); } };

export function runWorkerTask<T>(type: string, payload: any, key?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = generateUUID();
        const timer = setTimeout(() => {
            if (workerCallbacks.has(id)) {
                workerCallbacks.delete(id);
                reject(new Error("Worker Timeout (30s)"));
                terminateWorker(`Timeout:${type}`);
            }
        }, WORKER_TIMEOUT_MS);

        workerCallbacks.set(id, { resolve, reject, timer });
        
        try {
            const w = getWorker();
            // DEBUG: Verificando payload antes do envio
            if (type === 'encrypt' || type === 'merge') {
                const issue = probeForIllegalTypes(payload);
                if (issue) {
                    console.error(`[Cloud] 🛑 ABORTANDO ENVIO AO WORKER: ${issue}`);
                    throw new Error(`Payload inválido: ${issue}`);
                }
            }
            
            w.postMessage({ id, type, payload, key });
        } catch (e) {
            clearTimeout(timer);
            workerCallbacks.delete(id);
            reject(e);
        }
    });
}

// --- SYNC LOGIC ---

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial' | 'syncing') {
    state.syncState = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    const displayKey = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    
    if (ui.syncStatus) ui.syncStatus.textContent = t(displayKey);
    
    if (ui.syncErrorMsg) {
        if (statusKey === 'syncError' && state.syncLastError) {
            ui.syncErrorMsg.textContent = state.syncLastError; // Exibe o erro real na tela
            ui.syncErrorMsg.classList.remove('hidden');
            console.error(`[Cloud UI] Erro exibido: ${state.syncLastError}`);
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

async function _performSync(currentState: AppState) {
    const key = _getAuthKey();
    if (!key) return;
    
    console.group('☁️ INICIANDO SINCRONIZAÇÃO (DEBUG)');
    try {
        isSyncInProgress = true;
        setSyncStatus('syncing');

        // 1. Extração
        console.time('Extract');
        const rawState = getPersistableState();
        const { monthlyLogs, ...cleanState } = rawState as any;
        console.timeEnd('Extract');

        // 2. Serialização
        console.time('Serialize');
        const serializedLogs = _serializeLogsInternal(monthlyLogs || state.monthlyLogs);
        console.log(`[Cloud] Serializados ${serializedLogs.length} logs.`);
        
        const stateToSend = {
            ...cleanState,
            monthlyLogsSerialized: serializedLogs 
        };
        console.timeEnd('Serialize');

        // 3. Criptografia (Worker)
        console.time('Worker Encrypt');
        console.log("[Cloud] Enviando para encriptação...");
        const encryptedState = await runWorkerTask<string>('encrypt', stateToSend, key);
        console.log(`[Cloud] Encriptado com sucesso. Tamanho: ${encryptedState.length} chars.`);
        console.timeEnd('Worker Encrypt');

        // 4. Rede
        const payload = {
            updatedAt: new Date().toISOString(),
            lastModified: currentState.lastModified,
            deviceId: (currentState as any).deviceId || 'unknown',
            state: encryptedState
        };

        console.time('Network');
        const res = await apiFetch('/api/sync', {
            method: 'POST',
            body: JSON.stringify(payload)
        }, true);
        console.timeEnd('Network');

        if (res.ok) {
            console.log("✅ SUCESSO: Dados enviados para nuvem.");
            setSyncStatus('syncSynced');
            state.syncLastError = null;
            syncFailCount = 0;
            if (!pendingSyncState) terminateWorker("Sync Complete");
        } else {
            console.error(`❌ ERRO DE REDE: Status ${res.status}`);
            if (res.status === 409) {
                console.warn("[Cloud] Conflito detectado (409). Iniciando resolução...");
                const serverData = await res.json();
                await resolveConflictWithServerState(serverData);
            } else if (res.status === 401) {
                clearLocalAuth();
            } else {
                throw new Error(`Erro do Servidor: ${res.status} ${res.statusText}`);
            }
        }

    } catch (e: any) {
        console.error("🔥 EXCEÇÃO NO PROCESSO DE SYNC:", e);
        
        // Melhora a mensagem de erro para o usuário
        let cleanMsg = e.message || "Unknown Error";
        if (cleanMsg.includes("DataCloneError")) cleanMsg = "Erro interno: Dados não clonáveis (BigInt?)";
        if (cleanMsg.includes("Worker")) cleanMsg = "Erro no Worker de Criptografia";
        if (cleanMsg.includes("Failed to fetch")) cleanMsg = "Sem conexão com a internet";

        state.syncLastError = cleanMsg;
        syncFailCount++;
        setSyncStatus('syncError');
        
        if (syncFailCount <= MAX_RETRIES) {
            console.log(`[Cloud] Tentando novamente (${syncFailCount}/${MAX_RETRIES})...`);
            const delay = 5000 * Math.pow(2, syncFailCount - 1);
            syncTimeout = setTimeout(() => _performSync(currentState), delay);
        }
    } finally {
        isSyncInProgress = false;
        console.groupEnd();
        if (pendingSyncState) {
            const next = pendingSyncState;
            pendingSyncState = null;
            syncStateWithCloud(next);
        }
    }
}

// ... Resto das funções (fetchStateFromCloud, resolveConflictWithServerState, syncStateWithCloud) 
// permanecem similares, mas usando runWorkerTask que agora tem o "probe".

async function resolveConflictWithServerState(serverData: any) {
    console.group('⚔️ RESOLVENDO CONFLITO');
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
        
        if ((state as any).lastModified <= serverData.updatedAt) (state as any).lastModified = Date.now();
        
        await persistStateLocally(state as unknown as AppState);
        document.dispatchEvent(new CustomEvent('render-app'));
        syncStateWithCloud(state as unknown as AppState);
        console.log("✅ Conflito resolvido.");

    } catch (e: any) {
        console.error("❌ Falha na resolução de conflito:", e);
        state.syncLastError = "Merge Failed: " + e.message;
        setSyncStatus('syncError');
    } finally {
        console.groupEnd();
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
            if (res.status === 401) { clearLocalAuth(); return null; }
            throw new Error(`Fetch failed: ${res.status}`);
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
        console.error("[Cloud] Fetch failed:", e);
        state.syncLastError = "Decryption Failed";
        setSyncStatus('syncError');
        return null;
    }
}

export async function syncStateWithCloud(currentState: AppState, force = false) {
    if (!hasLocalSyncKey()) return;
    if (isSyncInProgress) { pendingSyncState = currentState; return; }
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => _performSync(currentState), DEBOUNCE_DELAY);
}

// FERRAMENTA DE TESTE MANUAL
(window as any).askesis_test_sync = () => {
    console.clear();
    console.log("🛠️ Forçando sincronização manual...");
    _performSync(state as AppState);
};