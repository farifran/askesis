
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from "../render/ui";
import { t } from "../i18n";
import { downloadRemoteState, syncStateWithCloud, setSyncStatus, diagnoseConnection } from "../services/cloud";
import { loadState, saveState, clearLocalPersistence } from "../services/persistence";
import { renderApp } from "../render";
import { showConfirmationModal } from "../render/modals";
import { storeKey, clearKey, hasLocalSyncKey, getSyncKey, isValidKeyFormat } from "../services/api";
import { generateUUID } from "../utils";
import { getPersistableState, state } from "../state";
import { mergeStates } from "../services/dataMerge";

// --- UI HELPERS ---

function showView(view: 'inactive' | 'enterKey' | 'displayKey' | 'active') {
    ui.syncInactiveView.style.display = 'none';
    ui.syncEnterKeyView.style.display = 'none';
    ui.syncDisplayKeyView.style.display = 'none';
    ui.syncActiveView.style.display = 'none';

    // Clear errors on view switch
    if (ui.syncErrorMsg) ui.syncErrorMsg.classList.add('hidden');

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
    
    // Clear previous errors
    if (ui.syncErrorMsg) ui.syncErrorMsg.classList.add('hidden');
    
    const originalBtnText = ui.submitKeyBtn.textContent;
    ui.submitKeyBtn.textContent = t('syncVerifying');

    const originalKey = getSyncKey();
    
    try {
        // Armazena temporariamente para o teste
        storeKey(key);
        
        // [INSTANT FEEDBACK]: Atualiza a view imediatamente para 'active'
        // Isso remove a sensação de lag enquanto o download acontece em background.
        _refreshViewState(); 
        
        // Testa a chave baixando dados
        console.log("[Sync Debug] Downloading remote state...");
        const cloudState = await downloadRemoteState(key);

        if (cloudState) {
            console.log("[Sync Debug] Data found. Performing Smart Merge.");
            
            const localState = getPersistableState();
            // Fix Map loss during getPersistableState
            if (!localState.monthlyLogs && state.monthlyLogs) {
                localState.monthlyLogs = state.monthlyLogs;
            }

            // Realiza a fusão ponderada (Com prioridade Cloud para Hoje)
            const mergedState = await mergeStates(localState, cloudState);
            
            // Aplica na memória
            Object.assign(state, mergedState);
            
            // Salva no disco (Local)
            await saveState();
            
            // Renderiza UI
            renderApp();
            
            // Feedback visual e transição
            setSyncStatus('syncSynced');
            
            // Push para atualizar a nuvem com a versão mesclada (se necessário)
            syncStateWithCloud(mergedState, true);

        } else {
            // CENÁRIO A: Nuvem Vazia (404) -> Novo Usuário ou Chave Nova
            console.log("[Sync Debug] New user/Empty cloud. Uploading local state.");
            setSyncStatus('syncSynced');
            
            // Force immediate push to create the key on server and populate with local data
            syncStateWithCloud(getPersistableState(), true);
        }
    } catch (error: any) {
        console.error("[Sync Debug] Error processing key:", error);
        
        // Restore old state on error
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
        ui.enableSyncBtn.disabled = true;
        if (ui.syncErrorMsg) ui.syncErrorMsg.classList.add('hidden');
        
        const newKey = generateUUID();
        storeKey(newKey);
        
        // UX FIX: Atualiza status imediatamente para "Ativo".
        setSyncStatus('syncSynced');
        
        ui.syncKeyText.textContent = newKey;
        ui.syncDisplayKeyView.dataset.context = 'setup';
        showView('displayKey');
        
        // Immediate push for new key (Best Effort)
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

// --- DIAGNOSTICS HANDLER ---
const _handleDiagnostics = async () => {
    const originalText = ui.syncStatus.textContent;
    ui.syncStatus.textContent = "Testando...";
    const report = await diagnoseConnection();
    ui.syncStatus.textContent = originalText;
    alert(report);
};

function _refreshViewState() {
    const hasKey = hasLocalSyncKey();
    console.log(`[Sync Debug] Refreshing View. Has Key: ${hasKey}, State: ${state.syncState}`);
    
    if (hasKey) {
        showView('active');
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
    
    // NEW: Diagnostics Listener
    if (ui.syncStatus) ui.syncStatus.addEventListener('click', _handleDiagnostics);

    _refreshViewState();
}
