
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

// STATE: Proteção contra inicialização dupla (Idempotência)
let areListenersAttached = false;

// PERFORMANCE: Timer para Debounce de Rede
let networkDebounceTimer: number | undefined;

// --- STATIC HANDLERS (Zero-Allocation) ---

const _handleRenderAppEvent = () => {
    renderApp();
};

const _handlePermissionChange = () => {
    window.setTimeout(updateNotificationUI, 500);
};

const _handleOneSignalInit = (OneSignal: any) => {
    OneSignal.Notifications.addEventListener('permissionChange', _handlePermissionChange);
    updateNotificationUI();
};

/**
 * NETWORK RELIABILITY: Handler otimizado para mudanças de rede.
 * BLINDAGEM: Implementa Debounce (500ms) para evitar "Flapping" (oscilação rápida de sinal),
 * que causaria UI Thrashing e tempestades de sincronização.
 */
const _handleNetworkChange = () => {
    // Cancela execução pendente se houver nova mudança rápida
    if (networkDebounceTimer) clearTimeout(networkDebounceTimer);

    networkDebounceTimer = window.setTimeout(() => {
        const isOnline = navigator.onLine;
        const body = document.body;
        
        // UI Update
        const isOfflineClass = !isOnline;
        if (body.classList.contains('is-offline') !== isOfflineClass) {
            body.classList.toggle('is-offline', isOfflineClass);
            renderAINotificationState();
        }

        // SYNC TRIGGER: Se voltamos a ficar online e estável, empurramos dados.
        if (isOnline) {
            console.log("[Network] Online stable. Attempting to flush pending sync.");
            syncStateWithCloud(getPersistableState(), true);
        }
    }, 500);
};

/**
 * PWA LIFECYCLE: Handler para quando o app volta do background (Wake from Sleep).
 */
const _handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
        // 1. Refresh Network State (Immediately check, bypassing debounce for UX responsiveness on wake)
        // Chamamos a lógica interna diretamente ou deixamos o debounce rodar?
        // Deixar o debounce rodar é mais seguro para evitar conflitos de boot.
        _handleNetworkChange();

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
            requestAnimationFrame(renderApp);
        }
    }
};

export function setupEventListeners() {
    // ROBUSTNESS: Singleton Guard. Impede duplicação de listeners se chamado múltiplas vezes.
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

    // 3. App Event Bus
    document.addEventListener('render-app', _handleRenderAppEvent);

    // 4. ENVIRONMENT & LIFECYCLE LISTENERS
    window.addEventListener('online', _handleNetworkChange);
    window.addEventListener('offline', _handleNetworkChange);
    document.addEventListener('visibilitychange', _handleVisibilityChange);
    
    // Boot Check (Immediate execution)
    if (navigator.onLine) {
        document.body.classList.remove('is-offline');
    } else {
        document.body.classList.add('is-offline');
    }

    // 5. DEFERRED PHYSICS (Input Prioritization)
    const setupHeavyInteractions = () => {
        const container = ui.habitContainer;
        // Se o container não existir (erro de boot), aborta para evitar crash
        if (!container) return;
        
        setupDragHandler(container);
        setupSwipeHandler(container);
        initChartInteractions();
    };

    // UX OPTIMIZATION: Elevado de 'background' para 'user-visible'.
    // A física de gestos é crítica para a percepção de "App Nativo". 
    // O usuário espera poder interagir (swipe) imediatamente após ver a lista.
    if ('scheduler' in window && window.scheduler) {
        window.scheduler.postTask(setupHeavyInteractions, { priority: 'user-visible' });
    } else if ('requestIdleCallback' in window) {
        // Fallback: requestIdleCallback pode demorar muito em main thread ocupada.
        // Usamos setTimeout curto para garantir execução.
        setTimeout(setupHeavyInteractions, 50);
    } else {
        setTimeout(setupHeavyInteractions, 50);
    }
}
