
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/cards.ts
 * @description Controlador de Interação de Itens da Lista (Cartões de Hábito).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo gerencia interações de alta frequência (cliques, teclado) dentro da lista virtualizada.
 * 
 * ARQUITETURA (Event Delegation):
 * - Em vez de anexar N listeners (um para cada cartão/botão), anexa-se apenas 1 listener
 *   no container pai (`ui.habitContainer`).
 * - O evento "borbulha" (bubbles up) e é interceptado aqui.
 * 
 * DECISÕES TÉCNICAS:
 * 1. Single-Pass Delegation: Usa um `INTERACTIVE_SELECTOR` unificado para identificar
 *    o alvo da interação com uma única chamada de `closest()`, reduzindo reflows e verificações.
 * 2. Inputs Efêmeros: O modo de edição de metas cria/destrói elementos DOM sob demanda
 *    para não poluir a árvore DOM permanente com inputs ocultos.
 * 3. Race-to-Idle: Em caso de sucesso na edição, pulamos a restauração do DOM antigo
 *    porque o ciclo de renderização global (`renderApp`) irá sobrescrever tudo em breve.
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
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

const GOAL_STEP = 5;

// PERFORMANCE: Pre-computed selector for single-pass delegation.
// Combina todos os elementos interativos em uma única query string.
// Isso permite verificar "o usuário clicou em ALGO relevante?" com uma única operação de DOM (O(1)).
const INTERACTIVE_SELECTOR = `${DOM_SELECTORS.HABIT_CONTENT_WRAPPER}, ${DOM_SELECTORS.GOAL_CONTROL_BTN}, ${DOM_SELECTORS.GOAL_VALUE_WRAPPER}, ${DOM_SELECTORS.SWIPE_DELETE_BTN}, ${DOM_SELECTORS.SWIPE_NOTE_BTN}, ${DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER}`;

function createGoalInput(habit: Habit, time: TimeOfDay, wrapper: HTMLElement) {
    if (wrapper.querySelector('input')) return; // Já está no modo de edição

    const originalContent = wrapper.innerHTML;
    const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
    
    // DOM MANIPULATION: Swap text for input directly.
    wrapper.innerHTML = `<input type="number" class="goal-input-inline" value="${currentGoal}" min="1" step="1" inputmode="numeric" pattern="[0-9]*" />`;
    const input = wrapper.querySelector('input')!;
    input.focus();
    input.select();

    // FLAG: Previne submissão dupla (Condição de corrida Enter vs Blur)
    let isSaving = false;

    // MEMORY MANAGEMENT: Manual cleanup of temporary listeners to prevent leaks.
    const cleanupListeners = () => {
        input.removeEventListener('blur', onBlur);
        input.removeEventListener('keydown', onKeyDown);
    };

    const restoreOriginalContent = () => {
        cleanupListeners();
        wrapper.innerHTML = originalContent;
    };

    const save = () => {
        // ROBUSTNESS: Se já estiver salvando, aborta.
        if (isSaving) return;
        isSaving = true;

        const newGoal = parseInt(input.value, 10);
        
        if (!isNaN(newGoal) && newGoal > 0) {
            // PERFORMANCE [2025-03-16]: Skip restoreOriginalContent().
            // CRITICAL ARCHITECTURE: Otimização de "Race-to-Idle".
            // A função setGoalOverride dispara um renderApp() completo via Event Bus.
            // Não restauramos o conteúdo antigo aqui para evitar "Layout Thrashing" (Write -> Read -> Write).
            // Deixamos o motor de renderização reconstruir o estado correto no próximo frame.
            cleanupListeners();
            
            setGoalOverride(habit.id, state.selectedDate, time, newGoal);
            triggerHaptic('success');

            // Reuse 'wrapper' reference directly for simple feedback animation
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
            // Invalid input: restore previous state immediately
            isSaving = false; // Reset lock if validation failed (though usually we destroy input)
            restoreOriginalContent();
        }
    };

    const onBlur = () => save();
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur(); // Dispara onBlur -> save (protegido pela flag isSaving)
        } else if (e.key === 'Escape') {
            // Se já estiver salvando, ignora o escape para não desfazer visualmente antes do refresh
            if (isSaving) return;
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
    // A11Y: Keyboard Navigation Logic
    // Permite interagir com cartões complexos (Swipe simulado) usando apenas teclado.
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

    // PERFORMANCE: Centralized Click Handler (Event Delegation).
    // Gerencia TODOS os cliques dentro da lista de hábitos.
    ui.habitContainer.addEventListener('click', e => {
        const target = e.target as HTMLElement;

        // ADVANCED OPTIMIZATION [2025-03-18]: Single-Pass Delegation.
        // Instead of calling .closest() multiple times for every possible button/wrapper,
        // we call it ONCE for a combined selector of all interactive elements.
        // This reduces DOM traversal complexity from O(Depth * Selectors) to O(Depth).
        const interactiveElement = target.closest(INTERACTIVE_SELECTOR) as HTMLElement;
        
        if (!interactiveElement) return;

        // --- PLACEHOLDER (Caso Especial: Não tem cartão pai) ---
        if (interactiveElement.classList.contains(CSS_CLASSES.EMPTY_GROUP_PLACEHOLDER)) {
            triggerHaptic('light');
            renderExploreHabits();
            openModal(ui.exploreModal);
            return;
        }

        // All other interactions require a habit card context
        // Busca o elemento pai 'habit-card' para obter IDs e contexto.
        const card = interactiveElement.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!card) return;

        const habitId = card.dataset.habitId;
        const time = card.dataset.time as TimeOfDay | undefined;
        if (!habitId || !time) return;

        // --- SWIPE ACTIONS (Camada Inferior) ---
        if (interactiveElement.classList.contains(CSS_CLASSES.SWIPE_DELETE_BTN)) {
            triggerHaptic('medium');
            
            const habit = state.habits.find(h => h.id === habitId);
            if (!habit) return;

            const currentScheduleTimes = getEffectiveScheduleForHabitOnDate(habit, state.selectedDate);

            // UX Logic: Se for o único horário do dia, sugere encerrar o hábito.
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

        // --- GOAL CONTROLS (+/-) ---
        if (interactiveElement.classList.contains(CSS_CLASSES.GOAL_CONTROL_BTN)) {
            e.stopPropagation(); // Impede que o clique propague e marque o hábito como feito
            
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

        // --- GOAL VALUE (Edit Mode) ---
        if (interactiveElement.classList.contains(CSS_CLASSES.GOAL_VALUE_WRAPPER)) {
            e.stopPropagation();
            triggerHaptic('light');
            const habit = state.habits.find(h => h.id === habitId);
            if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes')) {
                createGoalInput(habit, time, interactiveElement);
            }
            return;
        }

        // --- MAIN CARD CONTENT (Toggle Status) ---
        if (interactiveElement.classList.contains(CSS_CLASSES.HABIT_CONTENT_WRAPPER)) {
            // Se o cartão estiver "aberto" (swipe active), o clique apenas fecha.
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
