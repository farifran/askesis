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

function checkIntegrityAndHeal() {
    const attempts = parseInt(sessionStorage.getItem(BOOT_ATTEMPTS_KEY) || '0', 10);
    if (attempts >= MAX_BOOT_ATTEMPTS) {
        console.warn("🚨 Detected boot loop. Initiating Auto-Healing...");
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(registrations => {
                for (const registration of registrations) { registration.unregister(); }
            });
        }
        if ('caches' in window) {
            caches.keys().then(names => { for (const name of names) { caches.delete(name); } });
        }
        sessionStorage.removeItem(BOOT_ATTEMPTS_KEY);
        setTimeout(() => window.location.reload(), 500);
        return false;
    }
    sessionStorage.setItem(BOOT_ATTEMPTS_KEY, (attempts + 1).toString());
    return true;
}

let isInitializing = false;
let isInitialized = false;

const registerServiceWorker = () => {
    if ('serviceWorker' in navigator && !window.location.protocol.startsWith('file')) {
        const loadSW = () => navigator.serviceWorker.register('/sw.js').catch(console.warn);
        if (document.readyState === 'complete') loadSW();
        else window.addEventListener('load', loadSW);
    }
};

const NETWORK_TIMEOUT = Symbol('NETWORK_TIMEOUT');

async function loadInitialState() {
    // 1. Carrega Estado Local (Rápido) para First Paint
    await loadState();

    // 2. Se houver chave, tenta buscar e mesclar da Nuvem
    if (hasLocalSyncKey()) {
        try {
            console.log("[Boot] Sync Key detectada. Iniciando Pull da nuvem...");
            const CLOUD_BOOT_TIMEOUT_MS = 3000;
            
            // fetchStateFromCloud agora já faz o merge e o save internamente.
            // Nós apenas esperamos ele terminar ou o timeout estourar.
            await Promise.race([
                fetchStateFromCloud(),
                new Promise<typeof NETWORK_TIMEOUT>(resolve => setTimeout(() => resolve(NETWORK_TIMEOUT), CLOUD_BOOT_TIMEOUT_MS))
            ]);
            
            // O estado global 'state' já foi atualizado pelo fetchStateFromCloud se teve sucesso.
            
        } catch (e) {
            console.error("Startup: Cloud sync failed, continuing with local state.", e);
            setSyncStatus('syncError');
        }
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

function setupAppListeners() {
    setupEventListeners();
    initSync();
    document.addEventListener('habitsChanged', updateAppBadge);
    setupMidnightLoop();
    document.addEventListener('dayChanged', handleDayTransition);
    registerSyncHandler(syncStateWithCloud);
}

function finalizeInit(loader: HTMLElement | null) {
    sessionStorage.removeItem(BOOT_ATTEMPTS_KEY);
    if (loader) {
        loader.classList.add('hidden');
        const cleanup = () => {
            loader.remove();
            document.getElementById('initial-loader-container')?.remove();
        };
        const timer = setTimeout(cleanup, 400); 
        loader.addEventListener('transitionend', () => { clearTimeout(timer); cleanup(); }, { once: true });
    }
    const runBackgroundTasks = () => {
        performArchivalCheck();
        if (process.env.NODE_ENV === 'production') {
            import('./services/analytics').then(({ initAnalytics }) => initAnalytics()).catch(() => {});
        }
    };
    if ((window as any).scheduler?.postTask) {
        (window as any).scheduler.postTask(runBackgroundTasks, { priority: 'background' });
    } else {
        (window.requestIdleCallback || ((cb) => setTimeout(cb, 1000)))(runBackgroundTasks);
    }
}

async function init(loader: HTMLElement | null) {
    if (isInitializing || isInitialized) return;
    isInitializing = true;

    if ((window as any).bootWatchdog) {
        clearTimeout((window as any).bootWatchdog);
        delete (window as any).bootWatchdog;
    }

    // AUTH FIX: Await key restoration (LocalStorage + IndexedDB) BEFORE loading state
    await initAuth();
    
    await Promise.all([initI18n(), updateUIText()]);

    await loadInitialState();

    setupAppListeners();
    handleFirstTimeUser();
    renderApp(); 
    
    updateAppBadge();
    finalizeInit(loader);
    
    isInitialized = true;
    isInitializing = false;
}

const startApp = () => {
    if (!checkIntegrityAndHeal()) return;
    registerServiceWorker();
    if (isInitializing || isInitialized) return;
    const loader = document.getElementById('initial-loader');
    init(loader).catch(err => {
        console.error("Boot failed:", err);
        isInitializing = false;
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