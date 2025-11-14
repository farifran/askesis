// ANÁLISE DO ARQUIVO: 0% concluído. A lógica de arrastar e soltar foi otimizada para performance e UX. Com a refatoração para constantes, é considerada finalizada.
import { isCurrentlySwiping } from './swipeHandler';
// FIX: Corrected imports for functions that were missing exports.
import { handleHabitDrop, reorderHabit } from './habitActions';
import { state, TimeOfDay, getScheduleForDate, Habit, getEffectiveScheduleForHabitOnDate } from './state';

// MELHORIA DE MANUTENIBILIDADE [2024-10-29]: Os "números mágicos" para o posicionamento do indicador de soltura foram substituídos por constantes nomeadas.
// Isso melhora a legibilidade do código e torna mais fácil ajustar o comportamento visual, se necessário.
const DROP_INDICATOR_GAP = 5; // Espaçamento em pixels acima/abaixo do cartão de destino
const DROP_INDICATOR_HEIGHT = 3; // Deve corresponder à altura do indicador no CSS

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
        
        // BUGFIX [2024-09-05]: Limpa explicitamente a classe 'drag-over' quando o cursor sai de uma zona de soltura válida.
        // Isso corrige o bug onde a borda azul ficava presa se o usuário arrastasse para fora da área de soltura.
        if (dropZone !== currentDropZoneTarget) {
            currentDropZoneTarget?.classList.remove('drag-over', 'invalid-drop');
        }
        
        if (!dropZone) {
            currentDropZoneTarget = null;
            e.dataTransfer!.dropEffect = 'none';
            return;
        }

        currentDropZoneTarget = dropZone;

        const newTime = dropZone.dataset.time as TimeOfDay;
        const cardTarget = target.closest<HTMLElement>('.habit-card');

        // BUGFIX [2024-08-19]: A lógica de arrastar e soltar foi refatorada para unificar a reordenação e a movimentação.
        // O indicador de soltura agora é movido dinamicamente para o DOM do novo grupo, e a condição que restringia
        // a reordenação ao grupo original foi removida, permitindo uma experiência de usuário mais fluida e intuitiva.
        
        // Etapa 1: Mover o indicador para o contêiner correto, se necessário.
        if (dropIndicator && dropIndicator.parentElement !== dropZone) {
            dropZone.appendChild(dropIndicator);
        }

        // CORREÇÃO DE BUG DE ESTADO VISUAL [2024-09-23]: A lógica de feedback visual foi refatorada para ser mutuamente exclusiva.
        // O uso de `classList.toggle` garante que apenas um estado (válido ou inválido) seja exibido por vez,
        // corrigindo um bug onde ambas as classes poderiam ser aplicadas simultaneamente.
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(draggedHabitObject, state.selectedDate);
        const isInvalidDrop = newTime !== draggedHabitOriginalTime && scheduleForDay.includes(newTime);

        dropZone.classList.toggle('invalid-drop', isInvalidDrop);
        dropZone.classList.toggle('drag-over', !isInvalidDrop);

        if (isInvalidDrop) {
            e.dataTransfer!.dropEffect = 'none';
            // Garante que o indicador de reordenação não apareça em uma zona inválida.
            if (dropIndicator) {
                dropIndicator.classList.remove('visible');
            }
            return;
        }
        
        // Etapa 3: A movimentação é válida, definir dropEffect.
        e.dataTransfer!.dropEffect = 'move';
        
        // Etapa 4: Lidar com a reordenação visual se estiver sobre outro cartão.
        if (cardTarget && cardTarget !== draggedElement) {
            const targetRect = cardTarget.getBoundingClientRect();
            const midY = targetRect.top + targetRect.height / 2;
            const position = e.clientY < midY ? 'before' : 'after';

            const indicatorTop = position === 'before'
                ? cardTarget.offsetTop - DROP_INDICATOR_GAP
                : cardTarget.offsetTop + cardTarget.offsetHeight + DROP_INDICATOR_GAP;
            
            if (dropIndicator) {
                dropIndicator.style.top = `${indicatorTop - (DROP_INDICATOR_HEIGHT / 2)}px`; // Centraliza o indicador no espaço
                dropIndicator.classList.add('visible');
                dropIndicator.dataset.targetId = cardTarget.dataset.habitId;
                dropIndicator.dataset.position = position;
            }
        }
    };

    // REFACTOR [2024-09-06]: Lógica de soltura refatorada para maior clareza e correção de bug.
    const handleBodyDrop = (e: DragEvent) => {
        e.preventDefault();
        
        // CORREÇÃO DE ROBUSTEZ [2024-09-18]: Remove os listeners de arrasto do corpo imediatamente
        // após o soltar para prevenir "listeners pendentes" e condições de corrida caso o
        // evento `dragend` seja atrasado ou falhe.
        document.body.removeEventListener('dragover', handleBodyDragOver);
        document.body.removeEventListener('drop', handleBodyDrop);

        // 1. Captura os dados necessários para a lógica de soltura antes de limpar a UI.
        const reorderTargetId = dropIndicator?.dataset.targetId;
        const reorderPosition = dropIndicator?.dataset.position as 'before' | 'after';
        const isDropIndicatorVisible = dropIndicator?.classList.contains('visible');
        const dropZone = currentDropZoneTarget;
        const newTime = dropZone?.dataset.time as TimeOfDay | undefined;

        // 2. BUGFIX: Limpa o estado visual (borda azul/vermelha) imediatamente no evento 'drop'.
        // Isso previne uma condição de corrida onde a limpeza em 'dragend' ocorria após a
        // re-renderização do DOM, deixando a referência ao elemento obsoleta e a borda presa.
        dropZone?.classList.remove('drag-over', 'invalid-drop');
        if (dropIndicator) {
            dropIndicator.classList.remove('visible');
        }

        if (!draggedHabitId || !draggedHabitOriginalTime || !newTime) return;
        
        // 3. Determina a ação: Mover para um novo grupo ou Reordenar dentro do mesmo grupo.
        const isMovingGroup = newTime !== draggedHabitOriginalTime;
        const isReordering = isDropIndicatorVisible && reorderTargetId && draggedHabitId !== reorderTargetId;

        if (isMovingGroup) {
            handleHabitDrop(draggedHabitId, draggedHabitOriginalTime, newTime);
        } else if (isReordering) {
            reorderHabit(draggedHabitId, reorderTargetId, reorderPosition);
        }
    };
    
    const cleanupDrag = () => {
        draggedElement?.classList.remove('dragging');
        document.body.classList.remove('is-dragging-active');
        
        // A limpeza visual principal agora ocorre em 'handleBodyDrop' para evitar race conditions.
        // Esta função limpa as referências restantes e os listeners.
        currentDropZoneTarget?.classList.remove('drag-over', 'invalid-drop'); // Redundante, mas seguro
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