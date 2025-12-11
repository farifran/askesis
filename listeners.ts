
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída.
// [NOTA COMPARATIVA]: Este arquivo atua como o 'Controlador de Eventos'. Em comparação com a complexidade algorítmica de 'habitActions.ts' ou a manipulação direta do DOM em 'render.ts', este arquivo é arquiteturalmente limpo, atuando como um despachante (Dispatcher). Seu nível de código é excelente, pois delega responsabilidades complexas (Swipe, Drag&Drop) para módulos especializados.

import { ui } from './ui';
import { state, invalidateChartCache, DAYS_IN_CALENDAR } from './state';
import { renderApp, renderFullCalendar, openModal, scrollToToday } from './render';
import { parseUTCIsoDate, triggerHaptic, getTodayUTCIso, addDays } from './utils';
import { setupModalListeners } from './modalListeners';
import { setupHabitCardListeners } from './habitCardListeners';
import { setupDragAndDropHandler } from './dragAndDropHandler';
import { setupSwipeHandler } from './swipeHandler';

function updateSelectedDateAndRender(date: string) {
    state.selectedDate = date;
    // UX UPDATE [2025-02-15]: Força a atualização da UI.
    // Como a navegação ou seleção mudou a data, precisamos garantir que o renderApp 
    // saiba que a estrutura da lista de hábitos mudou.
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    invalidateChartCache();
    renderApp();
}

export function setupEventListeners() {
    // Inicializa módulos de listeners especializados
    setupModalListeners();
    setupHabitCardListeners();
    
    // Inicializa manipuladores de gestos complexos
    setupDragAndDropHandler(ui.habitContainer);
    setupSwipeHandler(ui.habitContainer);

    // --- Calendar Strip Logic (Long Press & Click) ---
    // Variáveis de controle para distinguir clique de pressão longa
    const LONG_PRESS_DURATION = 500;
    let longPressTimer: number | null = null;
    let isLongPress = false;

    const openAlmanac = () => {
        state.fullCalendar = {
            year: parseUTCIsoDate(state.selectedDate).getUTCFullYear(),
            month: parseUTCIsoDate(state.selectedDate).getUTCMonth()
        };
        renderFullCalendar();
        openModal(ui.fullCalendarModal);
    };

    const clearTimer = () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    };

    // UX: Pointer events para suporte unificado a Mouse e Touch
    ui.calendarStrip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // Apenas botão esquerdo/toque principal
        const dayItem = (e.target as HTMLElement).closest('.day-item');
        if (!dayItem) return;

        isLongPress = false;
        longPressTimer = window.setTimeout(() => {
            isLongPress = true;
            triggerHaptic('medium');
            openAlmanac();
        }, LONG_PRESS_DURATION);
    });

    // Cancela o timer em qualquer interrupção
    ui.calendarStrip.addEventListener('pointerup', clearTimer);
    ui.calendarStrip.addEventListener('pointercancel', clearTimer);
    ui.calendarStrip.addEventListener('pointerleave', clearTimer);
    ui.calendarStrip.addEventListener('scroll', clearTimer); // Scroll cancela a intenção de long press

    ui.calendarStrip.addEventListener('click', e => {
        // Previne a seleção se foi um Long Press (gatilho do Almanaque)
        if (isLongPress) {
            e.preventDefault();
            e.stopPropagation();
            isLongPress = false;
            return;
        }

        const dayItem = (e.target as HTMLElement).closest<HTMLElement>('.day-item');
        if (dayItem && dayItem.dataset.date) {
            triggerHaptic('selection');
            updateSelectedDateAndRender(dayItem.dataset.date);
        }
    });

    // --- Header Title Listener (Go to Today) ---
    // [2025-02-23]: Removida verificação 'if (ui.headerTitle)' pois initUI garante existência do elemento.
    ui.headerTitle.addEventListener('click', () => {
        triggerHaptic('light');
        
        const today = getTodayUTCIso();
        
        // LOGIC FIX [2025-02-18]: Reset Calendar Range.
        // Se o usuário navegou para longe via almanaque, clicar em "Hoje" deve trazer
        // a faixa do calendário de volta para a visualização padrão (centrada em hoje).
        const todayDate = parseUTCIsoDate(today);
        state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
            addDays(todayDate, i - 30)
        );

        updateSelectedDateAndRender(today);
        
        // Visual Reset: Smooth scroll to the updated "today" element
        scrollToToday('smooth');
    });
}
