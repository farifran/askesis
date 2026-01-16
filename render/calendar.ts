
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file render/calendar.ts
 * @description Motor de Renderização do Calendário (Strip & Almanac) com Suporte a Infinite Scroll e Teleport.
 */

import { state } from '../state';
import { calculateDaySummary } from '../services/selectors';
import { ui } from './ui';
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, addDays } from '../utils';
import { formatInteger, getLocaleDayName } from '../i18n'; 
import { setTextContent } from './dom';
import { CSS_CLASSES } from './constants';

// --- CONFIGURAÇÃO SWEET SPOT ---
const INITIAL_BUFFER_DAYS = 15; // Teleport Buffer: Mantém o DOM inicial leve
const MAX_DOM_NODES = 200;      // Teto rígido de memória para o Scroll Infinito

let dayItemTemplate: HTMLElement | null = null;
let fullCalendarDayTemplate: HTMLElement | null = null;

const OPTS_ARIA = { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' } as const;
const PAD = Array.from({length: 100}, (_, i) => (i < 10 ? '0' : '') + i);

// --- TEMPLATES (Lazy Init) ---

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

// --- CORE RENDERING (STRIP) ---

/**
 * Cria um elemento de dia isolado.
 * SOURCE OF TRUTH: O dataset.date é a verdade absoluta para os listeners.
 */
function createDayElement(dateISO: string, isSelected: boolean, isToday: boolean): HTMLElement {
    const el = getDayItemTemplate().cloneNode(true) as HTMLElement;
    const dateObj = parseUTCIsoDate(dateISO);
    
    el.dataset.date = dateISO; 
    
    const dayNameEl = el.firstElementChild as HTMLElement;
    const ringEl = dayNameEl.nextElementSibling as HTMLElement;
    const numEl = ringEl.firstElementChild as HTMLElement;

    setTextContent(dayNameEl, getLocaleDayName(dateObj));
    setTextContent(numEl, formatInteger(dateObj.getUTCDate()));
    
    if (isSelected) el.classList.add(CSS_CLASSES.SELECTED);
    if (isToday) el.classList.add(CSS_CLASSES.TODAY);

    const { completedPercent, snoozedPercent, showPlusIndicator } = calculateDaySummary(dateISO, dateObj);
    if (completedPercent > 0) ringEl.style.setProperty('--completed-percent', `${completedPercent}%`);
    if (snoozedPercent > 0) ringEl.style.setProperty('--snoozed-percent', `${snoozedPercent}%`);
    if (showPlusIndicator) numEl.classList.add('has-plus');

    el.setAttribute('aria-label', dateObj.toLocaleDateString(state.activeLanguageCode, OPTS_ARIA));
    if (isSelected) {
        el.setAttribute('aria-current', 'date');
        el.setAttribute('tabindex', '0');
    } else {
        el.setAttribute('tabindex', '-1');
    }

    return el;
}

/**
 * Renderiza a fita (Strip) centrada na data selecionada.
 * ESTRATÉGIA: Teletransporte (Hard Reset).
 * Limpa o DOM antigo e cria um novo universo de +/- 15 dias ao redor da data foco.
 */
export function renderCalendar() {
    if (!ui.calendarStrip) return;

    // Dirty Check para evitar re-render desnecessário
    if (!state.uiDirtyState.calendarVisuals && ui.calendarStrip.children.length > 0) return;

    const centerDateISO = state.selectedDate || getTodayUTCIso();
    const centerDate = parseUTCIsoDate(centerDateISO);
    const todayISO = getTodayUTCIso();
    
    const frag = document.createDocumentFragment();

    for (let i = -INITIAL_BUFFER_DAYS; i <= INITIAL_BUFFER_DAYS; i++) {
        const d = addDays(centerDate, i);
        const iso = toUTCIsoDateString(d);
        const el = createDayElement(iso, iso === centerDateISO, iso === todayISO);
        frag.appendChild(el);
    }

    ui.calendarStrip.innerHTML = ''; // Limpeza Total (GC Trigger)
    ui.calendarStrip.appendChild(frag);
    
    state.uiDirtyState.calendarVisuals = false;
    
    // Força o scroll para a posição correta (Teleporte)
    requestAnimationFrame(() => scrollToSelectedDate(false));
}

/**
 * [INFINITE SCROLL] Adiciona um dia ao final da lista (Futuro).
 * OTIMIZAÇÃO: Remove nós antigos do topo se exceder MAX_DOM_NODES.
 */
export function appendDayToStrip(lastDateISO: string, container: Node = ui.calendarStrip): string {
    const nextDate = addDays(parseUTCIsoDate(lastDateISO), 1);
    const iso = toUTCIsoDateString(nextDate);
    const todayISO = getTodayUTCIso();
    
    const el = createDayElement(iso, iso === state.selectedDate, iso === todayISO);
    container.appendChild(el);

    // [GARBAGE COLLECTION] Mantém o DOM leve
    if (container === ui.calendarStrip && ui.calendarStrip.children.length > MAX_DOM_NODES) {
        ui.calendarStrip.firstElementChild?.remove();
    }

    return iso;
}

/**
 * [INFINITE SCROLL] Adiciona um dia ao início da lista (Passado).
 * OTIMIZAÇÃO: Remove nós futuros do final se exceder MAX_DOM_NODES.
 */
export function prependDayToStrip(firstDateISO: string, container: Node = ui.calendarStrip): string {
    const prevDate = addDays(parseUTCIsoDate(firstDateISO), -1);
    const iso = toUTCIsoDateString(prevDate);
    const todayISO = getTodayUTCIso();

    const el = createDayElement(iso, iso === state.selectedDate, iso === todayISO);
    
    if (container instanceof DocumentFragment) {
        container.prepend(el);
    } else {
        (container as HTMLElement).insertBefore(el, (container as HTMLElement).firstElementChild);
    }

    // [GARBAGE COLLECTION] Mantém o DOM leve
    if (container === ui.calendarStrip && ui.calendarStrip.children.length > MAX_DOM_NODES) {
        ui.calendarStrip.lastElementChild?.remove();
    }

    return iso;
}

// --- FULL CALENDAR (ALMANAC) ---

export function renderFullCalendar() {
    if (!ui.fullCalendarGrid || !state.fullCalendar) return;

    const { year, month } = state.fullCalendar;
    
    ui.fullCalendarMonthYear.textContent = new Date(Date.UTC(year, month, 1))
        .toLocaleDateString(state.activeLanguageCode, { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const frag = document.createDocumentFragment();
    const first = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const startDayOfWeek = first.getUTCDay(); // 0 = Domingo
    const prevMonthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();

    // Dias do mês anterior (Cinza)
    for (let i = 0; i < startDayOfWeek; i++) {
        const d = prevMonthDays - startDayOfWeek + 1 + i;
        const el = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        el.classList.add('other-month');
        (el.firstElementChild!.firstElementChild as HTMLElement).textContent = formatInteger(d);
        frag.appendChild(el);
    }

    // Dias do mês atual
    const todayISO = getTodayUTCIso();
    const prefix = `${year}-${PAD[month + 1]}-`;

    for (let i = 1; i <= daysInMonth; i++) {
        const iso = prefix + PAD[i];
        const el = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        const ring = el.firstElementChild as HTMLElement;
        const num = ring.firstElementChild as HTMLElement;
        
        num.textContent = formatInteger(i);
        el.dataset.date = iso;

        const { completedPercent, snoozedPercent, showPlusIndicator } = calculateDaySummary(iso, parseUTCIsoDate(iso));
        
        if (completedPercent > 0) ring.style.setProperty('--completed-percent', `${completedPercent}%`);
        if (snoozedPercent > 0) ring.style.setProperty('--snoozed-percent', `${snoozedPercent}%`);
        if (showPlusIndicator) num.classList.add('has-plus');

        if (iso === state.selectedDate) el.classList.add(CSS_CLASSES.SELECTED);
        if (iso === todayISO) el.classList.add(CSS_CLASSES.TODAY);

        frag.appendChild(el);
    }

    ui.fullCalendarGrid.innerHTML = '';
    ui.fullCalendarGrid.appendChild(frag);
}

/**
 * Rola a fita para posicionar o elemento selecionado.
 * LÓGICA CONTEXTUAL: "Hoje" alinha à direita (histórico), outros centralizam.
 */
export function scrollToSelectedDate(smooth = true) {
    if (!ui.calendarStrip) return;
    
    requestAnimationFrame(() => {
        const selectedEl = ui.calendarStrip.querySelector(`.${CSS_CLASSES.SELECTED}`) as HTMLElement;
        
        if (selectedEl) {
            const stripWidth = ui.calendarStrip.clientWidth;
            const elLeft = selectedEl.offsetLeft;
            const elWidth = selectedEl.offsetWidth;
            const isToday = selectedEl.classList.contains(CSS_CLASSES.TODAY);
            
            let targetScroll;

            if (isToday) {
                // ALIGN END (Right): Prioriza o passado imediato
                const paddingRight = 10;
                targetScroll = (elLeft + elWidth) - stripWidth + paddingRight;
            } else {
                // ALIGN CENTER: Contexto balanceado
                targetScroll = elLeft - (stripWidth / 2) + (elWidth / 2);
            }
            
            ui.calendarStrip.scrollTo({
                left: targetScroll,
                behavior: smooth ? 'smooth' : 'auto'
            });
        }
    });
}
