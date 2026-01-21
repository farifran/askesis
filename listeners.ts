
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners.ts
 * @description Ponto de Entrada para Inicialização de Eventos (Event Bootstrapper).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo roda na thread principal e deve ser executado apenas UMA VEZ na inicialização (Singleton initialization).
 * 
 * ARQUITETURA (Static Dispatch & Dependency Injection):
 * - **Static Handlers:** Callbacks são definidos no escopo do módulo para evitar alocação de closures durante o boot.
 * - **Sync-on-Connect:** Garante integridade de dados ao recuperar conexão.
 */

import { ui } from './render/ui';
import { renderApp, renderAINotificationState, updateNotificationUI, initModalEngine } from './render';
import { setupModalListeners } from './listeners/modals';
import { setupCardListeners } from './listeners/cards';
import { setupDragHandler } from './listeners/drag';
import { setupSwipeHandler } from './listeners/swipe';
import { setupCalendarListeners } from './listeners/calendar';
import { initChartInteractions } from './render/chart';
import { pushToOneSignal, getTodayUTCIso, resetTodayCache } from './utils';
import { state, getPersistableState } from './state';
import { syncStateWithCloud } from './services/cloud';

// CONSTANTS
const NETWORK_DEBOUNCE_MS = 500;
const PERMISSION_DELAY_MS = 500;
const INTERACTION_DELAY_MS = 50;

// STATE: Proteção contra inicialização dupla (Idempotência)
let areListenersAttached = false;

// PERFORMANCE: Timer para Debounce de Rede
let networkDebounceTimer: number | undefined;

// PERFORMANCE: RAF ID para evitar Render Storm em visibilitychange [CHAOS FIX]
let visibilityRafId: number | null = null;

// --- STATIC HANDLERS (Zero-Allocation) ---

const _handlePermissionChange = () => {
    window.setTimeout(updateNotificationUI, PERMISSION_DELAY_MS);
};

const _handleOneSignalInit = (OneSignal: any) => {
    OneSignal.Notifications.addEventListener('permissionChange', _handlePermissionChange);
    updateNotificationUI();
};

/**
 * NETWORK RELIABILITY: Handler otimizado para mudanças de rede.
 * BLINDAGEM: Implementa Debounce (500ms) para evitar "Flapping".
 */
const _handleNetworkChange = () => {
    if (networkDebounceTimer) clearTimeout(networkDebounceTimer);

    networkDebounceTimer = window.setTimeout(() => {
        const isOnline = navigator.onLine;
        
        // UI Update: Toggle class and re-render notification state if changed
        const wasOffline = document.body.classList.contains('is-offline');
        document.body.classList.toggle('is-offline', !isOnline);
        
        if (wasOffline === isOnline) { // Estado mudou
            renderAINotificationState();
        }

        // SYNC TRIGGER: Se voltamos a ficar online e estável, empurramos dados.
        // O algoritmo de resolução de conflitos (409) cuidará de puxar atualizações remotas se necessário.
        if (isOnline) {
            console.log("[Network] Online stable. Checking for updates/syncing.");
            syncStateWithCloud(getPersistableState(), true);
        }
    }, NETWORK_DEBOUNCE_MS);
};

/**
 * PWA LIFECYCLE: Handler para quando o app volta do background (Wake from Sleep).
 */
const _handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
        // 1. Refresh Network State (Immediately check)
        _handleNetworkChange();

        // SYNC TRIGGER [2025-06-03]: Força uma verificação de sincronização (Pull/Push) ao acordar.
        // Se houver dados novos na nuvem (de outro dispositivo), o servidor retornará 409 e o
        // cliente fará o merge automaticamente.
        if (navigator.onLine) {
            syncStateWithCloud(getPersistableState(), true);
        }

        // 2. Temporal Consistency Check
        const cachedToday = getTodayUTCIso(); // Valor atual em cache
        resetTodayCache(); // Força recálculo
        const realToday = getTodayUTCIso(); // Novo valor real

        if (cachedToday !== realToday) {
            console.log("App woke up in a new day. Refreshing context.");
            if (state.selectedDate === cachedToday) {
                state.selectedDate = realToday;
            }
            document.dispatchEvent(new CustomEvent('dayChanged'));
        } else {
            // Re-sync visual state
            // CHAOS FIX: Debounce visual alinhado ao VSync para evitar Render Storm
            if (visibilityRafId) cancelAnimationFrame(visibilityRafId);
            visibilityRafId = requestAnimationFrame(() => {
                renderApp();
                visibilityRafId = null;
            });
        }
    }
};

export function setupEventListeners() {
    // ROBUSTNESS: Singleton Guard.
    if (areListenersAttached) {
        console.warn("setupEventListeners called multiple times. Ignoring.");
        return;
    }
    areListenersAttached = true;

    // 1. Critical Path Listeners
    initModalEngine();
    setupModalListeners();
    setupCardListeners();
    setupCalendarListeners();
    
    // 2. Notification System
    pushToOneSignal(_handleOneSignalInit);

    // 3. App Event Bus (Direct reference)
    document.addEventListener('render-app', renderApp);

    // 4. ENVIRONMENT & LIFECYCLE LISTENERS
    window.addEventListener('online', _handleNetworkChange);
    window.addEventListener('offline', _handleNetworkChange);
    document.addEventListener('visibilitychange', _handleVisibilityChange);
    
    // Boot Check (Immediate execution)
    document.body.classList.toggle('is-offline', !navigator.onLine);

    // 5. DEFERRED PHYSICS (Input Prioritization)
    const setupHeavyInteractions = () => {
        try {
            // CHAOS FIX: O acesso a ui.* lança erro se o DOM estiver incompleto.
            const container = ui.habitContainer;
            setupDragHandler(container);
            setupSwipeHandler(container);
            initChartInteractions();
        } catch (e) {
            console.warn("Interaction setup skipped: DOM not ready/Element missing.");
        }
    };

    // UX OPTIMIZATION: Elevado de 'background' para 'user-visible'.
    // A física de gestos é crítica para a percepção de "App Nativo". 
    // @fix: Cast to any to check and call scheduler API
    if ('scheduler' in window && (window as any).scheduler) {
        (window as any).scheduler.postTask(setupHeavyInteractions, { priority: 'user-visible' });
    } else {
        // Fallback universal: setTimeout garante execução na próxima task loop.
        setTimeout(setupHeavyInteractions, INTERACTION_DELAY_MS);
    }
}
