/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file cloud.ts
 * @description Orquestrador de Sincronização e Ponte para Web Workers (Main Thread Client).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo roda na thread principal (UI), mas sua função primária é **delegar** processamento pesado.
 * Atua como o "Cliente" para o `sync.worker.ts` e gerencia a máquina de estados da sincronização.
 * 
 * ARQUITETURA (Worker Bridge & Mutex):
 * - **Responsabilidade Única:** Gerenciar o ciclo de vida da sincronização (Rede + Criptografia) e comunicação com Workers.
 * - **Off-Main-Thread Architecture:** Garante que Criptografia (AES-GCM), Parsing de JSON massivo e 
 *   construção de prompts de IA ocorram em uma thread separada para manter a UI em 60fps (Zero Jank).
 * - **Controle de Concorrência:** Implementa um Mutex lógico (`isSyncInProgress`) e Debouncing 
 *   para evitar condições de corrida em rede e sobrecarga de bateria.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `sync.worker.ts`: O script do worker (deve coincidir com a saída do build).
 * - `services/dataMerge.ts`: Algoritmo de resolução de conflitos (Smart Merge).
 * - `services/api.ts`: Transporte HTTP.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Lazy Worker Instantiation:** O Worker consome memória significativa. Só é criado quando necessário.
 * 2. **Promise-based Messaging:** Abstrai a complexidade de `postMessage` em chamadas `async/await` lineares.
 * 3. **Recursive Queueing:** Se o estado muda durante uma sincronização, uma nova sincronização é agendada automaticamente.
 */

import { AppState, state, getPersistableState } from '../state';
import { loadState, persistStateLocally } from './persistence';
import { generateUUID } from '../utils';
import { ui } from '../render/ui';
import { t } from '../i18n';
import { hasLocalSyncKey, getSyncKey, apiFetch } from './api';
import { mergeStates } from './dataMerge';

// PERFORMANCE: Debounce para evitar salvar na nuvem a cada pequena alteração (ex: digitar uma nota).
// Reduz chamadas de API e overhead de criptografia (bateria).
let syncTimeout: number | null = null;
const DEBOUNCE_DELAY = 2000; // 2 segundos
const WORKER_TIMEOUT_MS = 30000; // 30s Hard Timeout para tarefas do Worker

// CRITICAL LOGIC: Mutex de Sincronização.
// Variáveis de estado para prevenir condições de corrida (Race Conditions) na rede.
// Garante que apenas uma operação de sync ocorra por vez.
let isSyncInProgress = false;
let pendingSyncState: AppState | null = null;

// --- WORKER INFRASTRUCTURE [2025-02-28] ---
// Singleton lazy-loaded worker instance.
let syncWorker: Worker | null = null;
// Map para correlacionar requisições e respostas do Worker via IDs únicos.
const workerCallbacks = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void }>();

function terminateWorker() {
    if (syncWorker) {
        syncWorker.terminate();
        syncWorker = null;
    }
    // Reject all pending callbacks to unblock UI
    for (const [id, callback] of workerCallbacks.entries()) {
        callback.reject(new Error("Worker terminated."));
    }
    workerCallbacks.clear();
}

function getWorker(): Worker {
    // PERFORMANCE: Lazy Loading.
    // Só instanciamos o worker se e quando for necessário (ex: usuário ativa sync ou pede análise IA).
    // Isso economiza memória e tempo de boot para usuários locais.
    if (!syncWorker) {
        // O nome do arquivo deve corresponder à saída configurada no build.js
        syncWorker = new Worker('./sync-worker.js', { type: 'module' });
        
        // Configura o listener global para receber respostas do worker
        syncWorker.onmessage = (e) => {
            const { id, status, result, error } = e.data;
            // Correlaciona a resposta com a promessa original via ID
            const callback = workerCallbacks.get(id);
            if (callback) {
                if (status === 'success') {
                    callback.resolve(result);
                } else {
                    callback.reject(new Error(error));
                }
                workerCallbacks.delete(id);
            }
        };
        
        // ROBUSTEZ: Tratamento de falhas catastróficas do Worker.
        syncWorker.onerror = (e) => {
            console.error("Critical Worker Error:", e);
            terminateWorker();
        };
    }
    return syncWorker;
}

/**
 * PERFORMANCE: Pré-aquece o Worker.
 * Deve ser chamado quando o usuário entra em fluxos que certamente usarão criptografia ou IA em breve.
 */
export function prewarmWorker() {
    getWorker();
}

/**
 * Ponte de comunicação assíncrona com o Worker com TIMEOUT DE SEGURANÇA.
 * Envia uma tarefa e retorna uma Promise que resolve quando o Worker responder.
 * 
 * @param type Tipo da operação.
 * @param payload Dados para processamento.
 * @param key (Opcional) Chave de criptografia/sincronização.
 */
export function runWorkerTask<T>(
    type: 'encrypt' | 'decrypt' | 'build-ai-prompt' | 'archive' | 'prune-habit', 
    payload: any, 
    key?: string
): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = generateUUID();
        const worker = getWorker();
        
        // SAFETY: Timeout para evitar Deadlocks se o Worker travar silenciosamente.
        const timeoutId = setTimeout(() => {
            if (workerCallbacks.has(id)) {
                // RECOVERY LOGIC [2025-05-02]: Se atingir o timeout, assumimos que o Worker morreu ou travou.
                // 1. Removemos esta callback específica para rejeitar com erro de timeout preciso.
                workerCallbacks.delete(id);
                reject(new Error(`Worker task '${type}' timed out after ${WORKER_TIMEOUT_MS}ms`));
                
                // 2. Matamos o Worker atual para limpar o estado e rejeitar outras pendências com "Worker terminated".
                // Isso garante que a próxima chamada a getWorker() crie uma nova instância fresca (Auto-Restart).
                console.warn(`Worker unresponsive during '${type}'. Terminating to force restart.`);
                terminateWorker();
            }
        }, WORKER_TIMEOUT_MS);

        // Armazena os handlers da Promise.
        workerCallbacks.set(id, { 
            resolve: (val) => {
                clearTimeout(timeoutId);
                resolve(val);
            }, 
            reject: (err) => {
                clearTimeout(timeoutId);
                reject(err);
            } 
        });

        worker.postMessage({ id, type, payload, key });
    });
}

// Interface para a carga de dados que o servidor manipula (Blob opaco)
interface ServerPayload {
    lastModified: number;
    state: string; // Esta é a string criptografada
}

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial') {
    state.syncState = statusKey;
    // PERFORMANCE: Atualização direta do DOM, ignorando o ciclo de renderização completo se possível.
    // ViewModel Pattern: Cloud service updates UI state directly for performance, 
    // bypassing full render loop for status text.
    if (ui.syncStatus) {
        ui.syncStatus.textContent = t(statusKey);
    }
}

/**
 * Lida com um conflito de sincronização, onde o servidor tem uma versão mais recente dos dados.
 */
async function resolveConflictWithServerState(serverPayload: ServerPayload) {
    console.warn("Sync conflict detected. Initiating Smart Merge sequence.");
    
    const syncKey = getSyncKey();
    if (!syncKey) {
        console.error("Cannot resolve conflict without sync key.");
        setSyncStatus('syncError');
        return;
    }
    
    try {
        // Worker Offload Crítico.
        const serverState = await runWorkerTask<AppState>('decrypt', serverPayload.state, syncKey);

        // 1. Snapshot do estado local atual
        const localState = getPersistableState();

        // 2. Executa a fusão (Main Thread - Lógica Pura)
        const mergedState = mergeStates(localState, serverState);
        console.log("Smart Merge completed successfully.");

        // 3. Persiste e Carrega o novo estado unificado
        await persistStateLocally(mergedState);
        await loadState(mergedState);
        
        // 4. Atualiza a UI via Event Bus (Desacoplamento)
        document.dispatchEvent(new CustomEvent('render-app'));
        setSyncStatus('syncSynced');
        document.dispatchEvent(new CustomEvent('habitsChanged'));

        // 5. CRÍTICO: Push back.
        syncStateWithCloud(mergedState, true);
        
    } catch (error) {
        console.error("Failed to resolve conflict with server state:", error);
        setSyncStatus('syncError');
    }
}

/**
 * Executa a requisição de rede real para sincronizar o estado com a nuvem.
 * CRITICAL LOGIC: Implementa um Mutex (isSyncInProgress) para serializar os salvamentos.
 */
async function performSync() {
    // Race Condition Guard.
    if (isSyncInProgress || !pendingSyncState) {
        return;
    }

    // Lock Mutex
    isSyncInProgress = true;
    const appState = pendingSyncState;
    pendingSyncState = null; // Consome o estado pendente.

    const syncKey = getSyncKey();
    if (!syncKey) {
        setSyncStatus('syncError');
        isSyncInProgress = false; // Release Mutex
        return;
    }

    try {
        // 1. Criptografia no Worker (com Timeout de segurança)
        const encryptedState = await runWorkerTask<string>('encrypt', appState, syncKey);

        const payload: ServerPayload = {
            lastModified: appState.lastModified,
            state: encryptedState,
        };
        
        // 2. Network IO
        const response = await apiFetch('/api/sync', {
            method: 'POST',
            body: JSON.stringify(payload),
        }, true);

        if (response.status === 409) {
            const serverPayload: ServerPayload = await response.json();
            await resolveConflictWithServerState(serverPayload);
        } else {
            setSyncStatus('syncSynced');
            document.dispatchEvent(new CustomEvent('habitsChanged'));
        }
    } catch (error) {
        console.error("Error syncing state to cloud:", error);
        setSyncStatus('syncError');
        
        // FAIL-SAFE: Se falhar (ex: worker timeout), re-agendamos o estado que falhou
        // para não perder dados, a menos que um mais novo já tenha entrado na fila.
        if (!pendingSyncState) {
            pendingSyncState = appState;
        }
    } finally {
        // Release Mutex
        isSyncInProgress = false;
        
        // Queue Processing (Recursion).
        if (pendingSyncState) {
            if (syncTimeout) clearTimeout(syncTimeout);
            performSync();
        }
    }
}

/**
 * Agenda uma sincronização com a nuvem.
 */
export function syncStateWithCloud(appState: AppState, immediate = false) {
    if (!hasLocalSyncKey()) return;

    pendingSyncState = appState; // Last Write Wins local.
    setSyncStatus('syncSaving');

    if (syncTimeout) clearTimeout(syncTimeout);
    
    if (isSyncInProgress) {
        // Se já está rodando, o loop recursivo no finally de performSync cuidará do pendingSyncState.
        return;
    }

    if (immediate) {
        performSync();
    } else {
        syncTimeout = window.setTimeout(performSync, DEBOUNCE_DELAY);
    }
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    if (!hasLocalSyncKey()) return undefined;

    const syncKey = getSyncKey();
    if (!syncKey) return undefined;

    // PERFORMANCE [2025-04-14]: Speculative Worker Pre-warming (SOPA).
    // Inicia o carregamento e parsing do Worker em paralelo com a requisição de rede.
    // Isso remove o "tempo morto" de inicialização do worker após o retorno da API.
    prewarmWorker();

    try {
        const response = await apiFetch('/api/sync', {}, true);
        const data: ServerPayload | null = await response.json();

        if (data && data.state) {
            // Decriptografia no Worker
            const appState = await runWorkerTask<AppState>('decrypt', data.state, syncKey);
            setSyncStatus('syncSynced');
            return appState;
        } else {
            console.log("No state found in cloud. Performing initial sync.");
            if (state.habits.length > 0 || Object.keys(state.dailyData).length > 0) {
                syncStateWithCloud(getPersistableState(), true);
            }
            return undefined;
        }
    } catch (error) {
        console.error("Failed to fetch state from cloud:", error);
        setSyncStatus('syncError');
        throw error;
    }
}