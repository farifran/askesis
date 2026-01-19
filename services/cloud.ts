/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * VERSÃO: Robust Type Handling & Direct Crypto
 */

import { AppState, state, getPersistableState } from '../state';
import { persistStateLocally } from './persistence';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch } from './api';
import { encrypt, decrypt } from './crypto';
import { mergeStates } from './dataMerge';

const DEBOUNCE_DELAY = 2000;
let syncTimeout: any = null;
let isSyncInProgress = false;

// --- TYPE SAFETY UTILS ---

/**
 * Converte o Map de BigInts para um objeto serializável (para encrypt/JSON).
 */
function _serializeLogs(map: Map<string, bigint> | undefined): Record<string, string> {
    if (!map) return {};
    const obj: Record<string, string> = {};
    for (const [k, v] of map.entries()) {
        obj[k] = v.toString(); // BigInt -> String
    }
    return obj;
}

/**
 * Reconstrói o Map de BigInts a partir do objeto JSON recebido.
 * CRÍTICO: Garante que strings numéricas virem BigInts reais.
 */
function _deserializeLogs(obj: any): Map<string, bigint> {
    const map = new Map<string, bigint>();
    if (obj && typeof obj === 'object') {
        try {
            Object.entries(obj).forEach(([k, v]) => {
                if (v) {
                    try {
                        map.set(k, BigInt(v as string | number));
                    } catch (e) {
                        console.warn(`[Cloud] Invalid log entry for ${k}:`, v);
                    }
                }
            });
        } catch (e) {
            console.error("[Cloud] Log Deserialization Failed", e);
        }
    }
    return map;
}

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial' | 'syncing') {
    state.syncState = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    const displayKey = statusKey === 'syncing' ? 'syncSaving' : statusKey;
    
    if (ui.syncStatus) ui.syncStatus.textContent = t(displayKey);
    
    if (statusKey === 'syncError' && ui.syncErrorMsg) {
        ui.syncErrorMsg.textContent = state.syncLastError || t('syncError');
        ui.syncErrorMsg.classList.remove('hidden');
    } else if (ui.syncErrorMsg) {
        ui.syncErrorMsg.classList.add('hidden');
    }
}

// Deprecated Worker Stub
export function runWorkerTask<T>(type: string, payload: any): Promise<T> {
    return Promise.reject(new Error("Worker tasks deprecated."));
}
export function prewarmWorker() {}

// --- CORE FUNCTIONS ---

/**
 * Baixa, decifra e HIDRATA o estado da nuvem.
 * Retorna um AppState pronto para uso (com Maps instanciados).
 */
export async function downloadRemoteState(key: string): Promise<AppState | null> {
    try {
        const res = await apiFetch('/api/sync', { method: 'GET' }, true);
        
        if (res.status === 404) return null; // Novo usuário
        if (res.status === 401) throw new Error("Chave Inválida");
        if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);

        const data = await res.json();
        if (!data || !data.state) return null;

        // 1. Decriptar
        const jsonString = await decrypt(data.state, key);
        const incomingState = JSON.parse(jsonString);

        // 2. Hidratação de Maps (Logs)
        // Se monthlyLogs vier como objeto simples, converte para Map<string, bigint>
        if (incomingState.monthlyLogs && !(incomingState.monthlyLogs instanceof Map)) {
            incomingState.monthlyLogs = _deserializeLogs(incomingState.monthlyLogs);
        }

        return incomingState;

    } catch (e) {
        console.error("Download/Decrypt Failed:", e);
        throw e;
    }
}

export async function fetchStateFromCloud(): Promise<AppState | null> {
    if (!hasLocalSyncKey()) return null;
    const key = getSyncKey();
    if (!key) return null;

    try {
        setSyncStatus('syncing');
        
        // 1. Baixar Remoto
        const remoteState = await downloadRemoteState(key);
        
        if (!remoteState) {
            setSyncStatus('syncSynced');
            return null; // Nuvem vazia
        }

        // 2. Merge Inteligente
        const localState = getPersistableState();
        const mergedState = await mergeStates(localState, remoteState);

        // 3. Persistir e Atualizar UI
        Object.assign(state, mergedState);
        await persistStateLocally(mergedState);
        
        document.dispatchEvent(new CustomEvent('render-app'));
        setSyncStatus('syncSynced');
        
        return mergedState;

    } catch (e: any) {
        console.error("Cloud Pull Failed:", e);
        state.syncLastError = e.message;
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
        
        // Prepara para envio: Converte Map -> Object
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
            console.warn("Conflict (409). Pulling newer version...");
            await fetchStateFromCloud(); // Auto-heal: Baixa, mescla, e o próximo sync enviará o merge
        } else if (!res.ok) {
            throw new Error(`Server Error: ${res.status}`);
        } else {
            setSyncStatus('syncSynced');
            state.syncLastError = null;
        }

    } catch (e: any) {
        console.error("Sync Push Failed:", e);
        state.syncLastError = e.message;
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

// Inicialização segura
if (hasLocalSyncKey()) {
    // Delay pequeno para garantir que a UI já montou
    setTimeout(fetchStateFromCloud, 1500);
}