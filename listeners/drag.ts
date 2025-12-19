/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { ui } from '../render/ui';
import { isCurrentlySwiping } from './swipe';
import { handleHabitDrop, reorderHabit } from '../habitActions';
import { state, TimeOfDay, Habit, getEffectiveScheduleForHabitOnDate } from '../state';
import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

const DROP_INDICATOR_GAP = 5; 
const DROP_INDICATOR_HEIGHT = 3; 

// CALIBRAÇÃO DE FÍSICA [2025-03-04]:
// Zona de 120px. Velocidade quadrática para controle preciso.
// Curva: v = MAX * (proximidade ^ 2).
const SCROLL_ZONE_SIZE = 120;
const MAX_SCROLL_SPEED = 15; // Aumentado levemente pois a curva quadrática é mais suave na média

export function setupDragHandler(habitContainer: HTMLElement) {
    let draggedElement: HTMLElement | null = null;
    let draggedHabitId: string | null = null;
    let draggedHabitObject: Habit | null = null; 
    let draggedHabitOriginalTime: TimeOfDay | null = null;
    let dropIndicator: HTMLElement | null = null;
    
    // Render State Variables
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
    
    // PERFORMANCE [2025-03-03]: Cache container bounds to avoid layout thrashing
    let cachedContainerRect: DOMRect | null = null;

    function _animationLoop() {
        if (scrollVelocity !== 0) {
            // Nota: O CSS 'scroll-behavior: auto' é forçado pela classe .is-dragging
            habitContainer.scrollBy(0, scrollVelocity);
        }

        if (nextDropZoneTarget !== currentRenderedDropZone) {
            if (currentRenderedDropZone) {
                currentRenderedDropZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
            }
            currentRenderedDropZone = nextDropZoneTarget;
        }

        if (currentRenderedDropZone) {
            const shouldBeInvalid = !isDropValid;
            const shouldBeDragOver = isDropValid && currentRenderedDropZone.dataset.time !== draggedHabitOriginalTime;

            if (currentRenderedDropZone.classList.contains(CSS_CLASSES.INVALID_DROP) !== shouldBeInvalid) {
                currentRenderedDropZone.classList.toggle(CSS_CLASSES.INVALID_DROP, shouldBeInvalid);
            }
            if (currentRenderedDropZone.classList.contains(CSS_CLASSES.DRAG_OVER) !== shouldBeDragOver) {
                currentRenderedDropZone.classList.toggle(CSS_CLASSES.DRAG_OVER, shouldBeDragOver);
            }
            
            if (dropIndicator && dropIndicator.parentElement !== currentRenderedDropZone) {
                currentRenderedDropZone.appendChild(dropIndicator);
            }
        } else {
             if (dropIndicator && dropIndicator.parentElement) {
                 dropIndicator.remove();
             }
        }

        if (dropIndicator && currentRenderedDropZone) {
            if (isDropValid) {
                if (!dropIndicator.classList.contains('visible')) {
                    dropIndicator.classList.add('visible');
                }
                if (nextIndicatorTop !== currentIndicatorTop && nextIndicatorTop !== null) {
                    dropIndicator.style.top = nextIndicatorTop;
                    currentIndicatorTop = nextIndicatorTop;
                }
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

    function _calculateDragState(e: DragEvent) {
        const target = e.target as HTMLElement;
        
        let dropZone = target.closest<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
        if (!dropZone) {
            const wrapper = target.closest<HTMLElement>('.habit-group-wrapper');
            if (wrapper) {
                dropZone = wrapper.querySelector<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
            }
        }
        
        const { clientY } = e;
        
        const scrollContainerRect = cachedContainerRect || habitContainer.getBoundingClientRect();
        
        const topZoneEnd = scrollContainerRect.top + SCROLL_ZONE_SIZE;
        const bottomZoneStart = scrollContainerRect.bottom - SCROLL_ZONE_SIZE;

        let potentialVelocity = 0;
        
        // --- 1. CALCULAR VELOCIDADE POTENCIAL ---
        if (clientY < topZoneEnd) {
            const distance = clientY - scrollContainerRect.top;
            let ratio = (SCROLL_ZONE_SIZE - distance) / SCROLL_ZONE_SIZE;
            ratio = Math.max(0, Math.min(1, ratio));
            const intensity = ratio * ratio; 
            potentialVelocity = -(intensity * MAX_SCROLL_SPEED);
            if (potentialVelocity > -1 && potentialVelocity < 0) potentialVelocity = -1;

        } else if (clientY > bottomZoneStart) {
            const distance = scrollContainerRect.bottom - clientY;
            let ratio = (SCROLL_ZONE_SIZE - distance) / SCROLL_ZONE_SIZE;
            ratio = Math.max(0, Math.min(1, ratio));
            const intensity = ratio * ratio;
            potentialVelocity = intensity * MAX_SCROLL_SPEED;
            if (potentialVelocity < 1 && potentialVelocity > 0) potentialVelocity = 1;
        }

        // --- 2. VERIFICAÇÃO DE LIMITES (PROATIVA) ---
        let finalVelocity = potentialVelocity;
        
        if (potentialVelocity < 0 && habitContainer.scrollTop <= 0) {
            finalVelocity = 0;
        } else if (potentialVelocity > 0) {
            const atScrollEnd = habitContainer.scrollTop >= (habitContainer.scrollHeight - habitContainer.clientHeight);
            
            // BUGFIX: Adiciona verificação geométrica para o último elemento.
            // Se o último grupo já estiver totalmente visível, não devemos rolar.
            const lastGroupWrapper = habitContainer.querySelector('.habit-group-wrapper:last-child');
            let isLastElementVisible = false;
            if (lastGroupWrapper) {
                const lastGroupRect = lastGroupWrapper.getBoundingClientRect();
                isLastElementVisible = lastGroupRect.bottom <= scrollContainerRect.bottom;
            }

            if (atScrollEnd || isLastElementVisible) {
                finalVelocity = 0;
            }
        }
        
        scrollVelocity = finalVelocity;

        // --- 3. LÓGICA DE ZONA DE SOLTURA (DROP ZONE) ---
        if (!draggedHabitObject || !draggedHabitOriginalTime || !dropZone) {
            nextDropZoneTarget = null;
            isDropValid = false;
            return;
        }

        nextDropZoneTarget = dropZone;
        const newTime = dropZone.dataset.time as TimeOfDay;
        const scheduleForDay = getEffectiveScheduleForHabitOnDate(draggedHabitObject, state.selectedDate);
        
        const isSameGroup = newTime === draggedHabitOriginalTime;
        let isInvalidDrop = !isSameGroup && scheduleForDay.includes(newTime);
    
        if (!isSameGroup && scheduleForDay.length <= 1) {
            isInvalidDrop = false; 
        }
    
        isDropValid = !isInvalidDrop;

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
            nextReorderTargetId = null;
            nextReorderPosition = null;
            nextIndicatorTop = null; 
        }
    }

    function _determineAndExecuteDropAction() {
        if (!draggedHabitId || !draggedHabitOriginalTime) return;
        
        const reorderTargetId = nextReorderTargetId;
        const reorderPosition = nextReorderPosition;
        const newTime = nextDropZoneTarget?.dataset.time as TimeOfDay | undefined;

        if (!newTime || !isDropValid) return;

        const isMovingGroup = newTime !== draggedHabitOriginalTime;
        const isReordering = reorderTargetId && draggedHabitId !== reorderTargetId;

        if (isMovingGroup) {
            triggerHaptic('medium');
            handleHabitDrop(
                draggedHabitId, 
                draggedHabitOriginalTime, 
                newTime,
                isReordering && reorderTargetId ? { id: reorderTargetId, pos: reorderPosition! } : undefined
            );
        } else if (isReordering) {
            triggerHaptic('medium');
            reorderHabit(draggedHabitId, reorderTargetId!, reorderPosition!);
        }
    }

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
        
        cachedContainerRect = null; // Clear cache
    }


    const handleBodyDragOver = (e: DragEvent) => {
        e.preventDefault(); 
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
        draggedElement?.classList.remove(CSS_CLASSES.DRAGGING);
        document.body.classList.remove('is-dragging-active');
        
        habitContainer.classList.remove('is-dragging');
        
        if (currentRenderedDropZone) {
            currentRenderedDropZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
        }
        
        dropIndicator?.remove();
        _stopAnimationLoop();
        
        document.body.removeEventListener('dragover', handleBodyDragOver);
        document.body.removeEventListener('drop', handleBodyDrop);

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
            draggedHabitObject = state.habits.find(h => h.id === draggedHabitId) || null;
            
            cachedContainerRect = habitContainer.getBoundingClientRect();

            e.dataTransfer!.setData('text/plain', draggedHabitId);
            e.dataTransfer!.effectAllowed = 'move';

            const dragImage = cardContent.cloneNode(true) as HTMLElement;
            dragImage.classList.add(CSS_CLASSES.DRAG_IMAGE_GHOST);
            
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
            
            document.body.addEventListener('dragover', handleBodyDragOver);
            document.body.addEventListener('drop', handleBodyDrop);
            document.body.addEventListener('dragend', cleanupDrag, { once: true });

            _startAnimationLoop();

            setTimeout(() => {
                document.body.classList.add('is-dragging-active');
                card.classList.add(CSS_CLASSES.DRAGGING);
                habitContainer.classList.add('is-dragging');
            }, 0);
        }
    });
}