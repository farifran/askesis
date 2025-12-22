/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from '../render/ui';
import { state, DAYS_IN_CALENDAR } from '../state';
import { renderApp, renderFullCalendar, openModal, scrollToToday, closeModal } from '../render';
import { parseUTCIsoDate, triggerHaptic, getTodayUTCIso, addDays, toUTCIsoDateString } from '../utils';
import { DOM_SELECTORS } from '../render/constants';
import { markAllHabitsForDate } from '../habitActions';

function updateSelectedDateAndRender(date: string) {
    state.selectedDate = date;
    state.uiDirtyState.calendarVisuals = true;
    state.uiDirtyState.habitListStructure = true;
    state.uiDirtyState.chartData = true;
    renderApp();
}

export function setupCalendarListeners() {
    const LONG_PRESS_DURATION = 500;
    let longPressTimer: number | null = null;
    let isLongPress = false;
    let activeQuickActionDate: string | null = null;

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
        const dayItem = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.DAY_ITEM);
        if (!dayItem || !dayItem.dataset.date) return;

        const dateISO = dayItem.dataset.date;

        isLongPress = false;
        longPressTimer = window.setTimeout(() => {
            isLongPress = true;
            dayItem.classList.add('is-pressing');
            triggerHaptic('medium');
            
            activeQuickActionDate = dateISO;

            const rect = dayItem.getBoundingClientRect();
            const modal = ui.calendarQuickActions;
            const modalContent = modal.querySelector<HTMLElement>('.quick-actions-content');

            if (!modalContent) return;

            const top = rect.bottom + 8;
            const centerPoint = rect.left + rect.width / 2;
            const modalWidth = 240; // Based on min-width in CSS
            const windowWidth = window.innerWidth;
            const padding = 8; // Screen edge padding

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
                activeQuickActionDate = null;
            });

        }, LONG_PRESS_DURATION);

        const clearPressing = () => {
            dayItem.classList.remove('is-pressing');
            window.removeEventListener('pointerup', clearPressing);
            window.removeEventListener('pointercancel', clearPressing);
        };
        window.addEventListener('pointerup', clearPressing, { once: true });
        window.addEventListener('pointercancel', clearPressing, { once: true });
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

        triggerHaptic('selection');
        updateSelectedDateAndRender(dayItem.dataset.date);
    });
    
    ui.quickActionDone.addEventListener('click', () => {
        if (activeQuickActionDate) {
            triggerHaptic('success');
            if (markAllHabitsForDate(activeQuickActionDate, 'completed')) {
                renderApp();
            }
        }
        closeModal(ui.calendarQuickActions);
    });

    ui.quickActionSnooze.addEventListener('click', () => {
        if (activeQuickActionDate) {
            triggerHaptic('medium');
            if (markAllHabitsForDate(activeQuickActionDate, 'snoozed')) {
                renderApp();
            }
        }
        closeModal(ui.calendarQuickActions);
    });

    ui.quickActionAlmanac.addEventListener('click', () => {
        triggerHaptic('light');
        closeModal(ui.calendarQuickActions);
        openAlmanac();
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
