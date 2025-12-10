

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. Implementada otimização de renderização no evento 'dragover' para evitar layout thrashing e removida redundância na limpeza de listeners (DRY).
// UX UPDATE [2025-01-17]: Adicionado Auto-Scroll suave para permitir arrastar itens para fora da área visível atual.
// PERFORMANCE UPDATE [2025-01-20]: Decoupled Rendering. Visual updates now run in a rAF loop separate from the high-frequency dragover event.
// FIX [2025-02-23]: Updated Auto-Scroll to target 'main' element due to Flow Layout change.

import { ui } from './ui';
import { isCurrentlySwiping } from './swipeHandler';
import { handleHabitDrop, reorderHabit } from './habitActions';
import { state, TimeOfDay, Habit, getEffectiveScheduleForHabitOnDate } from './state';
import { triggerHaptic } from './utils';

const DROP_INDICATOR_GAP = 5; // Espaçamento em pixels acima/abaixo do cartão de destino
const DROP_INDICATOR_HEIGHT = 3; // Deve corresponder à altura do indicador no CSS

// Constantes para Auto-Scroll
const SCROLL_ZONE_SIZE = 150; // Increased zone size for better reachability
const BASE_SCROLL_SPEED = 10;
const MAX_SCROLL_SPEED = 30; // Increased speed for smoother traversal

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
    let scrollContainer: HTMLElement | null = null;

    /**
     * UX & PERFORMANCE: Loop de animação unificado para Auto-Scroll e Atualizações Visuais.
     * Separa a leitura de eventos (input) da escrita no DOM (output).
     */
    function _animationLoop() {
        // 1. Auto-Scroll Logic
        if (scrollVelocity !== 0 && scrollContainer) {
            scrollContainer.scrollBy(0, scrollVelocity);
        }

        // 2. Visual Updates Logic (Dirty Checking)
        
        // Atualiza Drop Zone (Highlight)
        if (nextDropZoneTarget !== currentRenderedDropZone) {
            if (currentRenderedDropZone) {
                currentRenderedDropZone.classList.remove('drag-over', 'invalid-drop');
            }
            currentRenderedDropZone = nextDropZoneTarget;
        }

        if (currentRenderedDropZone) {
            // Aplica classes de validação apenas se necessário
            const shouldBeInvalid = !isDropValid;
            const shouldBeDragOver = isDropValid && currentRenderedDropZone.dataset.time !== draggedHabitOriginalTime;

            if (currentRenderedDropZone.classList.contains('invalid-drop') !== shouldBeInvalid) {
                currentRenderedDropZone.classList.toggle('invalid-drop', shouldBeInvalid);
            }
            if (currentRenderedDropZone.classList.contains('drag-over') !== shouldBeDragOver) {
                currentRenderedDropZone.classList.toggle('drag-over', shouldBeDragOver);
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
        const dropZone = target.closest<HTMLElement>('.drop-zone');
        
        // UX: Lógica de detecção de borda para Auto-Scroll
        // Find the scrollable container (#habit-container) dynamically
        if (!scrollContainer) {
            scrollContainer = document.getElementById('habit-container');
        }

        // AUTO-SCROLL LOGIC UPDATE [2025-02-23]: Global Viewport Detection.
        // Instead of calculating relative to the container element (which can be tricky with complex layouts),
        // we use absolute viewport coordinates. If the finger/cursor is at the top/bottom of the SCREEN,
        // we scroll the container.
        if (scrollContainer) {
            const { clientY } = e;
            const viewportHeight = window.innerHeight;
            
            // Top Zone: 0 to SCROLL_ZONE_SIZE
            if (clientY < SCROLL_ZONE_SIZE) {
                // Moving UP: Closer to 0 = Faster speed
                const intensity = 1 - (Math.max(0, clientY) / SCROLL_ZONE_SIZE);
                scrollVelocity = -(BASE_SCROLL_SPEED + (intensity * intensity * (MAX_SCROLL_SPEED - BASE_SCROLL_SPEED)));
            } 
            // Bottom Zone: (Height - Zone) to Height
            else if (clientY > (viewportHeight - SCROLL_ZONE_SIZE)) {
                // Moving DOWN: Closer to bottom = Faster speed
                const intensity = 1 - ((viewportHeight - clientY) / SCROLL_ZONE_SIZE);
                scrollVelocity = BASE_SCROLL_SPEED + (intensity * intensity * (MAX_SCROLL_SPEED - BASE_SCROLL_SPEED));
            } 
            else {
                scrollVelocity = 0;
            }
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
        // É inválido se tentar mover para um grupo onde o hábito já existe (exceto se for o mesmo grupo, que é reordenação)
        const isInvalidDrop = !isSameGroup && scheduleForDay.includes(newTime);
        
        isDropValid = !isInvalidDrop;

        // Cálculo da posição do indicador
        const cardTarget = target.closest<HTMLElement>('.habit-card');
        if (cardTarget && cardTarget !== draggedElement) {
            const targetRect = cardTarget.getBoundingClientRect();
            // Calculation needs to be relative to the parent drop zone (which is relatively positioned)
            // But offsetTop works relative to the parent anyway.
            const midY = targetRect.top + targetRect.height / 2;
            const position = e.clientY < midY ? 'before' : 'after';

            const indicatorTopVal = position === 'before'
                ? cardTarget.offsetTop - DROP_INDICATOR_GAP
                : cardTarget.offsetTop + cardTarget.offsetHeight + DROP_INDICATOR_GAP;

            nextIndicatorTop = `${indicatorTopVal - (DROP_INDICATOR_HEIGHT / 2)}px`;
            nextReorderTargetId = cardTarget.dataset.habitId || null;
            nextReorderPosition = position;
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
        
        // Reset scroll container reference
        scrollContainer = null;
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
        draggedElement?.classList.remove('dragging');
        document.body.classList.remove('is-dragging-active');
        
        if (currentRenderedDropZone) {
            currentRenderedDropZone.classList.remove('drag-over', 'invalid-drop');
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
        const cardContent = (e.target as HTMLElement).closest<HTMLElement>('.habit-content-wrapper');
        const card = cardContent?.closest<HTMLElement>('.habit-card');
        if (card && cardContent && card.dataset.habitId && card.dataset.time) {
            triggerHaptic('light');
            draggedElement = card;
            draggedHabitId = card.dataset.habitId;
            draggedHabitOriginalTime = card.dataset.time as TimeOfDay;
            draggedHabitObject = state.habits.find(h => h.id === draggedHabitId) || null;

            e.dataTransfer!.setData('text/plain', draggedHabitId);
            e.dataTransfer!.effectAllowed = 'move';

            const dragImage = cardContent.cloneNode(true) as HTMLElement;
            dragImage.classList.add('drag-image-ghost');
            
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
            
            document.body.classList.add('is-dragging-active');
            document.body.addEventListener('dragover', handleBodyDragOver);
            document.body.addEventListener('drop', handleBodyDrop);
            document.body.addEventListener('dragend', cleanupDrag, { once: true });

            // Inicia o loop de renderização desacoplado
            _startAnimationLoop();

            setTimeout(() => {
                card.classList.add('dragging');
            }, 0);
        }
    });
}