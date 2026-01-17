
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/sync.ts
 * @description Controlador de Interface para Sincronização e Autenticação (Sync UI Controller).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo gerencia a Máquina de Estados da UI de Sincronização (Views: Inactive, Entry, Active).
 * 
 * ARQUITETURA:
 * - State Machine Pattern: A UI alterna entre estados discretos (`showView`) em vez de manipular
 *   visibilidade de elementos individuais, prevenindo estados inconsistentes.
 * - Transactional Key Swap: Ao inserir uma chave, o sistema entra em um estado "tentativo".
 *   Se houver erro ou cancelamento, a chave anterior é restaurada (Rollback).
 * - Optimistic UI Locking: Botões são desabilitados (`_toggleButtons`) durante operações de rede
 *   para evitar submissões duplas ou condições de corrida.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `services/cloud.ts`: Orquestração de dados e criptografia.
 * - `services/api.ts`: Gerenciamento seguro de chaves no LocalStorage.
 */

import { ui } from "../render/ui";
import { t } from "../i18n";
import { fetchStateFromCloud, setSyncStatus, prewarmWorker } from "../services/cloud";
import { loadState, saveState } from "../services/persistence";
import { renderApp } from "../render";
import { showConfirmationModal } from "../render/modals";
import { storeKey, clearKey, hasLocalSyncKey, getSyncKey, isValidKeyFormat, initAuth } from "../services/api";
import { generateUUID } from "../utils";

// --- UI HELPERS ---

function showView(view: 'inactive' | 'enterKey' | 'displayKey' | 'active') {
    const viewsMap = {
        inactive: ui.syncInactiveView,
        enterKey: ui.syncEnterKeyView,
        displayKey: ui.syncDisplayKeyView,
        active: ui.syncActiveView,
    };

    // Fast loop over keys
    for (const key in viewsMap) {
        viewsMap[key as keyof typeof viewsMap].style.display = 'none';
    }

    viewsMap[view].style.display = 'flex';

    if (view === 'displayKey') {
        const context = ui.syncDisplayKeyView.dataset.context;
        ui.keySavedBtn.textContent = (context === 'view') ? t('closeButton') : t('syncKeySaved');
    }
}

function _toggleButtons(buttons: HTMLButtonElement[], disabled: boolean) {
    buttons.forEach(btn => btn.disabled = disabled);
}

// --- LOGIC ---

async function _processKey(key: string) {
    const buttons = [ui.submitKeyBtn, ui.cancelEnterKeyBtn];
    _toggleButtons(buttons, true);
    
    const originalBtnText = ui.submitKeyBtn.textContent;
    ui.submitKeyBtn.textContent = t('syncVerifying');

    const originalKey = getSyncKey();
    
    try {
        storeKey(key);
        const cloudState = await fetchStateFromCloud();

        // Rollback safety fallback handled below
        if (originalKey) storeKey(originalKey); 
        else clearKey();

        if (cloudState) {
            showConfirmationModal(
                t('confirmSyncOverwrite'),
                async () => { // onConfirm
                    storeKey(key);
                    await loadState(cloudState);
                    await saveState();
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
            storeKey(key);
            showView('active');
        }
    } catch (error) {
        if (originalKey) storeKey(originalKey);
        else clearKey();

        console.error("Failed to sync with provided key:", error);
        setSyncStatus('syncError');
    } finally {
        ui.submitKeyBtn.textContent = originalBtnText;
        _toggleButtons(buttons, false);
    }
}

// --- STATIC HANDLERS ---

const _handleEnableSync = async () => {
    const buttons = [ui.enableSyncBtn, ui.enterKeyViewBtn];
    _toggleButtons(buttons, true);

    try {
        const newKey = generateUUID();
        storeKey(newKey);
        ui.syncKeyText.textContent = newKey;
        ui.syncDisplayKeyView.dataset.context = 'setup';
        showView('displayKey');
        await fetchStateFromCloud();
    } catch (e) {
        console.error("Failed initial sync on new key generation", e);
        clearKey();
        showView('inactive');
        setSyncStatus('syncError');
    } finally {
        _toggleButtons(buttons, false);
    }
};

const _handleEnterKeyView = () => {
    showView('enterKey');
    prewarmWorker(); 
};

const _handleCancelEnterKey = () => {
    ui.syncKeyInput.value = '';
    showView('inactive');
};

const _handleSubmitKey = () => {
    const key = ui.syncKeyInput.value.trim();
    if (!key) return;

    if (!isValidKeyFormat(key)) {
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
};

const _handleKeySaved = () => showView('active');

const _handleCopyKey = () => {
    const key = ui.syncKeyText.textContent;
    if(key) {
        navigator.clipboard.writeText(key).then(() => {
            const originalText = ui.copyKeyBtn.innerHTML;
            ui.copyKeyBtn.innerHTML = '✓';
            setTimeout(() => { ui.copyKeyBtn.innerHTML = originalText; }, 1500);
        }).catch(err => {
            console.error("Failed to copy key to clipboard:", err);
        });
    }
};

const _handleViewKey = () => {
    const key = getSyncKey();
    if (key) {
        ui.syncKeyText.textContent = key;
        ui.syncDisplayKeyView.dataset.context = 'view';
        showView('displayKey');
    }
};

const _handleDisableSync = () => {
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
};

export async function initSync() {
    initAuth();
    const hasKey = hasLocalSyncKey();

    if (hasKey) {
        showView('active');
        setSyncStatus('syncSynced');
    } else {
        showView('inactive');
        setSyncStatus('syncInitial');
    }
    
    // Attach static listeners
    ui.enableSyncBtn.addEventListener('click', _handleEnableSync);
    ui.enterKeyViewBtn.addEventListener('click', _handleEnterKeyView);
    ui.cancelEnterKeyBtn.addEventListener('click', _handleCancelEnterKey);
    ui.submitKeyBtn.addEventListener('click', _handleSubmitKey);
    ui.keySavedBtn.addEventListener('click', _handleKeySaved);
    ui.copyKeyBtn.addEventListener('click', _handleCopyKey);
    ui.viewKeyBtn.addEventListener('click', _handleViewKey);
    ui.disableSyncBtn.addEventListener('click', _handleDisableSync);
}
