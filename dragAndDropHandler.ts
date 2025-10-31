import { isCurrentlySwiping } from './swipeHandler';
import { handleHabitDrop, reorderHabit } from './habitActions';
import { state, TimeOfDay, getScheduleForDate, Habit } from './state';

export function setupDragAndDropHandler(habitContainer: HTMLElement) {
    let draggedElement: HTMLElement | null = null;
    let draggedHabitId: string | null = null;
    // PERFORMANCE [2024-08-23]: Otimiza o manipulador de arrastar e soltar.
    // Anteriormente, o objeto do hábito era procurado no array de estado em cada evento 'dragover', causando uma busca O(n) em um loop de alta frequência.
    // Agora, o objeto do hábito é encontrado uma vez no 'dragstart' e armazenado em cache em uma variável local (`draggedHabitObject`),
    // reduzindo significativamente a carga de processamento durante o gesto de arrastar e tornando a UI mais responsiva.
    let draggedHabitObject: Habit | null = null; 
    let draggedHabitOriginalTime: TimeOfDay | null = null;
    let dropIndicator: HTMLElement | null = null;
    let currentDropZoneTarget: HTMLElement | null = null; // Rastreia a zona de soltar atual para otimização

    const handleBodyDragOver = (e: DragEvent) => {
        e.preventDefault();
        const target = e.target as HTMLElement;

        // Limpa o indicador de reordenação visual, se existir
        if (dropIndicator) {
            dropIndicator.classList.remove('visible');
            delete dropIndicator.dataset.targetId;
        }

        if (!draggedHabitId || !draggedHabitOriginalTime || !draggedHabitObject) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }

        const dropZone = target.closest<HTMLElement>('.drop-zone');

        // OTIMIZAÇÃO: Limpa a classe da zona de soltar anterior apenas se tivermos movido para uma nova.
        if (dropZone !== currentDropZoneTarget) {
            currentDropZoneTarget?.classList.remove('drag-over', 'invalid-drop');
        }
        currentDropZoneTarget = dropZone;

        if (!dropZone) {
            e.dataTransfer!.dropEffect = 'none';
            return;
        }

        const newTime = dropZone.dataset.time as TimeOfDay;
        const cardTarget = target.closest<HTMLElement>('.habit-card');

        // BUGFIX [2024-08-19]: A lógica de arrastar e soltar foi refatorada para unificar a reordenação e a movimentação.
        // O indicador de soltura agora é movido dinamicamente para o DOM do novo grupo, e a condição que restringia
        // a reordenação ao grupo original foi removida, permitindo uma experiência de usuário mais fluida e intuitiva.
        
        // Etapa 1: Mover o indicador para o contêiner correto, se necessário.
        if (dropIndicator && dropIndicator.parentElement !== dropZone) {
            dropZone.appendChild(dropIndicator);
        }

        // Etapa 2: Verificar se a movimentação é inválida (duplicada).
        const habit = draggedHabitObject; // Usa o objeto do hábito em cache
        const activeSchedule = habit ? getScheduleForDate(habit, state.selectedDate) : null;
        const dailyInfo = state.dailyData[state.selectedDate]?.[draggedHabitId];
        const scheduleForDay = dailyInfo?.dailySchedule || activeSchedule?.times || [];
        
        if (newTime !== draggedHabitOriginalTime && scheduleForDay.includes(newTime)) {
            dropZone.classList.add('invalid-drop');
            e.dataTransfer!.dropEffect = 'none';
            return; // Impede a reordenação ou qualquer outra ação.
        }

        // Etapa 3: A movimentação é válida, definir efeitos visuais.
        dropZone.classList.add('drag-over');
        e.dataTransfer!.dropEffect = 'move';
        
        // Etapa 4: Lidar com a reordenação visual se estiver sobre outro cartão.
        if (cardTarget && cardTarget !== draggedElement) {
            const targetRect = cardTarget.getBoundingClientRect();
            const midY = targetRect.top + targetRect.height / 2;
            const position = e.clientY < midY ? 'before' : 'after';

            const indicatorTop = position === 'before'
                ? cardTarget.offsetTop - 5 
                : cardTarget.offsetTop + cardTarget.offsetHeight + 5;
            
            if (dropIndicator) {
                dropIndicator.style.top = `${indicatorTop - 1.5}px`;
                dropIndicator.classList.add('visible');
                dropIndicator.dataset.targetId = cardTarget.dataset.habitId;
                dropIndicator.dataset.position = position;
            }
        }
    };

    // REFACTOR [2024-08-02]: Unifica a lógica de soltura para usar a zona de soltura pré-validada
    // de 'dragover'. Isso torna o código mais robusto e remove uma consulta redundante ao DOM,
    // garantindo que a ação de soltura corresponda ao feedback visual que o usuário viu.
    const handleBodyDrop = (e: DragEvent) => {
        e.preventDefault();
        
        if (!draggedHabitId || !draggedHabitOriginalTime) return;

        // --- Soltar para Reordenar ---
        if (dropIndicator?.classList.contains('visible') && dropIndicator.dataset.targetId) {
            const targetId = dropIndicator.dataset.targetId;
            const position = dropIndicator.dataset.position as 'before' | 'after';
            if (draggedHabitId && targetId !== draggedHabitId) {
                reorderHabit(draggedHabitId, targetId, position);
            }
            // A lógica para mover entre grupos será tratada a seguir se necessário
        }

        // --- Soltar para Mover ---
        // Usa a zona de soltura validada e armazenada em cache do evento 'dragover'.
        const dropZone = currentDropZoneTarget;
        if (dropZone?.dataset.time) {
            const newTime = dropZone.dataset.time as TimeOfDay;
            if (newTime !== draggedHabitOriginalTime) {
                handleHabitDrop(draggedHabitId, draggedHabitOriginalTime, newTime);
            }
        }
    };
    
    const cleanupDrag = () => {
        draggedElement?.classList.remove('dragging');
        document.body.classList.remove('is-dragging-active');
        
        // Limpeza eficiente usando a referência em cache
        currentDropZoneTarget?.classList.remove('drag-over', 'invalid-drop');
        currentDropZoneTarget = null;
        
        if (dropIndicator) {
            dropIndicator.remove();
            dropIndicator = null;
        }
        document.body.removeEventListener('dragover', handleBodyDragOver);
        document.body.removeEventListener('drop', handleBodyDrop);
        draggedElement = null;
        draggedHabitId = null;
        draggedHabitOriginalTime = null;
        draggedHabitObject = null; // Limpa o objeto do hábito em cache
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
            // Armazena em cache o objeto do hábito no início do arrasto.
            draggedHabitObject = state.habits.find(h => h.id === draggedHabitId) || null;

            e.dataTransfer!.setData('text/plain', draggedHabitId);
            e.dataTransfer!.effectAllowed = 'move';

            // UX IMPROVEMENT [2024-08-09]: Usa uma imagem de arrasto personalizada para um feedback visual consistente.
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