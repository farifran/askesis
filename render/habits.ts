
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render/habits.ts
 * @description Motor de Renderização de Cartões de Hábito (Virtual DOM-lite).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo gerencia a lista principal de hábitos. É o componente mais pesado da UI.
 * 
 * ARQUITETURA (DOM Caching & Object Pooling):
 * - **Responsabilidade Única:** Criar, atualizar e organizar os cartões de hábito no DOM.
 * - **WeakMap Cache:** Utiliza `WeakMap` para associar metadados (referências a nós filhos) 
 *   aos elementos DOM sem impedir o Garbage Collection quando o nó é removido.
 * - **Template Cloning:** Criação de novos cartões via clonagem de templates para evitar overhead de parsing HTML.
 * - **Object Pooling:** Reutiliza arrays de agrupamento (`habitsByTimePool`) para evitar alocação de memória a cada frame (GC Pause).
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - `state.ts`: Dados brutos.
 * - `selectors.ts`: Lógica derivada (streaks, metas).
 * - `dom.ts`: Utilitários de escrita segura.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Separação Criação/Atualização:** `createHabitCardElement` monta o esqueleto; `updateHabitCardElement` hidrata os dados.
 *    Isso permite reciclar esqueletos no futuro se necessário.
 * 2. **Interação com Drag & Drop:** Expõe iteradores (`getLiveHabitCards`) para que o motor de física (`listeners/drag.ts`)
 *    possa ler posições sem varrer o DOM.
 */

// FIX: Import getSmartGoalForHabit from selectors module, not state module.
import { state, Habit, HabitStatus, HabitDayData, STREAK_CONSOLIDATED, STREAK_SEMI_CONSOLIDATED, TimeOfDay, getHabitDailyInfoForDate, TIMES_OF_DAY, HabitDailyInfo } from '../state';
import { calculateHabitStreak, getActiveHabitsForDate, getSmartGoalForHabit, getHabitDisplayInfo } from '../services/selectors';
import { ui } from './ui';
import { t, getTimeOfDayName, formatInteger } from '../i18n';
import { UI_ICONS, getTimeOfDayIcon } from './icons';
import { setTextContent } from './dom';
import { CSS_CLASSES, DOM_SELECTORS } from './constants'; // TYPE SAFETY IMPORT
import { parseUTCIsoDate } from '../utils';

// OTIMIZAÇÃO [2025-01-24]: Cache persistente para cartões de hábitos.
// Mapeia "HabitID|TimeOfDay" -> HTMLElement. Evita recriar DOM se o hábito não mudou de grupo.
const habitElementCache = new Map<string, HTMLElement>();

// PERFORMANCE [2025-03-05]: Cache para referências de elementos internos dos cartões.
// Using WeakMap allows keys (HTML Elements) to be garbage collected automatically when removed from DOM.
// Evita chamar `card.querySelector(...)` repetidamente dentro de `updateHabitCardElement` (Hot Path).
type CardElements = {
    icon: HTMLElement;
    contentWrapper: HTMLElement;
    name: HTMLElement;
    subtitle: HTMLElement;
    details: HTMLElement;
    consolidationMsg: HTMLElement; // Stable DOM reference
    noteBtn: HTMLElement;
    deleteBtn: HTMLElement;
    goal: HTMLElement;
    // Cache opcional para elementos que podem ou não existir dependendo do tipo de meta
    goalProgress?: HTMLElement;
    goalUnit?: HTMLElement;
    goalDecBtn?: HTMLButtonElement;
    goalIncBtn?: HTMLButtonElement;
    // PERFORMANCE [2025-04-05]: Estado local do ícone para evitar re-parsing de SVG
    cachedIconHtml?: string;
};
const cardElementsCache = new WeakMap<HTMLElement, CardElements>();

// MEMORY OPTIMIZATION [2025-03-04]: Object Pool para agrupamento de hábitos.
// Evita a criação de novos arrays (alocação de memória) a cada frame de renderização.
// Apenas limpamos (.length = 0) e reutilizamos os arrays existentes.
const habitsByTimePool: Record<TimeOfDay, Habit[]> = { 'Morning': [], 'Afternoon': [], 'Evening': [] };

// PERFORMANCE [2025-04-20]: Static DOM Cache for Habit Groups.
// Avoids repetitive querySelector calls inside the render loop (3x per frame).
// The structure of wrapper -> group/marker is static in index.html.
type GroupDOM = { wrapper: HTMLElement; group: HTMLElement; marker: HTMLElement };
const groupDomCache = new Map<TimeOfDay, GroupDOM>();

function getGroupDOM(time: TimeOfDay): GroupDOM | null {
    // Fast Path: Check memory cache
    const cached = groupDomCache.get(time);
    if (cached) return cached;

    // Slow Path: Query DOM (Once per session)
    if (!ui.habitContainer) return null; // Safety check if UI not hydrated

    const wrapper = ui.habitContainer.querySelector<HTMLElement>(`.habit-group-wrapper[data-time-wrapper="${time}"]`);
    if (!wrapper) return null;

    const group = wrapper.querySelector<HTMLElement>(`.${CSS_CLASSES.HABIT_GROUP}[data-time="${time}"]`);
    const marker = wrapper.querySelector<HTMLElement>('.time-marker');

    if (group && marker) {
        const dom = { wrapper, group, marker };
        groupDomCache.set(time, dom);
        return dom;
    }
    return null;
}

// --- DOM TEMPLATES (PERFORMANCE) ---
// Pre-parsing HTML strings into DOM nodes prevents browser parser overhead during list rendering.

let goalControlsTemplate: HTMLElement | null = null;
let completedWrapperTemplate: HTMLElement | null = null;
let snoozedWrapperTemplate: HTMLElement | null = null;
let habitCardTemplate: HTMLElement | null = null;
let placeholderTemplate: HTMLElement | null = null;

function getGoalControlsTemplate(): HTMLElement {
    if (!goalControlsTemplate) {
        const div = document.createElement('div');
        div.className = CSS_CLASSES.HABIT_GOAL_CONTROLS;
        div.innerHTML = `
            <button type="button" class="${CSS_CLASSES.GOAL_CONTROL_BTN}" data-action="decrement">-</button>
            <div class="${CSS_CLASSES.GOAL_VALUE_WRAPPER}">
                <div class="progress"></div>
                <div class="unit"></div>
            </div>
            <button type="button" class="${CSS_CLASSES.GOAL_CONTROL_BTN}" data-action="increment">+</button>
        `;
        goalControlsTemplate = div;
    }
    return goalControlsTemplate;
}

function getCompletedWrapperTemplate(): HTMLElement {
    if (!completedWrapperTemplate) {
        const wrapper = document.createElement('div');
        wrapper.className = 'completed-wrapper';
        wrapper.innerHTML = UI_ICONS.check;
        completedWrapperTemplate = wrapper;
    }
    return completedWrapperTemplate;
}

function getSnoozedWrapperTemplate(): HTMLElement {
    if (!snoozedWrapperTemplate) {
        const wrapper = document.createElement('div');
        wrapper.className = 'snoozed-wrapper';
        wrapper.innerHTML = UI_ICONS.snoozed;
        snoozedWrapperTemplate = wrapper;
    }
    return snoozedWrapperTemplate;
}

function getPlaceholderTemplate(): HTMLElement {
    if (!placeholderTemplate) {
        placeholderTemplate = document.createElement('div');
        placeholderTemplate.className = CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER;
        placeholderTemplate.setAttribute('role', 'button');
        placeholderTemplate.setAttribute('tabindex', '0');
    }
    return placeholderTemplate;
}

/**
 * STATE OF THE ART [2025-04-05]: Singleton Template para Cartão de Hábito.
 * Constrói a estrutura DOM completa uma única vez.
 * Subsequentemente, usamos `cloneNode(true)` que é processado em C++ pelo navegador,
 * sendo muito mais rápido que múltiplas chamadas JS de `createElement`.
 */
function getHabitCardTemplate(): HTMLElement {
    if (!habitCardTemplate) {
        habitCardTemplate = document.createElement('li');
        habitCardTemplate.className = CSS_CLASSES.HABIT_CARD;
        
        // Estrutura estática interna.
        // Nota: Botões já nascem com os ícones corretos para evitar re-parse.
        habitCardTemplate.innerHTML = `
            <div class="habit-actions-left">
                <button type="button" class="${CSS_CLASSES.SWIPE_DELETE_BTN}">${UI_ICONS.swipeDelete}</button>
            </div>
            <div class="habit-actions-right">
                <button type="button" class="${CSS_CLASSES.SWIPE_NOTE_BTN}">${UI_ICONS.swipeNote}</button>
            </div>
            <div class="${CSS_CLASSES.HABIT_CONTENT_WRAPPER}" role="button" tabindex="0" draggable="true">
                <div class="habit-icon"></div>
                <div class="${CSS_CLASSES.HABIT_DETAILS}">
                    <div class="name"></div>
                    <div class="subtitle"></div>
                    <div class="consolidation-message" hidden></div>
                </div>
                <div class="habit-goal"></div>
            </div>
        `;
    }
    return habitCardTemplate;
}

export function clearHabitDomCache() {
    habitElementCache.clear();
    // cardElementsCache is a WeakMap, it clears itself when elements are GC'd
}

export function getCachedHabitCard(habitId: string, time: TimeOfDay): HTMLElement | undefined {
    return habitElementCache.get(`${habitId}|${time}`);
}

/**
 * ADVANCED OPTIMIZATION [2025-03-17]: Expose live cache iterator.
 * Returns an iterator for all live habit card elements currently in the DOM/Cache.
 * Used by drag handler to avoid `querySelectorAll` layout thrashing.
 */
export function getLiveHabitCards(): IterableIterator<HTMLElement> {
    return habitElementCache.values();
}

export const getUnitString = (habit: Habit, value: number | undefined) => {
    const unitKey = habit.goal.unitKey || 'unitCheck';
    return t(unitKey, { count: value });
};

function _renderCompletedGoal(goalEl: HTMLElement) {
    // OPTIMIZATION: Check classList first to avoid DOM read/write
    if (goalEl.firstElementChild?.classList.contains('completed-wrapper')) return;

    // PERFORMANCE: Template Cloning é mais rápido que innerHTML para estruturas repetitivas.
    goalEl.replaceChildren(getCompletedWrapperTemplate().cloneNode(true));
}

function _renderSnoozedGoal(goalEl: HTMLElement) {
    // PERFORMANCE: Dirty Check antes de manipular o DOM.
    if (goalEl.firstElementChild?.classList.contains('snoozed-wrapper')) return;

    goalEl.replaceChildren(getSnoozedWrapperTemplate().cloneNode(true));
}

/**
 * Renderiza ou atualiza os controles de meta numérica.
 * OPTIMIZATION [2025-04-04]: Deep Caching de referências.
 * Em vez de buscar `.progress` e `.unit` via querySelector a cada update,
 * usamos as referências cacheadas no `CardElements` do WeakMap.
 */
function _renderPendingGoalControls(
    habit: Habit, 
    time: TimeOfDay, 
    dayDataForInstance: HabitDayData | undefined,
    cachedElements: CardElements
) {
    const hasNumericGoal = habit.goal.type === 'pages' || habit.goal.type === 'minutes';
    const goalEl = cachedElements.goal;

    if (hasNumericGoal) {
        const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
        const currentGoal = dayDataForInstance?.goalOverride ?? smartGoal;
        // SOPA Update: Use localized integer format
        const displayVal = formatInteger(currentGoal);
        const unitVal = getUnitString(habit, currentGoal);

        // Se os controles ainda não existem ou foram removidos (ex: transição de completado -> pendente)
        // Precisamos reconstruir e atualizar o cache.
        if (!goalEl.querySelector(`.${CSS_CLASSES.HABIT_GOAL_CONTROLS}`)) {
            goalEl.replaceChildren();
            // PERFORMANCE: Use cloned template
            const controls = getGoalControlsTemplate().cloneNode(true) as HTMLElement;
            goalEl.appendChild(controls);

            // Update Cache with new elements (Lookup ONCE)
            cachedElements.goalDecBtn = controls.querySelector(`[data-action="decrement"]`) as HTMLButtonElement;
            cachedElements.goalIncBtn = controls.querySelector(`[data-action="increment"]`) as HTMLButtonElement;
            cachedElements.goalProgress = controls.querySelector('.progress') as HTMLElement;
            cachedElements.goalUnit = controls.querySelector('.unit') as HTMLElement;
        }

        // Fast Access via Cache (No DOM Querying)
        const { goalDecBtn, goalIncBtn, goalProgress, goalUnit } = cachedElements;

        if (goalDecBtn && goalIncBtn && goalProgress && goalUnit) {
            // Update Dynamic Data
            goalDecBtn.dataset.habitId = habit.id;
            goalDecBtn.dataset.time = time;
            goalDecBtn.setAttribute('aria-label', t('habitGoalDecrement_ariaLabel'));
            goalDecBtn.disabled = currentGoal <= 1;

            goalIncBtn.dataset.habitId = habit.id;
            goalIncBtn.dataset.time = time;
            goalIncBtn.setAttribute('aria-label', t('habitGoalIncrement_ariaLabel'));

            // PERFORMANCE: setTextContent usa nodeValue para evitar reflows.
            setTextContent(goalProgress, displayVal);
            setTextContent(goalUnit, unitVal);
        }
    } else {
        if (goalEl.hasChildNodes()) goalEl.replaceChildren();
    }
}

export function updateGoalContentElement(
    status: HabitStatus, 
    habit: Habit, 
    time: TimeOfDay, 
    dayDataForInstance: HabitDayData | undefined,
    cachedElements: CardElements
) {
    const goalEl = cachedElements.goal;

    // UX UPDATE [2025-03-19]: Simplificação visual no estado 'Completed'.
    if (status === 'completed') {
        _renderCompletedGoal(goalEl);
    } else if (status === 'snoozed') {
        _renderSnoozedGoal(goalEl);
    } else {
        // ROBUSTNESS FIX [2025-04-01]: Protect inline edit input.
        if (goalEl.querySelector('input')) return;

        // Renderiza controles apenas se estiver pendente (e for numérico)
        _renderPendingGoalControls(habit, time, dayDataForInstance, cachedElements);
    }
}

/**
 * Atualiza a mensagem de consolidação (Hábito Consolidado / Semi).
 * PERFORMANCE [2025-04-04]: Stable DOM.
 * Não cria/remove elementos. Apenas altera o texto e a classe 'hidden'.
 */
export function _updateConsolidationMessage(msgEl: HTMLElement, streak: number) {
    let messageText: string | null = null;
    if (streak >= STREAK_CONSOLIDATED) {
        messageText = t('habitConsolidatedMessage');
    } else if (streak >= STREAK_SEMI_CONSOLIDATED) {
        messageText = t('habitSemiConsolidatedMessage');
    }

    if (messageText) {
        setTextContent(msgEl, messageText);
        if (msgEl.hidden) msgEl.hidden = false;
    } else {
        if (!msgEl.hidden) msgEl.hidden = true;
    }
}

/**
 * Updates a habit card's DOM with current state.
 * PERFORMANCE [2025-03-16]: Accepts optional `preLoadedDailyInfo` to avoid fetching data map repeatedly in loops.
 * [HOT PATH]: Esta função é chamada N vezes por frame de renderização.
 */
export function updateHabitCardElement(
    card: HTMLElement, 
    habit: Habit, 
    time: TimeOfDay, 
    preLoadedDailyInfo?: Record<string, HabitDailyInfo>
): void {
    let elements = cardElementsCache.get(card);
    
    // FIX [2025-03-09]: ROBUSTNESS AUTO-REPAIR.
    // Fallback caso o elemento não tenha sido criado via createHabitCardElement (ex: SSR ou bugs de cache).
    if (!elements) {
        const icon = card.querySelector('.habit-icon') as HTMLElement;
        const contentWrapper = card.querySelector(`.${CSS_CLASSES.HABIT_CONTENT_WRAPPER}`) as HTMLElement;
        
        if (icon && contentWrapper) {
             elements = {
                icon: icon,
                contentWrapper: contentWrapper,
                name: card.querySelector('.name') as HTMLElement,
                subtitle: card.querySelector('.subtitle') as HTMLElement,
                details: card.querySelector(`.${CSS_CLASSES.HABIT_DETAILS}`) as HTMLElement,
                consolidationMsg: card.querySelector('.consolidation-message') as HTMLElement,
                noteBtn: card.querySelector(`.${CSS_CLASSES.SWIPE_NOTE_BTN}`) as HTMLElement,
                deleteBtn: card.querySelector(`.${CSS_CLASSES.SWIPE_DELETE_BTN}`) as HTMLElement,
                goal: card.querySelector('.habit-goal') as HTMLElement,
            };
            // Repair cache
            cardElementsCache.set(card, elements);
        } else {
            console.warn(`Critical DOM elements missing for habit ${habit.id}. Cannot render.`);
            return;
        }
    }
    
    const { icon, contentWrapper, name: nameEl, subtitle: subtitleEl, details: detailsEl, consolidationMsg, noteBtn, deleteBtn } = elements;
    
    // OPTIMIZATION: Use injected daily info map if available, otherwise fetch it.
    const dailyInfo = preLoadedDailyInfo || getHabitDailyInfoForDate(state.selectedDate);
    
    const habitInstanceData = dailyInfo[habit.id]?.instances?.[time];
    const status = habitInstanceData?.status ?? CSS_CLASSES.PENDING;
    const hasNote = habitInstanceData?.note && habitInstanceData.note.length > 0;
    
    // OTIMIZAÇÃO: Passar objeto 'habit' diretamente para evitar busca O(N) dentro da função.
    const streak = calculateHabitStreak(habit, state.selectedDate);
    const { name, subtitle } = getHabitDisplayInfo(habit, state.selectedDate);

    const wasCompleted = card.classList.contains(CSS_CLASSES.COMPLETED);
    // PERFORMANCE: Dirty Check de Classes CSS.
    if (!card.classList.contains(status)) {
        card.classList.remove(CSS_CLASSES.PENDING, CSS_CLASSES.COMPLETED, CSS_CLASSES.SNOOZED);
        card.classList.add(status);
    }

    const isCompleted = status === CSS_CLASSES.COMPLETED;
    
    const newIconHtml = habit.icon;
    const newColor = habit.color;
    const newBgColor = `${habit.color}30`;

    // PERFORMANCE [2025-04-05]: Cache local de HTML no WeakMap para evitar re-parse se o ícone não mudou.
    // Substitui o antigo (icon as any)._cachedIconHtml por uma abordagem limpa e type-safe.
    if (elements.cachedIconHtml !== newIconHtml) {
        icon.innerHTML = newIconHtml;
        elements.cachedIconHtml = newIconHtml;
    }
    
    // OPTIMIZATION [2025-03-09]: Dirty Check styles to prevent Layout Thrashing
    if (icon.style.color !== newColor) icon.style.color = newColor;
    if (icon.style.backgroundColor !== newBgColor) icon.style.backgroundColor = newBgColor;

    if (!wasCompleted && isCompleted) {
        icon.classList.remove('animate-pop');
        void icon.offsetWidth; // Trigger Reflow para reiniciar animação
        icon.classList.add('animate-pop');
        icon.addEventListener('animationend', () => icon.classList.remove('animate-pop'), { once: true });
    }

    const isConsolidated = streak >= STREAK_CONSOLIDATED;
    const isSemi = streak >= STREAK_SEMI_CONSOLIDATED && !isConsolidated;
    
    // PERFORMANCE: Toggle condicional.
    if (card.classList.contains('consolidated') !== isConsolidated) {
        card.classList.toggle('consolidated', isConsolidated);
    }
    if (card.classList.contains('semi-consolidated') !== isSemi) {
        card.classList.toggle('semi-consolidated', isSemi);
    }
    
    const newLabel = `${name}, ${t(`filter${time}`)}, ${status}`;
    if (contentWrapper.getAttribute('aria-label') !== newLabel) {
        contentWrapper.setAttribute('aria-label', newLabel);
    }
    
    setTextContent(nameEl, name);
    setTextContent(subtitleEl, subtitle);

    _updateConsolidationMessage(consolidationMsg, streak);
    
    const hasNoteStr = String(hasNote);
    if (noteBtn.dataset.hasNote !== hasNoteStr) {
        noteBtn.innerHTML = hasNote ? UI_ICONS.swipeNoteHasNote : UI_ICONS.swipeNote;
        noteBtn.setAttribute('aria-label', t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel'));
        noteBtn.dataset.hasNote = hasNoteStr;
    }

    // A11Y FIX [2025-03-08]: Update aria-label for delete button dynamically on language change
    deleteBtn.setAttribute('aria-label', t('habitEnd_ariaLabel'));

    updateGoalContentElement(status, habit, time, habitInstanceData, elements);
}

export function createHabitCardElement(habit: Habit, time: TimeOfDay, preLoadedDailyInfo?: Record<string, HabitDailyInfo>): HTMLElement {
    // REFACTOR [2025-04-05]: Template Cloning Strategy.
    // Substitui a criação imperativa (document.createElement) pela clonagem de um template pré-aquecido.
    // Isso move a construção da árvore DOM para o código nativo (C++), reduzindo drasticamente o tempo de script.
    
    const card = getHabitCardTemplate().cloneNode(true) as HTMLElement;
    card.dataset.habitId = habit.id;
    card.dataset.time = time;

    // Cache the root element
    habitElementCache.set(`${habit.id}|${time}`, card);

    // PERFORMANCE [2025-04-05]: O(1) Structure Traversal.
    // Como a estrutura do template é conhecida e rígida, podemos popular o cache usando
    // propriedades de navegação direta (firstElementChild, nextElementSibling) em vez de querySelector.
    // Isso evita o parse de seletores CSS para cada cartão criado.
    
    // Structure:
    // 0: div.habit-actions-left > button
    // 1: div.habit-actions-right > button
    // 2: div.habit-content-wrapper > [icon, details, goal]
    
    const actionsLeft = card.firstElementChild as HTMLElement;
    const actionsRight = actionsLeft.nextElementSibling as HTMLElement;
    const contentWrapper = actionsRight.nextElementSibling as HTMLElement;
    
    const deleteBtn = actionsLeft.firstElementChild as HTMLElement;
    const noteBtn = actionsRight.firstElementChild as HTMLElement;
    
    // Content Wrapper Structure:
    // 0: div.habit-icon
    // 1: div.habit-details > [name, subtitle, consolidationMsg]
    // 2: div.habit-goal
    
    const icon = contentWrapper.firstElementChild as HTMLElement;
    const details = icon.nextElementSibling as HTMLElement;
    const goal = details.nextElementSibling as HTMLElement;
    
    // Details Structure:
    const nameEl = details.firstElementChild as HTMLElement;
    const subtitleEl = nameEl.nextElementSibling as HTMLElement;
    const consolidationMsg = subtitleEl.nextElementSibling as HTMLElement;

    // PERFORMANCE: Cache element references ONCE at creation.
    cardElementsCache.set(card, {
        icon,
        contentWrapper,
        name: nameEl,
        subtitle: subtitleEl,
        details,
        consolidationMsg,
        noteBtn,
        deleteBtn,
        goal,
    });

    // DELEGATION: Populate data immediately using cached elements.
    updateHabitCardElement(card, habit, time, preLoadedDailyInfo);

    return card;
}

export function updatePlaceholderForGroup(groupEl: HTMLElement, time: TimeOfDay, hasHabits: boolean, isSmartPlaceholder: boolean, emptyTimes: TimeOfDay[]) {
    let placeholder = groupEl.querySelector<HTMLElement>(DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER);
    
    if (!hasHabits) {
        if (!placeholder) {
            // PERFORMANCE: Use template cloning for placeholder too
            placeholder = getPlaceholderTemplate().cloneNode(true) as HTMLElement;
            groupEl.appendChild(placeholder);
        }
        // Dirty Check
        if (placeholder.classList.contains('show-smart-placeholder') !== isSmartPlaceholder) {
            placeholder.classList.toggle('show-smart-placeholder', isSmartPlaceholder);
        }
        
        const text = t('dragToAddHabit');
        let iconHTML = '';

        if (isSmartPlaceholder) {
            const genericIconHTML = emptyTimes
                .map(getTimeOfDayIcon)
                .join('<span class="icon-separator">/</span>');
            const specificIconHTML = getTimeOfDayIcon(time);
            
            iconHTML = `
                <span class="placeholder-icon-generic">${genericIconHTML}</span>
                <span class="placeholder-icon-specific">${specificIconHTML}</span>
            `;
        } else {
            iconHTML = `<span class="placeholder-icon-specific">${getTimeOfDayIcon(time)}</span>`;
        }
        
        // PERFORMANCE: Verifica se o conteúdo HTML mudou antes de atribuir para evitar parsing.
        const newInner = `<div class="time-of-day-icon">${iconHTML}</span><span>${text}</span>`;
        if (placeholder.innerHTML !== newInner) {
            placeholder.innerHTML = newInner;
        }

    } else if (placeholder) {
        placeholder.remove();
    }
}

/**
 * Função Principal de Renderização da Lista.
 * Reconstrói a árvore de hábitos se necessário, reutilizando nós do cache.
 */
export function renderHabits() {
    // CRITICAL BUGFIX [2025-04-03]: Drag Locking.
    // Se o usuário estiver arrastando um item, bloqueamos qualquer re-renderização da lista.
    // Se permitirmos o re-render, o DOM do item arrastado pode ser reciclado ou removido,
    // cancelando o evento de arrasto nativo do navegador e causando bugs visuais/lógicos.
    if (document.body.classList.contains('is-dragging-active')) {
        return;
    }

    // PERFORMANCE: Dirty Check global. Se a estrutura da lista não mudou, aborta.
    if (!state.uiDirtyState.habitListStructure) {
        return;
    }

    // OTIMIZAÇÃO [2025-03-16]: Pre-Parse Date & Batch Fetch Data.
    // We parse the date ONCE and fetch the daily data ONCE for the entire render cycle.
    // This avoids redundant parsing and cache lookups inside loops (N habits * M invocations).
    const selectedDateObj = parseUTCIsoDate(state.selectedDate);
    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    
    // Pass pre-parsed date to selector to avoid re-parsing inside filter loop
    const activeHabitsData = getActiveHabitsForDate(state.selectedDate, selectedDateObj);
    
    // MEMORY OPTIMIZATION: Reset pool instead of creating new objects.
    habitsByTimePool.Morning.length = 0;
    habitsByTimePool.Afternoon.length = 0;
    habitsByTimePool.Evening.length = 0;
    
    const activeLen = activeHabitsData.length;
    // BCE Loop
    for (let i = 0; i < activeLen; i = (i + 1) | 0) {
        const { habit, schedule } = activeHabitsData[i];
        const schedLen = schedule.length;
        for (let j = 0; j < schedLen; j = (j + 1) | 0) {
            const time = schedule[j];
            if (habitsByTimePool[time]) {
                habitsByTimePool[time].push(habit);
            }
        }
    }

    // OTIMIZAÇÃO: Filtra diretamente para obter os horários vazios em uma única passagem.
    const emptyTimes = TIMES_OF_DAY.filter(time => habitsByTimePool[time].length === 0);
    const smartPlaceholderTargetTime: TimeOfDay | undefined = emptyTimes[0];

    // BCE Loop for Times of Day
    const timesLen = TIMES_OF_DAY.length;
    for (let i = 0; i < timesLen; i = (i + 1) | 0) {
        const time = TIMES_OF_DAY[i];
        
        // PERF: DOM Access via Cache O(1)
        const dom = getGroupDOM(time);
        if (!dom) continue; // Skip if UI not ready
        
        const { wrapper: wrapperEl, group: groupEl, marker } = dom;
        
        const desiredHabits = habitsByTimePool[time];
        const habitsLen = desiredHabits.length;
        const hasHabits = habitsLen > 0;

        // Toggle Marker Visibility
        if (hasHabits) {
            const iconHtml = getTimeOfDayIcon(time);
            // DOM Read/Write optimization: check first
            if (marker.innerHTML !== iconHtml) marker.innerHTML = iconHtml;
            if (marker.style.display !== '') marker.style.display = '';
            if (marker.style.opacity !== '1') marker.style.opacity = '1';
        } else {
            if (marker.style.display !== 'none') marker.style.display = 'none'; 
            if (marker.innerHTML !== '') marker.innerHTML = ''; 
        }

        const ariaLabel = getTimeOfDayName(time);
        if (groupEl.getAttribute('aria-label') !== ariaLabel) {
            groupEl.setAttribute('aria-label', ariaLabel);
        }

        let currentIndex = 0;

        // Reconciliação do DOM (Virtual DOM-lite)
        for (let h = 0; h < habitsLen; h = (h + 1) | 0) {
            const habit = desiredHabits[h];
            const key = `${habit.id}|${time}`;
            
            let card = habitElementCache.get(key);
            
            if (card) {
                // Reset states
                card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT, CSS_CLASSES.IS_SWIPING, CSS_CLASSES.DRAGGING);
                // Pass pre-fetched dailyInfo to avoid re-fetch
                updateHabitCardElement(card, habit, time, dailyInfo);
            } else {
                // UPDATE [2025-03-16]: Pass pre-fetched dailyInfo to card creation logic
                card = createHabitCardElement(habit, time, dailyInfo);
            }
            
            if (card) {
                const currentChildAtIndex = groupEl.children[currentIndex];
                // Move o nó apenas se estiver na posição errada
                if (currentChildAtIndex !== card) {
                    if (currentChildAtIndex) {
                        groupEl.insertBefore(card, currentChildAtIndex);
                    } else {
                        groupEl.appendChild(card);
                    }
                }
                currentIndex = (currentIndex + 1) | 0;
            }
        }

        // MEMORY LEAK FIX [2025-03-05]: Limpa os caches para elementos removidos do DOM.
        // Remove quaisquer filhos extras que não deveriam estar lá.
        while (groupEl.children.length > currentIndex) {
            const childToRemove = groupEl.lastChild as HTMLElement;
            if (childToRemove) {
                const habitId = childToRemove.dataset.habitId;
                const habitTime = childToRemove.dataset.time as TimeOfDay;

                if (habitId && habitTime) {
                    const cacheKey = `${habitId}|${habitTime}`;
                    
                    // FIX [2025-03-09]: Only remove from cache if the cached element is the one being removed.
                    // This prevents deleting the cache entry for a new card that has just been created
                    // (and has the same key) but is inserted before this cleanup runs.
                    if (habitElementCache.get(cacheKey) === childToRemove) {
                        habitElementCache.delete(cacheKey);
                    }
                    // WeakMap clears automatically
                }
                childToRemove.remove();
            }
        }
        
        const isSmartPlaceholder = time === smartPlaceholderTargetTime;
        
        // Batch Class Updates on Wrapper
        if (wrapperEl.classList.contains('has-habits') !== hasHabits) wrapperEl.classList.toggle('has-habits', hasHabits);
        
        const isCollapsible = !hasHabits && !isSmartPlaceholder;
        if (wrapperEl.classList.contains('is-collapsible') !== isCollapsible) wrapperEl.classList.toggle('is-collapsible', isCollapsible);

        updatePlaceholderForGroup(groupEl, time, hasHabits, isSmartPlaceholder, emptyTimes);
    }

    state.uiDirtyState.habitListStructure = false;
}
