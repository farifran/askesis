import { ui } from './ui';
import { state, Habit, getSmartGoalForHabit, TimeOfDay } from './state';
import { openNotesModal, showConfirmationModal, closeModal, openEditModal, renderHabits } from './render';
import {
    toggleHabitStatus,
    updateGoalOverride,
    requestHabitTimeRemoval,
} from './habitActions';
import { isCurrentlySwiping } from './swipeHandler';
import { getHabitDisplayInfo, t } from './i18n';

const GOAL_STEP = 5;

function createGoalInput(habit: Habit, time: TimeOfDay, wrapper: HTMLElement) {
    const controls = wrapper.closest('.habit-goal-controls');
    if (controls?.querySelector('input')) return; // Já está no modo de edição

    const habitId = habit.id;
    const dayHabitData = state.dailyData[state.selectedDate]?.[habitId]?.instances[time];
    const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
    const currentGoal = dayHabitData?.goalOverride ?? smartGoal;

    const originalContent = wrapper.innerHTML;
    
    wrapper.innerHTML = `<input type="number" class="goal-input-inline" value="${currentGoal}" min="1" step="1" />`;
    const input = wrapper.querySelector('input')!;
    input.focus();
    input.select();

    const save = () => {
        const newGoal = parseInt(input.value, 10);
        if (!isNaN(newGoal) && newGoal > 0) {
            updateGoalOverride(habitId, state.selectedDate, time, newGoal);
        }
        // A atualização da UI será feita por renderHabits após o estado ser salvo
        renderHabits();
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
        // Previne a ação de clique se um deslize (swipe) acabou de acontecer,
        // evitando que a mudança de status seja acionada acidentalmente.
        if (isCurrentlySwiping()) {
            return;
        }

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
    
            const dayInstanceData = state.dailyData[state.selectedDate]?.[habitId]?.instances[time];
            const smartGoal = getSmartGoalForHabit(habit, state.selectedDate, time);
            const currentGoal = dayInstanceData?.goalOverride ?? smartGoal;
            
            let newGoal;
            if (action === 'increment') {
                newGoal = currentGoal + GOAL_STEP;
            } else {
                newGoal = Math.max(1, currentGoal - GOAL_STEP);
            }

            // Animação da UI
            const progressEl = controlBtn.parentElement?.querySelector<HTMLElement>('.progress');
            if (progressEl && newGoal !== currentGoal) {
                const animClass = newGoal > currentGoal ? 'goal-increased' : 'goal-decreased';
                progressEl.classList.add(animClass);
                progressEl.addEventListener('animationend', () => {
                    progressEl.classList.remove(animClass);
                }, { once: true });
            }

            updateGoalOverride(habitId, state.selectedDate, time, newGoal);
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
