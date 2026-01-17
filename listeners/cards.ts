
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
 * - **Debounce Strategy:** Proteção contra "Render Storm" em cliques rápidos de meta.
 */

import { ui } from '../render/ui';
import { state, Habit, TimeOfDay } from '../state';
import { getCurrentGoalForInstance, getEffectiveScheduleForHabitOnDate } from '../services/selectors';
import { openNotesModal, renderExploreHabits, openModal } from '../render';
import {
    toggleHabitStatus,
    setGoalOverride,
    requestHabitTimeRemoval,
    requestHabitEndingFromModal,
} from '../habitActions';
import { triggerHaptic } from '../utils';
import { setTextContent } from '../render/dom'; // Import adicionado para update otimista
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

const GOAL_STEP = 5;
const MAX_ALLOWED_GOAL = 9999; // BLINDAGEM: Limite são para evitar quebra de layout/gráfico
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

// --- STATIC STATE (Debounce) ---
// Protege contra "Render Storm" ao clicar rápido nos botões de meta
const GoalDebouncer = {
    timer: 0,
    // Key: "habitId|time|dateISO" -> newValue
    // FIX: Date included in key to prevent race conditions during navigation
    pendingValues: new Map<string, number>() 
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

    let newGoal = parseInt(activeInput.value, 10);

    // Cleanup listeners immediately
    activeInput.removeEventListener('blur', _handleGoalBlur);
    activeInput.removeEventListener('keydown', _handleGoalKeydown);

    if (!isNaN(newGoal) && newGoal > 0) {
        // BLINDAGEM: Clamp value to prevent layout destruction
        if (newGoal > MAX_ALLOWED_GOAL) newGoal = MAX_ALLOWED_GOAL;

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

    const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
    
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

// --- RIPPLE EFFECT LOGIC ---
// Creates a visual ripple effect on click
function _createRipple(event: MouseEvent, target: HTMLElement) {
    const rippleContainer = target.querySelector('.ripple-container');
    if (!rippleContainer) return;

    const circle = document.createElement('span');
    const diameter = Math.max(target.clientWidth, target.clientHeight);
    const radius = diameter / 2;

    const rect = target.getBoundingClientRect();
    
    // Calculate position relative to the element
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    circle.style.width = circle.style.height = `${diameter}px`;
    circle.style.left = `${x - radius}px`;
    circle.style.top = `${y - radius}px`;
    circle.classList.add('ripple');

    // Remove ripple after animation finishes
    const ripple = rippleContainer.appendChild(circle);
    
    // Use timeout matching CSS animation duration (0.6s)
    setTimeout(() => {
        ripple.remove();
    }, 600);
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

    // --- GOAL CONTROLS (BLINDAGEM CONTRA SPAM) ---
    if (interactiveElement.classList.contains(CSS_CLASSES.GOAL_CONTROL_BTN)) {
        e.stopPropagation();
        
        const habit = state.habits.find(h => h.id === habitId);
        if (!habit) return;
        
        const action = interactiveElement.dataset.action as 'increment' | 'decrement';
        triggerHaptic('light');
        
        // BUGFIX: Include Date in key to ensure clicks are attributed to the correct day
        // even if user navigates away before debounce fires.
        const key = `${habitId}|${time}|${state.selectedDate}`;
        
        // 1. Determine base value (Current State OR Pending Debounced Value)
        const baseGoal = GoalDebouncer.pendingValues.has(key) 
            ? GoalDebouncer.pendingValues.get(key)! 
            : getCurrentGoalForInstance(habit, state.selectedDate, time);

        // 2. Calculate New Value
        let newGoal = (action === 'increment') 
            ? baseGoal + GOAL_STEP 
            : Math.max(1, baseGoal - GOAL_STEP);
            
        if (newGoal > MAX_ALLOWED_GOAL) newGoal = MAX_ALLOWED_GOAL;

        // 3. Store in pending map
        GoalDebouncer.pendingValues.set(key, newGoal);

        // 4. OPTIMISTIC UI UPDATE (Direct DOM Manipulation)
        // Find sibling value wrapper to update text immediately without waiting for renderApp
        const parent = interactiveElement.parentElement;
        const progressEl = parent?.querySelector('.progress');
        if (progressEl) {
            setTextContent(progressEl, String(newGoal));
        }
        // Update button state immediately
        const decBtn = parent?.querySelector('[data-action="decrement"]') as HTMLButtonElement;
        if (decBtn) decBtn.disabled = newGoal <= 1;

        // 5. DEBOUNCE PERSISTENCE
        if (GoalDebouncer.timer) clearTimeout(GoalDebouncer.timer);
        
        GoalDebouncer.timer = window.setTimeout(() => {
            // Flush all pending updates for all keys/dates
            GoalDebouncer.pendingValues.forEach((val, mapKey) => {
                const [hId, tId, dateISO] = mapKey.split('|');
                // Use stored dateISO, not global state.selectedDate
                setGoalOverride(hId, dateISO, tId as TimeOfDay, val);
            });
            GoalDebouncer.pendingValues.clear();
            GoalDebouncer.timer = 0;
        }, 600); // 600ms debounce allows rapid tapping

        // Animation (Visual Feedback)
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
        
        // Trigger Ripple Effect
        _createRipple(e, interactiveElement);
        
        triggerHaptic(currentStatus === 'pending' ? 'success' : 'light');
        
        toggleHabitStatus(habitId, time, state.selectedDate);
    }
};

export function setupCardListeners() {
    ui.habitContainer.addEventListener('keydown', _handleContainerKeyDown);
    ui.habitContainer.addEventListener('click', _handleContainerClick);
}
