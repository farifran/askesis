
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, calculateDaySummary, DAYS_IN_CALENDAR } from '../state';
import { ui } from './ui';
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, getDateTimeFormat, addDays } from '../utils';
import { getLocaleDayName } from '../i18n';
import { setTextContent } from './dom';
import { openModal, closeModal } from './modals';
import { CSS_CLASSES, DOM_SELECTORS } from './constants';

// OTIMIZAÇÃO [2025-01-22]: Cache de elementos do calendário para evitar querySelectorAll repetido.
let cachedDayElements: HTMLElement[] = [];

/**
 * OTIMIZAÇÃO (DRY): Aplica o estado visual a um elemento de dia do calendário.
 * Centraliza a lógica de classes, atributos ARIA e variáveis CSS para evitar duplicação.
 */
export function _applyDayState(dayItem: HTMLElement, date: Date) {
    const todayISO = getTodayUTCIso();
    const isoDate = toUTCIsoDateString(date);
    const { completedPercent, snoozedPercent, showPlus } = calculateDaySummary(isoDate);
    const isSelected = isoDate === state.selectedDate;
    const isToday = isoDate === todayISO;

    // Gerenciamento de Classes
    if (dayItem.classList.contains(CSS_CLASSES.SELECTED) !== isSelected) {
        dayItem.classList.toggle(CSS_CLASSES.SELECTED, isSelected);
    }
    if (dayItem.classList.contains(CSS_CLASSES.TODAY) !== isToday) {
        dayItem.classList.toggle(CSS_CLASSES.TODAY, isToday);
    }

    // Acessibilidade e Estado
    if (dayItem.getAttribute('aria-pressed') !== String(isSelected)) {
        dayItem.setAttribute('aria-pressed', String(isSelected));
    }
    
    // A11Y [2025-01-17]: Implementação de Roving Tabindex.
    const newTabIndex = isSelected ? '0' : '-1';
    if (dayItem.getAttribute('tabindex') !== newTabIndex) {
        dayItem.setAttribute('tabindex', newTabIndex);
    }

    // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat.
    const ariaDate = getDateTimeFormat(state.activeLanguageCode, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC'
    }).format(date);
    
    if (dayItem.getAttribute('aria-label') !== ariaDate) {
        dayItem.setAttribute('aria-label', ariaDate);
    }

    // Atualização Visual (Variáveis CSS e Indicadores)
    const dayProgressRing = dayItem.querySelector<HTMLElement>(`.${CSS_CLASSES.DAY_PROGRESS_RING}`);
    if (dayProgressRing) {
        const newCompleted = `${completedPercent}%`;
        const newSnoozed = `${snoozedPercent}%`;
        
        // PERFORMANCE CRÍTICA [2025-01-23]: Uso de dataset para Dirty Checking.
        if (dayProgressRing.dataset.completedPercent !== newCompleted) {
            dayProgressRing.style.setProperty('--completed-percent', newCompleted);
            dayProgressRing.dataset.completedPercent = newCompleted;
        }
        if (dayProgressRing.dataset.snoozedPercent !== newSnoozed) {
            dayProgressRing.style.setProperty('--snoozed-percent', newSnoozed);
            dayProgressRing.dataset.snoozedPercent = newSnoozed;
        }
        
        const dayNumber = dayProgressRing.querySelector<HTMLElement>(`.${CSS_CLASSES.DAY_NUMBER}`);
        if (dayNumber) {
            if (dayNumber.classList.contains('has-plus') !== showPlus) {
                dayNumber.classList.toggle('has-plus', showPlus);
            }
            setTextContent(dayNumber, String(date.getUTCDate()));
        }
    }
    
    const dayNameEl = dayItem.querySelector(`.${CSS_CLASSES.DAY_NAME}`);
    setTextContent(dayNameEl, getLocaleDayName(date));
}

function updateCalendarDayElement(dayItem: HTMLElement, date: Date) {
    _applyDayState(dayItem, date);
}

/**
 * SURGICAL UPDATE: Atualiza apenas o dia do calendário especificado no DOM.
 */
export function renderCalendarDayPartial(dateISO: string) {
    // Uses type-safe DOM selector
    const dayItem = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}[data-date="${dateISO}"]`);
    if (dayItem) {
        const dateObj = parseUTCIsoDate(dateISO);
        _applyDayState(dayItem, dateObj);
    }
}

export function createCalendarDayElement(date: Date): HTMLElement {
    const dayItem = document.createElement('div');
    dayItem.className = CSS_CLASSES.DAY_ITEM;
    dayItem.dataset.date = toUTCIsoDateString(date);
    dayItem.setAttribute('role', 'button');
    dayItem.setAttribute('tabindex', '-1');

    const dayName = document.createElement('span');
    dayName.className = CSS_CLASSES.DAY_NAME;

    const dayProgressRing = document.createElement('div');
    dayProgressRing.className = CSS_CLASSES.DAY_PROGRESS_RING;

    const dayNumber = document.createElement('span');
    dayNumber.className = CSS_CLASSES.DAY_NUMBER;

    dayProgressRing.appendChild(dayNumber);
    dayItem.appendChild(dayName);
    dayItem.appendChild(dayProgressRing);

    _applyDayState(dayItem, date);

    return dayItem;
}

/**
 * Helper centralizado para rolar o calendário para o dia "Hoje".
 */
export function scrollToToday(behavior: ScrollBehavior = 'auto') {
    requestAnimationFrame(() => {
        const todayEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}.${CSS_CLASSES.TODAY}`);
        if (todayEl) {
            // LOGIC UPDATE [2025-02-05]: Alinhamento 'end' para coincidir com o futuro à direita.
            todayEl.scrollIntoView({ behavior, block: 'nearest', inline: 'end' });
        }
    });
}

export function renderCalendar() {
    // PERFORMANCE [2025-01-26]: DIRTY CHECK GUARD.
    if (!state.uiDirtyState.calendarVisuals) {
        return;
    }

    const needsRebuild = cachedDayElements.length === 0 || cachedDayElements.length !== state.calendarDates.length;
    
    if (needsRebuild) {
        ui.calendarStrip.innerHTML = '';
        cachedDayElements = [];
        
        const fragment = document.createDocumentFragment();
        state.calendarDates.forEach(date => {
            const el = createCalendarDayElement(date);
            cachedDayElements.push(el);
            fragment.appendChild(el);
        });
        ui.calendarStrip.appendChild(fragment);

        scrollToToday('auto');
    } else {
        cachedDayElements.forEach((dayEl, index) => {
            const date = state.calendarDates[index];
            if (date) {
                const isoDate = toUTCIsoDateString(date);
                if(dayEl.dataset.date !== isoDate) {
                    dayEl.dataset.date = isoDate;
                }
                updateCalendarDayElement(dayEl, date);
            }
        });
    }

    state.uiDirtyState.calendarVisuals = false;
}

export function renderFullCalendar() {
    const { year, month } = state.fullCalendar;
    const todayISO = getTodayUTCIso();

    const monthDate = new Date(Date.UTC(year, month, 1));
    ui.fullCalendarMonthYear.textContent = getDateTimeFormat(state.activeLanguageCode, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(monthDate);

    const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const startDayOfWeek = firstDayOfMonth.getUTCDay();

    const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const grid = ui.fullCalendarGrid;
    grid.innerHTML = '';
    
    if (ui.fullCalendarWeekdays.childElementCount === 0) {
        const weekdaysFragment = document.createDocumentFragment();
        for (let i = 0; i < 7; i++) {
            const day = new Date(Date.UTC(2024, 0, 7 + i));
            const weekdayEl = document.createElement('div');
            weekdayEl.textContent = getLocaleDayName(day).substring(0, 1);
            weekdaysFragment.appendChild(weekdayEl);
        }
        ui.fullCalendarWeekdays.appendChild(weekdaysFragment);
    }
    
    const fragment = document.createDocumentFragment();
    let totalGridCells = 0;

    for (let i = 0; i < startDayOfWeek; i++) {
        const day = daysInPrevMonth - startDayOfWeek + 1 + i;
        const dayEl = document.createElement('div');
        dayEl.className = 'full-calendar-day other-month';
        const numberEl = document.createElement('span');
        numberEl.className = CSS_CLASSES.DAY_NUMBER;
        numberEl.textContent = String(day);
        dayEl.appendChild(numberEl);
        fragment.appendChild(dayEl);
        totalGridCells++;
    }

    const ariaDateFormatter = getDateTimeFormat(state.activeLanguageCode, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'
    });

    for (let day = 1; day <= daysInMonth; day++) {
        const currentDate = new Date(Date.UTC(year, month, day));
        const isoDate = toUTCIsoDateString(currentDate);
        const { completedPercent, snoozedPercent } = calculateDaySummary(isoDate);

        const dayEl = document.createElement('div');
        dayEl.className = 'full-calendar-day';
        dayEl.dataset.date = isoDate;
        dayEl.setAttribute('role', 'button');
        const isSelected = isoDate === state.selectedDate;
        dayEl.classList.toggle(CSS_CLASSES.SELECTED, isSelected);
        dayEl.classList.toggle(CSS_CLASSES.TODAY, isoDate === todayISO);
        dayEl.setAttribute('aria-pressed', String(isSelected));
        dayEl.setAttribute('aria-label', ariaDateFormatter.format(currentDate));
        dayEl.setAttribute('tabindex', isSelected ? '0' : '-1');

        const ringEl = document.createElement('div');
        ringEl.className = CSS_CLASSES.DAY_PROGRESS_RING;
        ringEl.style.setProperty('--completed-percent', `${completedPercent}%`);
        ringEl.style.setProperty('--snoozed-percent', `${snoozedPercent}%`);

        const numberEl = document.createElement('span');
        numberEl.className = CSS_CLASSES.DAY_NUMBER;
        numberEl.textContent = String(day);
        
        ringEl.appendChild(numberEl);
        dayEl.appendChild(ringEl);
        fragment.appendChild(dayEl);
        totalGridCells++;
    }
    
    const remainingCells = (7 - (totalGridCells % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        const day = i;
        const dayEl = document.createElement('div');
        dayEl.className = 'full-calendar-day other-month';
        const numberEl = document.createElement('span');
        numberEl.className = CSS_CLASSES.DAY_NUMBER;
        numberEl.textContent = String(day);
        dayEl.appendChild(numberEl);
        fragment.appendChild(dayEl);
    }
    
    grid.appendChild(fragment);
}
