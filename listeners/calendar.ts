
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
 */

import { ui } from '../render/ui';
import { state, DAYS_IN_CALENDAR, invalidateChartCache } from '../state';
import { renderApp, renderFullCalendar, openModal, scrollToToday, closeModal } from '../render';
import { parseUTCIsoDate, triggerHaptic, getTodayUTCIso, addDays, toUTCIsoDateString } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { markAllHabitsForDate } from '../habitActions';
import { setCSSVariable } from '../render/dom';

// --- STATIC CONSTANTS ---
const LONG_PRESS_DURATION = 500;

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

/**
 * Executa a lógica visual do Long Press (Popover).
 * Separado em fase de Leitura e Escrita para evitar Layout Thrashing.
 */
function _executeLongPressVisuals(dayItem: HTMLElement, dateISO: string) {
    CalendarGestureState.isLongPress = 1;
    dayItem.classList.add('is-pressing');
    triggerHaptic('medium');
    
    CalendarGestureState.activeDateISO = dateISO;

    // 1. READ PHASE (Synchronous)
    const rect = dayItem.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    
    // 2. WRITE PHASE (Async / RAF)
    requestAnimationFrame(() => {
        const modal = ui.calendarQuickActions;
        const modalContent = modal.querySelector<HTMLElement>('.quick-actions-content');

        if (!modalContent) return;

        const top = rect.bottom + 8;
        const centerPoint = rect.left + rect.width / 2;
        const modalWidth = 240; 
        const padding = 8; 

        let finalLeft = centerPoint;
        let translateX = -50; // Use numeric value for logic

        const halfModalWidth = modalWidth / 2;
        const leftEdge = centerPoint - halfModalWidth;
        const rightEdge = centerPoint + halfModalWidth;

        // Edge Detection
        if (leftEdge < padding) {
            finalLeft = padding;
            translateX = 0;
        } else if (rightEdge > windowWidth - padding) {
            finalLeft = windowWidth - padding;
            translateX = -100;
        }

        // BLEEDING-EDGE FIX: Use Typed OM via setCSSVariable instead of string interpolation
        setCSSVariable(modal, '--actions-top', top, 'px');
        setCSSVariable(modal, '--actions-left', finalLeft, 'px');
        setCSSVariable(modalContent, '--translate-x', translateX, '%');

        openModal(modal, undefined, () => {
            CalendarGestureState.activeDateISO = null;
        });
        
        // Cleanup visual state
        dayItem.classList.remove('is-pressing');
    });
}

function updateSelectedDateAndRender(date: string) {
    if (state.selectedDate !== date) {
        state.selectedDate = date;
        state.uiDirtyState.calendarVisuals = true;
        state.uiDirtyState.habitListStructure = true;
        state.uiDirtyState.chartData = true;
        renderApp();
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
    if (!dayItem || !dayItem.dataset.date) return;

    triggerHaptic('selection');
    updateSelectedDateAndRender(dayItem.dataset.date);
};

const _handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    
    e.preventDefault();
    
    // Date Math
    const currentDate = parseUTCIsoDate(state.selectedDate);
    const direction = e.key === 'ArrowLeft' ? -1 : 1;
    const newDate = addDays(currentDate, direction);
    const newDateStr = toUTCIsoDateString(newDate);
    
    triggerHaptic('selection');
    updateSelectedDateAndRender(newDateStr);
    
    // UX: Scroll Sync
    requestAnimationFrame(() => {
        const newSelectedEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${newDateStr}"]`);
        if (newSelectedEl) {
            newSelectedEl.focus();
            newSelectedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    });
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
    
    // 4. Keyboard Nav
    ui.calendarStrip.addEventListener('keydown', _handleKeyDown);

    // 5. Header Reset Action
    ui.headerTitle.addEventListener('click', () => {
        triggerHaptic('light');
        const today = getTodayUTCIso();
        
        // Reset Logic
        // Re-center calendar array around today if needed
        const todayDate = parseUTCIsoDate(today);
        state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
            addDays(todayDate, i - 30)
        );

        updateSelectedDateAndRender(today);
        scrollToToday('smooth');
    });

    // 6. Quick Actions (Popover) Logic
    const _handleQuickAction = (action: 'completed' | 'snoozed' | 'almanac') => {
        const date = CalendarGestureState.activeDateISO;
        closeModal(ui.calendarQuickActions);
        
        if (action === 'almanac') {
            triggerHaptic('light');
            // Lazy load state for almanac
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
