// ANÁLISE DO ARQUIVO: 100% concluído.
// O que foi feito: A análise do módulo de arrastar e soltar foi finalizada. A lógica das funções `handleBodyDrop` e `cleanupDrag` foi refatorada para maior clareza e modularidade, com a extração de funções auxiliares (`_determineAndExecuteDropAction`, `_resetDragState`). Isso isola as responsabilidades de manipulação de eventos, lógica de negócio e limpeza de estado, tornando o código mais robusto e de fácil manutenção.
// O que falta: Nenhuma análise futura é necessária. O módulo é considerado finalizado.
import { isCurrentlySwiping } from './swipeHandler';
import { handleHabitDrop, reorderHabit } from './habitActions';
import { state, TimeOfDay, Habit, getEffectiveScheduleForHabitOnDate } from './state';

const DROP_INDICATOR_GAP = 5; // Espaçamento em pixels acima/abaixo do cartão de destino
const DROP_INDICATOR_HEIGHT = 3; // Deve corresponder à altura do indicador no CSS

export function setupDragAndDropHandler(habitContainer: HTMLElement) {
    let draggedElement: HTMLElement | null = null;
    let draggedHabitId: string | null = null;
    let draggedHabitObject: Habit | null = null; 
    let draggedHabitOriginalTime: TimeOfDay | null = null;
    let dropIndicator: HTMLElement | null = null;
    let currentDropZoneTarget: HTMLElement | null = null;

    /**
     * REATORAÇÃO DE MODULARIDADE: Atualiza os visuais da zona de soltura.
     */
    function _updateDropZoneVisuals(target: HTMLElement): { dropZone: HTMLElement | null; isValid: boolean } {
        const dropZone = target.closest<HTMLElement>('.drop-zone');

        if (dropZone !== currentDropZoneTarget) {
            currentDropZoneTarget?.classList.remove('drag-over', 'invalid-drop');
        }

        if (!draggedHabitObject || !draggedHabitOriginalTime || !dropZone) {
            return { dropZone: null, isValid: false };
        }

        const newTime = dropZone.dataset.time as TimeOfDay;
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(draggedHabitObject, state.selectedDate);
        const isInvalidDrop = newTime !== draggedHabitOriginalTime && scheduleForDay.includes(newTime);
        
        dropZone.classList.toggle('invalid-drop', isInvalidDrop);
        dropZone.classList.toggle('drag-over', !isInvalidDrop);

        return { dropZone, isValid: !isInvalidDrop };
    }

    /**
     * REATORAÇÃO DE MODULARIDADE: Atualiza a posição e visibilidade do indicador de reordenação.
     */
    function _updateReorderIndicator(e: DragEvent, cardTarget: HTMLElement | null) {
        if (!cardTarget || cardTarget === draggedElement || !dropIndicator) {
            return;
        }

        const targetRect = cardTarget.getBoundingClientRect();
        const midY = targetRect.top + targetRect.height / 2;
        const position = e.clientY < midY ? 'before' : 'after';

        const indicatorTop = position === 'before'
            ? cardTarget.offsetTop - DROP_INDICATOR_GAP
            : cardTarget.offsetTop + cardTarget.offsetHeight + DROP_INDICATOR_GAP;

        dropIndicator.style.top = `${indicatorTop - (DROP_INDICATOR_HEIGHT / 2)}px`;
        dropIndicator.classList.add('visible');
        dropIndicator.dataset.targetId = cardTarget.dataset.habitId;
        dropIndicator.dataset.position = position;
    }

    /**
     * REATORAÇÃO DE MODULARIDADE: Determina e executa a ação de soltar apropriada.
     */
    function _determineAndExecuteDropAction() {
        if (!draggedHabitId || !draggedHabitOriginalTime) return;
        
        const reorderTargetId = dropIndicator?.dataset.targetId;
        const reorderPosition = dropIndicator?.dataset.position as 'before' | 'after';
        const isDropIndicatorVisible = dropIndicator?.classList.contains('visible');
        const newTime = currentDropZoneTarget?.dataset.time as TimeOfDay | undefined;

        if (!newTime) return;

        const isMovingGroup = newTime !== draggedHabitOriginalTime;
        const isReordering = isDropIndicatorVisible && reorderTargetId && draggedHabitId !== reorderTargetId;

        if (isMovingGroup) {
            handleHabitDrop(draggedHabitId, draggedHabitOriginalTime, newTime);
        } else if (isReordering) {
            reorderHabit(draggedHabitId, reorderTargetId, reorderPosition);
        }
    }

    /**
     * REATORAÇÃO DE MODULARIDADE: Reseta todas as variáveis de estado do módulo de arrastar.
     */
    function _resetDragState() {
        draggedElement = null;
        draggedHabitId = null;
        draggedHabitOriginalTime = null;
        draggedHabitObject = null;
        dropIndicator = null;
        currentDropZoneTarget = null;
    }


    const handleBodyDragOver = (e: DragEvent) => {
        e.preventDefault();

        if (dropIndicator) {
            dropIndicator.classList.remove('visible');
            delete dropIndicator.dataset.targetId;
        }

        if (!draggedHabitId) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }

        const { dropZone, isValid } = _updateDropZoneVisuals(e.target as HTMLElement);
        currentDropZoneTarget = dropZone;
        
        if (!dropZone) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }
        
        if (dropIndicator && dropIndicator.parentElement !== dropZone) {
            dropZone.appendChild(dropIndicator);
        }

        if (!isValid) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }

        e.dataTransfer!.dropEffect = 'move';
        
        const cardTarget = (e.target as HTMLElement).closest<HTMLElement>('.habit-card');
        _updateReorderIndicator(e, cardTarget);
    };

    const handleBodyDrop = (e: DragEvent) => {
        e.preventDefault();
        
        document.body.removeEventListener('dragover', handleBodyDragOver);
        document.body.removeEventListener('drop', handleBodyDrop);

        currentDropZoneTarget?.classList.remove('drag-over', 'invalid-drop');
        if (dropIndicator) {
            dropIndicator.classList.remove('visible');
        }

        _determineAndExecuteDropAction();
    };
    
    const cleanupDrag = () => {
        // 1. Limpa os estilos visuais aplicados durante o arrasto
        draggedElement?.classList.remove('dragging');
        document.body.classList.remove('is-dragging-active');
        currentDropZoneTarget?.classList.remove('drag-over', 'invalid-drop');
        
        // 2. Remove elementos temporários do DOM
        dropIndicator?.remove();
        
        // 3. Remove os listeners de eventos globais para evitar vazamentos de memória
        document.body.removeEventListener('dragover', handleBodyDragOver);
        document.body.removeEventListener('drop', handleBodyDrop);

        // 4. Reseta todas as variáveis de estado internas para a próxima operação de arrasto
        _resetDragState();
    };

    habitContainer.addEventListener('dragstart', e => {
        if (isCurrentlySwiping()) {
            e.preventDefault();
            return;
        }
        const cardContent = (e.target as HTMLElement).closest<HTMLElement>('.habit-content-wrapper');
        const card = cardContent?.closest<HTMLElement>('.habit-card');
        if (card && cardContent && card.dataset.habitId && card.dataset.time) {
            draggedElement = card;
            draggedHabitId = card.dataset.habitId;
            draggedHabitOriginalTime = card.dataset.time as TimeOfDay;
            draggedHabitObject = state.habits.find(h => h.id === draggedHabitId) || null;

            e.dataTransfer!.setData('text/plain', draggedHabitId);
            e.dataTransfer!.effectAllowed = 'move';

            const dragImage = cardContent.cloneNode(true) as HTMLElement;
            dragImage.classList.add('drag-image-ghost');
            dragImage.style.width = `${cardContent.offsetWidth}px`;
            document.body.appendChild(dragImage);
            e.dataTransfer!.setDragImage(dragImage, e.offsetX, e.offsetY);
            setTimeout(() => document.body.removeChild(dragImage), 0);
            
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