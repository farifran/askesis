
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/cards.ts
 * @description Controlador de Interação de Itens da Lista (Cartões de Hábito).
 */

import { ui } from '../render/ui';
import { state, TimeOfDay, getNextStatus, HabitStatus } from '../state';
import { getCurrentGoalForInstance, getEffectiveScheduleForHabitOnDate } from '../services/selectors';
import { openNotesModal, renderExploreHabits, openModal } from '../render';
import { toggleHabitStatus, setGoalOverride, requestHabitTimeRemoval, requestHabitEndingFromModal } from '../habitActions';
import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

const GOAL_STEP = 5, MAX_GOAL = 9999;
const SELECTOR = `${DOM_SELECTORS.HABIT_CONTENT_WRAPPER}, ${DOM_SELECTORS.GOAL_CONTROL_BTN}, ${DOM_SELECTORS.GOAL_VALUE_WRAPPER}, ${DOM_SELECTORS.SWIPE_DELETE_BTN}, ${DOM_SELECTORS.SWIPE_NOTE_BTN}, ${DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER}`;

// PERFORMANCE: Reduzido de 250ms para 200ms para maior responsividade tátil.
const StatusDebouncer = { timer: 0, counts: new Map<string, number>() };

/**
 * Cria o efeito visual de ripple (onda) na posição do clique.
 */
const createRipple = (e: MouseEvent, container: HTMLElement) => {
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    
    const rect = container.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    
    container.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
};

const _handleContainerClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(SELECTOR);
    if (!el) return;

    if (el.classList.contains(CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER)) {
        triggerHaptic('light'); renderExploreHabits(); openModal(ui.exploreModal); return;
    }

    const card = el.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
    const { habitId: hId, time } = card?.dataset || {};
    if (!hId || !time) return;
    const t = time as TimeOfDay;

    if (el.classList.contains(CSS_CLASSES.SWIPE_DELETE_BTN)) {
        const h = state.habits.find(x => x.id === hId);
        if (h && getEffectiveScheduleForHabitOnDate(h, state.selectedDate).length <= 1) requestHabitEndingFromModal(hId);
        else requestHabitTimeRemoval(hId, t);
        return;
    }

    if (el.classList.contains(CSS_CLASSES.SWIPE_NOTE_BTN)) {
        triggerHaptic('light'); openNotesModal(hId, state.selectedDate, t); return;
    }

    if (el.classList.contains(CSS_CLASSES.GOAL_CONTROL_BTN)) {
        e.stopPropagation();
        const habit = state.habits.find(h => h.id === hId);
        if (!habit) return;
        const act = el.dataset.action, cur = getCurrentGoalForInstance(habit, state.selectedDate, t);
        const next = act === 'increment' ? Math.min(MAX_GOAL, cur + GOAL_STEP) : Math.max(1, cur - GOAL_STEP);
        setGoalOverride(hId, state.selectedDate, t, next);
        triggerHaptic('light'); return;
    }

    if (el.classList.contains(CSS_CLASSES.HABIT_CONTENT_WRAPPER)) {
        if (card!.classList.contains(CSS_CLASSES.IS_OPEN_LEFT) || card!.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT)) {
            card!.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT); return;
        }

        // --- EFEITO VISUAL RIPPLE ---
        const rippleContainer = el.querySelector('.ripple-container') as HTMLElement;
        if (rippleContainer) {
            createRipple(e, rippleContainer);
        }

        // --- UI OTIMISTA (Feedback Instantâneo) ---
        const currentStatus: HabitStatus = card!.classList.contains(CSS_CLASSES.COMPLETED) ? 'completed' : 
                                          (card!.classList.contains(CSS_CLASSES.SNOOZED) ? 'snoozed' : 'pending');
        
        const nextStatus = getNextStatus(currentStatus);
        
        requestAnimationFrame(() => {
            card!.classList.remove(CSS_CLASSES.PENDING, CSS_CLASSES.COMPLETED, CSS_CLASSES.SNOOZED);
            card!.classList.add(nextStatus);
            
            if (nextStatus === 'completed') {
                const icon = card!.querySelector('.habit-icon');
                if (icon) {
                    icon.classList.remove('animate-pop');
                    void (icon as HTMLElement).offsetWidth; // Force Reflow
                    icon.classList.add('animate-pop');
                }
            }
        });

        const key = `${hId}|${t}`, count = (StatusDebouncer.counts.get(key) || 0) + 1;
        StatusDebouncer.counts.set(key, count);
        triggerHaptic('light');

        if (StatusDebouncer.timer) clearTimeout(StatusDebouncer.timer);
        StatusDebouncer.timer = window.setTimeout(() => {
            StatusDebouncer.counts.forEach((c, k) => {
                const [id, tm] = k.split('|');
                const rotations = c % 3;
                for(let i=0; i < rotations; i++) {
                    toggleHabitStatus(id, tm as TimeOfDay, state.selectedDate);
                }
            });
            StatusDebouncer.counts.clear();
        }, 200);
    }
};

export function setupCardListeners() {
    ui.habitContainer.addEventListener('click', _handleContainerClick);
}
