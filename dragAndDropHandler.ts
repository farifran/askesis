import { ui } from './ui';
import { handleHabitDrop, reorderHabit } from './habitActions';
import { isCurrentlySwiping } from './swipeHandler';
import { state, TimeOfDay, getScheduleForDate } from './state';
import { getHabitDisplayInfo, t } from './i18n';
import { showInlineNotice } from './render';
import { parseUTCIsoDate } from './utils';

export function setupDragAndDropHandler(habitContainer: HTMLElement) {
    let draggedElement: HTMLElement | null = null;
    let draggedHabitId: string | null = null;
    let draggedHabitOriginalTime: TimeOfDay | null = null;
    let dropIndicator: HTMLElement | null = null;

    const handleBodyDragOver = (e: DragEvent) => {
        e.preventDefault();
        const target = e.target as HTMLElement;

        document.querySelectorAll('.drag-over, .invalid-drop').forEach(el => el.classList.remove('drag-over', 'invalid-drop'));
        if (dropIndicator) {
            dropIndicator.classList.remove('visible');
            delete dropIndicator.dataset.targetId;
        }

        if (!draggedHabitId || !draggedHabitOriginalTime) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }

        const dropZone = target.closest<HTMLElement>('.drop-zone');
        if (!dropZone) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }

        const newTime = dropZone.dataset.time as TimeOfDay;
        const cardTarget = target.closest<HTMLElement>('.habit-card');

        // Caso 1: Reordenando dentro do mesmo horário
        if (newTime === draggedHabitOriginalTime && cardTarget && cardTarget !== draggedElement) {
            const targetRect = cardTarget.getBoundingClientRect();
            const midY = targetRect.top + targetRect.height / 2;
            const position = e.clientY < midY ? 'before' : 'after';

            // Ajusta para a margem (10px)
            const indicatorTop = position === 'before'
                ? cardTarget.offsetTop - 5 
                : cardTarget.offsetTop + cardTarget.offsetHeight + 5;
            
            if (dropIndicator) {
                dropIndicator.style.top = `${indicatorTop - 1.5}px`; // centraliza a linha de 3px
                dropIndicator.classList.add('visible');
                dropIndicator.dataset.targetId = cardTarget.dataset.habitId;
                dropIndicator.dataset.position = position;
            }
            e.dataTransfer!.dropEffect = 'move';
            return;
        }

        // Caso 2: Movendo para um horário diferente
        if (newTime !== draggedHabitOriginalTime) {
            const habit = state.habits.find(h => h.id === draggedHabitId);
            if (!habit) { e.dataTransfer!.dropEffect = 'none'; return; }

            const activeSchedule = getScheduleForDate(habit, state.selectedDate);
            if (!activeSchedule) { e.dataTransfer!.dropEffect = 'none'; return; }

            const dailyInfo = state.dailyData[state.selectedDate]?.[draggedHabitId];
            const scheduleForDay = dailyInfo?.dailySchedule || activeSchedule.times;
            const isDuplicate = scheduleForDay.includes(newTime);

            if (!isDuplicate) {
                dropZone.classList.add('drag-over');
                e.dataTransfer!.dropEffect = 'move';
            } else {
                dropZone.classList.add('invalid-drop');
                e.dataTransfer!.dropEffect = 'none';
            }
            return;
        }

        // Caso padrão: nenhum alvo de soltura válido
        e.dataTransfer!.dropEffect = 'none';
    };

    const handleBodyDrop = (e: DragEvent) => {
        e.preventDefault();
        
        document.querySelectorAll('.drag-over, .invalid-drop').forEach(el => el.classList.remove('drag-over', 'invalid-drop'));
        
        if (!draggedHabitId || !draggedHabitOriginalTime) return;

        // --- Soltar para Reordenar ---
        if (dropIndicator?.classList.contains('visible') && dropIndicator.dataset.targetId) {
            const targetId = dropIndicator.dataset.targetId;
            const position = dropIndicator.dataset.position as 'before' | 'after';
            if (draggedHabitId && targetId !== draggedHabitId) {
                reorderHabit(draggedHabitId, targetId, position);
            }
            return;
        }

        // --- Soltar para Mover (lógica existente) ---
        const target = e.target as HTMLElement;
        const dropZone = target.closest<HTMLElement>('.drop-zone');
        if (dropZone?.dataset.time) {
            const newTime = dropZone.dataset.time as TimeOfDay;
            const habit = state.habits.find(h => h.id === draggedHabitId);
            if (!habit) return;
            
            const activeSchedule = getScheduleForDate(habit, state.selectedDate);
            if (!activeSchedule) return;

            const dailyInfo = state.dailyData[state.selectedDate]?.[draggedHabitId];
            const scheduleForDay = dailyInfo?.dailySchedule || activeSchedule.times;
            const isDuplicate = scheduleForDay.includes(newTime);
            const isSameTime = newTime === draggedHabitOriginalTime;

            if (isDuplicate && !isSameTime) {
                const noticeEl = dropZone.closest('.habit-group-wrapper')?.querySelector<HTMLElement>('.duplicate-drop-notice');
                if (noticeEl) {
                    const habitName = getHabitDisplayInfo(habit).name;
                    showInlineNotice(noticeEl, t('noticeDuplicateDrop', { habitName }));
                }
            } else if (!isSameTime) {
                handleHabitDrop(draggedHabitId, draggedHabitOriginalTime, newTime);
            }
        }
    };
    
    const cleanupDrag = () => {
        draggedElement?.classList.remove('dragging');
        document.body.classList.remove('is-dragging-active');
        document.querySelectorAll('.drag-over, .invalid-drop').forEach(el => el.classList.remove('drag-over', 'invalid-drop'));
        if (dropIndicator) {
            dropIndicator.remove();
            dropIndicator = null;
        }
        document.body.removeEventListener('dragover', handleBodyDragOver);
        document.body.removeEventListener('drop', handleBodyDrop);
        draggedElement = null;
        draggedHabitId = null;
        draggedHabitOriginalTime = null;
    };

    habitContainer.addEventListener('dragstart', e => {
        if (isCurrentlySwiping()) {
            e.preventDefault();
            return;
        }
        const cardContent = (e.target as HTMLElement).closest<HTMLElement>('.habit-content-wrapper');
        const card = cardContent?.closest<HTMLElement>('.habit-card');
        if (card && card.dataset.habitId && card.dataset.time) {
            draggedElement = card;
            draggedHabitId = card.dataset.habitId;
            draggedHabitOriginalTime = card.dataset.time as TimeOfDay;

            e.dataTransfer!.setData('text/plain', draggedHabitId);
            e.dataTransfer!.effectAllowed = 'move';

            dropIndicator = document.createElement('div');
            dropIndicator.className = 'drop-indicator';
            const groupEl = card.closest('.habit-group');
            groupEl?.appendChild(dropIndicator);
            
            document.body.classList.add('is-dragging-active');
            document.body.addEventListener('dragover', handleBodyDragOver);
            document.body.addEventListener('drop', handleBodyDrop);
            document.body.addEventListener('dragend', cleanupDrag, { once: true });

            setTimeout(() => {
                card.classList.add('dragging');
            }, 0);
        }
    });
}