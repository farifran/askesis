/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from './ui';
import { isCurrentlySwiping } from './swipeHandler';
import { handleHabitDrop, reorderHabit } from './habitActions';
import { state, TimeOfDay, Habit, getEffectiveScheduleForHabitOnDate } from './state';
import { triggerHaptic } from './utils';
import { DOM_SELECTORS, CSS_CLASSES } from './domConstants';

const DROP_INDICATOR_GAP = 5; // Espaçamento em pixels acima/abaixo do cartão de destino
const DROP_INDICATOR_HEIGHT = 3; // Deve corresponder à altura do indicador no CSS

// Constantes para Auto-Scroll
const SCROLL_ZONE_SIZE = 200; // Increased zone size for better reachability
const BASE_SCROLL_SPEED = 60;
const MAX_SCROLL_SPEED = 180;

export function setupDragAndDropHandler(habitContainer: HTMLElement) {
    let draggedElement: HTMLElement | null = null;
    let draggedHabitId: string | null = null;
    let draggedHabitObject: Habit | null = null; 
    let draggedHabitOriginalTime: TimeOfDay | null = null;
    let dropIndicator: HTMLElement | null = null;
    
    // Render State Variables (Decoupled form DOM)
    let nextDropZoneTarget: HTMLElement | null = null;
    let currentRenderedDropZone: HTMLElement | null = null;
    
    let nextIndicatorTop: string | null = null;
    let currentIndicatorTop: string | null = null;
    
    let nextReorderTargetId: string | null = null;
    let nextReorderPosition: 'before' | 'after' | null = null;
    let isDropValid = false;

    // Variáveis de estado para Auto-Scroll
    let scrollVelocity = 0;
    let animationFrameId: number | null = null;

    /**
     * UX & PERFORMANCE: Loop de animação unificado para Auto-Scroll e Atualizações Visuais.
     * Separa a leitura de eventos (input) da escrita no DOM (output).
     */
    function _animationLoop() {
        // 1. Auto-Scroll Logic
        if (scrollVelocity !== 0) {
            habitContainer.scrollBy(0, scrollVelocity);
        }

        // 2. Visual Updates Logic (Dirty Checking)
        
        // Atualiza Drop Zone (Highlight)
        if (nextDropZoneTarget !== currentRenderedDropZone) {
            if (currentRenderedDropZone) {
                currentRenderedDropZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
            }
            currentRenderedDropZone = nextDropZoneTarget;
        }

        if (currentRenderedDropZone) {
            // Aplica classes de validação apenas se necessário
            const shouldBeInvalid = !isDropValid;
            const shouldBeDragOver = isDropValid && currentRenderedDropZone.dataset.time !== draggedHabitOriginalTime;

            if (currentRenderedDropZone.classList.contains(CSS_CLASSES.INVALID_DROP) !== shouldBeInvalid) {
                currentRenderedDropZone.classList.toggle(CSS_CLASSES.INVALID_DROP, shouldBeInvalid);
            }
            if (currentRenderedDropZone.classList.contains(CSS_CLASSES.DRAG_OVER) !== shouldBeDragOver) {
                currentRenderedDropZone.classList.toggle(CSS_CLASSES.DRAG_OVER, shouldBeDragOver);
            }
            
            // Garante que o indicador esteja no container correto
            if (dropIndicator && dropIndicator.parentElement !== currentRenderedDropZone) {
                currentRenderedDropZone.appendChild(dropIndicator);
            }
        } else {
             if (dropIndicator && dropIndicator.parentElement) {
                 dropIndicator.remove(); // Remove se não houver drop zone válida
             }
        }

        // Atualiza Indicador de Posição
        if (dropIndicator && currentRenderedDropZone) {
            if (isDropValid) {
                if (!dropIndicator.classList.contains('visible')) {
                    dropIndicator.classList.add('visible');
                }
                // Só atualiza o estilo top se mudou
                if (nextIndicatorTop !== currentIndicatorTop && nextIndicatorTop !== null) {
                    dropIndicator.style.top = nextIndicatorTop;
                    currentIndicatorTop = nextIndicatorTop;
                }
                // Atualiza datasets para lógica
                if (nextReorderTargetId) dropIndicator.dataset.targetId = nextReorderTargetId;
                if (nextReorderPosition) dropIndicator.dataset.position = nextReorderPosition;
            } else {
                if (dropIndicator.classList.contains('visible')) {
                    dropIndicator.classList.remove('visible');
                }
            }
        }

        animationFrameId = requestAnimationFrame(_animationLoop);
    }

    function _startAnimationLoop() {
        if (!animationFrameId) {
            animationFrameId = requestAnimationFrame(_animationLoop);
        }
    }

    function _stopAnimationLoop() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        scrollVelocity = 0;
    }

    /**
     * Lógica de cálculo de estado ( executada no dragover).
     * Não toca no DOM, apenas atualiza variáveis de estado.
     */
    function _calculateDragState(e: DragEvent) {
        const target = e.target as HTMLElement;
        
        // UX IMPROVEMENT [2025-02-25]: Robust Drop Zone Detection.
        // Instead of requiring the user to hover precisely over the list (UL), we allow hovering
        // anywhere inside the wrapper (including the time marker or padding). This prevents
        // the "stuck card" feeling when dragging to an empty group.
        let dropZone = target.closest<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
        if (!dropZone) {
            // If not directly over the list, check if we are in the wrapper and find the list inside it.
            const wrapper = target.closest<HTMLElement>('.habit-group-wrapper');
            if (wrapper) {
                dropZone = wrapper.querySelector<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
            }
        }
        
        // UX: Lógica de detecção de borda para Auto-Scroll
        const { clientY } = e;
        const scrollContainerRect = habitContainer.getBoundingClientRect();
        
        const topZoneEnd = scrollContainerRect.top + SCROLL_ZONE_SIZE;
        const bottomZoneStart = scrollContainerRect.bottom - SCROLL_ZONE_SIZE;

        if (clientY < topZoneEnd && clientY > scrollContainerRect.top) {
            const intensity = Math.sqrt(1 - (clientY - scrollContainerRect.top) / SCROLL_ZONE_SIZE);
            scrollVelocity = -(BASE_SCROLL_SPEED + (intensity * (MAX_SCROLL_SPEED - BASE_SCROLL_SPEED)));
        } 
        else if (clientY > bottomZoneStart && clientY < scrollContainerRect.bottom) {
            const intensity = Math.sqrt((clientY - bottomZoneStart) / SCROLL_ZONE_SIZE);
            scrollVelocity = BASE_SCROLL_SPEED + (intensity * (MAX_SCROLL_SPEED - BASE_SCROLL_SPEED));
        } 
        else {
            scrollVelocity = 0;
        }

        if (!draggedHabitObject || !draggedHabitOriginalTime || !dropZone) {
            nextDropZoneTarget = null;
            isDropValid = false;
            return;
        }

        nextDropZoneTarget = dropZone;
        const newTime = dropZone.dataset.time as TimeOfDay;
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(draggedHabitObject, state.selectedDate);
        
        const isSameGroup = newTime === draggedHabitOriginalTime;
        
        // Normal validation: Invalid if different group AND target group already contains this habit.
        let isInvalidDrop = !isSameGroup && scheduleForDay.includes(newTime);
    
        // BUGFIX [2025-02-25]: PRIORITY OVERRIDE for Single Habit Instance.
        // If the habit effectively only has 1 instance on this day (or zero, defensively), 
        // AND we are moving it to a DIFFERENT group, we explicitly ALLOW the move.
        // This bypasses any subtle cache/state desync issues that might falsely flag 'isInvalidDrop' as true.
        // We do NOT override for `isSameGroup` because dragging to the same group without reordering targets is a no-op anyway.
        if (!isSameGroup && scheduleForDay.length <= 1) {
            isInvalidDrop = false; 
        }
    
        isDropValid = !isInvalidDrop;

        // Cálculo da posição do indicador
        const cardTarget = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (cardTarget && cardTarget !== draggedElement && cardTarget.parentElement === dropZone) {
            const targetRect = cardTarget.getBoundingClientRect();
            const midY = targetRect.top + targetRect.height / 2;
            const position = e.clientY < midY ? 'before' : 'after';

            const indicatorTopVal = position === 'before'
                ? cardTarget.offsetTop - DROP_INDICATOR_GAP
                : cardTarget.offsetTop + cardTarget.offsetHeight + DROP_INDICATOR_GAP;

            nextIndicatorTop = `${indicatorTopVal - (DROP_INDICATOR_HEIGHT / 2)}px`;
            nextReorderTargetId = cardTarget.dataset.habitId || null;
            nextReorderPosition = position;
        } else {
            // Default to appending if not over a card
            nextReorderTargetId = null;
            nextReorderPosition = null;
            nextIndicatorTop = null; // Let CSS handle default or hide it
        }
    }

    /**
     * REATORAÇÃO DE MODULARIDADE: Determina e executa a ação de soltar apropriada.
     */
    function _determineAndExecuteDropAction() {
        if (!draggedHabitId || !draggedHabitOriginalTime) return;
        
        // Lê o estado final das variáveis, não do DOM
        const reorderTargetId = nextReorderTargetId;
        const reorderPosition = nextReorderPosition;
        const newTime = nextDropZoneTarget?.dataset.time as TimeOfDay | undefined;

        if (!newTime || !isDropValid) return;

        const isMovingGroup = newTime !== draggedHabitOriginalTime;
        const isReordering = reorderTargetId && draggedHabitId !== reorderTargetId;

        if (isMovingGroup) {
            triggerHaptic('medium');
            handleHabitDrop(draggedHabitId, draggedHabitOriginalTime, newTime);
        } else if (isReordering) {
            triggerHaptic('medium');
            reorderHabit(draggedHabitId, reorderTargetId!, reorderPosition!);
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
        
        nextDropZoneTarget = null;
        currentRenderedDropZone = null;
        nextIndicatorTop = null;
        currentIndicatorTop = null;
        nextReorderTargetId = null;
        nextReorderPosition = null;
        isDropValid = false;
    }


    const handleBodyDragOver = (e: DragEvent) => {
        e.preventDefault(); // Necessário para permitir drop
        _calculateDragState(e);
        
        if (isDropValid) {
            e.dataTransfer!.dropEffect = 'move';
        } else {
            e.dataTransfer!.dropEffect = 'none';
        }
    };

    const handleBodyDrop = (e: DragEvent) => {
        e.preventDefault();
        _determineAndExecuteDropAction();
    };
    
    const cleanupDrag = () => {
        // 1. Limpa os estilos visuais aplicados durante o arrasto
        draggedElement?.classList.remove(CSS_CLASSES.DRAGGING);
        document.body.classList.remove('is-dragging-active');
        
        if (currentRenderedDropZone) {
            currentRenderedDropZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
        }
        
        // 2. Remove elementos temporários do DOM
        dropIndicator?.remove();
        
        // 3. Para o loop de animação
        _stopAnimationLoop();
        
        // 4. Remove os listeners de eventos globais para evitar vazamentos de memória
        document.body.removeEventListener('dragover', handleBodyDragOver);
        document.body.removeEventListener('drop', handleBodyDrop);

        // 5. Reseta todas as variáveis de estado internas para a próxima operação de arrasto
        _resetDragState();
    };

    habitContainer.addEventListener('dragstart', e => {
        if (isCurrentlySwiping()) {
            e.preventDefault();
            return;
        }
        const cardContent = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        const card = cardContent?.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (card && cardContent && card.dataset.habitId && card.dataset.time) {
            triggerHaptic('light');
            draggedElement = card;
            draggedHabitId = card.dataset.habitId;
            draggedHabitOriginalTime = card.dataset.time as TimeOfDay;
            // UPDATE: Ensure fresh habit object reference from state
            draggedHabitObject = state.habits.find(h => h.id === draggedHabitId) || null;

            e.dataTransfer!.setData('text/plain', draggedHabitId);
            e.dataTransfer!.effectAllowed = 'move';

            const dragImage = cardContent.cloneNode(true) as HTMLElement;
            dragImage.classList.add(CSS_CLASSES.DRAG_IMAGE_GHOST);
            
            // FIX [2025-01-17]: Copia estilos computados críticos para garantir que a imagem de arrasto
            // mantenha a aparência visual exata (cor, bordas arredondadas), já que ao ser anexada
            // ao body ela perde o contexto dos seletores CSS pais (ex: .habit-card.completed).
            const computedStyle = window.getComputedStyle(cardContent);
            dragImage.style.width = `${cardContent.offsetWidth}px`;
            dragImage.style.height = `${cardContent.offsetHeight}px`;
            dragImage.style.backgroundColor = computedStyle.backgroundColor;
            dragImage.style.borderRadius = computedStyle.borderRadius;
            dragImage.style.color = computedStyle.color;

            document.body.appendChild(dragImage);
            e.dataTransfer!.setDragImage(dragImage, e.offsetX, e.offsetY);
            setTimeout(() => document.body.removeChild(dragImage), 0);
            
            dropIndicator = document.createElement('div');
            dropIndicator.className = 'drop-indicator';
            // O indicador será anexado via loop de animação quando necessário
            
            document.body.addEventListener('dragover', handleBodyDragOver);
            document.body.addEventListener('drop', handleBodyDrop);
            document.body.addEventListener('dragend', cleanupDrag, { once: true });

            // Inicia o loop de renderização desacoplado
            _startAnimationLoop();

            // FIX [2025-02-26]: LAYOUT SHIFT PROTECTION.
            // Movemos a adição da classe 'is-dragging-active' para o final da fila de eventos.
            // Isso garante que o navegador tenha tempo de processar a imagem de arrasto (Drag Ghost)
            // ANTES que o layout mude drasticamente (expansão das zonas ocultas da manhã/tarde).
            // Se o layout mudar no mesmo tick do dragstart, o elemento sob o cursor muda e o browser cancela o drag.
            setTimeout(() => {
                document.body.classList.add('is-dragging-active');
                card.classList.add(CSS_CLASSES.DRAGGING);
            }, 0);
        }
    });
}
