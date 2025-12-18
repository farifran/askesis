
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [NOTA COMPARATIVA]: Este arquivo atua como o 'Controlador de Eventos'. Arquiteturalmente limpo, atua como um despachante (Dispatcher) delegando implementações para a pasta 'listeners/'.

import { ui } from './render/ui';
import { renderApp } from './render';
import { setupModalListeners } from './listeners/modals';
import { setupCardListeners } from './listeners/cards';
import { setupDragHandler } from './listeners/drag';
import { setupSwipeHandler } from './listeners/swipe';
import { setupCalendarListeners } from './listeners/calendar';
import { initChartInteractions } from './render/chart';

export function setupEventListeners() {
    // Inicializa módulos de listeners especializados
    setupModalListeners();
    setupCardListeners();
    setupCalendarListeners();
    initChartInteractions(); // Adiciona a inicialização do gráfico
    
    // Inicializa manipuladores de gestos complexos
    setupDragHandler(ui.habitContainer);
    setupSwipeHandler(ui.habitContainer);

    // Event bus listener for application-wide re-renders (breaks circular dependencies)
    document.addEventListener('render-app', () => renderApp());
}
