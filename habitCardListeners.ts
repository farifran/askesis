import { ui } from './ui';
import { state, Habit, getCurrentGoalForInstance, TimeOfDay } from './state';
import { openNotesModal, getUnitString, formatGoalForDisplay } from './render';
import {
    toggleHabitStatus,
    updateGoalOverride,
    requestHabitTimeRemoval,
} from './habitActions';

const GOAL_STEP = 5;

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
            updateGoalOverride(habitId, state.selectedDate, time, newGoal);
        } else {
             // Se o valor for inválido, restaura o conteúdo original para evitar um estado vazio.
            wrapper.innerHTML = originalContent;
        }
    };
    
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            save();
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

        // Clicou no botão de deletar (revelado pelo swipe)
        const deleteBtn = target.closest<HTMLElement>('.swipe-delete-btn');
        if (deleteBtn && habitId && time) {
            requestHabitTimeRemoval(habitId, time);
            return;
        }

        // Clicou no botão de nota (revelado pelo swipe)
        const noteBtn = target.closest<HTMLElement>('.swipe-note-btn');
        if (noteBtn && habitId && time) {
            openNotesModal(habitId, state.selectedDate, time);
            return;
        }

        // Clicou em um dos controles de meta (+/-)
        const controlBtn = target.closest<HTMLElement>('.goal-control-btn');
        if (controlBtn && habitId && time) {
            e.stopPropagation(); // Impede que o clique se propague para o card
            const action = controlBtn.dataset.action as 'increment' | 'decrement';
            
            const habit = state.habits.find(h => h.id === habitId);
            if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;
    
            const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
            
            const newGoal = (action === 'increment') 
                ? currentGoal + GOAL_STEP 
                : Math.max(1, currentGoal - GOAL_STEP);

            // Ação: Atualiza o estado. A renderização é tratada dentro de updateGoalOverride.
            updateGoalOverride(habitId, state.selectedDate, time, newGoal);

            // Após a atualização do estado e a nova renderização, encontre o elemento novamente para aplicar a animação.
            const updatedCard = ui.habitContainer.querySelector(`.habit-card[data-habit-id="${habitId}"][data-time="${time}"]`);
            const goalWrapper = updatedCard?.querySelector<HTMLElement>('.goal-value-wrapper');
    
            if (goalWrapper) {
                const animationClass = action === 'increment' ? 'increase' : 'decrease';
                
                // Remove quaisquer classes de animação existentes para reiniciar a animação se for clicado rapidamente
                goalWrapper.classList.remove('increase', 'decrease');
                
                // Precisamos de um pequeno atraso para permitir que o navegador remova a classe antes de adicioná-la novamente.
                // requestAnimationFrame é uma boa maneira de esperar pelo próximo frame.
                requestAnimationFrame(() => {
                    goalWrapper.classList.add(animationClass);
                    goalWrapper.addEventListener('animationend', () => {
                        goalWrapper.classList.remove(animationClass);
                    }, { once: true });
                });
            }

            return;
        }

        // Clicou na área do valor da meta para edição direta
        const goalWrapper = target.closest<HTMLElement>('.goal-value-wrapper');
        if (goalWrapper && habitId && time) {
            e.stopPropagation(); // Previne o toggle do card
            const habit = state.habits.find(h => h.id === habitId);
            // Só ativa para metas numéricas e se não estiver já concluído
            if (habit && (habit.goal.type === 'pages' || habit.goal.type === 'minutes') && !card.classList.contains('completed')) {
                createGoalInput(habit, time, goalWrapper);
            }
            return;
        }

        // Clicou na área principal do cartão
        const contentWrapper = target.closest<HTMLElement>('.habit-content-wrapper');
        if (contentWrapper && habitId && time) {
            const isOpen = card.classList.contains('is-open-left') || card.classList.contains('is-open-right');
            
            // Se o cartão de hábito estiver com as ações de swipe abertas,
            // um clique na área de conteúdo deve apenas fechar as ações, sem alterar o status.
            if (isOpen) {
                card.classList.remove('is-open-left', 'is-open-right');
                return;
            }

            // Se o cartão estiver fechado, o clique executa a ação padrão de alternar o status.
            toggleHabitStatus(habitId, time);
        }
    });
}