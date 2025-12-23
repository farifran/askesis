
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners.ts
 * @description Orquestrador Central de Interatividade e Despacho de Eventos.
 * 
 * [MAIN THREAD]: Este módulo é o ponto de entrada para toda a reatividade da aplicação na thread principal.
 * Foco absoluto em latência de entrada mínima (input latency) para manter 60fps constantes.
 * 
 * ARQUITETURA:
 * 1. **Delegation Pattern:** Atua como um Dispatcher que inicializa sub-módulos especializados. Isso previne 
 *    a criação de um "God Object" de eventos e permite otimização granular de memória em cada categoria (Modals, Cards, etc).
 * 2. **Event Bus Pattern:** Implementa o listener global 'render-app' no objeto `document`. Esta decisão técnica 
 *    resolve dependências circulares, permitindo que a lógica de negócios (habitActions.ts) notifique a UI 
 *    sem importar diretamente o motor de renderização.
 * 3. **Complex Gesture Orchestration:** Inicializa sistemas de Swipe e Drag & Drop que dependem de Geometry Caching 
 *    para evitar Layout Thrashing durante movimentos rápidos.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `render/ui.ts`: Referências estáticas de alta velocidade para elementos críticos do DOM.
 * - `listeners/*`: Implementações desacopladas da lógica de resposta.
 * - `render/chart.ts`: Inicialização de interações SVG/Canvas.
 */

import { ui } from './render/ui';
import { renderApp } from './render';
import { setupModalListeners } from './listeners/modals';
import { setupCardListeners } from './listeners/cards';
import { setupDragHandler } from './listeners/drag';
import { setupSwipeHandler } from './listeners/swipe';
import { setupCalendarListeners } from './listeners/calendar';
import { initChartInteractions } from './render/chart';

export function setupEventListeners() {
    // [MAIN THREAD]: Inicialização sequencial de listeners especializados.
    setupModalListeners();
    setupCardListeners();
    setupCalendarListeners();
    
    // PERFORMANCE: A inicialização do gráfico ocorre de forma ociosa ou sob demanda para não bloquear o FCP.
    initChartInteractions(); 
    
    // PERFORMANCE: Uso de delegação de eventos no `habitContainer`. 
    // Em vez de N listeners (um para cada hábito), usamos um único ponto de entrada para processar gestos complexos.
    setupDragHandler(ui.habitContainer);
    setupSwipeHandler(ui.habitContainer);

    // DO NOT REFACTOR: Arquitetura de Desacoplamento via CustomEvents.
    // O evento 'render-app' permite que mutações de estado ocorram em qualquer lugar do sistema
    // disparando a atualização da UI sem acoplamento forte entre módulos.
    document.addEventListener('render-app', () => renderApp());
}
