
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from '../render/ui';
import { state, Habit, getCurrentGoalForInstance, TimeOfDay } from '../state';
import { openNotesModal, getUnitString, formatGoalForDisplay, renderExploreHabits, openModal } from '../render';
import {
    toggleHabitStatus,
    setGoalOverride,
    requestHabitTimeRemoval,
} from '../habitActions';
import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { t } from '../i18n';

const GOAL_STEP = 5;

/**
 * REATORAÇÃO [2024-09-11]: Centraliza a lógica de atualização da UI da meta para evitar duplicação.
 */
function _updateGoalDisplay(wrapperEl: HTMLElement, habit: Habit, newGoal: number) {
    const progressEl = wrapperEl.querySelector<HTMLElement>('.progress');
    const unitEl = wrapperEl.querySelector<HTMLElement>('.unit');
    if (progressEl && unitEl) {
        progressEl.textContent = formatGoalForDisplay(newGoal);
        unitEl.textContent = getUnitString(habit, newGoal);
    }
    
    // UX FIX [2025-02-05]: Update decrement button state based on value
    const controls = wrapperEl.closest(DOM_SELECTORS.HABIT_GOAL_CONTROLS);
    const decBtn = controls?.querySelector<HTMLButtonElement>(`${DOM_SELECTORS.GOAL_CONTROL_BTN}[data-action="decrement"]`);
    if (decBtn) {
        decBtn.disabled = newGoal <= 1;
    }
}


function createGoalInput(habit: Habit, time: TimeOfDay, wrapper: HTMLElement) {
    const controls = wrapper.closest(DOM_SELECTORS.HABIT_GOAL_CONTROLS);
    if (controls?.querySelector('input')) return; // Já está no modo de edição

    const habitId = habit.id;
    const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);

    const originalContent = wrapper.innerHTML;
    
    // UX IMPROVEMENT [2025-01-16]: Adicionado inputmode="numeric" e pattern="[0-9]*"
    wrapper.innerHTML = `<input type="number" class="goal-input-inline" value="${currentGoal}" min="1" step="1" inputmode="numeric" pattern="[0-9]*" />`;
    const input = wrapper.querySelector('input')!;
    input.focus();
    input.select();

    const cleanup = () => {
        input.removeEventListener('blur', onBlur);
        input.removeEventListener('keydown', onKeyDown);
    };

    const save = () => {
        const newGoal = parseInt(input.value, 10);
        cleanup(); // Limpa listeners antes de destruir o input

        if (!isNaN(newGoal) && newGoal > 0) {
            setGoalOverride(habitId, state.selectedDate, time, newGoal);
            wrapper.innerHTML = originalContent;
            _updateGoalDisplay(wrapper, habit, newGoal);
            triggerHaptic('success');

            requestAnimationFrame(() => {
                wrapper.classList.add('increase');
                wrapper.addEventListener('animationend', () => {
                    wrapper.classList.remove('increase');
                }, { once: true });
            });
        } else {
            wrapper.innerHTML = originalContent;
        }
    };

    const onBlur = () => {
        save();
    };
    
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur(); 
        } else if (e.key === 'Escape') {
            cleanup(); 
            wrapper.innerHTML = originalContent; 
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

        // --- PLACEHOLDER LISTENER ---
        const placeholder = target.closest(DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER);
        if (placeholder) {
            triggerHaptic('light');
            renderExploreHabits();
            openModal(ui.exploreModal);
            return;
        }

        const card = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!card) return;

        const habitId = card.dataset.habitId;
        const time = card.dataset.time as TimeOfDay | undefined;
        if (!habitId || !time) return;

        // Clicou no botão de deletar (revelado pelo swipe)
        const deleteBtn = target.closest<HTMLElement>(DOM_SELECTORS.SWIPE_DELETE_BTN);
        if (deleteBtn) {
            triggerHaptic('medium');
            requestHabitTimeRemoval(habitId, time);
            return;
        }

        // Clicou no botão de nota (revelado pelo swipe)
        const noteBtn = target.closest<HTMLElement>(DOM_SELECTORS.SWIPE_NOTE_BTN);
        if (noteBtn) {
            triggerHaptic('light');
            openNotesModal(habitId, state.selectedDate, time);
            return;
        }

        // Clicou em um dos controles de meta (+/-)
        const controlBtn = target.closest<HTMLElement>(DOM_SELECTORS.GOAL_CONTROL_BTN);
        if (controlBtn) {
            e.stopPropagation(); 
            
            const habit = state.habits.find(h => h.id === habitId);
            if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;
            
            const action = controlBtn.dataset.action as 'increment' | 'decrement';
            const goalWrapper = controlBtn.closest(DOM_SELECTORS.HABIT_GOAL_CONTROLS)?.querySelector<HTMLElement>(DOM_SELECTORS.GOAL_VALUE_WRAPPER);
            if (!goalWrapper) return;

            triggerHaptic('light');
            const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
            const newGoal = (action === 'increment') 
                ? currentGoal + GOAL_STEP 
                : Math.max(1, currentGoal - GOAL_STEP);

            setGoalOverride(habitId, state.selectedDate, time, newGoal);
            _updateGoalDisplay(goalWrapper, habit, newGoal);
            
            const animationClass = action === 'increment' ? 'increase' : 'decrease';
            goalWrapper.classList.remove('increase', 'decrease');
            requestAnimationFrame(() => {
                goalWrapper.classList.add(animationClass);
                goalWrapper.addEventListener('animationend', () => {
                    goalWrapper.classList.remove(animationClass);
                }, { once: true });
            });

            return;
        }

        // Clicou na área do valor da meta para edição direta
        const goalWrapper = target.closest<HTMLElement>(DOM_SELECTORS.GOAL_VALUE_WRAPPER);
        if (goalWrapper) {
            e.stopPropagation();
            triggerHaptic('light');
            const habit = state.habits.find(h => h.id === habitId);
            if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes') && !card.classList.contains(CSS_CLASSES.COMPLETED)) {
                createGoalInput(habit, time, goalWrapper);
            }
            return;
        }

        // Clicou na área principal do cartão
        const contentWrapper = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        if (contentWrapper) {
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
