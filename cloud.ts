/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { AppState, STATE_STORAGE_KEY, loadState, state, shouldHabitAppearOnDate, getEffectiveScheduleForHabitOnDate } from './state';
import { getTodayUTC, getTodayUTCIso, pushToOneSignal } from './utils';
import { ui } from './ui';
import { t } from './i18n';
import { getSyncKey, getSyncKeyHash, hasLocalSyncKey } from './sync';
import { renderApp, updateNotificationUI } from './render';
import { encrypt, decrypt } from './crypto';

// Debounce para evitar salvar na nuvem a cada pequena alteração.
let syncTimeout: number | null = null;
const DEBOUNCE_DELAY = 2000; // 2 segundos

// Interface para a carga de dados que o servidor manipula
interface ServerPayload {
    lastModified: number;
    state: string; // Esta é a string criptografada
}

/**
 * Constrói uma URL de API absoluta a partir de um endpoint relativo.
 * Isso garante que as chamadas de API funcionem corretamente, mesmo que a aplicação
 * seja servida a partir de um subdiretório.
 * @param endpoint O caminho da API, por exemplo, '/api/sync'.
 * @returns A URL completa da API.
 */
const getApiUrl = (endpoint: string): string => {
    return new URL(endpoint, window.location.origin).toString();
};

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial') {
    state.syncState = statusKey;
    ui.syncStatus.textContent = t(statusKey);
}

export function hasSyncKey(): boolean {
    return hasLocalSyncKey();
}

/**
 * Inicializa o SDK do OneSignal e configura os listeners de eventos relacionados a notificações.
 */
export function initNotifications() {
    // O script de nível de página do SDK do OneSignal já está incluído no index.html.
    // Agora o inicializamos aqui.
    pushToOneSignal((OneSignal: any) => {
        OneSignal.init({
            // IMPORTANTE: Substitua pelo seu App ID real do OneSignal.
            // Este é um valor de espaço reservado e não funcionará em produção.
            appId: "b2f7f966-d8cc-406a-a3a8-4c8d3d3a1e9c", // UUID de exemplo como placeholder
            safari_web_id: "web.onesignal.auto.12345678-1234-1234-1234-123456789012", // Placeholder de exemplo
            allowLocalhostAsSecureOrigin: true, // Útil para desenvolvimento local
        }).then(() => {
            // Este listener garante que a UI seja atualizada se o usuário alterar
            // as permissões de notificação nas configurações do navegador enquanto o app estiver aberto.
            OneSignal.Notifications.addEventListener('permissionChange', () => {
                // Adia a atualização da UI para dar tempo ao SDK de atualizar seu estado interno.
                setTimeout(updateNotificationUI, 500);
            });

            // Atualiza a UI no carregamento inicial, caso o estado já esteja definido.
            updateNotificationUI();
        });
    });
}

/**
 * Lida com um conflito de sincronização, onde o servidor tem uma versão mais recente dos dados.
 * Atualiza o estado local e a UI para corresponder à versão do servidor.
 * @param serverPayload O payload autoritativo (e criptografado) recebido do servidor.
 */
function resolveConflictWithServerState(serverPayload: ServerPayload) {
    console.warn("Sync conflict detected. Resolving with server data.");
    
    // 1. Para a operação de sincronização pendente (se houver).
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = null;

    const syncKey = getSyncKey();
    if (!syncKey) {
        console.error("Cannot resolve conflict without sync key.");
        setSyncStatus('syncError');
        return;
    }
    
    // 2. Decriptografa o estado do servidor.
    decrypt(serverPayload.state, syncKey)
        .then(decryptedStateJSON => {
            const serverState = JSON.parse(decryptedStateJSON) as AppState;
            
            // 3. Salva o estado do servidor (a fonte da verdade) no localStorage.
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(serverState));

            // 4. Carrega o novo estado na memória da aplicação.
            loadState(serverState); 
            
            // 5. Renderiza novamente toda a aplicação para refletir os dados atualizados.
            renderApp();
            
            // 6. Atualiza o status da UI para mostrar que a sincronização foi concluída.
            setSyncStatus('syncSynced');
            document.dispatchEvent(new CustomEvent('habitsChanged')); // Dispara atualização de tags de notificação
        })
        .catch(error => {
            console.error("Failed to decrypt server state during conflict resolution:", error);
            setSyncStatus('syncError');
        });
}

// FIX: Refactor sync logic into a reusable async function to allow for immediate sync.
/**
 * Performs the actual network request to sync state to the cloud.
 * This is separated from syncStateWithCloud to allow for immediate, non-debounced syncs.
 * @param appState The application state to sync.
 */
async function performSync(appState: AppState) {
    const syncKey = getSyncKey();
    if (!syncKey) {
        setSyncStatus('syncError');
        console.error("Cannot sync without a sync key.");
        return;
    }

    try {
        const keyHash = await getSyncKeyHash();
        if (!keyHash) {
             throw new Error("Could not generate sync key hash for saving.");
        }

        const stateJSON = JSON.stringify(appState);
        const encryptedState = await encrypt(stateJSON, syncKey);

        const payload: ServerPayload = {
            lastModified: appState.lastModified,
            state: encryptedState,
        };
        
        const response = await fetch(getApiUrl('/api/sync'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Sync-Key-Hash': keyHash
            },
            body: JSON.stringify(payload),
        });

        if (response.status === 409) {
            // Conflict: server has newer data.
            const serverPayload: ServerPayload = await response.json();
            resolveConflictWithServerState(serverPayload);
        } else if (!response.ok) {
            // Other server error.
            throw new Error(`Sync failed, status: ${response.status}`);
        } else {
            // Success.
            setSyncStatus('syncSynced');
            document.dispatchEvent(new CustomEvent('habitsChanged')); // Notify badge/etc to update
        }
    } catch (error) {
        console.error("Error syncing state to cloud:", error);
        setSyncStatus('syncError');
    }
}

/**
 * Reads the current state from localStorage and triggers an immediate sync to the cloud.
 */
async function syncLocalStateToCloud() {
    const localData = localStorage.getItem(STATE_STORAGE_KEY);
    if (localData) {
        try {
            const appState: AppState = JSON.parse(localData);
            await performSync(appState);
        } catch (e) {
            console.error("Failed to parse local state for initial sync", e);
            setSyncStatus('syncError');
        }
    }
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    if (!hasSyncKey()) return undefined;

    const syncKey = getSyncKey();
    if (!syncKey) return undefined;

    try {
        const keyHash = await getSyncKeyHash();
        if (!keyHash) {
            throw new Error("Could not generate sync key hash.");
        };

        const response = await fetch(getApiUrl('/api/sync'), {
            headers: {
                'X-Sync-Key-Hash': keyHash
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch state, status: ${response.status}`);
        }

        const data: ServerPayload | null = await response.json();

        if (data && data.state) {
            const decryptedStateJSON = await decrypt(data.state, syncKey);
            const appState = JSON.parse(decryptedStateJSON) as AppState;
            setSyncStatus('syncSynced');
            return appState;
        } else {
            // Nenhum dado na nuvem (resposta foi 200 com corpo nulo)
            console.log("No state found in cloud for this sync key. Performing initial sync.");
            const localData = localStorage.getItem(STATE_STORAGE_KEY);
            if (localData) {
                // Aguardamos para garantir que a sincronização inicial seja concluída e para tratar quaisquer erros.
                // FIX: Call the newly created syncLocalStateToCloud function.
                await syncLocalStateToCloud();
            }
            return undefined;
        }
    } catch (error) {
        console.error("Error fetching/decrypting state from cloud:", error);
        setSyncStatus('syncError');
        // Lança novamente o erro para que a função chamadora possa lidar com ele (ex: chave incorreta).
        throw error;
    }
}

export function syncStateWithCloud(appState: AppState) {
    if (!hasSyncKey()) {
        setSyncStatus('syncInitial');
        return;
    }
    
    setSyncStatus('syncSaving');

    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }

    // FIX: Use the refactored performSync function within the debounce timeout.
    syncTimeout = window.setTimeout(() => {
        performSync(appState);
    }, DEBOUNCE_DELAY);
}