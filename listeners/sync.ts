
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from "../render/ui";
import { t } from "../i18n";
import { fetchStateFromCloud, setSyncStatus } from "../services/cloud";
// ARCHITECTURE FIX: Import persistence logic from service layer.
import { loadState, saveState } from "../services/persistence";
import { renderApp, showConfirmationModal } from "../render";
import { storeKey, clearKey, hasLocalSyncKey, getSyncKey, isValidKeyFormat, initAuth } from "../services/api";

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

function _toggleButtons(buttons: HTMLButtonElement[], disabled: boolean) {
    buttons.forEach(btn => btn.disabled = disabled);
}

// --- Lógica Principal ---

async function handleEnableSync() {
    const buttons = [ui.enableSyncBtn, ui.enterKeyViewBtn];
    _toggleButtons(buttons, true);

    try {
        const newKey = crypto.randomUUID();
        storeKey(newKey); // Armazena otimisticamente via api.ts
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

async function _processKey(key: string) {
    const buttons = [ui.submitKeyBtn, ui.cancelEnterKeyBtn];
    _toggleButtons(buttons, true);

    const originalKey = getSyncKey();
    
    try {
        // Usa temporariamente a nova chave para buscar na nuvem
        // Nota: fetchStateFromCloud usa getSyncKey, então precisamos armazenar temporariamente
        storeKey(key);
        
        const cloudState = await fetchStateFromCloud();

        // Se houver conflito ou sucesso, mantemos a chave.
        // Mas para o fluxo de UI, se houver dados, perguntamos antes de sobrescrever.
        
        // Reverte temporariamente para evitar efeitos colaterais se o usuário cancelar
        if (originalKey) storeKey(originalKey); 
        else clearKey();

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
            // Nenhum estado na nuvem, sucesso.
            storeKey(key);
            showView('active');
        }
    } catch (error) {
        // Restaura a chave em caso de falha
        if (originalKey) storeKey(originalKey);
        else clearKey();

        console.error("Failed to sync with provided key:", error);
        setSyncStatus('syncError');
    } finally {
        // [2025-01-15] BUGFIX: Reabilitar botões incondicionalmente.
        // Anteriormente, havia uma verificação se o modal estava visível. Se o usuário cancelasse
        // o modal (clicando em Cancelar ou fora dele), a lógica do modal fechava-o,
        // mas os botões da tela de 'enterKey' permaneciam desabilitados para sempre.
        // Como o overlay do modal já impede cliques na interface de fundo, é seguro reabilitar aqui.
        _toggleButtons(buttons, false);
    }
}

function handleSubmitKey() {
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
    const key = getSyncKey();
    if (key) {
        ui.syncKeyText.textContent = key;
        ui.syncDisplayKeyView.dataset.context = 'view';
        showView('displayKey');
    }
}

function handleCopyKey() {
    const key = ui.syncKeyText.textContent;
    if(key) {
        // [2025-01-15] ROBUSTNESS: Adicionado tratamento de erro para a API Clipboard.
        navigator.clipboard.writeText(key).then(() => {
            const originalText = ui.copyKeyBtn.innerHTML;
            ui.copyKeyBtn.innerHTML = '✓';
            setTimeout(() => { ui.copyKeyBtn.innerHTML = originalText; }, 1500);
        }).catch(err => {
            console.error("Failed to copy key to clipboard:", err);
        });
    }
}

export async function initSync() {
    // Inicializa o armazenamento de chaves via API module
    initAuth();
    const hasKey = hasLocalSyncKey();

    if (hasKey) {
        showView('active');
        setSyncStatus('syncSynced');
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
