
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file index.tsx
 * @description Orquestrador Central de Inicialização e Bootstrapping do Sistema.
 * 
 * [MAIN THREAD]: Este módulo coordena o ciclo de vida inicial da aplicação.
 * Foco em TTI (Time to Interactive) e "Race-to-Idle".
 * 
 * ARQUITETURA DE INICIALIZAÇÃO:
 * 1. **Fase de Base:** Inicialização de segurança (Auth) e semântica (i18n).
 * 2. **Resolução de Estado:** Implementa o Smart Merge entre LocalStorage (Hot) e Vercel KV (Cloud).
 * 3. **Montagem da UI:** Injeção do motor de renderização e listeners de eventos.
 * 4. **Progressive Enhancement:** Registro de Service Worker e injeção de Analytics.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Definição do esquema de dados global.
 * - `services/persistence.ts`: Motor de IO local.
 * - `services/cloud.ts`: Interface com Web Workers e Cloud Sync.
 * - `services/dataMerge.ts`: Algoritmo de resolução de conflitos (CRDT-like).
 * 
 * POR QUE ESTA ESTRUTURA?
 * O uso de `async/await` no `init` garante que a aplicação nunca exiba dados parciais ou 
 * corrompidos. A sincronização com a nuvem ocorre ANTES do primeiro render para evitar 
 * "Layout Shift" ou "State Flickering".
 */

import { inject } from '@vercel/analytics';
import './index.css';
import { state, STATE_STORAGE_KEY, AppState } from './state';
import { loadState, saveState, persistStateLocally, registerSyncHandler } from './services/persistence';
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

/**
 * Registra o Service Worker para suporte Offline-First.
 * // PERFORMANCE: Registra apenas após o load da página para não competir por banda durante o CRP.
 */
const registerServiceWorker = () => {
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
        const doRegister = async () => {
            try {
                // DO NOT REFACTOR: O scope './' é vital para o SW interceptar todas as rotas da PWA.
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
    initAuth(); // Lê a chave de sincronização do hardware/storage antes do carregamento do estado.
    await initI18n(); // PERFORMANCE: Carregamento paralelo bloqueante necessário para consistência visual do primeiro frame.
}

/**
 * Lógica Crítica de Sincronização de Estado.
 * // DO NOT REFACTOR: A ordem de precedência Local vs Cloud protege contra perda de dados offline.
 * Implementa "Last Write Wins" com fusão granular de metadados.
 */
async function loadInitialState() {
    const localStr = localStorage.getItem(STATE_STORAGE_KEY);
    let localState: AppState | null = null;
    if (localStr) {
        try {
            // PERFORMANCE: Parsing síncrono aceitável apenas no boot.
            localState = JSON.parse(localStr);
        } catch (e) {
            console.error("Startup: Failed to parse local state", e);
        }
    }

    let stateToLoad: AppState | null = localState;

    if (hasLocalSyncKey()) {
        try {
            // Solicita dados da nuvem. Ocorrerá Off-Main-Thread via Worker (vide cloud.ts).
            const cloudState = await fetchStateFromCloud();

            if (cloudState && localState) {
                console.log("Startup: Both local and cloud state exist. Performing Smart Merge.");
                // LOGIC LOCK: Se o local for mais novo, ele manda no merge e atualiza a nuvem.
                if (localState.lastModified > cloudState.lastModified) {
                    stateToLoad = mergeStates(cloudState, localState);
                    syncStateWithCloud(stateToLoad, true);
                } else {
                    // Se a nuvem for mais nova, ela absorve o local.
                    stateToLoad = mergeStates(localState, cloudState);
                }
                persistStateLocally(stateToLoad);
            } else if (cloudState) {
                // Fonte de verdade única na nuvem.
                console.log("Startup: Using cloud state as the source of truth.");
                stateToLoad = cloudState;
                persistStateLocally(cloudState);
            } else if (localState) {
                // Primeira sincronização: empurra o local para cima.
                console.log("Startup: No cloud data found, pushing local state to cloud.");
                syncStateWithCloud(localState, true);
            }
            
        } catch (e) {
            console.error("Startup: Failed to process cloud state, falling back to local.", e);
            // Resiliência: Se a rede falhar, o app continua operacional com dados locais.
        }
    }
    
    // Injeta o estado final no singleton global 'state'.
    loadState(stateToLoad);
}

function handleFirstTimeUser() {
    // PERFORMANCE: Lazy creation de hábito padrão apenas se o banco estiver vazio.
    if (state.habits.length === 0) {
        createDefaultHabit();
    }
}

function setupAppListeners() {
    // Vincular Sincronização: Conecta mutações do 'state.ts' ao worker de nuvem.
    registerSyncHandler(syncStateWithCloud);
    
    setupEventListeners();
    setupNotificationListeners();
    initSync();
    
    // PERFORMANCE: Evento desacoplado para atualizar Badges sem travar o render loop principal.
    document.addEventListener('habitsChanged', updateAppBadge);
}

function finalizeInit(loader: HTMLElement | null) {
    if (loader) {
        loader.classList.add('hidden');
        // PERFORMANCE: Usa transição CSS nativa e remove do DOM para liberar memória.
        loader.addEventListener('transitionend', () => loader.remove());
    }
    
    // DO NOT REFACTOR: 'process.env.NODE_ENV' é substituído via esbuild (build.js).
    if (process.env.NODE_ENV === 'production') {
        inject(); 
    }
}

// --- MAIN INITIALIZATION ---

/**
 * Orquestrador sequencial de boot.
 * Cada passo é dependente do sucesso do anterior para garantir integridade.
 */
async function init(loader: HTMLElement | null) {
    await setupBase();
    await loadInitialState();
    handleFirstTimeUser();
    renderApp();
    setupAppListeners();
    updateAppBadge(); // Define o estado inicial da Badging API (PWA).
    finalizeInit(loader);
}

// Inicia registro do SW em background.
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

// PERFORMANCE: Aguarda o parser do HTML terminar para garantir que todos os IDs do index.html estejam disponíveis.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}
