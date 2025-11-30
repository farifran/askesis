
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. O arquivo serve como ponto de entrada e orquestrador da aplicação. A lógica de inicialização foi reforçada para priorizar dados locais se forem mais recentes que a nuvem (Offline Recovery).

import { inject } from '@vercel/analytics';
import './index.css';
import { loadState, saveState, state, persistStateLocally, STATE_STORAGE_KEY, AppState } from './state';
import { initUI } from './ui';
import { renderApp } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';
import { initSync } from './sync';
import { fetchStateFromCloud, setupNotificationListeners, syncStateWithCloud } from './cloud';
import { hasLocalSyncKey, initAuth } from './api';
import { updateAppBadge } from './badge';

// --- SERVICE WORKER REGISTRATION ---
const registerServiceWorker = () => {
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
        const doRegister = async () => {
            try {
                // Caminho relativo ./sw.js para maior compatibilidade
                const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
                console.log('ServiceWorker registration successful with scope: ', registration.scope);
            } catch (err) {
                console.error('ServiceWorker registration failed: ', err);
            }
        };

        if (document.readyState === 'complete') {
            doRegister();
        } else {
            window.addEventListener('load', doRegister);
        }
    } else if (window.location.protocol === 'file:') {
        console.warn('Service Worker não suportado no protocolo file://. Por favor, use um servidor local (npm run dev).');
    }
};


// --- PRIVATE HELPERS (INIT ORCHESTRATION) ---

async function setupBase() {
    initUI(); // Mapeia os elementos do DOM
    initAuth(); // Inicializa a autenticação (lê a chave de sincronização) antes de carregar o estado
    await initI18n(); // Carrega as traduções
}

async function loadInitialState() {
    // 1. Snapshot do estado local antes de qualquer operação de rede
    // Isso é crucial para garantir que edições offline não sejam sobrescritas.
    const localStr = localStorage.getItem(STATE_STORAGE_KEY);
    let localState: AppState | null = null;
    if (localStr) {
        try {
            localState = JSON.parse(localStr);
        } catch (e) {
            console.error("Startup: Failed to parse local state", e);
        }
    }

    let stateToLoad: AppState | null = localState; // Padrão: Confia no local

    if (hasLocalSyncKey()) {
        try {
            const cloudState = await fetchStateFromCloud();
            
            if (cloudState) {
                // LÓGICA DEFENSIVA: Comparação Estrita de Timestamps
                // Se o local for mais novo (ex: editado offline), ele deve vencer.
                if (localState && localState.lastModified > cloudState.lastModified) {
                    console.log(`Startup: Local state (${localState.lastModified}) is newer than cloud (${cloudState.lastModified}). Pushing local changes.`);
                    
                    // CRÍTICO: Atualiza o timestamp para "agora".
                    // Isso garante que este estado seja considerado a "nova verdade" pelo servidor
                    // e previne conflitos de hash se o conteúdo divergir sutilmente.
                    localState.lastModified = Date.now();
                    
                    // Persiste o novo timestamp localmente imediatamente
                    persistStateLocally(localState);
                    stateToLoad = localState;
                    
                    // Força o envio imediato para a nuvem para sincronizar os outros dispositivos
                    syncStateWithCloud(localState, true);
                } else {
                    console.log("Startup: Cloud state is newer or equal. Syncing local with cloud.");
                    // Nuvem vence (ou é igual). Persiste localmente para manter a consistência.
                    // ATENÇÃO: persistStateLocally não altera lastModified, apenas salva o blob.
                    persistStateLocally(cloudState);
                    stateToLoad = cloudState;
                }
            } else {
                // Chave existe, mas sem dados na nuvem (ou fetch retornou undefined/vazio).
                // Mantém o local. A lógica interna do fetchStateFromCloud já pode ter tentado iniciar o push,
                // mas garantimos que o loadState use o que temos em mãos.
                console.log("Startup: No cloud data found, using local.");
            }
        } catch (e) {
            console.error("Startup: Failed to fetch from cloud, falling back to local state.", e);
            // Em caso de erro de rede, stateToLoad continua sendo localState (o padrão definido acima)
        }
    }
    
    // Carrega o estado vencedor na memória da aplicação
    loadState(stateToLoad);
}

function handleFirstTimeUser() {
    if (state.habits.length === 0) {
        createDefaultHabit();
        saveState();
    }
}

function setupAppListeners() {
    setupEventListeners();
    setupNotificationListeners();
    initSync();
}

function finalizeInit(loader: HTMLElement | null) {
    if (loader) {
        loader.classList.add('hidden');
        loader.addEventListener('transitionend', () => loader.remove());
    }
    inject(); // Vercel Analytics
}

// --- MAIN INITIALIZATION ---
async function init(loader: HTMLElement | null) {
    await setupBase();
    await loadInitialState();
    handleFirstTimeUser();
    renderApp();
    setupAppListeners();
    updateAppBadge(); // Define o emblema inicial
    finalizeInit(loader);
}

registerServiceWorker();

const initialLoader = document.getElementById('initial-loader');
init(initialLoader).catch(err => {
    console.error("Failed to initialize application:", err);
    if(initialLoader) {
        initialLoader.innerHTML = '<h2>Falha ao carregar a aplicação. Por favor, tente novamente.</h2>'
    }
});
