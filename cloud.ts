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
export function updateOneSignalTags() {
    pushToOneSignal((OneSignal: any) => {
        // Só podemos enviar tags se o usuário tiver concedido permissão.
        if (OneSignal.Notifications.permission !== 'granted') {
            console.log('OneSignal: Permissão não concedida, pulando atualização de tags.');
            return;
        }

        const today = getTodayUTC();
        const todayISO = getTodayUTCIso();

        const activeHabitsToday = state.habits.filter(h =>
            !h.graduatedOn && shouldHabitAppearOnDate(h, today)
        );

        const tags: { [key: string]: boolean } = {
            'has_habit_morning': false,
            'has_habit_afternoon': false,
            'has_habit_evening': false,
        };

        const timeToTagMap: Record<string, keyof typeof tags> = {
            'Manhã': 'has_habit_morning',
            'Tarde': 'has_habit_afternoon',
            'Noite': 'has_habit_evening',
        };

        activeHabitsToday.forEach(habit => {
            const scheduleForDay = getEffectiveScheduleForHabitOnDate(habit, todayISO);
            scheduleForDay.forEach(time => {
                const tagName = timeToTagMap[time];
                if (tagName) {
                    tags[tagName] = true;
                }
            });
        });
        
        console.log('Atualizando tags do OneSignal:', tags);
        OneSignal.User.addTags(tags);
    });
}

/**
 * Inicializa o SDK do OneSignal e configura o estado inicial do toggle de notificação.
 */
export function initNotifications() {
    pushToOneSignal(function(OneSignal: any) {
        OneSignal.init({
            appId: "39454655-f1cd-4531-8ec5-d0f61eb1c478",
            serviceWorkerPath: "sw.js",
            promptOptions: {
                customlink: {
                    enabled: true,
                    style: "button",
                    size: "medium",
                    text: {
                        "subscribe": t('notificationEnableButton'),
                        "unsubscribe": t('notificationDisableButton'),
                    },
                    selector: ".onesignal-customlink-container"
                }
            }
        }).then(() => {
            // Após a inicialização, defina o idioma e adicione os listeners
            OneSignal.User.setLanguage(state.activeLanguageCode);

            OneSignal.Notifications.addEventListener('permissionChange', (isGranted: boolean) => {
                updateNotificationUI();
                if (isGranted) {
                    updateOneSignalTags();
                }
            });

            document.addEventListener('habitsChanged', updateOneSignalTags);
            
            // Atualização inicial da UI e sincronização de tags
            updateNotificationUI();
            updateOneSignalTags();
        });
    });
}