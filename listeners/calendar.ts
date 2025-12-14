
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from '../render/ui';
import { state, invalidateChartCache, DAYS_IN_CALENDAR } from '../state';
import { renderApp, renderFullCalendar, openModal, scrollToToday } from '../render';
import { parseUTCIsoDate, triggerHaptic, getTodayUTCIso, addDays, toUTCIsoDateString } from '../utils';
import { DOM_SELECTORS } from '../render/constants';
import { markAllHabitsForDate } from '../habitActions';

function updateSelectedDateAndRender(date: string) {
    state.selectedDate = date;
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    invalidateChartCache();
    renderApp();
}

export function setupCalendarListeners() {
    const LONG_PRESS_DURATION = 500;
    let longPressTimer: number | null = null;
    let isLongPress = false;
    
    let clickCount = 0;
    let clickTimer: number | null = null;
    const MULTI_CLICK_DELAY = 300; 

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
        if (e.button !== 0) return; 
        const dayItem = (e.target as HTMLElement).closest(DOM_SELECTORS.DAY_ITEM);
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
    ui.calendarStrip.addEventListener('scroll', clearTimer);

    ui.calendarStrip.addEventListener('click', e => {
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
                    triggerHaptic('selection');
                    updateSelectedDateAndRender(dateISO);
                    break;
                case 2:
                    triggerHaptic('success');
                    if (markAllHabitsForDate(dateISO, 'completed')) {
                        renderApp();
                    }
                    break;
                default:
                    if (clickCount >= 3) {
                        triggerHaptic('medium');
                        if (markAllHabitsForDate(dateISO, 'snoozed')) {
                            renderApp();
                        }
                    }
                    break;
            }
            clickCount = 0; 
        }, MULTI_CLICK_DELAY);
    });

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
        
        triggerHaptic('selection');
        updateSelectedDateAndRender(newDateStr);
        
        requestAnimationFrame(() => {
            const newSelectedEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${newDateStr}"]`);
            if (newSelectedEl) {
                newSelectedEl.focus();
                newSelectedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
        });
    });

    ui.headerTitle.addEventListener('click', () => {
        triggerHaptic('light');
        const today = getTodayUTCIso();
        const todayDate = parseUTCIsoDate(today);
        state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
            addDays(todayDate, i - 30)
        );

        updateSelectedDateAndRender(today);
        scrollToToday('smooth');
    });
}
