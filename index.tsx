

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file index.tsx
 * @description Bootstrapper e Orquestrador de Ciclo de Vida da Aplicação.
 */

import './css/variables.css';
import './css/base.css';
import './css/layout.css';
import './css/header.css';
import './css/components.css';
import './css/calendar.css';
import './css/habits.css';
import './css/charts.css';
import './css/forms.css';
import './css/modals.css';

import { state, AppState } from './state';
import { loadState, persistStateLocally, registerSyncHandler } from './services/persistence';
import { renderApp, initI18n, updateUIText } from './render';
import { setupEventListeners } from './listeners';
import { createDefaultHabit, handleDayTransition, performArchivalCheck } from './services/habitActions';
import { initSync } from './listeners/sync';
import { fetchStateFromCloud, syncStateWithCloud, setSyncStatus } from './services/cloud';
import { hasLocalSyncKey, initAuth } from './services/api';
import { updateAppBadge } from './services/badge';
import { mergeStates } from './services/dataMerge';
import { setupMidnightLoop } from './utils';

// --- AUTO-HEALING & INTEGRITY CHECK ---
const BOOT_ATTEMPTS_KEY = 'askesis_boot_attempts';
const MAX_BOOT_ATTEMPTS = 3;

/**
 * Verifica se o app está em loop de inicialização.
 * Se falhar repetidamente, limpa o Service Worker e Caches para forçar uma atualização limpa.
 */
function checkIntegrityAndHeal() {
    const attempts = parseInt(sessionStorage.getItem(BOOT_ATTEMPTS_KEY) || '0', 10);
    
    if (attempts >= MAX_BOOT_ATTEMPTS) {
        console.warn("🚨 Detected boot loop. Initiating Auto-Healing...");
        
        // Exorcismo do Service Worker Zumbi
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(registrations => {
                for (const registration of registrations) {
                    registration.unregister();
                    console.log("Service Worker Unregistered.");
                }
            });
        }

        // Limpeza de Cache (Assets corrompidos)
        if ('caches' in window) {
            caches.keys().then(names => {
                for (const name of names) {
                    caches.delete(name);
                    console.log(`Cache ${name} Deleted.`);
                }
            });
        }

        sessionStorage.removeItem(BOOT_ATTEMPTS_KEY);
        // Pequeno delay para garantir que as Promises de limpeza terminem antes do reload
        setTimeout(() => window.location.reload(), 500);
        return false; // Interrompe o boot atual
    }

    sessionStorage.setItem(BOOT_ATTEMPTS_KEY, (attempts + 1).toString());
    return true;
}

// --- STATE MACHINE: BOOT LOCK ---
let isInitializing = false;
let isInitialized = false;

// --- SERVICE WORKER REGISTRATION ---
const registerServiceWorker = () => {
    if ('serviceWorker' in navigator && !window.location.protocol.startsWith('file')) {
        const loadSW = () => navigator.serviceWorker.register('/sw.js').catch(console.warn);
        if (document.readyState === 'complete') loadSW();
        else window.addEventListener('load', loadSW);
    }
};

const NETWORK_TIMEOUT = Symbol('NETWORK_TIMEOUT');

async function loadInitialState() {
    // Carrega o estado local inicial. Se houver migrações, elas acontecem aqui na memória.
    let finalState = await loadState(); 

    if (hasLocalSyncKey()) {
        try {
            const CLOUD_BOOT_TIMEOUT_MS = 3000;
            const raceResult = await Promise.race([
                fetchStateFromCloud(),
                new Promise<typeof NETWORK_TIMEOUT>(resolve => setTimeout(() => resolve(NETWORK_TIMEOUT), CLOUD_BOOT_TIMEOUT_MS))
            ]);

            if (raceResult === NETWORK_TIMEOUT) {
                console.warn("Startup: Network timed out, using local state.");
                setSyncStatus('syncError');
            } else {
                const cloudState = raceResult; // Can be AppState | undefined
                const isCloudEmpty = cloudState === undefined;

                if (cloudState && finalState) {
                    const localIsNewer = finalState.lastModified > cloudState.lastModified;
                    finalState = await mergeStates(
                        localIsNewer ? cloudState : finalState, 
                        localIsNewer ? finalState : cloudState
                    );
                    if (localIsNewer) {
                        syncStateWithCloud(finalState);
                    }
                } else if (cloudState) {
                    finalState = cloudState;
                } else if (finalState && isCloudEmpty) {
                    // Cloud é confirmado como vazio, então enviamos o estado local
                    syncStateWithCloud(finalState as AppState);
                }
            }
        } catch (e) {
            console.error("Startup: Cloud sync failed, using local state.", e);
            setSyncStatus('syncError');
            // Nenhuma ação necessária, `finalState` já contém os dados locais.
        }
    }

    // Se, após todas as tentativas, tivermos um estado final (local, da nuvem ou mesclado)...
    if (finalState) {
        // Persiste o estado final no IDB (salvando migrações/mesclas) e
        // carrega-o no singleton `state` global para o resto do app usar.
        await persistStateLocally(finalState);
        await loadState(finalState);
    }
}

function handleFirstTimeUser() {
    if (state.habits.length === 0) {
        if (hasLocalSyncKey() && state.syncState === 'syncError') {
            console.warn("Startup: Aborting default habit creation due to Sync Error.");
            return;
        }
        createDefaultHabit();
    }
}

/**
 * Orquestra Listeners. 
 * CRÍTICO: syncHandler registrado após o carregamento de dados para evitar Race Condition de boot.
 */
function setupAppListeners() {
    setupEventListeners();
    initSync();
    document.addEventListener('habitsChanged', updateAppBadge);
    setupMidnightLoop();
    document.addEventListener('dayChanged', handleDayTransition);
    // Ativa o canal de saída de dados apenas após estabilização do estado
    registerSyncHandler(syncStateWithCloud);
}

function finalizeInit(loader: HTMLElement | null) {
    // SUCCESS SIGNAL: Reset boot attempt counter
    sessionStorage.removeItem(BOOT_ATTEMPTS_KEY);

    if (loader) {
        loader.classList.add('hidden');
        // RELIABILITY: Garante remoção mesmo se a transição CSS falhar/for desativada (Reduced Motion)
        const cleanup = () => {
            loader.remove();
            document.getElementById('initial-loader-container')?.remove();
        };
        const timer = setTimeout(cleanup, 400); // Buffer para a transição de 0.3s
        loader.addEventListener('transitionend', () => { clearTimeout(timer); cleanup(); }, { once: true });
    }
    
    const runBackgroundTasks = () => {
        performArchivalCheck();
        if (process.env.NODE_ENV === 'production') {
            import('./services/analytics').then(({ initAnalytics }) => initAnalytics()).catch(() => {});
        }
    };

    // BLEEDING-EDGE PERF: Utiliza a Scheduler API para executar tarefas de baixa prioridade (arquivamento, analytics)
    // sem bloquear a thread principal, garantindo uma inicialização mais fluida.
    // @fix: Cast to any to handle scheduler which might be missing in some global Window types
    if ((window as any).scheduler?.postTask) {
        (window as any).scheduler.postTask(runBackgroundTasks, { priority: 'background' });
    } else {
        (window.requestIdleCallback || ((cb) => setTimeout(cb, 1000)))(runBackgroundTasks);
    }
}

async function init(loader: HTMLElement | null) {
    // SINGLETON GUARD
    if (isInitializing || isInitialized) return;
    isInitializing = true;

    // @fix: Cast to any to access bootWatchdog property
    if ((window as any).bootWatchdog) {
        clearTimeout((window as any).bootWatchdog);
        delete (window as any).bootWatchdog;
    }

    initAuth();
    await Promise.all([initI18n(), updateUIText()]);

    // 1. Data Loading (Local -> Cloud -> Merge)
    await loadInitialState();

    // 2. Setup Listeners POST-DATA
    setupAppListeners();

    // 3. Logic & Render
    handleFirstTimeUser();
    renderApp(); 
    
    updateAppBadge();
    finalizeInit(loader);
    
    isInitialized = true;
    isInitializing = false;
}

const startApp = () => {
    // 0. AUTO-HEALING CHECK (Prevent Boot Loop)
    // ROBUSTNESS: SW Registration must happen AFTER healing check to avoid re-registering broken SWs.
    if (!checkIntegrityAndHeal()) return;

    // 1. REGISTER SW (Safe)
    registerServiceWorker();

    // PREVENT DOUBLE BOOT
    if (isInitializing || isInitialized) return;
    
    const loader = document.getElementById('initial-loader');
    init(loader).catch(err => {
        console.error("Boot failed:", err);
        isInitializing = false;
        // UX: Fallback visual robusto
        // @fix: Cast to any to check and call showFatalError
        if ((window as any).showFatalError) {
            (window as any).showFatalError("Erro na inicialização: " + (err.message || err));
        } else if(loader && loader.isConnected) {
            loader.innerHTML = '<div style="color:#ff6b6b;padding:2rem;text-align:center;"><h3>Falha Crítica</h3><button onclick="location.reload()">Tentar Novamente</button></div>';
        }
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}