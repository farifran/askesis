
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. O arquivo serve como ponto de entrada e orquestrador da aplicação. A importação não utilizada 'ui' foi removida. A lógica de inicialização, registro do Service Worker e tratamento de erros está robusta.

import { inject } from '@vercel/analytics';
import './index.css';
import { loadState, saveState, state, persistStateLocally } from './state';
import { initUI } from './ui';
import { renderApp } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';
import { initSync } from './sync';
import { fetchStateFromCloud, setupNotificationListeners } from './cloud';
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
    let cloudState;
    if (hasLocalSyncKey()) {
        try {
            cloudState = await fetchStateFromCloud();
            if (cloudState) {
                // Sincroniza o armazenamento local com a nuvem sem alterar o lastModified
                // e sem disparar um novo upload (loop de sincronização).
                persistStateLocally(cloudState);
            }
        } catch (e) {
            console.error("Failed to fetch from cloud on startup, using local state.", e);
        }
    }
    loadState(cloudState);
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
