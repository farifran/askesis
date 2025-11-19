/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído.
// O que foi feito: A análise do arquivo foi finalizada. O manipulador de eventos de clique em `setupHabitCardListeners` foi refatorado para centralizar a validação de `habitId` e `time`, eliminando verificações redundantes e melhorando a clareza e a manutenibilidade do código. As demais funcionalidades, como a edição de metas em linha e as animações, foram validadas e consideradas robustas.
// O que falta: Nenhuma análise futura é necessária. O módulo é considerado finalizado.
import { ui } from './ui';
import { state, Habit, getCurrentGoalForInstance, TimeOfDay } from './state';
import { openNotesModal, getUnitString, formatGoalForDisplay } from './render';
import {
    toggleHabitStatus,
    setGoalOverride,
    requestHabitTimeRemoval,
} from './habitActions';
import { triggerHaptic } from './utils';

const GOAL_STEP = 5;

/**
 * REATORAÇÃO [2024-09-11]: Centraliza a lógica de atualização da UI da meta para evitar duplicação.
 * Esta função atualiza o texto do valor e da unidade da meta, garantindo consistência
 * tanto nas ações de incremento/decremento quanto na edição inline.
 * @param wrapperEl O elemento que envolve o valor e a unidade da meta.
 * @param habit O objeto do hábito.
 * @param newGoal O novo valor da meta a ser exibido.
 */
function _updateGoalDisplay(wrapperEl: HTMLElement, habit: Habit, newGoal: number) {
    const progressEl = wrapperEl.querySelector<HTMLElement>('.progress');
    const unitEl = wrapperEl.querySelector<HTMLElement>('.unit');
    if (progressEl && unitEl) {
        progressEl.textContent = formatGoalForDisplay(newGoal);
        unitEl.textContent = getUnitString(habit, newGoal);
    }
}


function createGoalInput(habit: Habit, time: TimeOfDay, wrapper: HTMLElement) {
    const controls = wrapper.closest('.habit-goal-controls');
    if (controls?.querySelector('input')) return; // Já está no modo de edição

    const habitId = habit.id;
    const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);

    const originalContent = wrapper.innerHTML;
    
    wrapper.innerHTML = `<input type="number" class="goal-input-inline" value="${currentGoal}" min="1" step="1" />`;
    const input = wrapper.querySelector('input')!;
    input.focus();
    input.select();

    const save = () => {
        const newGoal = parseInt(input.value, 10);
        if (!isNaN(newGoal) && newGoal > 0) {
            // A ação de estado agora só atualiza o estado.
            setGoalOverride(habitId, state.selectedDate, time, newGoal);
            // Restaura a estrutura original e então atualiza a UI localmente com o novo valor.
            wrapper.innerHTML = originalContent;
            _updateGoalDisplay(wrapper, habit, newGoal);
            triggerHaptic('success');
        } else {
             // Se o valor for inválido, restaura o conteúdo original para evitar um estado vazio.
            wrapper.innerHTML = originalContent;
        }
    };
    
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur(); // Aciona o evento 'blur' para salvar
        } else if (e.key === 'Escape') {
            wrapper.innerHTML = originalContent;
        }
    });
}

export function setupHabitCardListeners() {
    ui.habitContainer.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const card = target.closest<HTMLElement>('.habit-card');
        if (!card) return;

        const habitId = card.dataset.habitId;
        const time = card.dataset.time as TimeOfDay | undefined;
        // REATORAÇÃO DE ROBUSTEZ: Valida habitId e time no início para evitar verificações repetidas.
        if (!habitId || !time) return;

        // Clicou no botão de deletar (revelado pelo swipe)
        const deleteBtn = target.closest<HTMLElement>('.swipe-delete-btn');
        if (deleteBtn) {
            triggerHaptic('medium');
            requestHabitTimeRemoval(habitId, time);
            return;
        }

        // Clicou no botão de nota (revelado pelo swipe)
        const noteBtn = target.closest<HTMLElement>('.swipe-note-btn');
        if (noteBtn) {
            triggerHaptic('light');
            openNotesModal(habitId, state.selectedDate, time);
            return;
        }

        // Clicou em um dos controles de meta (+/-)
        const controlBtn = target.closest<HTMLElement>('.goal-control-btn');
        if (controlBtn) {
            e.stopPropagation(); // Impede que o clique se propague para o card
            
            const habit = state.habits.find(h => h.id === habitId);
            if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;
            
            // REATORAÇÃO [2024-09-11]: A lógica de UI (atualização de texto e animação) foi consolidada aqui.
            // A função de ação agora lida apenas com o estado, melhorando a separação de responsabilidades.
            const action = controlBtn.dataset.action as 'increment' | 'decrement';
            const goalWrapper = controlBtn.closest('.habit-goal-controls')?.querySelector<HTMLElement>('.goal-value-wrapper');
            if (!goalWrapper) return;

            triggerHaptic('light');
            const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
            const newGoal = (action === 'increment') 
                ? currentGoal + GOAL_STEP 
                : Math.max(1, currentGoal - GOAL_STEP);

            // Etapa 1: Chama a ação para atualizar o estado e os componentes não-card.
            setGoalOverride(habitId, state.selectedDate, time, newGoal);
    
            // Etapa 2: Atualiza cirurgicamente a UI do cartão usando a função centralizada.
            _updateGoalDisplay(goalWrapper, habit, newGoal);
            
            // Etapa 3: Aplica a animação de feedback visual.
            const animationClass = action === 'increment' ? 'increase' : 'decrease';
            goalWrapper.classList.remove('increase', 'decrease');
            // Usar requestAnimationFrame garante que o navegador processe a remoção da classe antes de adicioná-la novamente, reiniciando a animação.
            requestAnimationFrame(() => {
                goalWrapper.classList.add(animationClass);
                goalWrapper.addEventListener('animationend', () => {
                    goalWrapper.classList.remove(animationClass);
                }, { once: true });
            });

            return;
        }

        // Clicou na área do valor da meta para edição direta
        const goalWrapper = target.closest<HTMLElement>('.goal-value-wrapper');
        if (goalWrapper) {
            e.stopPropagation(); // Previne o toggle do card
            triggerHaptic('light');
            const habit = state.habits.find(h => h.id === habitId);
            // Só ativa para metas numéricas e se não estiver já concluído
            if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes') && !card.classList.contains('completed')) {
                createGoalInput(habit, time, goalWrapper);
            }
            return;
        }

        // Clicou na área principal do cartão
        const contentWrapper = target.closest<HTMLElement>('.habit-content-wrapper');
        if (contentWrapper) {
            const isOpen = card.classList.contains('is-open-left') || card.classList.contains('is-open-right');
            
            // Se o cartão de hábito estiver com as ações de swipe abertas,
            // um clique na área de conteúdo deve apenas fechar as ações, sem alterar o status.
            if (isOpen) {
                card.classList.remove('is-open-left', 'is-open-right');
                return;
            }

            // Se o cartão estiver fechado, o clique executa a ação padrão de alternar o status.
            triggerHaptic('light');
            toggleHabitStatus(habitId, time, state.selectedDate);
        }
    });
}