
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
 * - **Injeção de Dependência Leve:** Passa referências de DOM cacheadas (`ui.habitContainer`) para os motores de física.
 * - **Event Bus:** O listener 'render-app' desacopla a Lógica da View.
 */

import { ui } from './render/ui';
import { renderApp, renderAINotificationState, updateNotificationUI, initModalEngine } from './render';
import { setupModalListeners } from './listeners/modals';
import { setupCardListeners } from './listeners/cards';
import { setupDragHandler } from './listeners/drag';
import { setupSwipeHandler } from './listeners/swipe';
import { setupCalendarListeners } from './listeners/calendar';
import { initChartInteractions } from './render/chart';
import { pushToOneSignal } from './utils';

// --- STATIC HANDLERS (Zero-Allocation) ---
// V8 Optimization: Hoisted constants avoid creating closure scopes during initialization.

const _handleRenderAppEvent = () => {
    renderApp();
};

const _handlePermissionChange = () => {
    // UX: Adia a atualização da UI para dar tempo ao SDK de atualizar seu estado interno.
    // Usamos window.setTimeout para evitar busca de escopo global implícita.
    window.setTimeout(updateNotificationUI, 500);
};

const _handleOneSignalInit = (OneSignal: any) => {
    // Listener aponta para referência estática.
    OneSignal.Notifications.addEventListener('permissionChange', _handlePermissionChange);
    // Atualiza a UI no carregamento inicial (Fast Path).
    updateNotificationUI();
};

/**
 * Handler otimizado para mudanças de rede.
 * Realiza "Dirty Check" estrito antes de invalidar estilos.
 */
const _handleNetworkChange = () => {
    const isOffline = !navigator.onLine;
    const body = document.body;
    
    // PERFORMANCE: Dirty Check para evitar 'Recalculate Style' desnecessário.
    // O acesso a classList.contains é O(1) e muito mais barato que uma escrita no DOM.
    if (body.classList.contains('is-offline') !== isOffline) {
        body.classList.toggle('is-offline', isOffline);
        // Só re-renderiza componentes reativos se o estado realmente mudou.
        renderAINotificationState();
    }
};

export function setupEventListeners() {
    // 1. Inicializa motores de UI globais
    initModalEngine();

    // 2. Inicializa módulos de listeners especializados (Subsystems)
    setupModalListeners();
    setupCardListeners();
    setupCalendarListeners();
    initChartInteractions(); 
    
    // 3. Notification System (Async/Callback based)
    // Passa a referência da função estática, zero alocação de closure.
    pushToOneSignal(_handleOneSignalInit);
    
    // 4. Inicializa manipuladores de gestos complexos (Physics Engines)
    // PERFORMANCE: Passamos o elemento cacheado `ui.habitContainer` (Direct Memory Reference).
    // Isso evita que setupDragHandler precise fazer um querySelector interno.
    const container = ui.habitContainer;
    setupDragHandler(container);
    setupSwipeHandler(container);

    // 5. CRITICAL LOGIC: Application Event Bus.
    document.addEventListener('render-app', _handleRenderAppEvent);

    // 6. NETWORK STATUS LISTENER (Native Events)
    window.addEventListener('online', _handleNetworkChange);
    window.addEventListener('offline', _handleNetworkChange);
    
    // Verificação inicial no boot (Fast Path)
    _handleNetworkChange();
}
