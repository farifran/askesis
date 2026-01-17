
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners.ts
 * @description Ponto de Entrada para Inicialização de Eventos (Event Bootstrapper).
 */

import { ui } from '../render/ui';
import { renderApp, renderAINotificationState, updateNotificationUI, initModalEngine, getCachedHabitCard, updateHabitCardElement } from '../render';
import { setupModalListeners } from './listeners/modals';
import { setupCardListeners } from './listeners/cards';
import { setupDragHandler } from './listeners/drag';
import { setupSwipeHandler } from './listeners/swipe';
import { setupCalendarListeners } from './listeners/calendar';
import { setupChartListeners } from './listeners/chart';
import { pushToOneSignal, getTodayUTCIso, resetTodayCache } from './utils';
import { state, getPersistableState } from '../state';
import { syncStateWithCloud, fetchStateFromCloud } from './services/cloud';
import { checkAndAnalyzeDayContext } from './services/analysis';

const NETWORK_DEBOUNCE_MS = 500;
const PERMISSION_DELAY_MS = 500;
const INTERACTION_DELAY_MS = 50;

let areListenersAttached = false;
let networkDebounceTimer: number | undefined;
let visibilityRafId: number | null = null;

const _handlePermissionChange = () => {
    window.setTimeout(updateNotificationUI, PERMISSION_DELAY_MS);
};

const _handleOneSignalInit = (OneSignal: any) => {
    OneSignal.Notifications.addEventListener('permissionChange', _handlePermissionChange);
    updateNotificationUI();
};

/**
 * NETWORK RELIABILITY: Handler otimizado para mudanças de rede.
 */
const _handleNetworkChange = () => {
    if (networkDebounceTimer) clearTimeout(networkDebounceTimer);

    networkDebounceTimer = window.setTimeout(() => {
        const isOnline = navigator.onLine;
        const wasOffline = document.body.classList.contains('is-offline');
        document.body.classList.toggle('is-offline', !isOnline);
        
        if (wasOffline === isOnline) {
            renderAINotificationState();
        }

        // SYNC TRIGGER: Se voltamos a ficar online, fazemos PULL para garantir que estamos atualizados
        // e depois o próprio fluxo cuidará do PUSH se necessário.
        if (isOnline) {
            console.log("[Network] Online. Triggering Pull & Sync.");
            fetchStateFromCloud();
        }
    }, NETWORK_DEBOUNCE_MS);
};

/**
 * PWA LIFECYCLE: Handler para quando o app volta do background (Wake from Sleep).
 */
const _handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
        _handleNetworkChange();

        const cachedToday = getTodayUTCIso();
        resetTodayCache(); 
        const realToday = getTodayUTCIso(); 

        // Se mudou o dia, refresh total
        if (cachedToday !== realToday) {
            console.log("App woke up in a new day. Refreshing context.");
            if (state.selectedDate === cachedToday) {
                state.selectedDate = realToday;
            }
            document.dispatchEvent(new CustomEvent('dayChanged'));
        } else {
            if (visibilityRafId) cancelAnimationFrame(visibilityRafId);
            visibilityRafId = requestAnimationFrame(() => {
                renderApp();
                visibilityRafId = null;
            });
        }
        
        // SYNC ON WAKE: Garante que pegamos alterações de outros devices
        if (navigator.onLine) {
             fetchStateFromCloud();
        }
    }
};

const _handleCardUpdate = (e: Event) => {
    const { habitId, time } = (e as CustomEvent).detail;
    const habit = state.habits.find(h => h.id === habitId);
    let cardElement = getCachedHabitCard(habitId, time);

    if (!cardElement) {
         cardElement = document.querySelector(`.habit-card[data-habit-id="${habitId}"][data-time="${time}"]`) as HTMLElement;
    }

    if (habit && cardElement) {
        const shouldAnimate = e.type === 'card-status-changed';
        updateHabitCardElement(cardElement, habit, time, undefined, { animate: shouldAnimate });
    }
};

export function setupEventListeners() {
    if (areListenersAttached) {
        console.warn("setupEventListeners called multiple times. Ignoring.");
        return;
    }
    areListenersAttached = true;

    initModalEngine();
    setupModalListeners();
    setupCardListeners();
    setupCalendarListeners();
    
    pushToOneSignal(_handleOneSignalInit);

    document.addEventListener('render-app', renderApp);
    
    document.addEventListener('request-analysis', (e: Event) => {
        const ce = e as CustomEvent;
        if (ce.detail?.date) {
            checkAndAnalyzeDayContext(ce.detail.date);
        }
    });

    document.addEventListener('card-status-changed', _handleCardUpdate);
    document.addEventListener('card-goal-changed', _handleCardUpdate);

    window.addEventListener('online', _handleNetworkChange);
    window.addEventListener('offline', _handleNetworkChange);
    document.addEventListener('visibilitychange', _handleVisibilityChange);
    
    document.body.classList.toggle('is-offline', !navigator.onLine);

    const setupHeavyInteractions = () => {
        try {
            const container = ui.habitContainer;
            setupDragHandler(container);
            setupSwipeHandler(container);
            setupChartListeners();
        } catch (e) {
            console.warn("Interaction setup skipped: DOM not ready/Element missing.");
        }
    };

    if ('scheduler' in window && (window as any).scheduler) {
        (window as any).scheduler.postTask(setupHeavyInteractions, { priority: 'user-visible' });
    } else {
        setTimeout(setupHeavyInteractions, INTERACTION_DELAY_MS);
    }
}
