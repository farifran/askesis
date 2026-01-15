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
import { formatInteger, getLocaleDayName, formatDate } from '../i18n'; 
import { setTextContent } from './dom';
import { CSS_CLASSES } from './constants';

// --- CONFIGURAÇÃO ---
const INITIAL_BUFFER_DAYS = 15; // Teleport Buffer: Mantém o DOM leve (aprox 31 itens)

let dayItemTemplate: HTMLElement | null = null;
let fullCalendarDayTemplate: HTMLElement | null = null;

const OPTS_ARIA = { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' } as const;
const OPTS_HEADER = { month: 'long', year: 'numeric', timeZone: 'UTC' } as const;
const PAD = Array.from({length: 100}, (_, i) => (i < 10 ? '0' : '') + i);

// --- TEMPLATES ---

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
 */
function createDayElement(dateISO: string, isSelected: boolean, isToday: boolean): HTMLElement {
    const el = getDayItemTemplate().cloneNode(true) as HTMLElement;
    const dateObj = parseUTCIsoDate(dateISO);
    
    // Dataset é a Fonte da Verdade
    el.dataset.date = dateISO; 
    
    const dayNameEl = el.firstElementChild as HTMLElement;
    const ringEl = dayNameEl.nextElementSibling as HTMLElement;
    const numEl = ringEl.firstElementChild as HTMLElement;

    // Conteúdo
    setTextContent(dayNameEl, getLocaleDayName(dateObj));
    setTextContent(numEl, formatInteger(dateObj.getUTCDate()));
    
    // Classes de Estado
    if (isSelected) el.classList.add(CSS_CLASSES.SELECTED);
    if (isToday) el.classList.add(CSS_CLASSES.TODAY);

    // Indicadores Visuais (Progress Rings)
    const { completedPercent, snoozedPercent, showPlusIndicator } = calculateDaySummary(dateISO, dateObj);
    if (completedPercent > 0) ringEl.style.setProperty('--completed-percent', `${completedPercent}%`);
    if (snoozedPercent > 0) ringEl.style.setProperty('--snoozed-percent', `${snoozedPercent}%`);
    if (showPlusIndicator) numEl.classList.add('has-plus');

    // Acessibilidade
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

    // PERFORMANCE FIX: Dirty Check Restaurado.
    // Isso garante que cliques simples na fita (que não setam calendarVisuals=true)
    // NÃO disparem o Hard Reset e o Scroll Automático, preservando a posição do usuário.
    if (!state.uiDirtyState.calendarVisuals && ui.calendarStrip.children.length > 0) return;

    const centerDateISO = state.selectedDate || getTodayUTCIso();
    const centerDate = parseUTCIsoDate(centerDateISO);
    const todayISO = getTodayUTCIso();
    
    const frag = document.createDocumentFragment();

    // Renderiza janela inicial: center - 15 ... center + 15
    for (let i = -INITIAL_BUFFER_DAYS; i <= INITIAL_BUFFER_DAYS; i++) {
        const d = addDays(centerDate, i);
        const iso = toUTCIsoDateString(d);
        const el = createDayElement(iso, iso === centerDateISO, iso === todayISO);
        frag.appendChild(el);
    }

    ui.calendarStrip.innerHTML = ''; // Limpeza Total
    ui.calendarStrip.appendChild(frag);
    
    state.uiDirtyState.calendarVisuals = false;
    
    // Força o scroll para a posição correta (Teleporte)
    requestAnimationFrame(() => scrollToSelectedDate(false));
}

/**
 * [INFINITE SCROLL] Adiciona um dia ao final.
 * Aceita um container (ui.calendarStrip ou DocumentFragment) para batching.
 */
export function appendDayToStrip(lastDateISO: string, container: Node = ui.calendarStrip): string {
    const nextDate = addDays(parseUTCIsoDate(lastDateISO), 1);
    const iso = toUTCIsoDateString(nextDate);
    const todayISO = getTodayUTCIso();
    
    const el = createDayElement(iso, iso === state.selectedDate, iso === todayISO);
    container.appendChild(el);

    return iso;
}

/**
 * [INFINITE SCROLL] Adiciona um dia ao início.
 */
export function prependDayToStrip(firstDateISO: string, container: Node = ui.calendarStrip): string {
    const prevDate = addDays(parseUTCIsoDate(firstDateISO), -1);
    const iso = toUTCIsoDateString(prevDate);
    const todayISO = getTodayUTCIso();

    const el = createDayElement(iso, iso === state.selectedDate, iso === todayISO);
    
    // Se for Fragment, prepend = append no fragmento (a ordem do loop decide)
    // Se for Elemento real, insertBefore
    if (container instanceof DocumentFragment) {
        container.prepend(el);
    } else {
        (container as HTMLElement).insertBefore(el, (container as HTMLElement).firstElementChild);
    }

    return iso;
}

// --- FULL CALENDAR (ALMANAC) ---

export function renderFullCalendar() {
    if (!ui.fullCalendarGrid || !state.fullCalendar) return;

    const { year, month } = state.fullCalendar;
    const date = new Date(Date.UTC(year, month, 1));
    ui.fullCalendarMonthYear.textContent = formatDate(date, OPTS_HEADER);

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

        // Indicadores
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
 * CORREÇÃO CIRÚRGICA: Se for "Hoje", alinha à direita (última posição) para mostrar o histórico.
 * Caso contrário (navegação no passado/futuro), centraliza para contexto.
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
                // ALIGN END (Right): Mantém o dia atual na borda direita (com leve respiro),
                // priorizando a visualização do histórico (passado).
                const paddingRight = 10; // Espaço visual na borda direita
                targetScroll = (elLeft + elWidth) - stripWidth + paddingRight;
            } else {
                // ALIGN CENTER: Para datas passadas/futuras selecionadas, o contexto central é melhor.
                targetScroll = elLeft - (stripWidth / 2) + (elWidth / 2);
            }
            
            ui.calendarStrip.scrollTo({
                left: targetScroll,
                behavior: smooth ? 'smooth' : 'auto'
            });
        }
    });
}