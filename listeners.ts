
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners.ts
 * @description Ponto de Entrada para Inicialização de Eventos (Event Bootstrapper).
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

const _handleNetworkChange = () => {
    if (networkDebounceTimer) clearTimeout(networkDebounceTimer);

    networkDebounceTimer = window.setTimeout(() => {
        const isOnline = navigator.onLine;
        const wasOffline = document.body.classList.contains('is-offline');
        document.body.classList.toggle('is-offline', !isOnline);
        
        if (wasOffline === isOnline) {
            renderAINotificationState();
        }

        if (isOnline) {
            console.log("[Network] Online stable. Checking for updates/syncing.");
            syncStateWithCloud(getPersistableState(), true);
        }
    }, NETWORK_DEBOUNCE_MS);
};

const _handleResume = () => {
    // Shared logic for visibilitychange and pageshow
    _handleNetworkChange();

    if (navigator.onLine) {
        syncStateWithCloud(getPersistableState(), true);
    }

    const cachedToday = getTodayUTCIso();
    resetTodayCache();
    const realToday = getTodayUTCIso();

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
};

const _handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
        _handleResume();
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

    window.addEventListener('online', _handleNetworkChange);
    window.addEventListener('offline', _handleNetworkChange);
    
    // SYNC ROBUSTNESS: Listen to both visibilitychange and pageshow (bfcache)
    document.addEventListener('visibilitychange', _handleVisibilityChange);
    window.addEventListener('pageshow', _handleResume);
    
    document.body.classList.toggle('is-offline', !navigator.onLine);

    const setupHeavyInteractions = () => {
        try {
            const container = ui.habitContainer;
            setupDragHandler(container);
            setupSwipeHandler(container);
            initChartInteractions();
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
