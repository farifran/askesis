/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, Habit, HabitStatus, HabitDayData, getSmartGoalForHabit, calculateHabitStreak, STREAK_CONSOLIDATED, STREAK_SEMI_CONSOLIDATED, TimeOfDay, getHabitDailyInfoForDate, getActiveHabitsForDate, TIMES_OF_DAY } from '../state';
import { ui } from './ui';
import { t, getHabitDisplayInfo, getTimeOfDayName } from '../i18n';
import { icons, getTimeOfDayIcon } from './icons';
import { setTextContent } from './dom';
import { CSS_CLASSES, DOM_SELECTORS } from './constants'; // TYPE SAFETY IMPORT

// OTIMIZAÇÃO [2025-01-24]: Cache persistente para cartões de hábitos.
const habitElementCache = new Map<string, HTMLElement>();

// PERFORMANCE [2025-03-05]: Cache para referências de elementos internos dos cartões.
type CardElements = {
    icon: HTMLElement;
    contentWrapper: HTMLElement;
    name: HTMLElement;
    subtitle: HTMLElement;
    details: HTMLElement;
    noteBtn: HTMLElement;
    goal: HTMLElement;
};
const cardElementsCache = new Map<HTMLElement, CardElements>();

// MEMORY OPTIMIZATION [2025-03-04]: Object Pool para agrupamento de hábitos.
// Evita a criação de novos arrays (alocação de memória) a cada frame de renderização.
// Apenas limpamos (.length = 0) e reutilizamos os arrays existentes.
const habitsByTimePool: Record<TimeOfDay, Habit[]> = { 'Morning': [], 'Afternoon': [], 'Evening': [] };

export function getCachedHabitCard(habitId: string, time: TimeOfDay): HTMLElement | undefined {
    return habitElementCache.get(`${habitId}|${time}`);
}

export function removeHabitFromCache(habitId: string) {
    for (const key of habitElementCache.keys()) {
        if (key.startsWith(`${habitId}|`)) {
            const el = habitElementCache.get(key);
            if (el) {
                cardElementsCache.delete(el); // Limpa o cache de elementos internos
                el.remove(); // Garante remoção do DOM
            }
            habitElementCache.delete(key);
        }
    }
}

export const getUnitString = (habit: Habit, value: number | undefined) => {
    const unitKey = habit.goal.unitKey || 'unitCheck';
    return t(unitKey, { count: value });
};

export const formatGoalForDisplay = (goal: number): string => {
    if (goal < 5) return '< 5';
    if (goal > 95) return '> 95';
    return goal.toString();
};

function _renderCompletedGoal(goalEl: HTMLElement) {
    if (goalEl.querySelector('.completed-wrapper')) return;

    goalEl.replaceChildren();
    
    const wrapper = document.createElement('div');
    wrapper.className = 'completed-wrapper';
    wrapper.innerHTML = icons.check;
    
    goalEl.appendChild(wrapper);
}

function _renderSnoozedGoal(goalEl: HTMLElement) {
    if (goalEl.querySelector('.snoozed-wrapper')) return;

    goalEl.replaceChildren();
    
    const wrapper = document.createElement('div');
    wrapper.className = 'snoozed-wrapper';
    wrapper.innerHTML = icons.snoozed;
    
    goalEl.appendChild(wrapper);
}

function _renderPendingGoalControls(goalEl: HTMLElement, habit: Habit, time: TimeOfDay, dayDataForInstance: HabitDayData | undefined) {
    const hasNumericGoal = habit.goal.type === 'pages' || habit.goal.type === 'minutes';

    if (hasNumericGoal) {
        const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
        const currentGoal = dayDataForInstance?.goalOverride ?? smartGoal;
        const displayVal = formatGoalForDisplay(currentGoal);
        const unitVal = getUnitString(habit, currentGoal);

        let controls = goalEl.querySelector(`.${CSS_CLASSES.HABIT_GOAL_CONTROLS}`);
        
        if (!controls) {
            goalEl.replaceChildren();
            controls = document.createElement('div');
            controls.className = CSS_CLASSES.HABIT_GOAL_CONTROLS;
            
            const decBtn = document.createElement('button');
            decBtn.type = 'button';
            decBtn.className = CSS_CLASSES.GOAL_CONTROL_BTN;
            decBtn.dataset.habitId = habit.id;
            decBtn.dataset.time = time;
            decBtn.dataset.action = 'decrement';
            decBtn.setAttribute('aria-label', t('habitGoalDecrement_ariaLabel'));
            decBtn.textContent = '-';
            
            const valWrapper = document.createElement('div');
            valWrapper.className = CSS_CLASSES.GOAL_VALUE_WRAPPER;
            
            const progDiv = document.createElement('div');
            progDiv.className = 'progress';
            
            const unitDiv = document.createElement('div');
            unitDiv.className = 'unit';
            
            valWrapper.append(progDiv, unitDiv);
            
            const incBtn = document.createElement('button');
            incBtn.type = 'button';
            incBtn.className = CSS_CLASSES.GOAL_CONTROL_BTN;
            incBtn.dataset.habitId = habit.id;
            incBtn.dataset.time = time;
            incBtn.dataset.action = 'increment';
            incBtn.setAttribute('aria-label', t('habitGoalIncrement_ariaLabel'));
            incBtn.textContent = '+';
            
            controls.append(decBtn, valWrapper, incBtn);
            goalEl.appendChild(controls);
        }

        const prog = controls.querySelector('.progress');
        const unit = controls.querySelector('.unit');
        setTextContent(prog, displayVal);
        setTextContent(unit, unitVal);
        
        const decBtn = controls.querySelector<HTMLButtonElement>(`.${CSS_CLASSES.GOAL_CONTROL_BTN}[data-action="decrement"]`);
        if (decBtn) {
            decBtn.disabled = currentGoal <= 1;
        }
    } else {
        if (goalEl.hasChildNodes()) goalEl.replaceChildren();
    }
}

export function updateGoalContentElement(goalEl: HTMLElement, status: HabitStatus, habit: Habit, time: TimeOfDay, dayDataForInstance: HabitDayData | undefined) {
    switch(status) {
        case 'completed':
            _renderCompletedGoal(goalEl);
            break;
        case 'snoozed':
            _renderSnoozedGoal(goalEl);
            break;
        case 'pending':
            _renderPendingGoalControls(goalEl, habit, time, dayDataForInstance);
            break;
    }
}

export function _updateConsolidationMessage(detailsEl: HTMLElement, streak: number) {
    let msgEl = detailsEl.querySelector<HTMLElement>('.consolidation-message');

    let messageText: string | null = null;
    if (streak >= STREAK_CONSOLIDATED) {
        messageText = t('habitConsolidatedMessage');
    } else if (streak >= STREAK_SEMI_CONSOLIDATED) {
        messageText = t('habitSemiConsolidatedMessage');
    }

    if (messageText) {
        if (!msgEl) {
            msgEl = document.createElement('div');
            msgEl.className = 'consolidation-message';
            detailsEl.appendChild(msgEl);
        }
        setTextContent(msgEl, messageText);
    } else if (msgEl) {
        msgEl.remove();
    }
}

export function updateHabitCardElement(card: HTMLElement, habit: Habit, time: TimeOfDay): void {
    const elements = cardElementsCache.get(card);
    if (!elements) {
        console.warn(`Cache miss for habit card elements: ${habit.id}|${time}. This should not happen.`);
        return; 
    }
    
    const { icon, contentWrapper, name: nameEl, subtitle: subtitleEl, details: detailsEl, noteBtn, goal: goalEl } = elements;
    
    const dailyInfo = getHabitDailyInfoForDate(state.selectedDate);
    const habitInstanceData = dailyInfo[habit.id]?.instances?.[time];
    const status = habitInstanceData?.status ?? CSS_CLASSES.PENDING;
    const hasNote = habitInstanceData?.note && habitInstanceData.note.length > 0;
    const streak = calculateHabitStreak(habit.id, state.selectedDate);
    const { name, subtitle } = getHabitDisplayInfo(habit, state.selectedDate);

    const wasCompleted = card.classList.contains(CSS_CLASSES.COMPLETED);
    if (!card.classList.contains(status)) {
        card.classList.remove(CSS_CLASSES.PENDING, CSS_CLASSES.COMPLETED, CSS_CLASSES.SNOOZED);
        card.classList.add(status);
    }

    const isCompleted = status === CSS_CLASSES.COMPLETED;
    
    const newIconHtml = habit.icon;
    const newColor = habit.color;
    const newBgColor = `${habit.color}30`;

    if ((icon as any)._cachedIconHtml !== newIconHtml) {
        icon.innerHTML = newIconHtml;
        (icon as any)._cachedIconHtml = newIconHtml;
    }
    
    if (icon.style.color !== newColor) icon.style.color = newColor;
    if (icon.style.backgroundColor !== newBgColor) icon.style.backgroundColor = newBgColor;

    if (!wasCompleted && isCompleted) {
        icon.classList.remove('animate-pop');
        void icon.offsetWidth;
        icon.classList.add('animate-pop');
        icon.addEventListener('animationend', () => icon.classList.remove('animate-pop'), { once: true });
    }

    const isConsolidated = streak >= STREAK_CONSOLIDATED;
    const isSemi = streak >= STREAK_SEMI_CONSOLIDATED && !isConsolidated;
    
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

    _updateConsolidationMessage(detailsEl, streak);
    
    const hasNoteStr = String(hasNote);
    if (noteBtn.dataset.hasNote !== hasNoteStr) {
        noteBtn.innerHTML = hasNote ? icons.swipeNoteHasNote : icons.swipeNote;
        noteBtn.setAttribute('aria-label', t(hasNote ? 'habitNoteEdit_ariaLabel' : 'habitNoteAdd_ariaLabel'));
        noteBtn.dataset.hasNote = hasNoteStr;
    }

    updateGoalContentElement(goalEl, status, habit, time, habitInstanceData);
}

/**
 * SURGICAL UPDATE: Atualiza apenas o cartão de hábito especificado no DOM.
 */
export function renderHabitCardState(habitId: string, time: TimeOfDay) {
    const card = getCachedHabitCard(habitId, time);
    const habit = state.habits.find(h => h.id === habitId);
    
    if (card && habit) {
        updateHabitCardElement(card, habit, time);
    }
}

export function createHabitCardElement(habit: Habit, time: TimeOfDay): HTMLElement {
    // REFACTOR [2025-03-05]: Pure Skeleton Factory.
    // Removes redundant logic by building only the DOM structure and delegating
    // all data population (status, text, classes) to updateHabitCardElement.
    
    const card = document.createElement('li');
    card.className = CSS_CLASSES.HABIT_CARD; 
    card.dataset.habitId = habit.id;
    card.dataset.time = time;

    const actionsLeft = document.createElement('div');
    actionsLeft.className = 'habit-actions-left';
    actionsLeft.innerHTML = `<button type="button" class="${CSS_CLASSES.SWIPE_DELETE_BTN}" aria-label="${t('habitEnd_ariaLabel')}">${icons.swipeDelete}</button>`;

    const actionsRight = document.createElement('div');
    actionsRight.className = 'habit-actions-right';
    actionsRight.innerHTML = `<button type="button" class="${CSS_CLASSES.SWIPE_NOTE_BTN}">${icons.swipeNote}</button>`;
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = CSS_CLASSES.HABIT_CONTENT_WRAPPER;
    contentWrapper.draggable = true;
    
    contentWrapper.setAttribute('role', 'button');
    contentWrapper.setAttribute('tabindex', '0');

    const icon = document.createElement('div');
    icon.className = 'habit-icon';

    const details = document.createElement('div');
    details.className = CSS_CLASSES.HABIT_DETAILS;
    
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'subtitle';
    
    details.append(nameEl, subtitleEl);

    const goal = document.createElement('div');
    goal.className = 'habit-goal';

    contentWrapper.append(icon, details, goal);
    card.append(actionsLeft, actionsRight, contentWrapper);
    
    habitElementCache.set(`${habit.id}|${time}`, card);

    // PERFORMANCE [2025-03-05]: Cache internal element references ONCE at creation.
    cardElementsCache.set(card, {
        icon: icon,
        contentWrapper: contentWrapper,
        name: nameEl,
        subtitle: subtitleEl,
        details: details,
        noteBtn: actionsRight.querySelector(`.${CSS_CLASSES.SWIPE_NOTE_BTN}`)!,
        goal: goal,
    });

    // DELEGATION: Populate data immediately using cached elements.
    updateHabitCardElement(card, habit, time);

    return card;
}

export function updatePlaceholderForGroup(groupEl: HTMLElement, time: TimeOfDay, hasHabits: boolean, isSmartPlaceholder: boolean, emptyTimes: TimeOfDay[]) {
    let placeholder = groupEl.querySelector<HTMLElement>(DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER);
    
    if (!hasHabits) {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER;
            placeholder.setAttribute('role', 'button');
            placeholder.setAttribute('tabindex', '0');
            groupEl.appendChild(placeholder);
        }
        placeholder.classList.toggle('show-smart-placeholder', isSmartPlaceholder);
        
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
        
        placeholder.innerHTML = `<div class="time-of-day-icon">${iconHTML}</div><span>${text}</span>`;

    } else if (placeholder) {
        placeholder.remove();
    }
}

export function renderHabits() {
    if (!state.uiDirtyState.habitListStructure) {
        return;
    }

    const activeHabitsData = getActiveHabitsForDate(state.selectedDate);
    
    // MEMORY OPTIMIZATION: Reset pool instead of creating new objects.
    habitsByTimePool.Morning.length = 0;
    habitsByTimePool.Afternoon.length = 0;
    habitsByTimePool.Evening.length = 0;
    
    activeHabitsData.forEach(({ habit, schedule }) => {
        schedule.forEach(time => {
            if (habitsByTimePool[time]) {
                habitsByTimePool[time].push(habit);
            }
        });
    });

    // OTIMIZAÇÃO: Filtra diretamente para obter os horários vazios em uma única passagem.
    const emptyTimes = TIMES_OF_DAY.filter(time => habitsByTimePool[time].length === 0);
    const smartPlaceholderTargetTime: TimeOfDay | undefined = emptyTimes[0];

    TIMES_OF_DAY.forEach(time => {
        const wrapperEl = ui.habitContainer.querySelector(`.habit-group-wrapper[data-time-wrapper="${time}"]`);
        const groupEl = wrapperEl?.querySelector<HTMLElement>(`.${CSS_CLASSES.HABIT_GROUP}[data-time="${time}"]`);
        if (!wrapperEl || !groupEl) return;
        
        const desiredHabits = habitsByTimePool[time];
        const hasHabits = desiredHabits.length > 0;

        const marker = wrapperEl.querySelector('.time-marker') as HTMLElement;
        if (marker) {
            if (hasHabits) {
                marker.innerHTML = getTimeOfDayIcon(time);
                marker.style.display = '';
                marker.style.opacity = '1';
            } else {
                marker.style.display = 'none'; 
                marker.innerHTML = ''; 
            }
        }

        groupEl.setAttribute('aria-label', getTimeOfDayName(time));

        const processedHabitIds = new Set<string>();
        let currentIndex = 0;

        desiredHabits.forEach(habit => {
            if (processedHabitIds.has(habit.id)) return; 
            processedHabitIds.add(habit.id);

            const key = `${habit.id}|${time}`;
            
            let card = habitElementCache.get(key);
            
            if (card) {
                card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT, CSS_CLASSES.IS_SWIPING, CSS_CLASSES.DRAGGING);
                updateHabitCardElement(card, habit, time);
            } else {
                card = createHabitCardElement(habit, time);
            }
            
            if (card) {
                const currentChildAtIndex = groupEl.children[currentIndex];
                if (currentChildAtIndex !== card) {
                    if (currentChildAtIndex) {
                        groupEl.insertBefore(card, currentChildAtIndex);
                    } else {
                        groupEl.appendChild(card);
                    }
                }
                currentIndex++;
            }
        });

        while (groupEl.children.length > currentIndex) {
            groupEl.lastChild?.remove();
        }
        
        const isSmartPlaceholder = time === smartPlaceholderTargetTime;
        
        wrapperEl.classList.toggle('has-habits', hasHabits);
        wrapperEl.classList.toggle('is-collapsible', !hasHabits && !isSmartPlaceholder);

        updatePlaceholderForGroup(groupEl, time, hasHabits, isSmartPlaceholder, emptyTimes);
    });

    state.uiDirtyState.habitListStructure = false;
}