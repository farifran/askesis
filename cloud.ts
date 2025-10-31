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


/**
 * REFACTOR [2024-08-13]: Wrapper centralizado para chamadas à API.
 * Encapsula a construção da URL, a adição de cabeçalhos (como o de sincronização) e o tratamento
 * básico de erros de rede, aderindo ao princípio DRY.
 * @param endpoint O endpoint da API a ser chamado (ex: '/api/sync').
 * @param options As opções de `fetch` (método, corpo, etc.).
 * @returns Uma promessa que resolve para o objeto Response.
 * @throws Lança um erro se a resposta não for 'ok'.
 */
async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = getApiUrl(endpoint);
    const keyHash = await getSyncKeyHash();

    const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    if (keyHash) {
        headers['X-Sync-Key-Hash'] = keyHash;
    }

    const response = await fetch(url, { ...options, headers });

    if (!response.ok && response.status !== 409) { // 409 é um estado de conflito esperado, tratado pelo chamador
        const errorBody = await response.json().catch(() => ({ error: 'Falha ao analisar a resposta de erro', details: response.statusText }));
        throw new Error(`[${response.status}] ${errorBody.error || 'Erro de API'}: ${errorBody.details || ''}`);
    }

    return response;
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

/**
 * Executa a requisição de rede real para sincronizar o estado com a nuvem.
 * @param appState O estado da aplicação a ser sincronizado.
 */
async function performSync(appState: AppState) {
    const syncKey = getSyncKey();
    if (!syncKey) {
        setSyncStatus('syncError');
        console.error("Cannot sync without a sync key.");
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
        });

        if (response.status === 409) {
            // Conflito: o servidor tem dados mais recentes.
            const serverPayload: ServerPayload = await response.json();
            resolveConflictWithServerState(serverPayload);
        } else {
            // Sucesso (a verificação de response.ok já foi feita em apiFetch).
            setSyncStatus('syncSynced');
            document.dispatchEvent(new CustomEvent('habitsChanged')); // Notifica o emblema/etc para atualizar
        }
    } catch (error) {
        console.error("Error syncing state to cloud:", error);
        setSyncStatus('syncError');
    }
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    if (!hasSyncKey()) return undefined;

    const syncKey = getSyncKey();
    if (!syncKey) return undefined;

    try {
        const response = await apiFetch('/api/sync');
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
                await syncStateWithCloud(localState, { immediate: true });
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


// REFACTOR [2024-07-31]: Lógica de sincronização unificada. A função agora aceita uma
// opção `immediate` para lidar tanto com salvamentos debounced (padrão) quanto com
// sincronizações imediatas (necessárias durante a configuração inicial). Isso remove
// a necessidade da função redundante `syncLocalStateToCloud`.
export function syncStateWithCloud(appState: AppState, options: { immediate?: boolean } = {}) {
    if (!hasSyncKey()) {
        setSyncStatus('syncInitial');
        return;
    }
    
    setSyncStatus('syncSaving');

    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }

    if (options.immediate) {
        performSync(appState);
    } else {
        syncTimeout = window.setTimeout(() => {
            performSync(appState);
        }, DEBOUNCE_DELAY);
    }
}