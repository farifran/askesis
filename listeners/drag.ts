
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

// UX IMPROVEMENT [2025-03-09]: Magnetic Threshold.
// Distância em pixels para "sugar" o item para dentro de um grupo vazio.
const MAGNETIC_THRESHOLD = 60; 

// Advanced Physics Cache Interface
interface ZoneGeometry {
    element: HTMLElement;
    initialTop: number;
    initialBottom: number;
    height: number;
}

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
    
    // PERFORMANCE [2025-03-09]: ZERO-REFLOW CACHE
    // Armazena geometrias estáticas relativas ao topo do documento (offset)
    // para calcular colisões magneticamente sem ler o DOM.
    let cachedEmptyZones: ZoneGeometry[] = [];
    let initialContainerScrollTop = 0;

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
        const { clientY } = e;
        
        // --- 1. DETECT DROP ZONE ---
        let dropZone: HTMLElement | null = null;
        let isMagnetized = false;

        // First check: Direct hover (Standard behavior)
        dropZone = target.closest<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
        if (!dropZone) {
            const wrapper = target.closest<HTMLElement>('.habit-group-wrapper');
            if (wrapper) {
                dropZone = wrapper.querySelector<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
            }
        }

        // UX IMPROVEMENT: Magnetic Pull for Empty Groups
        // ALGORITHMIC OPTIMIZATION [2025-03-09]: Projection Math.
        // Instead of querying DOM Rects (slow), calculate current position based on initial cache + scroll delta.
        // Formula: CurrentY = InitialY - (CurrentScrollTop - InitialScrollTop) + ContainerOffset.
        
        if (cachedContainerRect && cachedEmptyZones.length > 0) {
            // We need current container rect because the whole page doesn't scroll, but the container does.
            // Actually, getBoundingClientRect is relative to viewport.
            // If the container scrolls, the elements move up.
            // CurrentY = InitialRectY - (CurrentScroll - InitialScroll).
            
            const currentScrollTop = habitContainer.scrollTop;
            const scrollDelta = currentScrollTop - initialContainerScrollTop;
            
            let bestCandidate: HTMLElement | null = null;
            let minDistance = Infinity;

            for (const zoneGeom of cachedEmptyZones) {
                // Project the zone's current Y center relative to the viewport
                const projectedTop = zoneGeom.initialTop - scrollDelta;
                const projectedCenterY = projectedTop + (zoneGeom.height / 2);
                
                const dist = Math.abs(clientY - projectedCenterY);
                
                if (dist < MAGNETIC_THRESHOLD) {
                    if (dist < minDistance) {
                        minDistance = dist;
                        bestCandidate = zoneGeom.element;
                    }
                }
            }
            
            // Magnet wins if found
            if (bestCandidate) {
                dropZone = bestCandidate;
                isMagnetized = true;
            }
        }

        // --- 2. CALCULATE SCROLL VELOCITY ---
        
        // PERFORMANCE: Use cached rect
        const scrollContainerRect = cachedContainerRect || habitContainer.getBoundingClientRect();
        
        const topZoneEnd = scrollContainerRect.top + SCROLL_ZONE_SIZE;
        const bottomZoneStart = scrollContainerRect.bottom - SCROLL_ZONE_SIZE;

        // Stabilize scroll if magnetized (prevent jitter when dropping into empty slot)
        const scrollDampener = isMagnetized ? 0 : 1; 

        // Topo
        if (clientY < topZoneEnd) {
            const distance = clientY - scrollContainerRect.top;
            let ratio = (SCROLL_ZONE_SIZE - distance) / SCROLL_ZONE_SIZE;
            ratio = Math.max(0, Math.min(1, ratio));
            const intensity = ratio * ratio; 
            
            scrollVelocity = -(intensity * MAX_SCROLL_SPEED) * scrollDampener;
            
            if (scrollVelocity > -1 && scrollVelocity < 0) scrollVelocity = -1;
        } 
        // Fundo
        else if (clientY > bottomZoneStart) {
            const distance = scrollContainerRect.bottom - clientY;
            let ratio = (SCROLL_ZONE_SIZE - distance) / SCROLL_ZONE_SIZE;
            ratio = Math.max(0, Math.min(1, ratio));
            const intensity = ratio * ratio;
            
            scrollVelocity = (intensity * MAX_SCROLL_SPEED) * scrollDampener;
            
            if (scrollVelocity < 1 && scrollVelocity > 0) scrollVelocity = 1;
        } 
        else {
            scrollVelocity = 0;
        }

        // --- 3. VALIDATE DROP LOGIC ---

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

        // Calculate Position Indicator
        // If magnetized to an empty group, just show indicator at top (or hidden inside placeholder logic)
        const hasCards = dropZone.querySelectorAll(DOM_SELECTORS.HABIT_CARD).length > 0;

        if (hasCards) {
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
                // Hovering over group but not specific card (e.g. gap) - Append to end
                // Reset reorder specific targets to null so it appends
                nextReorderTargetId = null;
                nextReorderPosition = null;
                // Position indicator at bottom of list
                const lastCard = dropZone.lastElementChild as HTMLElement;
                if (lastCard && lastCard !== dropIndicator) {
                     nextIndicatorTop = `${lastCard.offsetTop + lastCard.offsetHeight + DROP_INDICATOR_GAP}px`;
                } else {
                     nextIndicatorTop = '0px';
                }
            }
        } else {
            // Empty group (Magnetized or Hovered)
            // Center the indicator or put it at the top relative to placeholder
            const placeholder = dropZone.querySelector(DOM_SELECTORS.EMPTY_GROUP_PLACEHOLDER) as HTMLElement;
            if (placeholder) {
                nextIndicatorTop = `${placeholder.offsetTop}px`;
            } else {
                nextIndicatorTop = '0px';
            }
            nextReorderTargetId = null;
            nextReorderPosition = null;
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
        cachedEmptyZones = []; // Clear cache
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
        
        // FIX [2025-03-04]: Restore smooth scrolling on container
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
            
            // PERFORMANCE: Cache the container rect ONCE at start
            cachedContainerRect = habitContainer.getBoundingClientRect();
            initialContainerScrollTop = habitContainer.scrollTop;
            
            // PERFORMANCE [2025-03-09]: Pre-calculate geometry of potential magnetic targets (Empty Zones).
            // This allows dragover to run at 60fps without touching the DOM.
            const allDropZones = Array.from(habitContainer.querySelectorAll(DOM_SELECTORS.DROP_ZONE));
            cachedEmptyZones = [];
            
            for (const zone of allDropZones) {
                // If zone has no cards (or only the placeholder), it's a candidate for magnetism
                if (!zone.querySelector(DOM_SELECTORS.HABIT_CARD)) {
                    const rect = zone.getBoundingClientRect();
                    cachedEmptyZones.push({
                        element: zone as HTMLElement,
                        initialTop: rect.top, // Viewport relative at start
                        initialBottom: rect.bottom,
                        height: rect.height
                    });
                }
            }

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
                // FIX [2025-03-04]: Disable smooth scrolling on container to prevent physics conflict
                habitContainer.classList.add('is-dragging');
            }, 0);
        }
    });
}
