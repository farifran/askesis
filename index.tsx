/**
 * @license
 * SPDX-License-Identifier: MIT
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

import { state } from './state';
import { loadState, registerSyncHandler, saveState } from './services/persistence';
import { renderApp, initI18n, updateUIText, showConfirmationModal } from './render';
import { setupEventListeners } from './listeners';
import { handleDayTransition, performArchivalCheck } from './services/habitActions';
import { initSync } from './listeners/sync';
import { fetchStateFromCloud, syncStateWithCloud, setSyncStatus } from './services/cloud';
import { hasLocalSyncKey, initAuth } from './services/api';
import { updateAppBadge } from './services/badge';
import { setupMidnightLoop, logger, getLocalPushOptIn, ensureOneSignalReady } from './utils';
import { BOOT_RELOAD_DELAY_MS, BOOT_SYNC_TIMEOUT_MS } from './constants';
import { t } from './i18n';

// --- AUTO-HEALING & INTEGRITY CHECK ---
const BOOT_ATTEMPTS_KEY = 'askesis_boot_attempts';
const MAX_BOOT_ATTEMPTS = 3;

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

function checkIntegrityAndHeal() {
    const attempts = parseInt(sessionStorage.getItem(BOOT_ATTEMPTS_KEY) || '0', 10);
    if (attempts >= MAX_BOOT_ATTEMPTS) {
        logger.warn('🚨 Detected boot loop. Initiating Auto-Healing...');
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(registrations => {
                for (const registration of registrations) { registration.unregister(); }
            });
        }
        if ('caches' in window) {
            caches.keys().then(names => { for (const name of names) { caches.delete(name); } });
        }
        sessionStorage.removeItem(BOOT_ATTEMPTS_KEY);
        setTimeout(() => window.location.reload(), BOOT_RELOAD_DELAY_MS);
        return false;
    }
    sessionStorage.setItem(BOOT_ATTEMPTS_KEY, (attempts + 1).toString());
    return true;
}

function isRunningAsInstalledPwa(): boolean {
    const standaloneDisplay = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
    const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    return standaloneDisplay || iosStandalone;
}

function setupInstallPromptCapture() {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event as BeforeInstallPromptEvent;
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
    });
}

function recommendInstallForNewUsers(isFirstTimeUser: boolean) {
    if (!isFirstTimeUser) return;
    if (isRunningAsInstalledPwa()) return;

    const openFallback = () => {
        showConfirmationModal(
            t('installPromptFallbackBody'),
            () => {},
            {
                title: t('installPromptFallbackTitle'),
                confirmText: t('closeButton'),
                hideCancel: true
            }
        );
    };

    showConfirmationModal(
        t('installPromptBody'),
        async () => {
            if (!deferredInstallPrompt) {
                openFallback();
                return;
            }

            try {
                await deferredInstallPrompt.prompt();
                await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
            } catch (error) {
                logger.warn('Install prompt failed', error);
            }
        },
        {
            title: t('installPromptTitle'),
            confirmText: t('installPromptConfirm'),
            cancelText: t('installPromptLater')
        }
    );
}

let isInitializing = false;
let isInitialized = false;

const registerServiceWorker = () => {
    if ('serviceWorker' in navigator && !window.location.protocol.startsWith('file')) {
        const loadSW = () => {
            const permission = (typeof Notification !== 'undefined' && (Notification as any).permission) ? (Notification as any).permission : 'default';
            const pushEnabled = getLocalPushOptIn() === true && permission === 'granted';
            const swUrl = pushEnabled ? './sw.js?push=1' : './sw.js';
            // FIX: Use relative path './sw.js' instead of absolute '/sw.js'.
            // This ensures the SW is fetched from the same origin even in subdirectories or proxies,
            // preventing "Script origin does not match" errors.
            navigator.serviceWorker.register(swUrl)
                .then(registration => {
                    logger.info('Service Worker registered with scope:', registration.scope);
                })
                .catch(err => {
                    logger.warn('Service worker registration failed:', err);
                });
        };

        if (document.readyState === 'complete') loadSW();
        else window.addEventListener('load', loadSW);
    }
};

async function loadInitialState() {
    // 1. CARREGAMENTO IMEDIATO (Local-First)
    await loadState();

    // 2. SINCRONIZAÇÃO PROATIVA (Background/Decisiva)
    if (hasLocalSyncKey()) {
        // Trava visual de boot: Bloqueia interações até o sync terminar ou dar timeout
        document.body.classList.add('is-booting');
        
        // Timeout de segurança para destravar a UI se a nuvem demorar demais
        const syncPromise = fetchStateFromCloud();
        const timeoutPromise = new Promise<void>((resolve) => 
            setTimeout(() => {
                if (!state.initialSyncDone) {
                    logger.warn('Boot sync timeout. Unlocking UI.');
                    state.initialSyncDone = true; // Força desbloqueio lógico
                    resolve();
                }
            }, BOOT_SYNC_TIMEOUT_MS)
        );

        Promise.race([syncPromise, timeoutPromise])
            .finally(() => {
                document.body.classList.remove('is-booting');
            });
            
    } else {
        state.initialSyncDone = true;
    }
}

function handleFirstTimeUser() {
    if (!state.hasOnboarded) {
        state.hasOnboarded = true;
        saveState();
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

        // Se o usuário já optou por notificações, carregamos o OneSignal automaticamente.
        // Isso mantém o runtime zero-deps por padrão (para quem não optou), mas respeita a decisão do usuário.
        const permission = (typeof Notification !== 'undefined' && (Notification as any).permission) ? (Notification as any).permission : 'default';
        if (getLocalPushOptIn() === true && permission === 'granted') {
            ensureOneSignalReady()
                .then((OneSignal) => OneSignal.Notifications.requestPermission?.().catch(() => {}))
                .catch(() => {});
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

    await initAuth();
    
    await Promise.all([initI18n(), updateUIText()]);

    await loadInitialState();
    const isFirstTimeUser = !state.hasOnboarded;

    setupAppListeners();
    handleFirstTimeUser();
    renderApp(); 
    setTimeout(() => recommendInstallForNewUsers(isFirstTimeUser), 1200);
    
    updateAppBadge();
    finalizeInit(loader);
    
    isInitialized = true;
    isInitializing = false;
}

const startApp = () => {
    if (!checkIntegrityAndHeal()) return;
    setupInstallPromptCapture();
    registerServiceWorker();
    if (isInitializing || isInitialized) return;
    const loader = document.getElementById('initial-loader');
    init(loader).catch(err => {
        logger.error('Boot failed', err);
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