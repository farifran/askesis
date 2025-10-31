import { ui } from './ui';
import { state, Habit, getCurrentGoalForInstance, TimeOfDay } from './state';
import { openNotesModal, getUnitString, formatGoalForDisplay } from './render';
import {
    toggleHabitStatus,
    setGoalOverride,
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
            // A ação de estado agora só atualiza o estado, a UI será atualizada pelo listener.
            setGoalOverride(habitId, state.selectedDate, time, newGoal);
            // Atualiza a UI localmente após salvar.
            const progressEl = wrapper.querySelector<HTMLElement>('.progress');
            const unitEl = wrapper.querySelector<HTMLElement>('.unit');
            if(progressEl && unitEl) {
                progressEl.textContent = formatGoalForDisplay(newGoal);
                unitEl.textContent = getUnitString(habit, newGoal);
            } else {
                // Se os elementos não existirem mais (caso raro), restaura o conteúdo.
                 wrapper.innerHTML = originalContent;
            }
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
            
            const habit = state.habits.find(h => h.id === habitId);
            if (!habit || (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes')) return;
            
            // REFACTOR [2024-08-25]: A lógica de UI (atualização de texto e animação) foi consolidada aqui.
            // A função de ação agora apenas lida com o estado, melhorando a separação de responsabilidades.
            const action = controlBtn.dataset.action as 'increment' | 'decrement';
            const goalWrapper = controlBtn.closest('.habit-goal-controls')?.querySelector<HTMLElement>('.goal-value-wrapper');
            if (!goalWrapper) return;

            const currentGoal = getCurrentGoalForInstance(habit, state.selectedDate, time);
            const newGoal = (action === 'increment') 
                ? currentGoal + GOAL_STEP 
                : Math.max(1, currentGoal - GOAL_STEP);

            // Etapa 1: Chama a ação para atualizar o estado.
            setGoalOverride(habitId, state.selectedDate, time, newGoal);
    
            // Etapa 2: Atualiza cirurgicamente a UI neste listener.
            const progressEl = goalWrapper.querySelector<HTMLElement>('.progress');
            const unitEl = goalWrapper.querySelector<HTMLElement>('.unit');
            if (progressEl && unitEl) {
                progressEl.textContent = formatGoalForDisplay(newGoal);
                unitEl.textContent = getUnitString(habit, newGoal);
            }
            
            // Etapa 3: Aplica a animação de feedback visual.
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
