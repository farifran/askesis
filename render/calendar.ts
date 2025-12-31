
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render/calendar.ts
 * @description Motor de Renderização do Calendário (Strip & Almanac).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo opera na thread principal e é crítico para a percepção de fluidez (60fps).
 * 
 * ARQUITETURA (DOM Recycling & Template Cloning):
 * - **Responsabilidade Única:** Gerenciar a representação visual do tempo (faixa horizontal e grid mensal).
 * - **Zero Allocations (Hot Path):** Utiliza "Template Cloning" em vez de `createElement` repetitivo e "DOM Recycling"
 *   para atualizar nós existentes em vez de destruir/recriar (GC Pressure Reduction).
 * - **Batching:** Todas as inserções usam `DocumentFragment` para causar apenas um Reflow por ciclo.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Fonte da verdade.
 * - `selectors.ts`: Cálculos de estatísticas diárias.
 * - `ui.ts`: Referências DOM cacheadas.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Geometry/Attribute Dirty Checking:** Antes de escrever no DOM (setAttribute, classList),
 *    verificamos se o valor mudou. Leituras são baratas; escritas invalidam o layout.
 * 2. **Manual String Construction:** Em loops de renderização (ex: `renderFullCalendar`), construímos strings ISO
 *    manualmente (concatenação de inteiros) para evitar a alocação de dezenas de objetos `Date`.
 * 3. **WeakMap DOM Cache:** Elimina `querySelector` no loop de renderização armazenando referências diretas aos nós filhos.
 */

import { state, DAYS_IN_CALENDAR } from '../state';
import { calculateDaySummary } from '../services/selectors';
import { ui } from './ui';
import { getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate, addDays } from '../utils';
import { getLocaleDayName, formatDate, formatInteger } from '../i18n'; 
import { setTextContent } from './dom';
import { CSS_CLASSES, DOM_SELECTORS } from './constants';

// PERFORMANCE [2025-01-22]: Cache de elementos do calendário (DOM Pool).
// Mantém referências aos nós DOM para atualização in-place, evitando o custo de `document.createElement`.
let cachedDayElements: HTMLElement[] = [];

// PERFORMANCE [2025-03-09]: Template Prototypes.
// `cloneNode(true)` é significativamente mais rápido que criar hierarquias DOM via API JS imperativa.
let dayItemTemplate: HTMLElement | null = null;
let fullCalendarDayTemplate: HTMLElement | null = null;

// PERFORMANCE [2025-04-16]: WeakMap Cache for internal DOM nodes.
// Avoids 3x querySelector calls per day item per render.
type CalendarDayRefs = {
    dayName: HTMLElement;
    dayProgressRing: HTMLElement;
    dayNumber: HTMLElement;
};
const dayElementCache = new WeakMap<HTMLElement, CalendarDayRefs>();

// PERFORMANCE [2025-04-13]: Hoisted Intl Options (Zero-Allocation)
// Define as opções de formatação como constantes para evitar recriação em loops.
const OPTS_ARIA_DATE: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
};

const OPTS_FULL_CAL_HEADER: Intl.DateTimeFormatOptions = {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
};

const OPTS_FULL_CAL_ARIA: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
};

// PERF: LUT for padding numbers 0-99 (Zero conditional branching)
const PAD_LUT = Array.from({length: 100}, (_, i) => (i < 10 ? '0' : '') + i);

/**
 * Singleton Lazy-Loader para o template do item de dia.
 * @returns O nó HTMLElement modelo (clone source).
 */
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

        // Structure: div > [span.day-name, div.ring > span.number]
        dayProgressRing.appendChild(dayNumber);
        dayItemTemplate.appendChild(dayName);
        dayItemTemplate.appendChild(dayProgressRing);
    }
    return dayItemTemplate;
}

/**
 * Singleton Lazy-Loader para o template do dia do calendário completo.
 */
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
 * [HOT PATH]: Esta função roda N vezes por renderização (N = dias visíveis).
 * OTIMIZAÇÃO (DRY & DOM Access): Aplica o estado visual minimizando escritas no DOM.
 * 
 * @param dayItem O elemento DOM a ser atualizado.
 * @param date O objeto Date correspondente.
 * @param todayISO (Opcional) Data de hoje pré-calculada para evitar chamadas repetidas a `getTodayUTCIso()`.
 * @param precalcIsoDate (Opcional) String ISO da data para evitar `toUTCIsoDateString()` repetido.
 */
export function updateCalendarDayElement(dayItem: HTMLElement, date: Date, todayISO?: string, precalcIsoDate?: string) {
    // PERFORMANCE: Retrieve DOM references from WeakMap (O(1))
    let refs = dayElementCache.get(dayItem);

    // ROBUSTNESS: Auto-repair cache if missing (e.g., external DOM manipulation)
    if (!refs) {
        const dayName = dayItem.firstElementChild as HTMLElement;
        const dayProgressRing = dayItem.lastElementChild as HTMLElement;
        const dayNumber = dayProgressRing?.firstElementChild as HTMLElement;
        
        if (dayName && dayProgressRing && dayNumber) {
            refs = { dayName, dayProgressRing, dayNumber };
            dayElementCache.set(dayItem, refs);
        } else {
            // Fallback to querySelector (Slow Path) only if structure is broken
            refs = {
                dayName: dayItem.querySelector(`.${CSS_CLASSES.DAY_NAME}`) as HTMLElement,
                dayProgressRing: dayItem.querySelector(`.${CSS_CLASSES.DAY_PROGRESS_RING}`) as HTMLElement,
                dayNumber: dayItem.querySelector(`.${CSS_CLASSES.DAY_NUMBER}`) as HTMLElement
            };
            if (refs.dayName) dayElementCache.set(dayItem, refs); // Cache what we found
        }
    }

    const { dayName, dayProgressRing, dayNumber } = refs;

    const effectiveTodayISO = todayISO || getTodayUTCIso();
    // PERFORMANCE: Usa valor pré-calculado se disponível para evitar alocação de string/processamento de data.
    const isoDate = precalcIsoDate || toUTCIsoDateString(date);
    
    // DECOUPLING: Passamos o objeto `date` para evitar re-parsing dentro do seletor.
    const { completedPercent, snoozedPercent, showPlusIndicator: showPlus } = calculateDaySummary(isoDate, date);
    
    const isSelected = isoDate === state.selectedDate;
    const isToday = isoDate === effectiveTodayISO;

    // PERFORMANCE: DOM Token List Toggle.
    // O navegador otimiza internamente, mas a verificação explícita `contains` evita invalidar estilos se o estado não mudou.
    if (dayItem.classList.contains(CSS_CLASSES.SELECTED) !== isSelected) {
        dayItem.classList.toggle(CSS_CLASSES.SELECTED, isSelected);
    }
    if (dayItem.classList.contains(CSS_CLASSES.TODAY) !== isToday) {
        dayItem.classList.toggle(CSS_CLASSES.TODAY, isToday);
    }

    // Acessibilidade (ARIA)
    // PERFORMANCE: Verificação de valor anterior (Dirty Check) antes da escrita.
    if (dayItem.getAttribute('aria-pressed') !== String(isSelected)) {
        dayItem.setAttribute('aria-pressed', String(isSelected));
    }
    
    // A11Y [2025-01-17]: Roving Tabindex para navegação por teclado.
    const newTabIndex = isSelected ? '0' : '-1';
    if (dayItem.getAttribute('tabindex') !== newTabIndex) {
        dayItem.setAttribute('tabindex', newTabIndex);
    }

    // PERFORMANCE [2025-01-16]: formatDate (i18n) Cacheado.
    const ariaDate = formatDate(date, OPTS_ARIA_DATE);
    
    if (dayItem.getAttribute('aria-label') !== ariaDate) {
        dayItem.setAttribute('aria-label', ariaDate);
    }

    // Atualização Visual (Variáveis CSS e Indicadores)
    if (dayProgressRing) {
        const newCompleted = `${completedPercent}%`;
        const newSnoozed = `${snoozedPercent}%`;
        
        // PERFORMANCE CRÍTICA [2025-01-23]: Dataset Dirty Checking.
        // `style.setProperty` força o navegador a recalcular estilos. Usamos `dataset` como um cache local
        // para saber se precisamos realmente tocar no estilo.
        if (dayProgressRing.dataset.completedPercent !== newCompleted) {
            dayProgressRing.style.setProperty('--completed-percent', newCompleted);
            dayProgressRing.dataset.completedPercent = newCompleted;
        }
        if (dayProgressRing.dataset.snoozedPercent !== newSnoozed) {
            dayProgressRing.style.setProperty('--snoozed-percent', newSnoozed);
            dayProgressRing.dataset.snoozedPercent = newSnoozed;
        }
        
        if (dayNumber) {
            if (dayNumber.classList.contains('has-plus') !== showPlus) {
                dayNumber.classList.toggle('has-plus', showPlus);
            }
            // SOPA Update: Use formatInteger for localized number
            setTextContent(dayNumber, formatInteger(date.getUTCDate()));
        }
    }
    
    if (dayName) {
        setTextContent(dayName, getLocaleDayName(date));
    }
}

export function createCalendarDayElement(date: Date, todayISO: string): HTMLElement {
    // PERFORMANCE [2025-03-09]: Template Cloning.
    const dayItem = getDayItemTemplate().cloneNode(true) as HTMLElement;
    
    // PERFORMANCE [2025-04-16]: O(1) Structure Traversal & Caching.
    // Known structure: div > [span.day-name, div.ring > span.number]
    const dayName = dayItem.firstElementChild as HTMLElement;
    const dayProgressRing = dayItem.lastElementChild as HTMLElement;
    const dayNumber = dayProgressRing.firstElementChild as HTMLElement;

    dayElementCache.set(dayItem, { dayName, dayProgressRing, dayNumber });
    
    const isoDate = toUTCIsoDateString(date);
    dayItem.dataset.date = isoDate;

    // Hidrata o nó clonado (usa o cache recém-criado).
    updateCalendarDayElement(dayItem, date, todayISO, isoDate);

    return dayItem;
}

/**
 * Helper centralizado para rolar o calendário para o dia "Hoje".
 * UX: `requestAnimationFrame` garante que o DOM esteja pintado antes de calcular o scroll.
 */
export function scrollToToday(behavior: ScrollBehavior = 'auto') {
    requestAnimationFrame(() => {
        const todayEl = ui.calendarStrip.querySelector<HTMLElement>(`${DOM_SELECTORS.DAY_ITEM}.${CSS_CLASSES.TODAY}`);
        if (todayEl) {
            // LOGIC UPDATE [2025-02-05]: 'end' alinha o dia atual à direita, mostrando o passado (contexto).
            todayEl.scrollIntoView({ behavior, block: 'nearest', inline: 'end' });
        }
    });
}

/**
 * Renderiza a faixa de calendário horizontal.
 * Implementa estratégia de reciclagem de DOM para evitar "Layout Thrashing".
 */
export function renderCalendar() {
    // PERFORMANCE [2025-01-26]: Dirty Check Guard.
    // Se nada relevante mudou visualmente no calendário, aborta o ciclo.
    if (!state.uiDirtyState.calendarVisuals) {
        return;
    }

    // ROBUSTNESS / SELF-HEALING [2025-03-10]:
    // Garante que o estado das datas esteja consistente antes de renderizar.
    let selectedDateObj = parseUTCIsoDate(state.selectedDate);
    if (isNaN(selectedDateObj.getTime())) {
        console.warn("Invalid selectedDate detected during render. Resetting to Today.");
        state.selectedDate = getTodayUTCIso();
        state.calendarDates = []; // Força rebuild
    }

    // Regenera o array de datas se estiver vazio (ex: first boot ou crash recovery).
    if (state.calendarDates.length === 0) {
        selectedDateObj = parseUTCIsoDate(state.selectedDate);
        state.calendarDates = Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => 
            addDays(selectedDateObj, i - 30)
        );
    }

    // DO NOT REFACTOR: Estratégia de Reciclagem.
    // Se o número de elementos cacheados bater com o necessário, atualizamos in-place (rápido).
    // Caso contrário, reconstruímos tudo (lento, mas necessário se o range mudar).
    const needsRebuild = cachedDayElements.length === 0 || cachedDayElements.length !== state.calendarDates.length;
    
    // PERFORMANCE [2025-03-03]: Hoist calculation out of the loop.
    const todayISO = getTodayUTCIso();
    
    if (needsRebuild) {
        ui.calendarStrip.innerHTML = '';
        cachedDayElements = [];
        
        // PERFORMANCE: DocumentFragment evita reflows a cada appendChild.
        const fragment = document.createDocumentFragment();
        state.calendarDates.forEach(date => {
            const el = createCalendarDayElement(date, todayISO);
            cachedDayElements.push(el);
            fragment.appendChild(el);
        });
        ui.calendarStrip.appendChild(fragment);

        scrollToToday('auto');
    } else {
        // Fast Path: Atualização In-Place.
        cachedDayElements.forEach((dayEl, index) => {
            const date = state.calendarDates[index];
            if (date) {
                const isoDate = toUTCIsoDateString(date);
                // Atualiza dataset apenas se mudou (Dirty Check)
                if(dayEl.dataset.date !== isoDate) {
                    dayEl.dataset.date = isoDate;
                }
                updateCalendarDayElement(dayEl, date, todayISO, isoDate);
            }
        });
    }

    state.uiDirtyState.calendarVisuals = false;
}

/**
 * Renderiza o modal de calendário completo (Almanaque).
 * Utiliza otimização SOTA: Integer-based String Construction.
 */
export function renderFullCalendar() {
    const { year, month } = state.fullCalendar;
    const todayISO = getTodayUTCIso();

    const monthDate = new Date(Date.UTC(year, month, 1));
    // SOPA Update: Use hoisted options
    ui.fullCalendarMonthYear.textContent = formatDate(monthDate, OPTS_FULL_CAL_HEADER);

    const firstDayOfMonth = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const startDayOfWeek = firstDayOfMonth.getUTCDay();

    const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const grid = ui.fullCalendarGrid;
    grid.innerHTML = '';
    
    // Renderiza cabeçalho de dias da semana (apenas se vazio)
    if (ui.fullCalendarWeekdays.childElementCount === 0) {
        const weekdaysFragment = document.createDocumentFragment();
        for (let i = 0; i < 7; i++) {
            // Data arbitrária (Domingo) para extrair nomes de dias localizados
            const day = new Date(Date.UTC(2024, 0, 7 + i));
            const weekdayEl = document.createElement('div');
            weekdayEl.textContent = getLocaleDayName(day).substring(0, 1);
            weekdaysFragment.appendChild(weekdayEl);
        }
        ui.fullCalendarWeekdays.appendChild(weekdaysFragment);
    }
    
    const fragment = document.createDocumentFragment();
    let totalGridCells = 0;

    // PERFORMANCE [2025-03-09]: Template Cloning para células "filler" (mês anterior).
    for (let i = 0; i < startDayOfWeek; i++) {
        const day = daysInPrevMonth - startDayOfWeek + 1 + i;
        const dayEl = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        dayEl.className = 'full-calendar-day other-month';
        
        // Estrutura conhecida: div.day-progress-ring > span.day-number
        const ring = dayEl.firstElementChild as HTMLElement;
        const number = ring.firstElementChild as HTMLElement;
        // SOPA Update: Use formatInteger
        number.textContent = formatInteger(day);
        
        fragment.appendChild(dayEl);
        totalGridCells++;
    }

    // MEMORY OPTIMIZATION [2025-04-15]: Integer-based ISO Construction.
    // Em vez de mutar um objeto Date (ou criar novos) em loop, construímos a string ISO manualmente.
    // Ano e Mês são constantes no loop. Apenas o dia muda.
    // Isso evita alocação de ~31 objetos Date e overhead de formatação.
    const paddedYear = year.toString(); // "2024"
    const displayMonth = month + 1;
    // PERF: LUT for month padding
    const paddedMonth = PAD_LUT[displayMonth]; 
    const prefix = `${paddedYear}-${paddedMonth}-`; // "2024-05-"

    // SOPA OPTIMIZATION [2025-04-22]: Single reusable date for calculateDaySummary
    // Passa uma referência única de Date para evitar criação interna na função de resumo.
    // Atualizamos o dia com setUTCDate a cada loop.
    const reusableDate = new Date(Date.UTC(year, month, 1));

    for (let day = 1; day <= daysInMonth; day++) {
        // PERF: Concatenação de string simples com LUT
        const paddedDay = PAD_LUT[day];
        const isoDate = prefix + paddedDay; // "2024-05-01"
        
        // Atualiza o objeto de data reutilizável para a lógica interna de summary
        reusableDate.setUTCDate(day);

        // Passa a referência para evitar re-parse
        const { completedPercent, snoozedPercent } = calculateDaySummary(isoDate, reusableDate);

        // PERFORMANCE: Template Cloning.
        const dayEl = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        
        dayEl.dataset.date = isoDate;
        const isSelected = isoDate === state.selectedDate;
        
        // Batch class updates
        if (isSelected) dayEl.classList.add(CSS_CLASSES.SELECTED);
        if (isoDate === todayISO) dayEl.classList.add(CSS_CLASSES.TODAY);
        
        dayEl.setAttribute('aria-pressed', String(isSelected));
        // SOPA Update: Use hoisted options
        dayEl.setAttribute('aria-label', formatDate(reusableDate, OPTS_FULL_CAL_ARIA));
        dayEl.setAttribute('tabindex', isSelected ? '0' : '-1');

        // Locate children in the cloned template structure (Fast access)
        const ringEl = dayEl.firstElementChild as HTMLElement; // .day-progress-ring
        const numberEl = ringEl.firstElementChild as HTMLElement; // .day-number

        // CSS Variables update
        ringEl.style.setProperty('--completed-percent', `${completedPercent}%`);
        ringEl.style.setProperty('--snoozed-percent', `${snoozedPercent}%`);
        // SOPA Update: Use formatInteger
        numberEl.textContent = formatInteger(day);
        
        fragment.appendChild(dayEl);
        totalGridCells++;
    }
    
    // Preenche células restantes do grid (mês seguinte)
    const remainingCells = (7 - (totalGridCells % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        const day = i;
        const dayEl = getFullCalendarDayTemplate().cloneNode(true) as HTMLElement;
        dayEl.className = 'full-calendar-day other-month';
        
        const ring = dayEl.firstElementChild as HTMLElement;
        const number = ring.firstElementChild as HTMLElement;
        // SOPA Update: Use formatInteger
        number.textContent = formatInteger(day);
        
        fragment.appendChild(dayEl);
    }
    
    grid.appendChild(fragment);
}
