
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/calendar.ts
 * @description Controlador de Interação do Calendário (Strip & Full Almanac).
 * 
 * [MAIN THREAD CONTEXT]:
 * Otimizado para 60fps em navegação e gestos.
 * 
 * ARQUITETURA (SOTA):
 * - **Static State Machine:** Evita alocação de closures para timers e handlers de eventos.
 * - **Async Layout (RAF):** Separa leitura de geometria (DOM Read) da escrita de estilo (DOM Write).
 * - **Event Delegation:** Um único listener gerencia todos os dias.
 * - **Directional Animation:** Aplica classes CSS manuais para feedback espacial (Passado/Futuro) sem usar View Transitions.
 */

import { ui } from '../render/ui';
import { state, DAYS_IN_CALENDAR } from '../state';
import { renderApp, renderFullCalendar, openModal, scrollToToday, closeModal } from '../render';
import { parseUTCIsoDate, triggerHaptic, getTodayUTCIso, addDays, toUTCIsoDateString } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { markAllHabitsForDate } from '../habitActions';

// --- STATIC CONSTANTS ---
const LONG_PRESS_DURATION = 500;
// SECURITY: Strict ISO 8601 Date Format (YYYY-MM-DD)
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// CONSTANTE DE FLUIDEZ: Margem de segurança para regenerar o calendário antes de bater na borda.
// Garante que sempre haja dias suficientes para o scroll animar.
const INFINITE_SCROLL_BUFFER = 4; 

// --- STATIC STATE MACHINE (Hot Memory) ---
const CalendarGestureState = {
    timerId: 0,
    isLongPress: 0, // 0 | 1 (Int32)
    activeDateISO: null as string | null,
    targetDayEl: null as HTMLElement | null
};

// --- HELPERS ---

function _clearGestureTimer() {
    if (CalendarGestureState.timerId) {
        clearTimeout(CalendarGestureState.timerId);
        CalendarGestureState.timerId = 0;
    }
    // Cleanup reference to prevent memory leaks if element is removed
    CalendarGestureState.targetDayEl = null;
}

// HELPER: Centraliza a lógica de reconstrução do array de datas
function _regenerateCalendarDates(centerDate: Date) {
    const halfRange = Math.floor(DAYS_IN_CALENDAR / 2); // 30
    state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
        addDays(centerDate, i - halfRange)
    );
    state.uiDirtyState.calendarVisuals = true;
}

/**
 * Executa a lógica visual do Long Press (Popover).
 * Separado em fase de Leitura e Escrita para evitar Layout Thrashing.
 */
function _executeLongPressVisuals(dayItem: HTMLElement, dateISO: string) {
    // CHAOS FIX: ZOMBIE POPOVER GUARD
    // Se o elemento foi removido do DOM (ex: infinite scroll reciclou a lista), abortamos.
    if (!dayItem.isConnected) {
        return;
    }

    CalendarGestureState.isLongPress = 1;
    dayItem.classList.add('is-pressing');
    triggerHaptic('medium');
    
    CalendarGestureState.activeDateISO = dateISO;

    // 1. READ PHASE (Synchronous)
    const rect = dayItem.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    
    // 2. WRITE PHASE (Async / RAF)
    requestAnimationFrame(() => {
        // Double check inside RAF as well
        if (!dayItem.isConnected) return;

        const modal = ui.calendarQuickActions;
        const modalContent = modal.querySelector<HTMLElement>('.quick-actions-content');

        if (!modalContent) return;

        const top = rect.bottom + 8;
        const centerPoint = rect.left + rect.width / 2;
        const modalWidth = 240; 
        const padding = 8; 

        let finalLeft = centerPoint;
        let translateX = '-50%';

        const halfModalWidth = modalWidth / 2;
        const leftEdge = centerPoint - halfModalWidth;
        const rightEdge = centerPoint + halfModalWidth;

        // Edge Detection
        if (leftEdge < padding) {
            finalLeft = padding;
            translateX = '0%';
        } else if (rightEdge > windowWidth - padding) {
            finalLeft = windowWidth - padding;
            translateX = '-100%';
        }

        // Direct Style Write (Composite Layer)
        modal.style.setProperty('--actions-top', `${top}px`);
        modal.style.setProperty('--actions-left', `${finalLeft}px`);
        modalContent.style.setProperty('--translate-x', translateX);

        openModal(modal, undefined, () => {
            CalendarGestureState.activeDateISO = null;
        });
        
        // Cleanup visual state
        dayItem.classList.remove('is-pressing');
    });
}

/**
 * Atualiza a data e renderiza com animação direcional.
 * @param date Nova data ISO.
 * @param forcedDirection Opcional: 1 (Futuro/Direita), -1 (Passado/Esquerda). Se omitido, é inferido.
 */
function updateSelectedDateAndRender(date: string, forcedDirection?: number) {
    if (state.selectedDate !== date) {
        // 1. Inferir Direção: Se a nova data é maior, estamos indo para o futuro (1).
        const dir = forcedDirection !== undefined 
            ? forcedDirection 
            : (date > state.selectedDate ? 1 : -1);

        state.selectedDate = date;
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        state.uiDirtyState.chartData = true;
        
        // 2. Renderizar Dados (DOM Update)
        renderApp();

        // 3. Aplicar Animação CSS no Container Principal
        requestAnimationFrame(() => {
            const container = ui.habitContainer;
            if (!container) return;

            // Reset: Remove classes anteriores para permitir re-trigger da animação
            container.classList.remove('anim-slide-left', 'anim-slide-right');
            
            // Force Reflow: Necessário para o navegador registrar que a classe foi removida e adicionada novamente
            void container.offsetWidth; 
            
            // Aplica a classe baseada na direção
            if (dir === 1) {
                // Indo para o Futuro -> Conteúdo entra da Direita
                container.classList.add('anim-slide-right');
            } else {
                // Indo para o Passado -> Conteúdo entra da Esquerda
                container.classList.add('anim-slide-left');
            }
        });
    }
}

// --- STATIC EVENT HANDLERS (Zero-Allocation) ---

const _handlePointerUp = () => {
    _clearGestureTimer();
    window.removeEventListener('pointerup', _handlePointerUp);
    window.removeEventListener('pointercancel', _handlePointerUp);
};

const _handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    
    const dayItem = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.DAY_ITEM);
    if (!dayItem || !dayItem.dataset.date) return;

    // SECURITY: Validação de Formato de Data antes de processar
    if (!ISO_DATE_REGEX.test(dayItem.dataset.date)) {
        console.warn("Invalid date format in calendar item.");
        return;
    }

    CalendarGestureState.isLongPress = 0;
    CalendarGestureState.targetDayEl = dayItem;
    const dateISO = dayItem.dataset.date;

    // Start Timer
    CalendarGestureState.timerId = window.setTimeout(() => {
        _executeLongPressVisuals(dayItem, dateISO);
    }, LONG_PRESS_DURATION);

    // Attach self-cleaning listeners
    window.addEventListener('pointerup', _handlePointerUp, { once: true });
    window.addEventListener('pointercancel', _handlePointerUp, { once: true });
};

const _handleCalendarClick = (e: MouseEvent) => {
    if (CalendarGestureState.isLongPress) {
        e.preventDefault();
        e.stopPropagation();
        CalendarGestureState.isLongPress = 0;
        return;
    }

    const dayItem = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.DAY_ITEM);
    const dateISO = dayItem?.dataset.date;

    if (!dayItem || !dateISO) return;

    // SECURITY: Validação de Data
    if (!ISO_DATE_REGEX.test(dateISO)) {
        console.warn("Attempt to navigate to invalid date detected and blocked.");
        return;
    }

    triggerHaptic('selection');
    
    // NAVIGATION: Infer direction automatically
    updateSelectedDateAndRender(dateISO);
    
    // UX FIX: Force 'Standard Position' (End alignment) when clicking 'Today' manually.
    if (dateISO === getTodayUTCIso()) {
            requestAnimationFrame(() => {
            const el = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${dateISO}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
            });
    }
};

const _handleResetToToday = () => {
    triggerHaptic('light');
    const today = getTodayUTCIso();
    
    // Performance optimization: Se já está em hoje, não faz nada
    if (state.selectedDate === today) return;

    // Reset Logic (Home Button Behavior)
    const todayDate = parseUTCIsoDate(today);
    _regenerateCalendarDates(todayDate);

    // Direction Logic:
    // Se estávamos no passado (selected < today), ir para hoje é avançar -> Futuro (1).
    // Se estávamos no futuro (selected > today), ir para hoje é voltar -> Passado (-1).
    const dir = today > state.selectedDate ? 1 : -1;

    updateSelectedDateAndRender(today, dir);
    
    // Scroll Síncrono para Reset.
    const todayEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${today}"]`);
    if (todayEl) {
        todayEl.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'end' });
    }
};

const _handleStep = (direction: number) => {
    // SECURITY: Garante que a data atual do estado é válida
    if (!ISO_DATE_REGEX.test(state.selectedDate)) {
        state.selectedDate = getTodayUTCIso();
    }

    const currentDate = parseUTCIsoDate(state.selectedDate);
    const newDate = addDays(currentDate, direction);
    const newDateStr = toUTCIsoDateString(newDate);
    const todayISO = getTodayUTCIso();
    
    triggerHaptic('selection');
    
    // INFINITE SCROLL LOGIC:
    // Mantém a rolagem suave sem reset estrutural ao navegar dia-a-dia
    const currentIndex = state.calendarDates.findIndex(d => toUTCIsoDateString(d) === newDateStr);
    const nearStart = currentIndex !== -1 && currentIndex < INFINITE_SCROLL_BUFFER;
    const nearEnd = currentIndex !== -1 && currentIndex > (state.calendarDates.length - 1 - INFINITE_SCROLL_BUFFER);
    const notFound = currentIndex === -1;

    if (notFound || nearStart || nearEnd) {
        _regenerateCalendarDates(newDate);
    }

    // Direction: -1 (Left/Past), 1 (Right/Future)
    updateSelectedDateAndRender(newDateStr, direction);
    
    requestAnimationFrame(() => {
        const newSelectedEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${newDateStr}"]`);
        if (newSelectedEl) {
            const align = newDateStr === todayISO ? 'end' : 'center';
            newSelectedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: align });
        }
    });
};

const _handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const direction = e.key === 'ArrowLeft' ? -1 : 1;
    _handleStep(direction);
};

// --- INITIALIZATION ---

export function setupCalendarListeners() {
    // 1. Gesture Recognition (Long Press)
    ui.calendarStrip.addEventListener('pointerdown', _handlePointerDown);
    
    // 2. Cancellation Triggers (Scroll/Move)
    const cancelGestures = () => _clearGestureTimer();
    ui.calendarStrip.addEventListener('pointerleave', cancelGestures);
    ui.calendarStrip.addEventListener('scroll', cancelGestures, { passive: true });

    // 3. Selection Interaction
    ui.calendarStrip.addEventListener('click', _handleCalendarClick);
    
    // 4. Keyboard Nav (Mantém navegação passo-a-passo)
    ui.calendarStrip.addEventListener('keydown', _handleKeyDown);

    // 5. Header Actions (Reset to Today)
    ui.headerTitle.addEventListener('click', _handleResetToToday);

    // 6. Navigation Arrows (UPDATE: Jump to Today)
    ui.navArrowPast.addEventListener('click', _handleResetToToday);
    ui.navArrowFuture.addEventListener('click', _handleResetToToday);

    // 7. Quick Actions (Popover) Logic
    const _handleQuickAction = (action: 'completed' | 'snoozed' | 'almanac') => {
        const date = CalendarGestureState.activeDateISO;
        closeModal(ui.calendarQuickActions);
        
        if (action === 'almanac') {
            triggerHaptic('light');
            // Lazy load state for almanac
            if (!ISO_DATE_REGEX.test(state.selectedDate)) {
                state.selectedDate = getTodayUTCIso();
            }
            
            state.fullCalendar = {
                year: parseUTCIsoDate(state.selectedDate).getUTCFullYear(),
                month: parseUTCIsoDate(state.selectedDate).getUTCMonth()
            };
            renderFullCalendar();
            openModal(ui.fullCalendarModal);
            return;
        }

        if (date) {
            const hapticType = action === 'completed' ? 'success' : 'medium';
            triggerHaptic(hapticType);
            if (markAllHabitsForDate(date, action)) {
                renderApp();
            }
        }
    };

    ui.quickActionDone.addEventListener('click', () => _handleQuickAction('completed'));
    ui.quickActionSnooze.addEventListener('click', () => _handleQuickAction('snoozed'));
    ui.quickActionAlmanac.addEventListener('click', () => _handleQuickAction('almanac'));
}
