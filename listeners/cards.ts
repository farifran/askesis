
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/cards.ts
 * @description Controlador de Interação de Itens da Lista (Cartões de Hábito).
 * 
 * [MAIN THREAD CONTEXT]:
 * Otimizado para alta frequência.
 * 
 * ARQUITETURA (Static Handlers & Singleton State):
 * - **GoalEditState:** Singleton para gerenciar o estado do input de edição, evitando closures.
 * - **Event Delegation:** Interceptação eficiente de eventos no container.
 */

import { ui } from '../render/ui';
import { state, Habit, TimeOfDay } from '../state';
import { getSmartGoalForHabit, getEffectiveScheduleForHabitOnDate } from '../services/selectors';
import { openNotesModal, renderExploreHabits, openModal } from '../render';
import {
    toggleHabitStatus,
    setGoalOverride,
    requestHabitTimeRemoval,
    requestHabitEndingFromModal,
} from '../habitActions';
import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

const GOAL_STEP = 5;
const INTERACTIVE_SELECTOR = `${DOM_SELECTORS.HABIT_CONTENT_WRAPPER}, ${DOM_SELECTORS.GOAL_CONTROL_BTN}, ${DOM_SELECTORS.GOAL_VALUE_WRAPPER}, ${DOM_SELECTORS.SWIPE_DELETE_BTN}, ${DOM_SELECTORS.SWIPE_NOTE_BTN}, ${DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER}`;

// --- STATIC STATE (Goal Editing) ---
const GoalEditState = {
    activeWrapper: null as HTMLElement | null,
    activeInput: null as HTMLInputElement | null,
    isSaving: 0, // 0 | 1
    originalContent: '',
    habitId: null as string | null,
    time: null as TimeOfDay | null,
    dateISO: null as string | null
};

// --- STATIC HANDLERS (Goal Editing) ---

const _restoreGoalContent = () => {
    const { activeWrapper, originalContent, activeInput } = GoalEditState;
    if (activeWrapper && originalContent) {
        // Cleanup listeners manually
        if (activeInput) {
            activeInput.removeEventListener('blur', _handleGoalBlur);
            activeInput.removeEventListener('keydown', _handleGoalKeydown);
        }
        activeWrapper.innerHTML = originalContent;
    }
    _resetGoalEditState();
};

const _resetGoalEditState = () => {
    GoalEditState.activeWrapper = null;
    GoalEditState.activeInput = null;
    GoalEditState.isSaving = 0;
    GoalEditState.originalContent = '';
    GoalEditState.habitId = null;
    GoalEditState.time = null;
    GoalEditState.dateISO = null;
};

const _saveGoal = () => {
    if (GoalEditState.isSaving) return;
    GoalEditState.isSaving = 1;

    const { activeInput, habitId, time, dateISO, activeWrapper } = GoalEditState;
    if (!activeInput || !habitId || !time || !dateISO || !activeWrapper) return;

    const newGoal = parseInt(activeInput.value, 10);

    // Cleanup listeners immediately
    activeInput.removeEventListener('blur', _handleGoalBlur);
    activeInput.removeEventListener('keydown', _handleGoalKeydown);

    if (!isNaN(newGoal) && newGoal > 0) {
        // RACE-TO-IDLE: Skip manual DOM restoration. 
        // setGoalOverride triggers a full app render.
        setGoalOverride(habitId, dateISO, time, newGoal);
        triggerHaptic('success');

        // Visual feedback (RAF)
        requestAnimationFrame(() => {
            if (activeWrapper.isConnected) {
                activeWrapper.classList.add('increase');
                activeWrapper.addEventListener('animationend', () => activeWrapper.classList.remove('increase'), { once: true });
            }
        });
        
        // Restore focus heuristic
        const card = activeWrapper.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        card?.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER)?.focus();
        
        _resetGoalEditState(); // Just clear references
    } else {
        GoalEditState.isSaving = 0; // Unlock
        _restoreGoalContent(); // Revert
    }
};

const _handleGoalBlur = () => _saveGoal();

const _handleGoalKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        GoalEditState.activeInput?.blur();
    } else if (e.key === 'Escape') {
        if (GoalEditState.isSaving) return;
        _restoreGoalContent();
        
        // Restore focus
        const wrapper = GoalEditState.activeWrapper;
        if (wrapper) {
            const card = wrapper.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
            card?.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER)?.focus();
        }
    }
};

function startGoalEditing(habit: Habit, time: TimeOfDay, wrapper: HTMLElement) {
    if (wrapper.querySelector('input')) return; // Already editing

    // Store state
    GoalEditState.activeWrapper = wrapper;
    GoalEditState.originalContent = wrapper.innerHTML;
    GoalEditState.habitId = habit.id;
    GoalEditState.time = time;
    GoalEditState.dateISO = state.selectedDate;
    GoalEditState.isSaving = 0;

    const currentGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
    
    // Swap to input
    wrapper.innerHTML = `<input type="number" class="goal-input-inline" value="${currentGoal}" min="1" step="1" inputmode="numeric" pattern="[0-9]*" />`;
    
    const input = wrapper.querySelector('input')!;
    GoalEditState.activeInput = input;
    
    input.focus();
    input.select();

    // Attach static handlers
    input.addEventListener('blur', _handleGoalBlur);
    input.addEventListener('keydown', _handleGoalKeydown);
}

// --- STATIC EVENT HANDLERS (Card Interaction) ---

const _handleContainerKeyDown = (e: KeyboardEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
    if (!card) return;
    
    if (!e.target || !(e.target as HTMLElement).classList.contains(CSS_CLASSES.HABIT_CONTENT_WRAPPER)) return;

    if (e.key === 'ArrowRight') {
        e.preventDefault();
        card.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
        card.classList.toggle(CSS_CLASSES.IS_OPEN_LEFT);
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
        card.classList.toggle(CSS_CLASSES.IS_OPEN_RIGHT);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
    }
};

const _handleContainerClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const interactiveElement = target.closest<HTMLElement>(INTERACTIVE_SELECTOR);
    
    if (!interactiveElement) return;

    // --- PLACEHOLDER ---
    if (interactiveElement.classList.contains(CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER)) {
        triggerHaptic('light');
        renderExploreHabits();
        openModal(ui.exploreModal);
        return;
    }

    const card = interactiveElement.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
    if (!card) return;

    const habitId = card.dataset.habitId;
    const time = card.dataset.time as TimeOfDay | undefined;
    if (!habitId || !time) return;

    // --- SWIPE ACTIONS ---
    if (interactiveElement.classList.contains(CSS_CLASSES.SWIPE_DELETE_BTN)) {
        triggerHaptic('medium');
        const habit = state.habits.find(h => h.id === habitId);
        if (!habit) return;

        const currentScheduleTimes = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);
        if (currentScheduleTimes.length <= 1) {
            requestHabitEndingFromModal(habitId);
        } else {
            requestHabitTimeRemoval(habitId, time);
        }
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
        if (!habit) return;
        
        const action = interactiveElement.dataset.action as 'increment' | 'decrement';
        triggerHaptic('light');
        
        const currentGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
        const newGoal = (action === 'increment') 
            ? currentGoal + GOAL_STEP 
            : Math.max(1, currentGoal - GOAL_STEP);

        setGoalOverride(habitId, state.selectedDate, time, newGoal);
        
        // Animation
        const goalWrapper = interactiveElement.parentElement?.querySelector<HTMLElement>(DOM_SELECTORS.GOAL_VALUE_WRAPPER);
        if (goalWrapper) {
            const animationClass = action === 'increment' ? 'increase' : 'decrease';
            goalWrapper.classList.remove('increase', 'decrease');
            requestAnimationFrame(() => {
                goalWrapper.classList.add(animationClass);
                goalWrapper.addEventListener('animationend', () => goalWrapper.classList.remove(animationClass), { once: true });
            });
        }
        return;
    }

    // --- GOAL VALUE (Edit) ---
    if (interactiveElement.classList.contains(CSS_CLASSES.GOAL_VALUE_WRAPPER)) {
        e.stopPropagation();
        triggerHaptic('light');
        const habit = state.habits.find(h => h.id === habitId);
        if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
            startGoalEditing(habit, time, interactiveElement);
        }
        return;
    }

    // --- MAIN TOGGLE ---
    if (interactiveElement.classList.contains(CSS_CLASSES.HABIT_CONTENT_WRAPPER)) {
        const isOpen = card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT) || card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT);
        
        if (isOpen) {
            card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
            return;
        }

        const currentStatus = card.classList.contains(CSS_CLASSES.COMPLETED) ? 'completed' : (card.classList.contains(CSS_CLASSES.SNOOZED) ? 'snoozed' : 'pending');
        triggerHaptic(currentStatus === 'pending' ? 'success' : 'light');
        
        toggleHabitStatus(habitId, time, state.selectedDate);
    }
};

export function setupCardListeners() {
    ui.habitContainer.addEventListener('keydown', _handleContainerKeyDown);
    ui.habitContainer.addEventListener('click', _handleContainerClick);
}
