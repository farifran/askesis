/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state } from "./state";
import { ui } from "./ui";
import { t } from "./i18n";
import { fetchStateFromCloud, setSyncStatus } from "./cloud";
import { loadState, saveState } from "./state";
import { renderApp, showConfirmationModal } from "./render";
import { updateNotificationUI } from "./notifications";

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';
let localSyncKey: string | null = null;
let keyHashCache: string | null = null;

// --- Funções de UI ---

function showView(view: 'inactive' | 'enterKey' | 'displayKey' | 'active') {
    ui.syncInactiveView.style.display = 'none';
    ui.syncEnterKeyView.style.display = 'none';
    ui.syncDisplayKeyView.style.display = 'none';
    ui.syncActiveView.style.display = 'none';

    switch (view) {
        case 'inactive':
            ui.syncInactiveView.style.display = 'flex';
            break;
        case 'enterKey':
            ui.syncEnterKeyView.style.display = 'flex';
            break;
        case 'displayKey':
            ui.syncDisplayKeyView.style.display = 'flex';
            break;
        case 'active':
            ui.syncActiveView.style.display = 'flex';
            break;
    }
}

// --- Funções Criptográficas ---

async function hashKey(key: string): Promise<string> {
    if (!key) return '';
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Lógica Principal ---

function storeKey(key: string) {
    localSyncKey = key;
    keyHashCache = null; // Invalida o cache
    localStorage.setItem(SYNC_KEY_STORAGE_KEY, key);
}

function clearKey() {
    localSyncKey = null;
    keyHashCache = null;
    localStorage.removeItem(SYNC_KEY_STORAGE_KEY);
}

async function handleEnableSync() {
    const newKey = crypto.randomUUID();
    storeKey(newKey);
    ui.syncKeyText.textContent = newKey;
    showView('displayKey');
    // Faz o upload do estado local atual para a nuvem com a nova chave.
    try {
        // Chamar fetchStateFromCloud acionará a sincronização inicial se não houver dados.
        await fetchStateFromCloud();
        updateNotificationUI(); // Atualiza a UI de notificações
    } catch(e) {
        console.error("Failed initial sync on new key generation", e);
        // O status de erro já está definido. O usuário vê a chave, mas a sincronização falhou.
        // Se a sincronização falhar, a chave não é útil. Devemos revertê-la.
        clearKey();
        showView('inactive');
        updateNotificationUI(); // Atualiza a UI de notificações
    }
}

async function handleSubmitKey() {
    const key = ui.syncKeyInput.value.trim();
    if (!key) return;

    const proceed = async () => {
        storeKey(key); // Armazena temporariamente a chave para tentar a sincronização
        try {
            const cloudState = await fetchStateFromCloud();
            if (cloudState) {
                showConfirmationModal(
                    t('confirmSyncOverwrite'),
                    () => {
                        loadState(cloudState);
                        saveState(); // Salva o estado mesclado localmente e aciona a sincronização com a nuvem
                        renderApp();
                        showView('active');
                        updateNotificationUI(); // Atualiza a UI de notificações
                    },
                    {
                        title: t('syncDataFoundTitle'),
                        confirmText: t('syncConfirmOverwrite'),
                        cancelText: t('cancelButton')
                    }
                );
            } else {
                // Nenhum estado na nuvem foi encontrado. fetchStateFromCloud já acionou uma sincronização inicial.
                // Apenas muda a visualização.
                showView('active');
                updateNotificationUI(); // Atualiza a UI de notificações
            }
        } catch (error) {
            console.error("Failed to sync with provided key:", error);
            // Limpa a chave inválida que acabamos de armazenar
            clearKey();
            // Mantém o usuário na mesma tela e mostra o status de erro
            setSyncStatus('syncError');
            updateNotificationUI(); // Atualiza a UI de notificações
            // A visualização permanece 'enterKey' porque não a mudamos em caso de falha
        }
    };

    const uuidRegex = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
    if (!uuidRegex.test(key)) {
        showConfirmationModal(
            t('confirmInvalidKeyBody'),
            proceed,
            {
                title: t('confirmInvalidKeyTitle'),
                confirmText: t('confirmButton'),
                cancelText: t('cancelButton')
            }
        );
    } else {
        await proceed();
    }
}

function handleDisableSync() {
    showConfirmationModal(
        t('confirmSyncDisable'),
        () => {
            clearKey();
            setSyncStatus('syncInitial');
            showView('inactive');
            updateNotificationUI(); // Atualiza a UI de notificações
        },
        { title: t('syncDisableTitle'), confirmText: t('syncDisableConfirm') }
    );
}

function handleViewKey() {
    if (localSyncKey) {
        ui.syncKeyText.textContent = localSyncKey;
        showView('displayKey');
    }
}

function handleCopyKey() {
    const key = ui.syncKeyText.textContent;
    if(key) {
        navigator.clipboard.writeText(key).then(() => {
            // Feedback opcional para o usuário
            const originalText = ui.copyKeyBtn.innerHTML;
            ui.copyKeyBtn.innerHTML = '✓';
            setTimeout(() => { ui.copyKeyBtn.innerHTML = originalText; }, 1500);
        });
    }
}

export async function initSync() {
    localSyncKey = localStorage.getItem(SYNC_KEY_STORAGE_KEY);

    if (localSyncKey) {
        showView('active');
        setSyncStatus('syncSynced'); // Assume que está sincronizado ao iniciar
    } else {
        showView('inactive');
        setSyncStatus('syncInitial');
    }
    
    // Adiciona os listeners
    ui.enableSyncBtn.addEventListener('click', handleEnableSync);
    ui.enterKeyViewBtn.addEventListener('click', () => showView('enterKey'));
    ui.cancelEnterKeyBtn.addEventListener('click', () => showView('inactive'));
    ui.submitKeyBtn.addEventListener('click', handleSubmitKey);
    ui.keySavedBtn.addEventListener('click', () => {
        showView('active');
        updateNotificationUI();
    });
    ui.copyKeyBtn.addEventListener('click', handleCopyKey);
    ui.viewKeyBtn.addEventListener('click', handleViewKey);
    ui.disableSyncBtn.addEventListener('click', handleDisableSync);
}

export function hasSyncKey(): boolean {
    return localSyncKey !== null;
}

export function getSyncKey(): string | null {
    return localSyncKey;
}

export async function getSyncKeyHash(): Promise<string | null> {
    if (!localSyncKey) {
        return null;
    }
    if (keyHashCache) {
        return keyHashCache;
    }
    keyHashCache = await hashKey(localSyncKey);
    return keyHashCache;
}
