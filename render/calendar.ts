
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, DAYS_IN_CALENDAR } from '../state';
import { calculateDaySummary } from '../services/selectors';
import { ui } from './ui';
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, getDateTimeFormat, addDays } from '../utils';
import { getLocaleDayName } from '../i18n';
import { setTextContent } from './dom';
import { CSS_CLASSES, DOM_SELECTORS } from './constants';

// OTIMIZAÇÃO [2025-01-22]: Cache de elementos do calendário para evitar querySelectorAll repetido.
let cachedDayElements: HTMLElement[] = [];

// OTIMIZAÇÃO [2025-03-09]: Template Prototype para clonagem rápida.
// Evita o custo de múltiplas chamadas 'createElement' e 'appendChild' a cada dia gerado.
let dayItemTemplate: HTMLElement | null = null;
// OTIMIZAÇÃO [2025-03-09]: Template Prototype para dias do calendário completo.
let fullCalendarDayTemplate: HTMLElement | null = null;

function getDayItemTemplate(): HTMLElement {
    if (!dayItemTemplate) {
        dayItemTemplate = document.createElement('div');
        dayItemTemplate.className = CSS_CLASSES.DAY_ITEM;
        dayItemTemplate.setAttribute('role', 'button');
        dayItemTemplate.setAttribute('tabindex', '-1');

        const dayName = document.createElement('span');
        dayName.className = CSS_CLASSES.DAY_NAME;

        const dayProgressRing = document.createElement('div');
        dayProgressRing.className = CSS_CLASSES.DAY_PROGRESS_RING;

        const dayNumber = document.createElement('span');
        dayNumber.className = CSS_CLASSES.DAY_NUMBER;

        dayProgressRing.appendChild(dayNumber);
        dayItemTemplate.appendChild(dayName);
        dayItemTemplate.appendChild(dayProgressRing);
    }
    return dayItemTemplate;
}

function getFullCalendarDayTemplate(): HTMLElement {
    if (!fullCalendarDayTemplate) {
        fullCalendarDayTemplate = document.createElement('div');
        fullCalendarDayTemplate.className = 'full-calendar-day';
        fullCalendarDayTemplate.setAttribute('role', 'button');
        fullCalendarDayTemplate.setAttribute('tabindex', '-1');

        const ringEl = document.createElement('div');
        ringEl.className = CSS_CLASSES.DAY_PROGRESS_RING;

        const numberEl = document.createElement('span');
        numberEl.className = CSS_CLASSES.DAY_NUMBER;
        
        ringEl.appendChild(numberEl);
        fullCalendarDayTemplate.appendChild(ringEl);
    }
    return fullCalendarDayTemplate;
}

/**
 * OTIMIZAÇÃO (DRY): Aplica o estado visual a um elemento de dia do calendário.
 * Centraliza a lógica de classes, atributos ARIA e variáveis CSS para evitar duplicação.
 * PERFORMANCE [2025-03-03]: Aceita todayISO opcional para evitar recálculo em loops.
 * PERFORMANCE [2025-03-13]: Aceita date object opcional para evitar recriação via parse.
 */
export function updateCalendarDayElement(dayItem: HTMLElement, date: Date, todayISO?: string, precalcIsoDate?: string) {
    const effectiveTodayISO = todayISO || getTodayUTCIso();
    // PERFORMANCE OPTIMIZATION: Use pre-calculated ISO date if available
    const isoDate = precalcIsoDate || toUTCIsoDateString(date);
    
    // DECOUPLING: Chamadas separadas para performance
    // Pass date object to avoid re-parsing inside calculateDaySummary
    const { completedPercent, snoozedPercent, showPlusIndicator: showPlus } = calculateDaySummary(isoDate, date);
    
    const isSelected = isoDate === state.selectedDate;
    const isToday = isoDate === effectiveTodayISO;

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

export function createCalendarDayElement(date: Date, todayISO: string): HTMLElement {
    // PERFORMANCE [2025-03-09]: Clone from template instead of creating fresh.
    const dayItem = getDayItemTemplate().cloneNode(true) as HTMLElement;
    
    const isoDate = toUTCIsoDateString(date);
    dayItem.dataset.date = isoDate;

    // Hydrate the cloned node with specific data
    updateCalendarDayElement(dayItem, date, todayISO, isoDate);

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

    // FIX [2025-03-10]: Self-healing and Robustness logic.
    // 1. Verify if selectedDate is valid. If not, reset to Today.
    let selectedDateObj = parseUTCIsoDate(state.selectedDate);
    if (isNaN(selectedDateObj.getTime())) {
        console.warn("Invalid selectedDate detected during render. Resetting to Today.");
        state.selectedDate = getTodayUTCIso();
        state.calendarDates = []; // Force rebuild
    }

    // 2. If state.calendarDates is empty or corrupted, repopulate it.
    if (state.calendarDates.length === 0) {
        selectedDateObj = parseUTCIsoDate(state.selectedDate); // Re-parse in case it was just fixed
        state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
            addDays(selectedDateObj, i - 30)
        );
    }

    const needsRebuild = cachedDayElements.length === 0 || cachedDayElements.length !== state.calendarDates.length;
    // PERFORMANCE [2025-03-03]: Hoist calculation out of the loop.
    const todayISO = getTodayUTCIso();
    
    if (needsRebuild) {
        ui.calendarStrip.innerHTML = '';
        cachedDayElements = [];
        
        const fragment = document.createDocumentFragment();
        state.calendarDates.forEach(date => {
            const el = createCalendarDayElement(date, todayISO);
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
                updateCalendarDayElement(dayEl, date, todayISO, isoDate);
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

    // PERFORMANCE [2025-03-09]: Use cached template for day creation
    // Reuse the full calendar day template logic for filler cells too
    for (let i = 0; i < startDayOfWeek; i++) {
        const day = daysInPrevMonth - startDayOfWeek + 1 + i;
        const dayEl = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        dayEl.className = 'full-calendar-day other-month';
        
        // Structure is div.day-progress-ring > span.day-number
        const ring = dayEl.firstElementChild as HTMLElement;
        const number = ring.firstElementChild as HTMLElement;
        number.textContent = String(day);
        
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

    // PERFORMANCE [2025-03-04]: Use a single mutable Date object for the loop.
    // Reduces garbage collection pressure by reusing the same object instance ~30 times.
    const iteratorDate = new Date(Date.UTC(year, month, 1));

    for (let day = 1; day <= daysInMonth; day++) {
        // Use iteratorDate which is already set to the correct day
        const isoDate = toUTCIsoDateString(iteratorDate);
        // Pass iteratorDate reference to selector to avoid re-parsing
        const { completedPercent, snoozedPercent } = calculateDaySummary(isoDate, iteratorDate);

        // OPTIMIZATION: Clone from template
        const dayEl = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        
        dayEl.dataset.date = isoDate;
        const isSelected = isoDate === state.selectedDate;
        
        // Batch class updates
        if (isSelected) dayEl.classList.add(CSS_CLASSES.SELECTED);
        if (isoDate === todayISO) dayEl.classList.add(CSS_CLASSES.TODAY);
        
        dayEl.setAttribute('aria-pressed', String(isSelected));
        dayEl.setAttribute('aria-label', ariaDateFormatter.format(iteratorDate));
        dayEl.setAttribute('tabindex', isSelected ? '0' : '-1');

        // Locate children in the cloned template (knowing the structure)
        const ringEl = dayEl.firstElementChild as HTMLElement; // .day-progress-ring
        const numberEl = ringEl.firstElementChild as HTMLElement; // .day-number

        ringEl.style.setProperty('--completed-percent', `${completedPercent}%`);
        ringEl.style.setProperty('--snoozed-percent', `${snoozedPercent}%`);
        numberEl.textContent = String(day);
        
        fragment.appendChild(dayEl);
        totalGridCells++;
        
        // Advance mutable date by one day
        iteratorDate.setUTCDate(iteratorDate.getUTCDate() + 1);
    }
    
    const remainingCells = (7 - (totalGridCells % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        const day = i;
        const dayEl = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        dayEl.className = 'full-calendar-day other-month';
        
        const ring = dayEl.firstElementChild as HTMLElement;
        const number = ring.firstElementChild as HTMLElement;
        number.textContent = String(day);
        
        fragment.appendChild(dayEl);
    }
    
    grid.appendChild(fragment);
}
