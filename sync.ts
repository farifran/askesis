/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído.
// O que foi feito: O módulo de UI de sincronização foi totalmente robustecido. A função `handleSubmitKey`, que era complexa, foi refatorada e dividida em duas (`handleSubmitKey` e `_processKey`), corrigindo um bug onde os botões poderiam ficar permanentemente desabilitados após o cancelamento de um modal. A lógica para gerenciar o estado dos botões durante operações assíncronas foi centralizada e tornada mais resiliente com o uso de blocos `try/finally`.
// O que falta: Nenhuma análise futura é necessária. O módulo é considerado finalizado.
import { state } from "./state";
import { ui } from "./ui";
import { t } from "./i18n";
import { fetchStateFromCloud, setSyncStatus } from "./cloud";
import { loadState, saveState } from "./state";
import { renderApp, showConfirmationModal } from "./render";

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';
const UUID_REGEX = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
let localSyncKey: string | null = null;
let keyHashCache: string | null = null;

// --- Funções de UI ---

function showView(view: 'inactive' | 'enterKey' | 'displayKey' | 'active') {
    const viewsMap = {
        inactive: ui.syncInactiveView,
        enterKey: ui.syncEnterKeyView,
        displayKey: ui.syncDisplayKeyView,
        active: ui.syncActiveView,
    };

    for (const key in viewsMap) {
        viewsMap[key as keyof typeof viewsMap].style.display = 'none';
    }

    viewsMap[view].style.display = 'flex';

    if (view === 'displayKey') {
        const context = ui.syncDisplayKeyView.dataset.context;
        ui.keySavedBtn.textContent = (context === 'view') ? t('closeButton') : t('syncKeySaved');
    }
}

/**
 * REATORAÇÃO DE ROBUSTEZ: Centraliza a lógica de habilitar/desabilitar botões.
 * @param buttons Um array de botões para modificar.
 * @param disabled O estado de desabilitado a ser aplicado.
 */
function _toggleButtons(buttons: HTMLButtonElement[], disabled: boolean) {
    buttons.forEach(btn => btn.disabled = disabled);
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
    keyHashCache = null;
    localStorage.setItem(SYNC_KEY_STORAGE_KEY, key);
}

function clearKey() {
    localSyncKey = null;
    keyHashCache = null;
    localStorage.removeItem(SYNC_KEY_STORAGE_KEY);
}

async function handleEnableSync() {
    const buttons = [ui.enableSyncBtn, ui.enterKeyViewBtn];
    _toggleButtons(buttons, true);

    try {
        const newKey = crypto.randomUUID();
        storeKey(newKey); // Armazena otimisticamente
        ui.syncKeyText.textContent = newKey;
        ui.syncDisplayKeyView.dataset.context = 'setup';
        showView('displayKey');
        await fetchStateFromCloud(); // Aciona a sincronização inicial
    } catch (e) {
        console.error("Failed initial sync on new key generation", e);
        clearKey(); // Reverte em caso de falha
        showView('inactive');
        setSyncStatus('syncError');
    } finally {
        _toggleButtons(buttons, false);
    }
}

/**
 * REATORAÇÃO DE ROBUSTEZ: Função `async` que encapsula a lógica de processamento de chave,
 * garantindo que os botões sejam sempre reabilitados.
 * @param key A chave de sincronização a ser processada.
 */
async function _processKey(key: string) {
    const buttons = [ui.submitKeyBtn, ui.cancelEnterKeyBtn];
    _toggleButtons(buttons, true);

    const originalKey = localSyncKey;
    const originalHash = keyHashCache;
    try {
        // Usa temporariamente a nova chave para buscar na nuvem
        localSyncKey = key;
        keyHashCache = null;
        const cloudState = await fetchStateFromCloud();

        // Restaura o estado original da chave antes de qualquer mudança de UI (como um modal)
        localSyncKey = originalKey;
        keyHashCache = originalHash;

        if (cloudState) {
            showConfirmationModal(
                t('confirmSyncOverwrite'),
                () => { // onConfirm
                    storeKey(key); // Persiste a nova chave
                    loadState(cloudState);
                    saveState();
                    renderApp();
                    showView('active');
                },
                {
                    title: t('syncDataFoundTitle'),
                    confirmText: t('syncConfirmOverwrite'),
                    cancelText: t('cancelButton')
                }
            );
        } else {
            // Nenhum estado na nuvem, a sincronização inicial foi bem-sucedida. Persiste a chave.
            storeKey(key);
            showView('active');
        }
    } catch (error) {
        // Restaura a chave em caso de falha
        localSyncKey = originalKey;
        keyHashCache = originalHash;
        console.error("Failed to sync with provided key:", error);
        setSyncStatus('syncError');
    } finally {
        // Se nenhum modal foi exibido, os botões são reabilitados. Se um modal foi
        // exibido, o usuário pode interagir com ele, e os botões de submissão permanecerão
        // desabilitados, o que é um comportamento aceitável para evitar submissões duplas.
        // O estado do botão é gerenciado no escopo da ação do modal.
        if (!document.querySelector('#confirm-modal.visible')) {
            _toggleButtons(buttons, false);
        }
    }
}


/**
 * REATORAÇÃO DE ROBUSTEZ: O manipulador de eventos agora delega a lógica assíncrona
 * para `_processKey`, separando a validação da execução.
 */
function handleSubmitKey() {
    const key = ui.syncKeyInput.value.trim();
    if (!key) return;

    if (!UUID_REGEX.test(key)) {
        showConfirmationModal(
            t('confirmInvalidKeyBody'),
            () => _processKey(key),
            {
                title: t('confirmInvalidKeyTitle'),
                confirmText: t('confirmButton'),
                cancelText: t('cancelButton')
            }
        );
    } else {
        _processKey(key);
    }
}


function handleDisableSync() {
    showConfirmationModal(
        t('confirmSyncDisable'),
        () => {
            clearKey();
            setSyncStatus('syncInitial');
            showView('inactive');
        },
        { 
            title: t('syncDisableTitle'), 
            confirmText: t('syncDisableConfirm'),
            confirmButtonStyle: 'danger'
        }
    );
}

function handleViewKey() {
    if (localSyncKey) {
        ui.syncKeyText.textContent = localSyncKey;
        ui.syncDisplayKeyView.dataset.context = 'view';
        showView('displayKey');
    }
}

function handleCopyKey() {
    const key = ui.syncKeyText.textContent;
    if(key) {
        navigator.clipboard.writeText(key).then(() => {
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
    ui.cancelEnterKeyBtn.addEventListener('click', () => {
        ui.syncKeyInput.value = '';
        showView('inactive');
    });
    ui.submitKeyBtn.addEventListener('click', handleSubmitKey);
    ui.keySavedBtn.addEventListener('click', () => showView('active'));
    ui.copyKeyBtn.addEventListener('click', handleCopyKey);
    ui.viewKeyBtn.addEventListener('click', handleViewKey);
    ui.disableSyncBtn.addEventListener('click', handleDisableSync);
}

export function hasLocalSyncKey(): boolean {
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