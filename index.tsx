
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [NOTA COMPARATIVA]: Este arquivo atua como o orquestrador de inicialização (Bootstrapper). Comparado aos módulos de lógica pesada ('state.ts', 'render.ts'), o 'index.tsx' é conciso e focado exclusivamente no ciclo de vida inicial: carregamento de dependências, resolução de conflitos de estado (Local vs Nuvem) e injeção no DOM. O nível de engenharia é alto, implementando um padrão de "Race-to-Idle" para inicialização perceptivelmente instantânea.

import { inject } from '@vercel/analytics';
import './index.css';
import { state, STATE_STORAGE_KEY, AppState } from './state';
import { loadState, saveState, persistStateLocally, registerSyncHandler } from './services/persistence';
// DEAD CODE REMOVAL [2025-03-10]: initUI removed as UI elements are lazily initialized.
import { renderApp } from './render';
import { setupEventListeners } from './listeners';
import { initI18n } from './i18n';
import { createDefaultHabit } from './habitActions';
import { initSync } from './listeners/sync';
import { fetchStateFromCloud, setupNotificationListeners, syncStateWithCloud } from './services/cloud';
import { hasLocalSyncKey, initAuth } from './services/api';
import { updateAppBadge } from './services/badge';
import { mergeStates } from './services/dataMerge';

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
    initAuth(); // Inicializa a autenticação (lê a chave de sincronização) antes de carregar o estado
    await initI18n(); // Carrega as traduções
}

async function loadInitialState() {
    const localStr = localStorage.getItem(STATE_STORAGE_KEY);
    let localState: AppState | null = null;
    if (localStr) {
        try {
            localState = JSON.parse(localStr);
        } catch (e) {
            console.error("Startup: Failed to parse local state", e);
        }
    }

    let stateToLoad: AppState | null = localState;

    if (hasLocalSyncKey()) {
        try {
            const cloudState = await fetchStateFromCloud();

            if (cloudState && localState) {
                console.log("Startup: Both local and cloud state exist. Performing Smart Merge.");
                // A base para a fusão é o estado mais recente.
                if (localState.lastModified > cloudState.lastModified) {
                    stateToLoad = mergeStates(cloudState, localState);
                    // Como a fusão resultou em um estado mais novo que o da nuvem, sincronizamos de volta.
                    syncStateWithCloud(stateToLoad, true);
                } else {
                    stateToLoad = mergeStates(localState, cloudState);
                }
                persistStateLocally(stateToLoad);
            } else if (cloudState) {
                // Apenas o estado da nuvem existe, ou o local é nulo.
                console.log("Startup: Using cloud state as the source of truth.");
                stateToLoad = cloudState;
                persistStateLocally(cloudState);
            } else if (localState) {
                // Apenas o estado local existe (ex: primeira sincronização).
                console.log("Startup: No cloud data found, pushing local state to cloud.");
                syncStateWithCloud(localState, true);
            }
            
        } catch (e) {
            console.error("Startup: Failed to process cloud state, falling back to local.", e);
            // Em caso de erro de rede, stateToLoad continua sendo localState.
        }
    }
    
    loadState(stateToLoad);
}

function handleFirstTimeUser() {
    if (state.habits.length === 0) {
        createDefaultHabit();
    }
}

function setupAppListeners() {
    // WIRE UP SYNC: Connect state changes to cloud sync
    registerSyncHandler(syncStateWithCloud);
    
    setupEventListeners();
    setupNotificationListeners();
    initSync();
    
    // BUGFIX: Garante que o emblema da PWA seja atualizado em tempo real.
    document.addEventListener('habitsChanged', updateAppBadge);
}

function finalizeInit(loader: HTMLElement | null) {
    if (loader) {
        loader.classList.add('hidden');
        loader.addEventListener('transitionend', () => loader.remove());
    }
    
    // FIX [2025-02-28]: Injeta Analytics apenas em produção para evitar erros 404 no console de desenvolvimento.
    // O script /_vercel/insights/script.js é virtual e só existe na infraestrutura da Vercel.
    if (process.env.NODE_ENV === 'production') {
        inject(); 
    }
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

const startApp = () => {
    const initialLoader = document.getElementById('initial-loader');
    init(initialLoader).catch(err => {
        console.error("Failed to initialize application:", err);
        if(initialLoader) {
            initialLoader.innerHTML = '<h2>Falha ao carregar a aplicação. Por favor, tente novamente.</h2>'
        }
    });
};

// FIX [2025-03-04]: Ensure DOM is fully loaded before initialization.
// This prevents "element not found" errors if the script runs before the HTML parser finishes.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}
