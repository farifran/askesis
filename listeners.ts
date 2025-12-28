
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
 * ARQUITETURA:
 * - Padrão "Facade": Centraliza a chamada de inicializadores espalhados por domínios (Modais, Cards, Gestos).
 * - Injeção de Dependência Leve: Passa referências de DOM cacheadas (`ui.habitContainer`) para os handlers 
 *   de gestos para evitar querySelectors repetitivos em módulos filhos.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `render/ui.ts`: Fonte da verdade para elementos DOM (evita re-query).
 * - `listeners/*.ts`: Implementações especializadas de eventos.
 * 
 * DECISÃO TÉCNICA (Event Bus):
 * - O listener 'render-app' é a espinha dorsal da reatividade desacoplada.
 * - Permite que a camada de Lógica (`habitActions.ts`) solicite renderizações sem importar 
 *   diretamente a camada de View (`render.ts`), quebrando dependências circulares estritas.
 */

// [NOTA COMPARATIVA]: Este arquivo atua como o 'Controlador de Eventos'. Arquiteturalmente limpo, atua como um despachante (Dispatcher) delegando implementações para a pasta 'listeners/'.

import { ui } from './render/ui';
import { renderApp, renderAINotificationState, updateNotificationUI } from './render';
import { setupModalListeners } from './listeners/modals';
import { setupCardListeners } from './listeners/cards';
import { setupDragHandler } from './listeners/drag';
import { setupSwipeHandler } from './listeners/swipe';
import { setupCalendarListeners } from './listeners/calendar';
import { initChartInteractions } from './render/chart';
import { pushToOneSignal } from './utils';

/**
 * Configura os listeners de notificação e atualiza a UI inicial.
 * MOVIDO DE cloud.ts [2025-04-14] para quebrar dependência circular.
 */
function setupNotificationListeners() {
    pushToOneSignal((OneSignal: any) => {
        // Este listener garante que a UI seja atualizada se o usuário alterar
        // as permissões de notificação nas configurações do navegador enquanto o app estiver aberto.
        OneSignal.Notifications.addEventListener('permissionChange', () => {
            // UX: Adia a atualização da UI para dar tempo ao SDK de atualizar seu estado interno.
            setTimeout(updateNotificationUI, 500);
        });

        // Atualiza a UI no carregamento inicial, caso o estado já esteja definido.
        updateNotificationUI();
    });
}

export function setupEventListeners() {
    // Inicializa módulos de listeners especializados
    setupModalListeners();
    setupCardListeners();
    setupCalendarListeners();
    initChartInteractions(); // Adiciona a inicialização do gráfico
    setupNotificationListeners(); // Inicializa listeners de notificação
    
    // Inicializa manipuladores de gestos complexos (Física de Drag & Swipe)
    // PERFORMANCE: Passamos o elemento cacheado `ui.habitContainer` para evitar que os 
    // módulos de gestos precisem fazer `document.querySelector` durante a inicialização.
    setupDragHandler(ui.habitContainer);
    setupSwipeHandler(ui.habitContainer);

    // CRITICAL LOGIC: Application Event Bus.
    // Event listener bus for application-wide re-renders (breaks circular dependencies).
    // DO NOT REFACTOR: Substituir isso por uma importação direta em `habitActions` causará
    // ciclos de dependência (Render -> State -> Actions -> Render).
    document.addEventListener('render-app', () => renderApp());

    // --- NETWORK STATUS LISTENER ---
    // UX: Monitora conectividade para alternar o ícone da IA (Sparkle <-> Offline Cloud)
    // e desabilitar o botão quando sem internet.
    const handleNetworkChange = () => {
        const isOffline = !navigator.onLine;
        
        // CSS Hook: O index.css usa body.is-offline para trocar a visibilidade dos ícones
        document.body.classList.toggle('is-offline', isOffline);
        
        // Update Logic: Atualiza o estado 'disabled' do botão
        renderAINotificationState();
    };

    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);
    
    // Verificação inicial no boot
    handleNetworkChange();
}
