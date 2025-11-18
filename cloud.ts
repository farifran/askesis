/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído.
// O que foi feito: O módulo de sincronização foi totalmente robustecido. Na primeira etapa (50%), a função de resolução de conflitos foi refatorada para async/await, melhorando a legibilidade e o tratamento de erros. Nesta etapa final, um mecanismo de travamento foi implementado para prevenir condições de corrida durante a sincronização, garantindo que as operações de salvamento na nuvem ocorram sequencialmente e que o estado mais recente seja sempre o que está na fila para ser salvo.
// O que falta: Nenhuma análise futura é necessária. O módulo é considerado finalizado.
import { AppState, STATE_STORAGE_KEY, loadState, state } from './state';
import { pushToOneSignal, apiFetch } from './utils';
import { ui } from './ui';
import { t } from './i18n';
import { getSyncKey, hasLocalSyncKey } from './sync';
import { renderApp, updateNotificationUI } from './render';
import { encrypt, decrypt } from './crypto';

// Debounce para evitar salvar na nuvem a cada pequena alteração.
let syncTimeout: number | null = null;
const DEBOUNCE_DELAY = 2000; // 2 segundos

// MELHORIA DE ROBUSTEZ: Variáveis de estado para prevenir condições de corrida de sincronização.
let isSyncInProgress = false;
let pendingSyncState: AppState | null = null;


// Interface para a carga de dados que o servidor manipula
interface ServerPayload {
    lastModified: number;
    state: string; // Esta é a string criptografada
}

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial') {
    state.syncState = statusKey;
    ui.syncStatus.textContent = t(statusKey);
}

export function hasSyncKey(): boolean {
    return hasLocalSyncKey();
}

/**
 * Configura os listeners de notificação e atualiza a UI inicial.
 */
export function setupNotificationListeners() {
    // A inicialização do SDK do OneSignal agora é feita diretamente no index.html.
    // Esta função apenas anexa os listeners de eventos necessários para a UI.
    pushToOneSignal((OneSignal: any) => {
        // Este listener garante que a UI seja atualizada se o usuário alterar
        // as permissões de notificação nas configurações do navegador enquanto o app estiver aberto.
        OneSignal.Notifications.addEventListener('permissionChange', () => {
            // Adia a atualização da UI para dar tempo ao SDK de atualizar seu estado interno.
            setTimeout(updateNotificationUI, 500);
        });

        // Atualiza a UI no carregamento inicial, caso o estado já esteja definido.
        updateNotificationUI();
    });
}


/**
 * Lida com um conflito de sincronização, onde o servidor tem uma versão mais recente dos dados.
 * Atualiza o estado local e a UI para corresponder à versão do servidor.
 * @param serverPayload O payload autoritativo (e criptografado) recebido do servidor.
 */
async function resolveConflictWithServerState(serverPayload: ServerPayload) {
    console.warn("Sync conflict detected. Resolving with server data.");
    
    const syncKey = getSyncKey();
    if (!syncKey) {
        console.error("Cannot resolve conflict without sync key.");
        setSyncStatus('syncError');
        return;
    }
    
    try {
        const decryptedStateJSON = await decrypt(serverPayload.state, syncKey);
        
        let serverState: AppState;
        try {
            serverState = JSON.parse(decryptedStateJSON);
        } catch (e) {
            console.error("Failed to parse decrypted server state during conflict resolution:", e);
            throw new Error("Corrupted server data received.");
        }
        
        localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(serverState));
        loadState(serverState); 
        renderApp();
        setSyncStatus('syncSynced');
        document.dispatchEvent(new CustomEvent('habitsChanged'));
    } catch (error) {
        console.error("Failed to resolve conflict with server state:", error);
        setSyncStatus('syncError');
    }
}

/**
 * Executa a requisição de rede real para sincronizar o estado com a nuvem.
 */
async function performSync() {
    if (isSyncInProgress || !pendingSyncState) {
        return;
    }

    isSyncInProgress = true;
    const appState = pendingSyncState;
    pendingSyncState = null; // Consome o estado pendente

    const syncKey = getSyncKey();
    if (!syncKey) {
        setSyncStatus('syncError');
        console.error("Cannot sync without a sync key.");
        isSyncInProgress = false; // Libera a trava
        return;
    }

    try {
        const stateJSON = JSON.stringify(appState);
        const encryptedState = await encrypt(stateJSON, syncKey);

        const payload: ServerPayload = {
            lastModified: appState.lastModified,
            state: encryptedState,
        };
        
        const response = await apiFetch('/api/sync', {
            method: 'POST',
            body: JSON.stringify(payload),
        }, true);

        if (response.status === 409) {
            // Conflito: o servidor tem dados mais recentes.
            const serverPayload: ServerPayload = await response.json();
            await resolveConflictWithServerState(serverPayload);
        } else {
            // Sucesso (a verificação de response.ok já foi feita em apiFetch).
            setSyncStatus('syncSynced');
            document.dispatchEvent(new CustomEvent('habitsChanged')); // Notifica o emblema/etc para atualizar
        }
    } catch (error) {
        console.error("Error syncing state to cloud:", error);
        setSyncStatus('syncError');
    } finally {
        isSyncInProgress = false;
        // Se um novo estado foi salvo enquanto a sincronização estava em andamento,
        // aciona uma nova sincronização imediatamente para processar a fila.
        if (pendingSyncState) {
            if (syncTimeout) clearTimeout(syncTimeout);
            performSync();
        }
    }
}

// FIX: Add missing syncStateWithCloud function.
/**
 * Schedules a state sync to the cloud. This is debounced and handles a sync-in-progress lock.
 * @param appState The application state to sync.
 * @param immediate If true, performs the sync immediately, bypassing the debounce timer.
 */
export function syncStateWithCloud(appState: AppState, immediate = false) {
    if (!hasSyncKey()) return;

    pendingSyncState = appState; // Sempre atualiza para o estado mais recente.
    setSyncStatus('syncSaving');

    if (syncTimeout) clearTimeout(syncTimeout);
    
    // Se uma sincronização já estiver em andamento, o bloco `finally` de `performSync`
    // cuidará de acionar a próxima. Não precisamos fazer nada aqui.
    if (isSyncInProgress) {
        return;
    }

    if (immediate) {
        performSync();
    } else {
        syncTimeout = window.setTimeout(performSync, DEBOUNCE_DELAY);
    }
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    if (!hasSyncKey()) return undefined;

    const syncKey = getSyncKey();
    if (!syncKey) return undefined;

    try {
        const response = await apiFetch('/api/sync', {}, true);
        const data: ServerPayload | null = await response.json();

        if (data && data.state) {
            const decryptedStateJSON = await decrypt(data.state, syncKey);
            const appState = JSON.parse(decryptedStateJSON) as AppState;
            setSyncStatus('syncSynced');
            return appState;
        } else {
            // Nenhum dado na nuvem (resposta foi 200 com corpo nulo)
            console.log("No state found in cloud for this sync key. Performing initial sync.");
            const localDataJSON = localStorage.getItem(STATE_STORAGE_KEY);
            if (localDataJSON) {
                // REFACTOR [2024-07-31]: A sincronização inicial agora usa a função unificada
                // `syncStateWithCloud` com a opção `immediate`.
                const localState = JSON.parse(localDataJSON) as AppState;
                syncStateWithCloud(localState, true);
            }
            return undefined;
        }
    } catch (error) {
        console.error("Failed to fetch state from cloud:", error);
        setSyncStatus('syncError');
        throw error;
    }
}