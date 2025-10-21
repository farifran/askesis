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

export function setSyncStatus(statusKey: 'syncSaving' | 'syncSynced' | 'syncError' | 'syncInitial') {
    ui.syncStatus.textContent = t(statusKey);
}

export function hasSyncKey(): boolean {
    return hasLocalSyncKey();
}

export async function fetchStateFromCloud(): Promise<AppState | undefined> {
    const keyHash = await getSyncKeyHash();
    if (!keyHash) return undefined;

    try {
        const response = await fetch('/api/sync', {
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
        const keyHash = await getSyncKeyHash();
        if (!keyHash) {
             setSyncStatus('syncError');
             return;
        }
        try {
            const response = await fetch('/api/sync', {
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
    const keyHash = await getSyncKeyHash();
    if (localStateJSON && keyHash) {
        console.log("Found local state. Syncing to cloud...");
        try {
            const localState: AppState = JSON.parse(localStateJSON);
            const response = await fetch('/api/sync', {
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
}