/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { AppState, STATE_STORAGE_KEY } from './state';
import { ui } from './ui';
import { t } from './i18n';
import { getSyncKeyHash, hasLocalSyncKey } from './sync';

// Debounce para evitar salvar na nuvem a cada pequena alteração.
let syncTimeout: number | null = null;
const DEBOUNCE_DELAY = 2000; // 2 segundos

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
    ui.syncStatus.textContent = t(statusKey);
}

export function hasSyncKey(): boolean {
    return hasLocalSyncKey();
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    if (!hasSyncKey()) return undefined;

    try {
        const keyHash = await getSyncKeyHash();
        if (!keyHash) {
            // Se não conseguirmos obter o hash (por exemplo, erro de criptografia), tratamos como um erro de sincronização.
            throw new Error("Could not generate sync key hash.");
        };

        const response = await fetch(getApiUrl('/api/sync'), {
            headers: {
                'X-Sync-Key-Hash': keyHash
            }
        });

        if (response.ok) {
            const data = await response.json();
            setSyncStatus('syncSynced');
            return data as AppState;
        }
        if (response.status === 404) {
            console.log("No state found in cloud for this sync key.");
            // Se não há dados na nuvem, mas temos dados locais, podemos fazer o upload.
            const localData = localStorage.getItem(STATE_STORAGE_KEY);
            if (localData) {
                syncLocalStateToCloud();
            }
            return undefined;
        }
        throw new Error(`Failed to fetch state, status: ${response.status}`);
    } catch (error) {
        console.error("Error fetching state from cloud:", error);
        setSyncStatus('syncError');
        return undefined;
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

    syncTimeout = window.setTimeout(async () => {
        try {
            const keyHash = await getSyncKeyHash();
            if (!keyHash) {
                 throw new Error("Could not generate sync key hash for saving.");
            }
            
            const response = await fetch(getApiUrl('/api/sync'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Sync-Key-Hash': keyHash
                },
                body: JSON.stringify(appState),
            });

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

    try {
        const keyHash = await getSyncKeyHash();
        if (!keyHash) {
             throw new Error("Could not generate sync key hash for initial sync.");
        }
        
        console.log("Found local state. Syncing to cloud...");
        const localState: AppState = JSON.parse(localStateJSON);
        const response = await fetch(getApiUrl('/api/sync'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Sync-Key-Hash': keyHash
            },
            body: JSON.stringify(localState),
        });
        if (!response.ok) {
            throw new Error(`Initial sync failed with status ${response.status}`);
        }
        console.log("Initial sync successful.");
        setSyncStatus('syncSynced');

    } catch (error) {
        console.error("Error on initial sync to cloud:", error);
        setSyncStatus('syncError');
    }
}