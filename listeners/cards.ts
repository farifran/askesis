
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from '../render/ui';
import { state, Habit, TimeOfDay } from '../state';
import { getCurrentGoalForInstance } from '../services/selectors';
import { openNotesModal, renderExploreHabits, openModal } from '../render';
import {
    toggleHabitStatus,
    setGoalOverride,
    requestHabitTimeRemoval,
} from '../habitActions';
import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

const GOAL_STEP = 5;

// Pre-computed selector for single-pass delegation
// Matches any interactive element we care about within the habit container
const INTERACTIVE_SELECTOR = `${DOM_SELECTORS.HABIT_CONTENT_WRAPPER}, ${DOM_SELECTORS.GOAL_CONTROL_BTN}, ${DOM_SELECTORS.GOAL_VALUE_WRAPPER}, ${DOM_SELECTORS.SWIPE_DELETE_BTN}, ${DOM_SELECTORS.SWIPE_NOTE_BTN}, ${DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER}`;

function createGoalInput(habit: Habit, time: TimeOfDay, wrapper: HTMLElement) {
    if (wrapper.querySelector('input')) return; // Já está no modo de edição

    const originalContent = wrapper.innerHTML;
    const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
    
    wrapper.innerHTML = `<input type="number" class="goal-input-inline" value="${currentGoal}" min="1" step="1" inputmode="numeric" pattern="[0-9]*" />`;
    const input = wrapper.querySelector('input')!;
    input.focus();
    input.select();

    const cleanupListeners = () => {
        input.removeEventListener('blur', onBlur);
        input.removeEventListener('keydown', onKeyDown);
    };

    const restoreOriginalContent = () => {
        cleanupListeners();
        wrapper.innerHTML = originalContent;
    };

    const save = () => {
        const newGoal = parseInt(input.value, 10);
        
        if (!isNaN(newGoal) && newGoal > 0) {
            // PERFORMANCE [2025-03-16]: Skip restoreOriginalContent().
            // setGoalOverride triggers a full app render which will update this wrapper's HTML 
            // with the new value immediately. Restoring old content first causes 
            // Layout Thrashing (Write -> Read -> Write).
            cleanupListeners();
            
            setGoalOverride(habit.id, state.selectedDate, time, newGoal);
            triggerHaptic('success');

            // Reuse 'wrapper' reference directly
            requestAnimationFrame(() => {
                wrapper.classList.add('increase');
                wrapper.addEventListener('animationend', () => wrapper.classList.remove('increase'), { once: true });
            });
            
            // A11Y FIX: Restore focus efficiently.
            // We use closest() here only on success, which is rare compared to reads.
            const card = wrapper.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
            const content = card?.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
            content?.focus();
        } else {
            // Invalid input: restore previous state
            restoreOriginalContent();
        }
    };

    const onBlur = () => save();
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur(); 
        } else if (e.key === 'Escape') {
            restoreOriginalContent();
            // A11Y: Restore focus on cancel
            const card = wrapper.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
            const content = card?.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
            content?.focus();
        }
    };
    
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKeyDown);
}

export function setupCardListeners() {
    ui.habitContainer.addEventListener('keydown', e => {
        const card = (e.target as HTMLElement).closest(DOM_SELECTORS.HABIT_CARD);
        if (!card) return;
        
        if (!e.target || !(e.target as HTMLElement).classList.contains(CSS_CLASSES.HABIT_CONTENT_WRAPPER)) return;

        if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT)) {
                card.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
            } else {
                card.classList.toggle(CSS_CLASSES.IS_OPEN_LEFT);
            }
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT)) {
                card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
            } else {
                card.classList.toggle(CSS_CLASSES.IS_OPEN_RIGHT);
            }
        } else if (e.key === 'Escape') {
            if (card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT) || card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT)) {
                e.preventDefault();
                card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
            }
        }
    });

    ui.habitContainer.addEventListener('click', e => {
        const target = e.target as HTMLElement;

        // ADVANCED OPTIMIZATION [2025-03-18]: Single-Pass Delegation.
        // Instead of calling .closest() multiple times for every possible button/wrapper,
        // we call it ONCE for a combined selector of all interactive elements.
        // This reduces DOM traversal complexity from O(Depth * Selectors) to O(Depth).
        const interactiveElement = target.closest(INTERACTIVE_SELECTOR) as HTMLElement;
        
        if (!interactiveElement) return;

        // --- PLACEHOLDER ---
        if (interactiveElement.classList.contains(CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER)) {
            triggerHaptic('light');
            renderExploreHabits();
            openModal(ui.exploreModal);
            return;
        }

        // All other interactions require a habit card context
        const card = interactiveElement.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!card) return;

        const habitId = card.dataset.habitId;
        const time = card.dataset.time as TimeOfDay | undefined;
        if (!habitId || !time) return;

        // --- SWIPE ACTIONS ---
        if (interactiveElement.classList.contains(CSS_CLASSES.SWIPE_DELETE_BTN)) {
            triggerHaptic('medium');
            requestHabitTimeRemoval(habitId, time);
            return;
        }

        if (interactiveElement.classList.contains(CSS_CLASSES.SWIPE_NOTE_BTN)) {
            triggerHaptic('light');
            openNotesModal(habitId, state.selectedDate, time);
            return;
        }

        // --- GOAL CONTROLS ---
        if (interactiveElement.classList.contains(CSS_CLASSES.GOAL_CONTROL_BTN)) {
            e.stopPropagation(); 
            
            const habit = state.habits.find(h => h.id === habitId);
            if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;
            
            const action = interactiveElement.dataset.action as 'increment' | 'decrement';
            
            triggerHaptic('light');
            const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
            const newGoal = (action === 'increment') 
                ? currentGoal + GOAL_STEP 
                : Math.max(1, currentGoal - GOAL_STEP);

            setGoalOverride(habitId, state.selectedDate, time, newGoal);
            
            // DOM OPTIMIZATION [2025-03-09]: Optimized lookup using sibling traversal.
            const goalWrapper = interactiveElement.parentElement?.querySelector<HTMLElement>(DOM_SELECTORS.GOAL_VALUE_WRAPPER);
            
            if (goalWrapper) {
                const animationClass = action === 'increment' ? 'increase' : 'decrease';
                goalWrapper.classList.remove('increase', 'decrease');
                requestAnimationFrame(() => {
                    goalWrapper.classList.add(animationClass);
                    goalWrapper.addEventListener('animationend', () => {
                        goalWrapper.classList.remove(animationClass);
                    }, { once: true });
                });
            }
            return;
        }

        if (interactiveElement.classList.contains(CSS_CLASSES.GOAL_VALUE_WRAPPER)) {
            e.stopPropagation();
            triggerHaptic('light');
            const habit = state.habits.find(h => h.id === habitId);
            if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
                createGoalInput(habit, time, interactiveElement);
            }
            return;
        }

        // --- MAIN CARD CONTENT ---
        if (interactiveElement.classList.contains(CSS_CLASSES.HABIT_CONTENT_WRAPPER)) {
            const isOpen = card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT) || card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT);
            
            if (isOpen) {
                card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
                return;
            }

            const currentStatus = card.classList.contains(CSS_CLASSES.COMPLETED) ? 'completed' : (card.classList.contains(CSS_CLASSES.SNOOZED) ? 'snoozed' : 'pending');
            
            if (currentStatus === 'pending') {
                triggerHaptic('success');
            } else {
                triggerHaptic('light');
            }
            
            toggleHabitStatus(habitId, time, state.selectedDate);
        }
    });
}
