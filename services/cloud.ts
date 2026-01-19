
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * VERSÃO: V18.6 - Robust Error Handling
 */

import { AppState, state, getPersistableState } from '../state';
import { persistStateLocally } from './persistence';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch } from './api';
import { encrypt, decrypt } from './crypto';
import { mergeStates } from './dataMerge';
import { compressToBuffer, decompressFromBuffer, decompressString } from '../utils';

const DEBOUNCE_DELAY = 2000;
let syncTimeout: any = null;
let isSyncInProgress = false;

// --- SERIALIZATION ENGINE ---

function _jsonReplacer(key: string, value: any): any {
    if (typeof value === 'bigint') {
        return { __type: 'bigint', val: value.toString() };
    }
    if (value instanceof Map) {
        return { __type: 'map', val: Array.from(value.entries()) };
    }
    return value;
}

function _jsonReviver(key: string, value: any): any {
    if (value && typeof value === 'object' && value.__type) {
        if (value.__type === 'bigint') {
            return BigInt(value.val);
        }
        if (value.__type === 'map') {
            return new Map(value.val);
        }
    }
    return value;
}

// --- VIRTUAL WORKER TASKS (Main Thread Async) ---

const TASKS: Record<string, (payload: any) => Promise<any> | any> = {
    'build-ai-prompt': (payload: any) => {
        const { analysisType, languageName, translations } = payload;
        return {
            prompt: `[${languageName}] ${analysisType} Analysis.\nContext: ${JSON.stringify(payload.dailyData || {})}`,
            systemInstruction: translations.aiSystemInstruction || "Act as a Stoic Mentor."
        };
    },
    'build-quote-analysis-prompt': (payload: any) => {
        return {
            prompt: payload.translations.aiPromptQuote.replace('{notes}', payload.notes).replace('{theme_list}', payload.themeList),
            systemInstruction: payload.translations.aiSystemInstructionQuote
        };
    },
    'archive': async (payload: any) => {
        // Payload: Record<year, { additions: DailyData, base: string|Uint8Array|Object }>
        const result: Record<string, Uint8Array> = {};
        const years = Object.keys(payload);

        for (const year of years) {
            const { additions, base } = payload[year];
            let baseObj = {};

            // 1. Hydrate Base (Decompress if needed)
            if (base) {
                if (typeof base === 'object' && !(base instanceof Uint8Array)) {
                    baseObj = base; // Already hydrated (from cache)
                } else {
                    try {
                        let jsonStr = '';
                        if (base instanceof Uint8Array) {
                            jsonStr = await decompressFromBuffer(base);
                        } else if (typeof base === 'string') {
                            // Legacy support
                            jsonStr = base.startsWith('GZIP:') 
                                ? await decompressString(base.substring(5))
                                : base;
                        }
                        baseObj = JSON.parse(jsonStr);
                    } catch (e) {
                        console.warn(`[Cloud] Archive corruption for ${year}, resetting base.`, e);
                        baseObj = {};
                    }
                }
            }

            // 2. Merge Additions
            const merged = { ...baseObj, ...additions };

            // 3. Compress Result (GZIP Buffer)
            // This ensures state.archives remains lightweight
            try {
                const compressed = await compressToBuffer(JSON.stringify(merged));
                result[year] = compressed;
            } catch (e) {
                console.error(`[Cloud] Compression failed for ${year}`, e);
                // In worst case, we lose the archive optimization but save data
                // Note: The app expects Uint8Array or String in archives.
                // We'll throw to prevent saving corrupted state.
                throw e;
            }
        }
        return result;
    },
    'prune-habit': (payload: any) => {
        // Simplificado: Apenas retorna os arquivos como estão,
        // pois a limpeza real de chaves órfãs é complexa sem descompressão total.
        // Em V18, aceitamos manter dados órfãos em archives (cold storage) para evitar overhead de CPU.
        return payload.archives;
    }
};

export function runWorkerTask<T>(type: string, payload: any): Promise<T> {
    return new Promise((resolve, reject) => {
        // Scheduler API or SetTimeout
        const scheduler = (window as any).scheduler;
        const runner = async () => {
            try {
                const handler = TASKS[type];
                if (!handler) throw new Error(`Unknown task: ${type}`);
                const result = await handler(payload);
                resolve(result);
            } catch (e) {
                reject(e);
            }
        };

        if (scheduler?.postTask) {
            scheduler.postTask(runner, { priority: 'background' });
        } else {
            setTimeout(runner, 0);
        }
    });
}

export function prewarmWorker() {}

// --- SYNC STATUS UI ---

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

// --- CLOUD SYNC CORE ---

export async function downloadRemoteState(key: string): Promise<AppState | null> {
    try {
        const res = await apiFetch('/api/sync', { method: 'GET' }, true);
        
        if (res.status === 404) return null;
        if (res.status === 401) throw new Error("Chave Inválida (401)");
        if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);

        const data = await res.json();
        if (!data || !data.state) return null;

        const jsonString = await decrypt(data.state, key);
        return JSON.parse(jsonString, _jsonReviver);

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
        
        const remoteState = await downloadRemoteState(key);
        
        if (!remoteState) {
            setSyncStatus('syncSynced');
            return null;
        }

        const localState = getPersistableState();
        // Fix: Ensure Maps exist for merge
        if (!localState.monthlyLogs && state.monthlyLogs) {
            localState.monthlyLogs = state.monthlyLogs;
        }

        const mergedState = await mergeStates(localState, remoteState);

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
        rawState.monthlyLogs = state.monthlyLogs;

        const jsonString = JSON.stringify(rawState, _jsonReplacer);
        const encryptedData = await encrypt(jsonString, key);

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
            // AUTO-MERGE STRATEGY: Pull, Merge, then (implicitly) user can save again later.
            await fetchStateFromCloud(); 
        } else if (res.status === 413) {
            throw new Error("Dados muito grandes (413).");
        } else if (res.status === 401) {
            throw new Error("Não autorizado (401). Verifique a chave.");
        } else if (!res.ok) {
            throw new Error(`Erro Servidor: ${res.status}`);
        } else {
            setSyncStatus('syncSynced');
            state.syncLastError = null;
        }

    } catch (e: any) {
        console.error("Sync Push Failed:", e);
        if (e instanceof TypeError && e.message.includes('BigInt')) {
            state.syncLastError = "Erro de Serialização";
        } else {
            state.syncLastError = e.message || "Erro de Conexão";
        }
        setSyncStatus('syncError');
    } finally {
        isSyncInProgress = false;
    }
}

export function syncStateWithCloud(currentState?: AppState, immediate = false) {
    if (!hasLocalSyncKey()) return;
    
    if (syncTimeout) clearTimeout(syncTimeout);
    
    if (immediate) {
        console.log("[Cloud] Immediate sync trigger.");
        _performSync();
    } else {
        syncTimeout = setTimeout(() => _performSync(), DEBOUNCE_DELAY);
    }
}

if (hasLocalSyncKey()) {
    setTimeout(fetchStateFromCloud, 1500);
}
