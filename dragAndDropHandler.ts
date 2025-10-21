import { ui } from './ui';
import { handleHabitDrop } from './habitActions';
import { isCurrentlySwiping } from './swipeHandler';
import { state, TimeOfDay, getScheduleForDate } from './state';
import { getHabitDisplayInfo, t } from './i18n';
import { showInlineNotice } from './render';
import { parseUTCIsoDate } from './utils';

export function setupDragAndDropHandler(habitContainer: HTMLElement) {
    let draggedElement: HTMLElement | null = null;
    let draggedHabitId: string | null = null;
    let draggedHabitOriginalTime: TimeOfDay | null = null;

    const handleBodyDragOver = (e: DragEvent) => {
        e.preventDefault();
        const target = e.target as HTMLElement;

        document.querySelectorAll('.drag-over, .invalid-drop').forEach(el => el.classList.remove('drag-over', 'invalid-drop'));
        
        const dropZone = target.closest<HTMLElement>('.drop-zone');

        if (dropZone && draggedHabitId) {
            const habit = state.habits.find(h => h.id === draggedHabitId);
            if (!habit) {
                e.dataTransfer!.dropEffect = 'none';
                return;
            }
            
            const activeSchedule = getScheduleForDate(habit, state.selectedDate);
            if (!activeSchedule) {
                e.dataTransfer!.dropEffect = 'none';
                return;
            }

            const newTime = dropZone.dataset.time as TimeOfDay;
            const dailyInfo = state.dailyData[state.selectedDate]?.[draggedHabitId];
            const scheduleForDay = dailyInfo?.dailySchedule || activeSchedule.times;

            const isSameTime = newTime === draggedHabitOriginalTime;
            const isDuplicate = scheduleForDay.includes(newTime);

            if (!isSameTime && !isDuplicate) {
                dropZone.classList.add('drag-over');
                e.dataTransfer!.dropEffect = 'move';
            } else {
                if (isDuplicate && !isSameTime) {
                    dropZone.classList.add('invalid-drop');
                }
                e.dataTransfer!.dropEffect = 'none';
            }
        } else {
            e.dataTransfer!.dropEffect = 'none';
        }
    };

    const handleBodyDrop = (e: DragEvent) => {
        e.preventDefault();
        
        const target = e.target as HTMLElement;
        const dropZone = target.closest<HTMLElement>('.drop-zone');
        
        document.querySelectorAll('.drag-over, .invalid-drop').forEach(el => el.classList.remove('drag-over', 'invalid-drop'));

        if (!draggedHabitId || !draggedHabitOriginalTime) return;

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