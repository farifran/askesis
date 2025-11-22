
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. O código utiliza delegação de eventos de forma eficiente. Refatorada a função 'createGoalInput' para garantir a remoção explícita de event listeners antes da manipulação do DOM, prevenindo vazamentos de memória (memory leaks) e referências circulares.

import { ui } from './ui';
import { state, Habit, getCurrentGoalForInstance, TimeOfDay, getSmartGoalForHabit } from './state';
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
    
    // UX IMPROVEMENT [2025-01-16]: Adicionado inputmode="numeric" e pattern="[0-9]*"
    // Isso força a abertura do teclado numérico otimizado em dispositivos móveis (iOS/Android),
    // melhorando significativamente a experiência de entrada de dados.
    wrapper.innerHTML = `<input type="number" class="goal-input-inline" value="${currentGoal}" min="1" step="1" inputmode="numeric" pattern="[0-9]*" />`;
    const input = wrapper.querySelector('input')!;
    input.focus();
    input.select();

    // MEMORY MANAGEMENT [2025-01-16]: Funções de handler nomeadas para permitir a remoção explícita
    // dos listeners. Isso previne vazamentos de memória em aplicações de longa duração,
    // quebrando potenciais referências circulares antes de remover o elemento do DOM.
    const cleanup = () => {
        input.removeEventListener('blur', onBlur);
        input.removeEventListener('keydown', onKeyDown);
    };

    const save = () => {
        const newGoal = parseInt(input.value, 10);
        cleanup(); // Limpa listeners antes de destruir o input

        if (!isNaN(newGoal) && newGoal > 0) {
            // A ação de estado agora só atualiza o estado.
            setGoalOverride(habitId, state.selectedDate, time, newGoal);
            // Restaura a estrutura original e então atualiza a UI localmente com o novo valor.
            wrapper.innerHTML = originalContent;
            _updateGoalDisplay(wrapper, habit, newGoal);
            
            // UX CHANGE [2025-02-05]: Auto-complete removido a pedido do usuário.
            // Apenas feedback tátil é disparado.
            
            triggerHaptic('success');
        } else {
             // Se o valor for inválido, restaura o conteúdo original para evitar um estado vazio.
            wrapper.innerHTML = originalContent;
        }
    };

    const onBlur = () => {
        save();
    };
    
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur(); // Aciona o evento 'blur' para salvar
        } else if (e.key === 'Escape') {
            cleanup(); // Limpa listeners
            wrapper.innerHTML = originalContent; // Cancela edição
        }
    };
    
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKeyDown);
}

export function setupHabitCardListeners() {
    // A11Y [2025-01-18]: Navegação por teclado para ações de swipe.
    ui.habitContainer.addEventListener('keydown', e => {
        const card = (e.target as HTMLElement).closest('.habit-card');
        if (!card) return;
        
        // Verifica se o foco está no wrapper de conteúdo (o elemento focável principal do cartão)
        if (!e.target || !(e.target as HTMLElement).classList.contains('habit-content-wrapper')) return;

        if (e.key === 'ArrowRight') {
            // Seta Direita -> Desliza conteúdo para direita -> Revela ação da Esquerda (Deletar)
            // Simula o swipe visualmente e torna o botão acessível
            e.preventDefault();
            if (card.classList.contains('is-open-right')) {
                card.classList.remove('is-open-right');
            } else {
                card.classList.toggle('is-open-left');
            }
        } else if (e.key === 'ArrowLeft') {
            // Seta Esquerda -> Desliza conteúdo para esquerda -> Revela ação da Direita (Notas)
            e.preventDefault();
            if (card.classList.contains('is-open-left')) {
                card.classList.remove('is-open-left');
            } else {
                card.classList.toggle('is-open-right');
            }
        } else if (e.key === 'Escape') {
            // Fecha qualquer ação aberta
            if (card.classList.contains('is-open-left') || card.classList.contains('is-open-right')) {
                e.preventDefault();
                card.classList.remove('is-open-left', 'is-open-right');
            }
        }
    });

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
            
            // UX CHANGE [2025-02-05]: Auto-complete removido a pedido do usuário.
            // O hábito não muda mais para 'completed' automaticamente.

            // Etapa 3: Aplica a animação de feedback visual (Verde para increase, Vermelho para decrease).
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

            // UX FIX [2025-02-05]: Predict next status for appropriate haptic feedback
            const currentStatus = card.classList.contains('completed') ? 'completed' : (card.classList.contains('snoozed') ? 'snoozed' : 'pending');
            
            if (currentStatus === 'pending') {
                triggerHaptic('success');
            } else {
                triggerHaptic('light');
            }
            
            toggleHabitStatus(habitId, time, state.selectedDate);
        }
    });
}
