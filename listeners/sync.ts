
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from "../render/ui";
import { t } from "../i18n";
import { downloadRemoteState, syncStateWithCloud, setSyncStatus } from "../services/cloud";
import { loadState, saveState, clearLocalPersistence } from "../services/persistence";
import { renderApp } from "../render";
import { showConfirmationModal } from "../render/modals";
import { storeKey, clearKey, hasLocalSyncKey, getSyncKey, isValidKeyFormat } from "../services/api";
import { generateUUID } from "../utils";
import { getPersistableState, state } from "../state";

// --- UI HELPERS ---

function showView(view: 'inactive' | 'enterKey' | 'displayKey' | 'active') {
    ui.syncInactiveView.style.display = 'none';
    ui.syncEnterKeyView.style.display = 'none';
    ui.syncDisplayKeyView.style.display = 'none';
    ui.syncActiveView.style.display = 'none';

    switch (view) {
        case 'inactive': ui.syncInactiveView.style.display = 'flex'; break;
        case 'enterKey': ui.syncEnterKeyView.style.display = 'flex'; break;
        case 'displayKey': 
            ui.syncDisplayKeyView.style.display = 'flex'; 
            const context = ui.syncDisplayKeyView.dataset.context;
            ui.keySavedBtn.textContent = (context === 'view') ? t('closeButton') : t('syncKeySaved');
            break;
        case 'active': ui.syncActiveView.style.display = 'flex'; break;
    }
}

function _toggleButtons(buttons: HTMLButtonElement[], disabled: boolean) {
    for (let i = 0; i < buttons.length; i++) {
        buttons[i].disabled = disabled;
    }
}

// --- LOGIC ---

async function _processKey(key: string) {
    console.log("[Sync Debug] Processing key...");
    const buttons = [ui.submitKeyBtn, ui.cancelEnterKeyBtn];
    _toggleButtons(buttons, true);
    
    const originalBtnText = ui.submitKeyBtn.textContent;
    ui.submitKeyBtn.textContent = t('syncVerifying');

    const originalKey = getSyncKey();
    
    try {
        // HTTPS Check
        if (!window.isSecureContext && window.location.hostname !== 'localhost') {
            throw new Error("HTTPS necessário para criptografia segura.");
        }

        // Armazena temporariamente para o teste
        storeKey(key);
        
        // Testa a chave baixando dados
        console.log("[Sync Debug] Downloading remote state...");
        const cloudState = await downloadRemoteState(key);

        if (cloudState) {
            console.log("[Sync Debug] Data found. Prompting overwrite.");
            // Dados encontrados -> Pergunta se sobrescreve
            showConfirmationModal(
                t('confirmSyncOverwrite'),
                async () => {
                    // SUCCESS CALLBACK (Overwrite)
                    try {
                        console.log("[Sync Debug] Hard Reset initiated (Overwrite)...");
                        
                        // 1. Limpa tudo localmente (IndexedDB + LocalStorage State)
                        await clearLocalPersistence();
                        
                        // CRITICAL FIX: Re-store the key explicitly immediately after wiping.
                        // This prevents any race condition where the key is considered lost during the wipe.
                        console.log("[Sync Debug] Re-asserting key persistence:", key);
                        storeKey(key);
                        
                        // 2. Carrega o estado da nuvem diretamente na memória
                        console.log("[Sync Debug] Loading cloud state into memory...");
                        await loadState(cloudState);
                        
                        // 3. Salva o novo estado localmente
                        console.log("[Sync Debug] Persisting new state...");
                        await saveState(true); // Suppress sync to avoid immediate push-back loop
                        
                        // 4. Renderiza e Atualiza UI
                        console.log("[Sync Debug] Re-rendering app...");
                        renderApp();
                        
                        // CRITICAL FIX: Force View Update immediately to "Active"
                        // We manually set the state to synced to avoid visual glitching
                        state.syncState = 'syncSynced';
                        if (ui.syncStatus) ui.syncStatus.textContent = t('syncSynced');
                        
                        _refreshViewState(); 
                        
                        console.log("[Sync Debug] Overwrite complete. UI Refreshed.");

                    } catch (e) {
                        console.error("[Sync Debug] Overwrite failed", e);
                        alert("Erro crítico ao restaurar dados. Tente novamente.");
                        // Restore old key if critical fail
                        if (originalKey) storeKey(originalKey);
                        else clearKey();
                        _refreshViewState();
                    }
                },
                {
                    title: t('syncDataFoundTitle'),
                    confirmText: t('syncConfirmOverwrite'),
                    cancelText: t('cancelButton'),
                    onCancel: () => {
                        // CANCEL CALLBACK
                        // Only runs if user explicitly clicks Cancel.
                        console.log("[Sync Debug] Overwrite cancelled by user. Reverting key.");
                        if (originalKey) storeKey(originalKey);
                        else clearKey();
                        _refreshViewState();
                    }
                }
            );
        } else {
            // 404 (Novo Usuário) -> Sucesso imediato
            console.log("[Sync Debug] New user/Empty cloud. Uploading local state.");
            _refreshViewState();
            setSyncStatus('syncSynced');
            // Force immediate push to create the key on server
            syncStateWithCloud(getPersistableState(), true);
        }
    } catch (error: any) {
        console.error("[Sync Debug] Error processing key:", error);
        
        // Restore state on error
        if (originalKey) storeKey(originalKey);
        else clearKey();

        if (ui.syncErrorMsg) {
            let msg = error.message || "Erro desconhecido";
            if (msg.includes('401')) msg = "Chave Inválida";
            ui.syncErrorMsg.textContent = msg;
            ui.syncErrorMsg.classList.remove('hidden');
        }
        setSyncStatus('syncError');
        _refreshViewState();

    } finally {
        ui.submitKeyBtn.textContent = originalBtnText;
        _toggleButtons(buttons, false);
    }
}

// --- HANDLERS ---

const _handleEnableSync = () => {
    try {
        // Immediate Feedback
        ui.enableSyncBtn.disabled = true;
        
        const newKey = generateUUID();
        storeKey(newKey);
        
        ui.syncKeyText.textContent = newKey;
        ui.syncDisplayKeyView.dataset.context = 'setup';
        showView('displayKey');
        
        // Immediate push for new key
        syncStateWithCloud(getPersistableState(), true);
        
        setTimeout(() => ui.enableSyncBtn.disabled = false, 500);
    } catch (e: any) {
        console.error(e);
        ui.enableSyncBtn.disabled = false;
        if (ui.syncErrorMsg) {
            ui.syncErrorMsg.textContent = e.message || "Erro ao gerar chave";
            ui.syncErrorMsg.classList.remove('hidden');
        }
    }
};

const _handleEnterKeyView = () => {
    showView('enterKey');
    if (ui.syncErrorMsg) ui.syncErrorMsg.classList.add('hidden');
    setTimeout(() => ui.syncKeyInput.focus(), 100);
};

const _handleCancelEnterKey = () => {
    ui.syncKeyInput.value = '';
    if (ui.syncErrorMsg) ui.syncErrorMsg.classList.add('hidden');
    _refreshViewState();
};

const _handleSubmitKey = () => {
    const key = ui.syncKeyInput.value.trim();
    if (!key) return;

    if (ui.syncErrorMsg) ui.syncErrorMsg.classList.add('hidden');

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
        navigator.clipboard.writeText(key)
            .then(() => {
                const originalText = ui.copyKeyBtn.innerHTML;
                ui.copyKeyBtn.innerHTML = '✓';
                setTimeout(() => { ui.copyKeyBtn.innerHTML = originalText; }, 1500);
            })
            .catch(() => alert("Copie manualmente: " + key));
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

function _refreshViewState() {
    const hasKey = hasLocalSyncKey();
    console.log(`[Sync Debug] Refreshing View. Has Key: ${hasKey}, State: ${state.syncState}`);
    
    if (hasKey) {
        showView('active');
        // Se o estado estava em erro ou inicial, mas temos a chave, assumimos synced até prova em contrário
        if (state.syncState === 'syncInitial') {
             setSyncStatus('syncSynced');
        }
    } else {
        showView('inactive');
        setSyncStatus('syncInitial');
    }
}

export function initSync() {
    console.log("[Sync] Initializing listeners...");
    
    // SAFE BINDING: Ensure elements exist before adding listeners
    if (ui.enableSyncBtn) ui.enableSyncBtn.addEventListener('click', _handleEnableSync);
    if (ui.enterKeyViewBtn) ui.enterKeyViewBtn.addEventListener('click', _handleEnterKeyView);
    if (ui.cancelEnterKeyBtn) ui.cancelEnterKeyBtn.addEventListener('click', _handleCancelEnterKey);
    if (ui.submitKeyBtn) ui.submitKeyBtn.addEventListener('click', _handleSubmitKey);
    if (ui.keySavedBtn) ui.keySavedBtn.addEventListener('click', _handleKeySaved);
    if (ui.copyKeyBtn) ui.copyKeyBtn.addEventListener('click', _handleCopyKey);
    if (ui.viewKeyBtn) ui.viewKeyBtn.addEventListener('click', _handleViewKey);
    if (ui.disableSyncBtn) ui.disableSyncBtn.addEventListener('click', _handleDisableSync);

    _refreshViewState();
}
