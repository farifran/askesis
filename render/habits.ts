/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file render/habits.ts
 * @description Motor de Renderização de Cartões de Hábito (Virtual DOM-lite).
 */

import { state, Habit, HabitStatus, HabitDayData, STREAK_CONSOLIDATED, STREAK_SEMI_CONSOLIDATED, TimeOfDay, getHabitDailyInfoForDate, TIMES_OF_DAY, HabitDailyInfo } from '../state';
import { calculateHabitStreak, getActiveHabitsForDate, getSmartGoalForHabit, getHabitDisplayInfo } from '../services/selectors';
import { ui } from './ui';
import { t, getTimeOfDayName, formatInteger } from '../i18n';
import { UI_ICONS, getTimeOfDayIcon } from './icons';
import { setTextContent } from './dom';
import { CSS_CLASSES, DOM_SELECTORS } from './constants';
import { parseUTCIsoDate } from '../utils';

const habitElementCache = new Map<string, HTMLElement>();
const habitsByTimePool: Record<TimeOfDay, Habit[]> = { 'Morning': [], 'Afternoon': [], 'Evening': [] };
const groupDomCache = new Map<TimeOfDay, { wrapper: HTMLElement; group: HTMLElement; marker: HTMLElement }>();

type CardElements = {
    icon: HTMLElement; contentWrapper: HTMLElement; name: HTMLElement; subtitle: HTMLElement;
    details: HTMLElement; consolidationMsg: HTMLElement; noteBtn: HTMLElement; deleteBtn: HTMLElement;
    goal: HTMLElement; goalProgress?: HTMLElement; goalUnit?: HTMLElement;
    goalDecBtn?: HTMLButtonElement; goalIncBtn?: HTMLButtonElement; cachedIconHtml?: string;
};
const cardElementsCache = new WeakMap<HTMLElement, CardElements>();

function getGroupDOM(time: TimeOfDay) {
    let cached = groupDomCache.get(time);
    if (!cached && ui.habitContainer) {
        const wrapper = ui.habitContainer.querySelector<HTMLElement>(`.habit-group-wrapper[data-time-wrapper="${time}"]`);
        const group = wrapper?.querySelector<HTMLElement>(`.${CSS_CLASSES.HABIT_GROUP}[data-time="${time}"]`);
        const marker = wrapper?.querySelector<HTMLElement>('.time-marker');
        if (wrapper && group && marker) {
            cached = { wrapper, group, marker };
            groupDomCache.set(time, cached);
        }
    }
    return cached;
}

// TEMPLATES
let goalControlsTemplate: HTMLElement | null = null;
const statusTemplates: Record<string, HTMLElement> = {};
let habitCardTemplate: HTMLElement | null = null;
let placeholderTemplate: HTMLElement | null = null;

const getGoalControlsTemplate = () => goalControlsTemplate || (goalControlsTemplate = (() => {
    const div = document.createElement('div');
    div.className = CSS_CLASSES.HABIT_GOAL_CONTROLS;
    div.innerHTML = `<button type="button" class="${CSS_CLASSES.GOAL_CONTROL_BTN}" data-action="decrement">-</button><div class="${CSS_CLASSES.GOAL_VALUE_WRAPPER}"><div class="progress"></div><div class="unit"></div></div><button type="button" class="${CSS_CLASSES.GOAL_CONTROL_BTN}" data-action="increment">+</button>`;
    return div;
})());

const getStatusWrapperTemplate = (cls: string, icon: string) => statusTemplates[cls] || (statusTemplates[cls] = (() => {
    const w = document.createElement('div'); w.className = cls; w.innerHTML = icon; return w;
})());

const getPlaceholderTemplate = () => placeholderTemplate || (placeholderTemplate = (() => {
    const p = document.createElement('div'); p.className = CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER;
    p.setAttribute('role', 'button'); p.setAttribute('tabindex', '0'); return p;
})());

const getHabitCardTemplate = () => habitCardTemplate || (habitCardTemplate = (() => {
    const li = document.createElement('li'); li.className = CSS_CLASSES.HABIT_CARD;
    li.innerHTML = `<div class="habit-actions-left"><button type="button" class="${CSS_CLASSES.SWIPE_DELETE_BTN}">${UI_ICONS.swipeDelete}</button></div><div class="habit-actions-right"><button type="button" class="${CSS_CLASSES.SWIPE_NOTE_BTN}">${UI_ICONS.swipeNote}</button></div><div class="${CSS_CLASSES.HABIT_CONTENT_WRAPPER}" role="button" tabindex="0" draggable="true"><div class="habit-icon"></div><div class="${CSS_CLASSES.HABIT_DETAILS}"><div class="name"></div><div class="subtitle"></div><div class="consolidation-message" hidden></div></div><div class="habit-goal"></div><div class="ripple-container"></div></div>`;
    return li;
})());

export const clearHabitDomCache = () => habitElementCache.clear();
export const getCachedHabitCard = (id: string, t: TimeOfDay) => habitElementCache.get(`${id}|${t}`);

function _renderPendingGoalControls(habit: Habit, time: TimeOfDay, dayData: HabitDayData | undefined, els: CardElements) {
    if (habit.goal.type === 'check') { if (els.goal.hasChildNodes()) els.goal.replaceChildren(); return; }
    if (!els.goal.querySelector(`.${CSS_CLASSES.HABIT_GOAL_CONTROLS}`)) {
        els.goal.replaceChildren(getGoalControlsTemplate().cloneNode(true));
        els.goalDecBtn = els.goal.querySelector(`[data-action="decrement"]`) as HTMLButtonElement;
        els.goalIncBtn = els.goal.querySelector(`[data-action="increment"]`) as HTMLButtonElement;
        els.goalProgress = els.goal.querySelector('.progress') as HTMLElement;
        els.goalUnit = els.goal.querySelector('.unit') as HTMLElement;
    }
    const cur = dayData?.goalOverride ?? getSmartGoalForHabit(habit, state.selectedDate, time);
    els.goalDecBtn!.disabled = cur <= 1;
    setTextContent(els.goalProgress!, formatInteger(cur));
    setTextContent(els.goalUnit!, t(habit.goal.unitKey || 'unitCheck', { count: cur }));
}

export function updateHabitCardElement(card: HTMLElement, habit: Habit, time: TimeOfDay, preInfo?: Record<string, HabitDailyInfo>) {
    const els = cardElementsCache.get(card)!;
    const info = (preInfo || getHabitDailyInfoForDate(state.selectedDate))[habit.id]?.instances?.[time];
    const status = info?.status ?? CSS_CLASSES.PENDING;
    const streak = calculateHabitStreak(habit, state.selectedDate);
    const { name, subtitle } = getHabitDisplayInfo(habit, state.selectedDate);

    if (!card.classList.contains(status)) {
        card.classList.remove(CSS_CLASSES.PENDING, CSS_CLASSES.COMPLETED, CSS_CLASSES.SNOOZED);
        card.classList.add(status);
        if (status === CSS_CLASSES.COMPLETED) {
            els.icon.classList.remove('animate-pop'); void els.icon.offsetWidth; els.icon.classList.add('animate-pop');
        }
    }

    if (els.cachedIconHtml !== habit.icon) { els.icon.innerHTML = els.cachedIconHtml = habit.icon; }
    els.icon.style.color = habit.color; els.icon.style.backgroundColor = `${habit.color}30`;
    
    const isCons = streak >= STREAK_CONSOLIDATED, isSemi = streak >= STREAK_SEMI_CONSOLIDATED && !isCons;
    card.classList.toggle('consolidated', isCons); card.classList.toggle('semi-consolidated', isSemi);
    
    setTextContent(els.name, name); setTextContent(els.subtitle, subtitle);
    const msg = isCons ? t('habitConsolidatedMessage') : (isSemi ? t('habitSemiConsolidatedMessage') : '');
    setTextContent(els.consolidationMsg, msg); els.consolidationMsg.hidden = !msg;

    const hasN = !!info?.note;
    if (els.noteBtn.dataset.hasNote !== String(hasN)) {
        els.noteBtn.innerHTML = hasN ? UI_ICONS.swipeNoteHasNote : UI_ICONS.swipeNote;
        els.noteBtn.dataset.hasNote = String(hasN);
    }

    if (status === 'completed') els.goal.replaceChildren(getStatusWrapperTemplate('completed-wrapper', UI_ICONS.check).cloneNode(true));
    else if (status === 'snoozed') els.goal.replaceChildren(getStatusWrapperTemplate('snoozed-wrapper', UI_ICONS.snoozed).cloneNode(true));
    else _renderPendingGoalControls(habit, time, info, els);
}

export function createHabitCardElement(habit: Habit, time: TimeOfDay, preInfo?: Record<string, HabitDailyInfo>): HTMLElement {
    const card = getHabitCardTemplate().cloneNode(true) as HTMLElement;
    card.dataset.habitId = habit.id; card.dataset.time = time;
    habitElementCache.set(`${habit.id}|${time}`, card);

    const al = card.firstElementChild!, ar = al.nextElementSibling!, cw = ar.nextElementSibling!;
    const det = cw.children[1] as HTMLElement, goal = cw.children[2] as HTMLElement;
    cardElementsCache.set(card, {
        icon: cw.children[0] as HTMLElement, contentWrapper: cw as HTMLElement,
        name: det.children[0] as HTMLElement, subtitle: det.children[1] as HTMLElement,
        details: det, consolidationMsg: det.children[2] as HTMLElement,
        noteBtn: ar.firstElementChild as HTMLElement, deleteBtn: al.firstElementChild as HTMLElement, goal
    });
    updateHabitCardElement(card, habit, time, preInfo);
    return card;
}

export function renderHabits() {
    if (document.body.classList.contains('is-interaction-active') || !state.uiDirtyState.habitListStructure) return;
    const selDate = parseUTCIsoDate(state.selectedDate), dInfo = getHabitDailyInfoForDate(state.selectedDate);
    const active = getActiveHabitsForDate(state.selectedDate, selDate);
    
    TIMES_OF_DAY.forEach(t => habitsByTimePool[t].length = 0);
    for (let i = 0; i < active.length; i++) {
        const { habit, schedule } = active[i];
        for (let j = 0; j < schedule.length; j++) habitsByTimePool[schedule[j]].push(habit);
    }

    const empty = TIMES_OF_DAY.filter(t => habitsByTimePool[t].length === 0);
    TIMES_OF_DAY.forEach(time => {
        const dom = getGroupDOM(time); if (!dom) return;
        const habits = habitsByTimePool[time], hasH = habits.length > 0;
        dom.marker.style.display = hasH ? '' : 'none';
        if (hasH) dom.marker.innerHTML = getTimeOfDayIcon(time);

        let curIdx = 0;
        for (let h = 0; h < habits.length; h++) {
            const habit = habits[h], key = `${habit.id}|${time}`;
            let card = habitElementCache.get(key);
            if (card) {
                card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT, CSS_CLASSES.IS_SWIPING, CSS_CLASSES.DRAGGING);
                updateHabitCardElement(card, habit, time, dInfo);
            } else card = createHabitCardElement(habit, time, dInfo);
            
            if (dom.group.children[curIdx] !== card) dom.group.insertBefore(card, dom.group.children[curIdx] || null);
            curIdx++;
        }
        while (dom.group.children.length > curIdx) {
            const rem = dom.group.lastChild as HTMLElement;
            if (rem.dataset?.habitId) habitElementCache.delete(`${rem.dataset.habitId}|${rem.dataset.time}`);
            rem.remove();
        }

        const isSmart = time === empty[0];
        dom.wrapper.classList.toggle('has-habits', hasH);
        dom.wrapper.classList.toggle('is-collapsible', !hasH && !isSmart);

        let ph = dom.group.querySelector<HTMLElement>(DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER);
        if (!hasH) {
            if (!ph) { ph = getPlaceholderTemplate().cloneNode(true) as HTMLElement; dom.group.appendChild(ph); }
            ph.classList.toggle('show-smart-placeholder', isSmart);
            const iconHtml = isSmart ? `<span class="placeholder-icon-generic">${empty.map(getTimeOfDayIcon).join('<span class="icon-separator">/</span>')}</span><span class="placeholder-icon-specific">${getTimeOfDayIcon(time)}</span>` : `<span class="placeholder-icon-specific">${getTimeOfDayIcon(time)}</span>`;
            ph.innerHTML = `<div class="time-of-day-icon">${iconHtml}</div><span class="placeholder-arrow">→</span><span>${t('dragToAddHabit')}</span>`;
        } else ph?.remove();
    });
    state.uiDirtyState.habitListStructure = false;
}