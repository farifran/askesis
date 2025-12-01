
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
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
    setupModalListeners();
    setupHabitCardListeners();
    setupDragAndDropHandler(ui.habitContainer);
    setupSwipeHandler(ui.habitContainer);

    // --- Calendar Strip Logic (Long Press & Click) ---
    let longPressTimer: number | null = null;
    let isLongPress = false;
    const LONG_PRESS_DURATION = 500;

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

    ui.calendarStrip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // Only left click/touch
        const dayItem = (e.target as HTMLElement).closest('.day-item');
        if (!dayItem) return;

        isLongPress = false;
        longPressTimer = window.setTimeout(() => {
            isLongPress = true;
            triggerHaptic('medium');
            openAlmanac();
        }, LONG_PRESS_DURATION);
    });

    ui.calendarStrip.addEventListener('pointerup', clearTimer);
    ui.calendarStrip.addEventListener('pointercancel', clearTimer);
    ui.calendarStrip.addEventListener('pointerleave', clearTimer);
    ui.calendarStrip.addEventListener('scroll', clearTimer); // Safety: scroll cancels long press

    ui.calendarStrip.addEventListener('click', e => {
        // Prevent selection if it was a long press (Almanac trigger)
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

    // Header Title Listener (Go to Today)
    if (ui.headerTitle) {
        ui.headerTitle.addEventListener('click', () => {
            triggerHaptic('light');
            
            const today = getTodayUTCIso();
            
            // LOGIC FIX [2025-02-18]: Reset Calendar Range.
            // If user navigated far away via almanac, clicking "Today" should bring the 
            // calendar strip back to the default view (centered on today), not just select the date.
            const todayDate = parseUTCIsoDate(today);
            state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
                addDays(todayDate, i - 30)
            );

            updateSelectedDateAndRender(today);
            
            // Visual Reset: Smooth scroll to the updated "today" element
            scrollToToday('smooth');
        });
    }
}
