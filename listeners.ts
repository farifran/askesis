/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [NOTA COMPARATIVA]: Este arquivo atua como o 'Controlador de Eventos'. Em comparação com a complexidade algorítmica de 'habitActions.ts' ou a manipulação direta do DOM em 'render.ts', este arquivo é arquiteturalmente limpo, atuando como um despachante (Dispatcher). Seu nível de código é excelente, pois delega responsabilidades complexas (Swipe, Drag&Drop) para módulos especializados.

import { ui } from './ui';
import { state, invalidateChartCache, DAYS_IN_CALENDAR } from './state';
import { renderApp, renderFullCalendar, openModal, scrollToToday } from './render';
import { parseUTCIsoDate, triggerHaptic, getTodayUTCIso, addDays, toUTCIsoDateString } from './utils';
import { setupModalListeners } from './modalListeners';
import { setupHabitCardListeners } from './habitCardListeners';
import { setupDragAndDropHandler } from './dragAndDropHandler';
import { setupSwipeHandler } from './swipeHandler';
import { DOM_SELECTORS } from './domConstants';
import { markAllHabitsForDate } from './habitActions';

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
    
    // Variáveis de controle para múltiplos cliques
    let clickCount = 0;
    let clickTimer: number | null = null;
    const MULTI_CLICK_DELAY = 300; // ms

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
        const dayItem = (e.target as HTMLElement).closest(DOM_SELECTORS.DAY_ITEM);
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

        const dayItem = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.DAY_ITEM);
        if (!dayItem || !dayItem.dataset.date) return;

        const dateISO = dayItem.dataset.date;

        clickCount++;

        if (clickTimer) {
            clearTimeout(clickTimer);
        }

        clickTimer = window.setTimeout(() => {
            switch (clickCount) {
                case 1:
                    // Single Click: Select Date
                    triggerHaptic('selection');
                    updateSelectedDateAndRender(dateISO);
                    break;
                case 2:
                    // Double Click: Mark all as completed
                    triggerHaptic('success');
                    if (markAllHabitsForDate(dateISO, 'completed')) {
                        renderApp();
                    }
                    break;
                default:
                    // Triple Click or more: Mark all as snoozed
                    if (clickCount >= 3) {
                        triggerHaptic('medium');
                        if (markAllHabitsForDate(dateISO, 'snoozed')) {
                            renderApp();
                        }
                    }
                    break;
            }
            clickCount = 0; // Reseta após a ação
        }, MULTI_CLICK_DELAY);
    });

    // A11Y [2025-02-23]: Navegação por teclado na faixa de dias (Roving Focus)
    ui.calendarStrip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        
        e.preventDefault();
        
        const currentDate = parseUTCIsoDate(state.selectedDate);
        let newDate: Date;
        
        if (e.key === 'ArrowLeft') {
            newDate = addDays(currentDate, -1);
        } else {
            newDate = addDays(currentDate, 1);
        }
        
        const newDateStr = toUTCIsoDateString(newDate);
        
        // Verifica se a nova data está dentro do alcance visível (opcional, mas bom para UX)
        // O renderApp vai regenerar a faixa se necessário (se mudasse o intervalo),
        // mas aqui estamos apenas navegando dentro da faixa existente.
        triggerHaptic('selection');
        updateSelectedDateAndRender(newDateStr);
        
        // Gerenciamento de Foco: Após a re-renderização, foca no novo dia selecionado.
        // O requestAnimationFrame garante que o DOM foi atualizado.
        requestAnimationFrame(() => {
            const newSelectedEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${newDateStr}"]`);
            if (newSelectedEl) {
                newSelectedEl.focus();
                newSelectedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
        });
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