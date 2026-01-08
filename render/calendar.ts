/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file render/calendar.ts
 * @description Motor de Renderização do Calendário (Strip & Almanac).
 */

import { state, DAYS_IN_CALENDAR } from '../state';
import { calculateDaySummary } from '../services/selectors';
import { ui } from './ui';
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, addDays } from '../utils';
import { getLocaleDayName, formatDate, formatInteger } from '../i18n'; 
import { setTextContent } from './dom';
import { CSS_CLASSES, DOM_SELECTORS } from './constants';

let cachedDayElements: HTMLElement[] = [];
let dayItemTemplate: HTMLElement | null = null;
let fullCalendarDayTemplate: HTMLElement | null = null;
const dayElementCache = new WeakMap<HTMLElement, { dayName: HTMLElement; ring: HTMLElement; num: HTMLElement }>();

const OPTS_ARIA = { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' } as const;
const OPTS_HEADER = { month: 'long', year: 'numeric', timeZone: 'UTC' } as const;
const PAD = Array.from({length: 100}, (_, i) => (i < 10 ? '0' : '') + i);

const getDayItemTemplate = () => dayItemTemplate || (dayItemTemplate = (() => {
    const el = document.createElement('div'); el.className = CSS_CLASSES.DAY_ITEM; el.setAttribute('role', 'button');
    el.innerHTML = `<span class="${CSS_CLASSES.DAY_NAME}"></span><div class="${CSS_CLASSES.DAY_PROGRESS_RING}"><span class="${CSS_CLASSES.DAY_NUMBER}"></span></div>`;
    return el;
})());

const getFullCalendarDayTemplate = () => fullCalendarDayTemplate || (fullCalendarDayTemplate = (() => {
    const el = document.createElement('div'); el.className = 'full-calendar-day'; el.setAttribute('role', 'button');
    el.innerHTML = `<div class="${CSS_CLASSES.DAY_PROGRESS_RING}"><span class="${CSS_CLASSES.DAY_NUMBER}"></span></div>`;
    return el;
})());

export function updateCalendarDayElement(el: HTMLElement, date: Date, todayISO?: string, preISO?: string) {
    const refs = dayElementCache.get(el)!;
    const iso = preISO || toUTCIsoDateString(date);
    const { completedPercent: cp, snoozedPercent: sp, showPlusIndicator: plus } = calculateDaySummary(iso, date);
    const isSel = iso === state.selectedDate, isTod = iso === (todayISO || getTodayUTCIso());

    el.classList.toggle(CSS_CLASSES.SELECTED, isSel);
    el.classList.toggle(CSS_CLASSES.TODAY, isTod);
    el.setAttribute('aria-pressed', String(isSel));
    el.setAttribute('tabindex', isSel ? '0' : '-1');
    el.setAttribute('aria-label', formatDate(date, OPTS_ARIA));

    const cpStr = `${cp}%`, spStr = `${sp}%`;
    if (refs.ring.style.getPropertyValue('--completed-percent') !== cpStr) refs.ring.style.setProperty('--completed-percent', cpStr);
    if (refs.ring.style.getPropertyValue('--snoozed-percent') !== spStr) refs.ring.style.setProperty('--snoozed-percent', spStr);
    
    refs.num.classList.toggle('has-plus', plus);
    setTextContent(refs.num, formatInteger(date.getUTCDate()));
    setTextContent(refs.dayName, getLocaleDayName(date));
}

export function createCalendarDayElement(date: Date, todayISO: string): HTMLElement {
    const el = getDayItemTemplate().cloneNode(true) as HTMLElement;
    dayElementCache.set(el, { dayName: el.children[0] as HTMLElement, ring: el.children[1] as HTMLElement, num: el.children[1].children[0] as HTMLElement });
    const iso = toUTCIsoDateString(date); el.dataset.date = iso;
    updateCalendarDayElement(el, date, todayISO, iso);
    return el;
}

export const scrollToToday = (behavior: ScrollBehavior = 'auto') => requestAnimationFrame(() => {
    ui.calendarStrip.querySelector(`${DOM_SELECTORS.DAY_ITEM}.${CSS_CLASSES.TODAY}`)?.scrollIntoView({ behavior, block: 'nearest', inline: 'end' });
});

export function renderCalendar() {
    if (!state.uiDirtyState.calendarVisuals) return;
    const todayISO = getTodayUTCIso();
    if (state.calendarDates.length === 0) {
        const start = parseUTCIsoDate(state.selectedDate);
        state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => addDays(start, i - 30));
    }

    if (cachedDayElements.length !== state.calendarDates.length) {
        ui.calendarStrip.innerHTML = ''; cachedDayElements = [];
        const frag = document.createDocumentFragment();
        state.calendarDates.forEach(d => { const el = createCalendarDayElement(d, todayISO); cachedDayElements.push(el); frag.appendChild(el); });
        ui.calendarStrip.appendChild(frag);
        scrollToToday();
    } else {
        cachedDayElements.forEach((el, i) => updateCalendarDayElement(el, state.calendarDates[i], todayISO));
    }
    state.uiDirtyState.calendarVisuals = false;
}

export function renderFullCalendar() {
    const { year, month } = state.fullCalendar;
    ui.fullCalendarMonthYear.textContent = formatDate(new Date(Date.UTC(year, month, 1)), OPTS_HEADER);
    ui.fullCalendarGrid.innerHTML = '';
    
    if (ui.fullCalendarWeekdays.childElementCount === 0) {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 7; i++) {
            const d = document.createElement('div'); d.textContent = getLocaleDayName(new Date(Date.UTC(2024, 0, 7 + i))).substring(0, 1);
            frag.appendChild(d);
        }
        ui.fullCalendarWeekdays.appendChild(frag);
    }
    
    const frag = document.createDocumentFragment();
    const first = new Date(Date.UTC(year, month, 1)), days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const start = first.getUTCDay(), prevDays = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const addCell = (d: number, cls?: string, iso?: string) => {
        const el = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        if (cls) el.className = `full-calendar-day ${cls}`;
        const r = el.firstElementChild as HTMLElement, n = r.firstElementChild as HTMLElement;
        n.textContent = formatInteger(d);
        if (iso) {
            const { completedPercent: cp, snoozedPercent: sp } = calculateDaySummary(iso, parseUTCIsoDate(iso));
            r.style.setProperty('--completed-percent', `${cp}%`); r.style.setProperty('--snoozed-percent', `${sp}%`);
            el.dataset.date = iso; el.classList.toggle(CSS_CLASSES.SELECTED, iso === state.selectedDate);
            el.classList.toggle(CSS_CLASSES.TODAY, iso === getTodayUTCIso());
        }
        frag.appendChild(el);
    };

    for (let i = 0; i < start; i++) addCell(prevDays - start + 1 + i, 'other-month');
    const prefix = `${year}-${PAD[month + 1]}-`;
    for (let d = 1; d <= days; d++) addCell(d, '', prefix + PAD[d]);
    const rem = (7 - ((start + days) % 7)) % 7;
    for (let i = 1; i <= rem; i++) addCell(i, 'other-month');
    
    ui.fullCalendarGrid.appendChild(frag);
}