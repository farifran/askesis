/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// FIX: Declare OneSignal to inform TypeScript that it exists in the global scope.
declare var OneSignal: any;

// FIX: Add global declaration for OneSignal on the window object to fix TypeScript error.
declare global {
    interface Window {
        OneSignal: any;
    }
}

// FIX: Import getTodayUTC from utils.ts instead of state.ts
import { AppState, STATE_STORAGE_KEY, loadState, state, shouldHabitAppearOnDate, getScheduleForDate, TIMES_OF_DAY, saveState } from './state';
import { getTodayUTC } from './utils';
import { ui } from './ui';
import { t } from './i18n';
import { getSyncKey, getSyncKeyHash, hasLocalSyncKey } from './sync';
import { renderApp } from './render';
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

    const syncKey = getSyncKey();
    if (!syncKey) {
        setSyncStatus('syncError');
        console.error("Cannot sync without a sync key.");
        return;
    }
    
    setSyncStatus('syncSaving');

    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }

    syncTimeout = window.setTimeout(async () => {
        try {
            const keyHash = await getSyncKeyHash();
            if (!keyHash) {
                 throw new Error("Could not generate sync key hash for saving.");
            }

            const stateJSON = JSON.stringify(appState);
            const encryptedState = await encrypt(stateJSON, syncKey);

            const payload = {
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
                const serverPayload = await response.json();
                resolveConflictWithServerState(serverPayload);
                return; // Para a execução após resolver o conflito.
            }

            if (response.ok) {
                setSyncStatus('syncSynced');
            } else {
                throw new Error(`Failed to sync state, status: ${response.status}`);
            }
        } catch (error) {
            console.error("Error syncing state to cloud:", error);
            setSyncStatus('syncError');
        }
    }, DEBOUNCE_DELAY);
}

// Função para fazer o upload único do estado local para a nuvem.
export async function syncLocalStateToCloud() {
    const localStateJSON = localStorage.getItem(STATE_STORAGE_KEY);
    if (!localStateJSON) return;

    const syncKey = getSyncKey();
    if (!syncKey) {
        throw new Error("Cannot perform initial sync without sync key.");
    }

    try {
        const keyHash = await getSyncKeyHash();
        if (!keyHash) {
             throw new Error("Could not generate sync key hash for initial sync.");
        }
        
        console.log("Found local state. Syncing to cloud...");
        const localState: AppState = JSON.parse(localStateJSON);
        
        // Garante que o estado local tenha um timestamp antes de sincronizar, para compatibilidade com versões antigas
        if (!localState.lastModified) {
            localState.lastModified = Date.now();
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(localState));
        }

        const stateJSON = JSON.stringify(localState);
        const encryptedState = await encrypt(stateJSON, syncKey);

        const payload = {
            lastModified: localState.lastModified,
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

        if (response.status === 409) { // Lida com conflitos durante a sincronização inicial
             const serverPayload = await response.json();
             resolveConflictWithServerState(serverPayload);
             return;
        }

        if (!response.ok) {
            throw new Error(`Initial sync failed with status ${response.status}`);
        }
        console.log("Initial sync successful.");
        setSyncStatus('syncSynced');

    } catch (error) {
        console.error("Error on initial sync to cloud:", error);
        setSyncStatus('syncError');
        // Lança o erro para que a função chamadora (fetchStateFromCloud) possa pegá-lo.
        throw error;
    }
}


// --- ONE SIGNAL NOTIFICATIONS ---

/**
 * Atualiza as tags do usuário no OneSignal com base nos hábitos agendados para HOJE.
 * Isso permite o direcionamento para lembretes via campanhas automatizadas do OneSignal.
 */
export function updateUserHabitTags() {
    OneSignal.push(async () => {
        try {
            if (!await OneSignal.Notifications.isPushEnabled()) {
                return;
            }

            const today = getTodayUTC();
            const tags: { [key: string]: string } = {};

            TIMES_OF_DAY.forEach(time => {
                const hasHabitForTime = state.habits.some(habit => {
                    if (shouldHabitAppearOnDate(habit, today)) {
                        const schedule = getScheduleForDate(habit, today);
                        return schedule?.times.includes(time);
                    }
                    return false;
                });
                const tagName = time.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                tags[`${tagName}_habits`] = String(hasHabitForTime);
            });

            console.log("Updating OneSignal tags for reminders:", tags);
            await OneSignal.User.addTags(tags);
        } catch (error) {
            console.error("Failed to update OneSignal tags:", error);
        }
    });
}

/**
 * Inicializa o SDK do OneSignal e configura toda a lógica de notificação.
 */
export function initNotifications() {
    window.OneSignal = window.OneSignal || [];
    OneSignal.push(async function() {
        
        // Esta função sincroniza a REALIDADE da inscrição para o nosso estado de aplicativo.
        // É usada para lidar com alterações externas (ex: configurações do navegador).
        const syncStateToSubscriptionReality = async () => {
            const isSubscribed = await OneSignal.Notifications.isPushEnabled();
            const permission = OneSignal.Notifications.getPermission();
            let needsSave = false;
            
            // Atualiza a aparência do toggle (estado desabilitado, texto)
            if (permission === 'denied') {
                ui.notificationToggleInput.disabled = true;
                ui.notificationToggleDesc.textContent = t('notificationsBlocked');
                // Se a permissão for negada, nosso estado do app deve refletir isso.
                if (state.notificationsEnabled) {
                    state.notificationsEnabled = false;
                    needsSave = true;
                }
            } else {
                ui.notificationToggleInput.disabled = false;
                ui.notificationToggleDesc.textContent = t('modalManageNotificationsDesc');
            }

            // Sincroniza o valor do estado em si
            if (state.notificationsEnabled !== isSubscribed) {
                state.notificationsEnabled = isSubscribed;
                needsSave = true;
            }

            // Atualiza o estado visual do toggle para corresponder à nova realidade
            ui.notificationToggleInput.checked = state.notificationsEnabled;
            
            if (needsSave) {
                saveState();
            }
        };

        // Esta função sincroniza a INSCRIÇÃO para corresponder ao estado do nosso app.
        // É usada para alterações internas (usuário clicando no toggle).
        const syncSubscriptionToState = async () => {
            // Nenhuma ação se a permissão não for concedida, para evitar prompts repetidos.
            if (OneSignal.Notifications.getPermission() !== 'granted') return;

            const isSubscribed = await OneSignal.Notifications.isPushEnabled();

            if (state.notificationsEnabled && !isSubscribed) {
                await OneSignal.User.pushSubscription.optIn();
                updateUserHabitTags(); // Atualiza as tags imediatamente após o opt-in
            } else if (!state.notificationsEnabled && isSubscribed) {
                await OneSignal.User.pushSubscription.optOut();
            }
        };
        
        // Listener para o USUÁRIO clicando no nosso toggle
        ui.notificationToggleInput.addEventListener('change', async (e: Event) => {
            const isEnabled = (e.target as HTMLInputElement).checked;
            
            // Passo 1: Atualiza o estado do aplicativo
            state.notificationsEnabled = isEnabled;
            
            // Passo 2: Salva o estado do aplicativo (local + aciona sincronização na nuvem)
            saveState();

            // Passo 3a: Se estiver ativando, podemos precisar pedir permissão.
            if (isEnabled) {
                await OneSignal.Notifications.requestPermission();
            }
            
            // Passo 3b: Sincroniza o serviço com o nosso novo estado
            await syncSubscriptionToState();
        });

        // Listener para alterações EXTERNAS na inscrição
        OneSignal.User.pushSubscription.addEventListener('change', syncStateToSubscriptionReality);
        
        // --- LÓGICA DE INICIALIZAÇÃO DO APLICATIVO ---

        // 1. Define o estado visual do toggle para a nossa preferência salva. Esta é a fonte da verdade.
        ui.notificationToggleInput.checked = state.notificationsEnabled;
        
        // 2. Sincroniza o serviço para corresponder à nossa preferência salva.
        await syncSubscriptionToState();

        // 3. Uma verificação final para alinhar a UI (especialmente o estado desabilitado) com a realidade após a tentativa de sincronização.
        // Isso garante que, se a permissão for negada, o toggle seja desabilitado corretamente.
        await syncStateToSubscriptionReality();
    });

    // Garante que, se os hábitos mudarem, as tags para direcionamento de notificações sejam atualizadas.
    document.addEventListener('habitsChanged', updateUserHabitTags);
}