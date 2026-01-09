
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
 * - **View Transitions API:** Substitui classes CSS manuais para navegação nativa e suave (SPA Mode).
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
 */
function _executeLongPressVisuals(dayItem: HTMLElement, dateISO: string) {
    if (!dayItem.isConnected) return;

    CalendarGestureState.isLongPress = 1;
    dayItem.classList.add('is-pressing');
    triggerHaptic('medium');
    
    CalendarGestureState.activeDateISO = dateISO;

    const rect = dayItem.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    
    requestAnimationFrame(() => {
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

        if (leftEdge < padding) {
            finalLeft = padding;
            translateX = '0%';
        } else if (rightEdge > windowWidth - padding) {
            finalLeft = windowWidth - padding;
            translateX = '-100%';
        }

        modal.style.setProperty('--actions-top', `${top}px`);
        modal.style.setProperty('--actions-left', `${finalLeft}px`);
        modalContent.style.setProperty('--translate-x', translateX);

        openModal(modal, undefined, () => {
            CalendarGestureState.activeDateISO = null;
        });
        
        dayItem.classList.remove('is-pressing');
    });
}

/**
 * Atualiza a data e renderiza com View Transitions API.
 * @param date Nova data ISO.
 * @param forcedDirection 1 (Futuro), -1 (Passado).
 */
function updateSelectedDateAndRender(date: string, forcedDirection?: number) {
    if (state.selectedDate !== date) {
        // 1. Inferir Direção
        const dir = forcedDirection !== undefined 
            ? forcedDirection 
            : (date > state.selectedDate ? 1 : -1);

        const updateState = () => {
            state.selectedDate = date;
            state.uiDirtyState.calendarVisuals = true;
            state.uiDirtyState.habitListStructure = true;
            state.uiDirtyState.chartData = true;
            renderApp();
        };

        // BLEEDING-EDGE: View Transitions API
        if (document.startViewTransition) {
            // Set direction for CSS to read
            document.documentElement.dataset.transition = dir > 0 ? 'next' : 'prev';
            
            const transition = document.startViewTransition(() => updateState());
            
            // Cleanup after transition
            transition.finished.finally(() => {
                delete document.documentElement.dataset.transition;
            });
        } else {
            // Fallback: Immediate update
            updateState();
        }
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

    if (!ISO_DATE_REGEX.test(dayItem.dataset.date)) {
        console.warn("Invalid date format in calendar item.");
        return;
    }

    CalendarGestureState.isLongPress = 0;
    CalendarGestureState.targetDayEl = dayItem;
    const dateISO = dayItem.dataset.date;

    CalendarGestureState.timerId = window.setTimeout(() => {
        _executeLongPressVisuals(dayItem, dateISO);
    }, LONG_PRESS_DURATION);

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

    if (!ISO_DATE_REGEX.test(dateISO)) return;

    triggerHaptic('selection');
    updateSelectedDateAndRender(dateISO);
    
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
    
    if (state.selectedDate === today) return;

    const todayDate = parseUTCIsoDate(today);
    _regenerateCalendarDates(todayDate);

    const dir = today > state.selectedDate ? 1 : -1;
    updateSelectedDateAndRender(today, dir);
    
    const todayEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${today}"]`);
    if (todayEl) {
        todayEl.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'end' });
    }
};

const _handleStep = (direction: number) => {
    if (!ISO_DATE_REGEX.test(state.selectedDate)) {
        state.selectedDate = getTodayUTCIso();
    }

    const currentDate = parseUTCIsoDate(state.selectedDate);
    const newDate = addDays(currentDate, direction);
    const newDateStr = toUTCIsoDateString(newDate);
    const todayISO = getTodayUTCIso();
    
    triggerHaptic('selection');
    
    const currentIndex = state.calendarDates.findIndex(d => toUTCIsoDateString(d) === newDateStr);
    const nearStart = currentIndex !== -1 && currentIndex < INFINITE_SCROLL_BUFFER;
    const nearEnd = currentIndex !== -1 && currentIndex > (state.calendarDates.length - 1 - INFINITE_SCROLL_BUFFER);
    const notFound = currentIndex === -1;

    if (notFound || nearStart || nearEnd) {
        _regenerateCalendarDates(newDate);
    }

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
    ui.calendarStrip.addEventListener('pointerdown', _handlePointerDown);
    
    const cancelGestures = () => _clearGestureTimer();
    ui.calendarStrip.addEventListener('pointerleave', cancelGestures);
    ui.calendarStrip.addEventListener('scroll', cancelGestures, { passive: true });

    ui.calendarStrip.addEventListener('click', _handleCalendarClick);
    ui.calendarStrip.addEventListener('keydown', _handleKeyDown);

    ui.headerTitle.addEventListener('click', _handleResetToToday);
    ui.navArrowPast.addEventListener('click', _handleResetToToday);
    ui.navArrowFuture.addEventListener('click', _handleResetToToday);

    const _handleQuickAction = (action: 'completed' | 'snoozed' | 'almanac') => {
        const date = CalendarGestureState.activeDateISO;
        closeModal(ui.calendarQuickActions);
        
        if (action === 'almanac') {
            triggerHaptic('light');
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
