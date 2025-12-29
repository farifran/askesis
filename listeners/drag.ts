
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/drag.ts
 * @description Motor de Física para Drag & Drop e Auto-Scroll.
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo gerencia a interação mais custosa da UI.
 * 
 * ARQUITETURA (Static State & Physics Engine):
 * - **Static State Machine:** Todo o estado mutável reside em `DragState` para evitar alocação de closures.
 * - **Read/Write Separation:** Loop de Eventos (Read/Calc) vs Loop de Renderização (Write/DOM).
 * - **Geometry Caching:** As posições de todos os cartões são cacheadas no `dragstart`.
 */

import { ui } from '../render/ui';
import { isCurrentlySwiping } from './swipe';
import { handleHabitDrop, reorderHabit } from '../habitActions';
import { TimeOfDay, state } from '../state';
import { getEffectiveScheduleForHabitOnDate } from '../services/selectors';
import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { getLiveHabitCards } from '../render/habits';

const DROP_INDICATOR_GAP = 5; 
const DROP_INDICATOR_HEIGHT = 3; 

// CALIBRAÇÃO DE FÍSICA:
const SCROLL_ZONE_SIZE = 120;
const MAX_SCROLL_SPEED = 15;

// --- STATIC PHYSICS CACHE (Module Scope / Hot Memory) ---
let _geo_topZoneEnd = 0;
let _geo_bottomZoneStart = 0;
let _geo_effectiveZone = 0;
let _geo_invEffectiveZone = 0; // Multiplier optimization
let _geo_containerTop = 0;
let _geo_containerBottom = 0;

// --- STATIC STATE SINGLETON ---
const DragState = {
    // Container Reference
    container: null as HTMLElement | null,

    // Drag Source
    draggedElement: null as HTMLElement | null,
    draggedHabitId: null as string | null,
    draggedHabitOriginalTime: null as TimeOfDay | null,
    cachedScheduleForDay: null as TimeOfDay[] | null,
    
    // UI Elements
    dropIndicator: null as HTMLElement | null,
    
    // Target State (Render Buffer)
    nextDropZoneTarget: null as HTMLElement | null,
    currentRenderedDropZone: null as HTMLElement | null,
    
    // Positioning
    nextIndicatorY: null as number | null,
    currentIndicatorY: null as number | null,
    
    // Logic State
    nextReorderTargetId: null as string | null,
    nextReorderPosition: null as 'before' | 'after' | null,
    isDropValid: false,

    // Auto-Scroll State
    scrollVelocity: 0,
    animationFrameId: 0,
    
    // Layout Snapshots
    cachedContainerRect: null as DOMRect | null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0
};

// PERFORMANCE: Geometry Cache for Habit Cards.
// Maps HabitID -> Geometry Props.
const cardRectCache = new Map<string, { offsetTop: number, localTop: number, offsetHeight: number }>();

/**
 * Snapshot geométrico do layout.
 * Deve ser chamado apenas UMA VEZ no início do arrasto.
 */
function _captureGeometryCache() {
    cardRectCache.clear();
    
    if (!DragState.container) return;

    if (!DragState.cachedContainerRect) {
        DragState.cachedContainerRect = DragState.container.getBoundingClientRect();
    }
    
    // PERF: Populate static physics cache vars
    const rectHeight = DragState.cachedContainerRect.height;
    _geo_containerTop = DragState.cachedContainerRect.top | 0; // Int
    _geo_containerBottom = DragState.cachedContainerRect.bottom | 0; // Int
    
    // Clamp scroll zone to max 50% of container
    _geo_effectiveZone = Math.min(SCROLL_ZONE_SIZE, rectHeight / 2);
    _geo_invEffectiveZone = 1 / _geo_effectiveZone; // Pre-calc division
    
    _geo_topZoneEnd = _geo_containerTop + _geo_effectiveZone;
    _geo_bottomZoneStart = _geo_containerBottom - _geo_effectiveZone;
    
    // Snapshot scroll state
    DragState.scrollTop = DragState.container.scrollTop | 0;
    DragState.scrollHeight = DragState.container.scrollHeight | 0;
    DragState.clientHeight = DragState.container.clientHeight | 0;

    // Iterate live cards directly from memory
    const liveCardsIterator = getLiveHabitCards();
    
    for (const card of liveCardsIterator) {
        if (card.isConnected && card.dataset.habitId && card !== DragState.draggedElement) {
            // Layout Read (Forces Style Recalc once)
            const rect = card.getBoundingClientRect();
            
            // Normalize geometry
            const normalizedOffsetTop = rect.top - _geo_containerTop + DragState.scrollTop;
            const localTop = card.offsetTop;

            cardRectCache.set(card.dataset.habitId, {
                offsetTop: normalizedOffsetTop,
                localTop: localTop,
                offsetHeight: rect.height
            });
        }
    }
}

// PASSIVE LISTENER: Sync scroll top without reflow
const _onScroll = () => {
    if (DragState.container) {
        DragState.scrollTop = DragState.container.scrollTop | 0;
    }
};

// --- RENDER LOOP ---

function _animationLoop() {
    if (!DragState.container) return;

    // 1. Auto-Scroll (Write)
    if (DragState.scrollVelocity !== 0) {
        DragState.container.scrollBy(0, DragState.scrollVelocity);
    }

    // 2. Drop Zone Highlighting (Write)
    if (DragState.nextDropZoneTarget !== DragState.currentRenderedDropZone) {
        if (DragState.currentRenderedDropZone) {
            DragState.currentRenderedDropZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
        }
        DragState.currentRenderedDropZone = DragState.nextDropZoneTarget;
    }

    if (DragState.currentRenderedDropZone) {
        const shouldBeInvalid = !DragState.isDropValid;
        const shouldBeDragOver = DragState.isDropValid && DragState.currentRenderedDropZone.dataset.time !== DragState.draggedHabitOriginalTime;

        // Dirty Checking
        if (DragState.currentRenderedDropZone.classList.contains(CSS_CLASSES.INVALID_DROP) !== shouldBeInvalid) {
            DragState.currentRenderedDropZone.classList.toggle(CSS_CLASSES.INVALID_DROP, shouldBeInvalid);
        }
        if (DragState.currentRenderedDropZone.classList.contains(CSS_CLASSES.DRAG_OVER) !== shouldBeDragOver) {
            DragState.currentRenderedDropZone.classList.toggle(CSS_CLASSES.DRAG_OVER, shouldBeDragOver);
        }
        
        if (DragState.dropIndicator && DragState.dropIndicator.parentElement !== DragState.currentRenderedDropZone) {
            DragState.currentRenderedDropZone.appendChild(DragState.dropIndicator);
            DragState.dropIndicator.style.transform = 'translate3d(0, 0, 0)';
        }
    } else {
         if (DragState.dropIndicator && DragState.dropIndicator.parentElement) {
             DragState.dropIndicator.remove();
         }
    }

    // 3. Drop Indicator Positioning (Write)
    if (DragState.dropIndicator && DragState.currentRenderedDropZone) {
        if (DragState.isDropValid) {
            if (!DragState.dropIndicator.classList.contains('visible')) {
                DragState.dropIndicator.classList.add('visible');
            }
            
            // GPU Hardware Acceleration
            if (DragState.nextIndicatorY !== DragState.currentIndicatorY && DragState.nextIndicatorY !== null) {
                DragState.dropIndicator.style.transform = `translate3d(0, ${DragState.nextIndicatorY}px, 0)`;
                DragState.currentIndicatorY = DragState.nextIndicatorY;
            }
            
            if (DragState.nextReorderTargetId) DragState.dropIndicator.dataset.targetId = DragState.nextReorderTargetId;
            if (DragState.nextReorderPosition) DragState.dropIndicator.dataset.position = DragState.nextReorderPosition;
        } else {
            if (DragState.dropIndicator.classList.contains('visible')) {
                DragState.dropIndicator.classList.remove('visible');
            }
        }
    }

    DragState.animationFrameId = requestAnimationFrame(_animationLoop);
}

function _startAnimationLoop() {
    if (!DragState.animationFrameId) {
        DragState.animationFrameId = requestAnimationFrame(_animationLoop);
    }
}

function _stopAnimationLoop() {
    if (DragState.animationFrameId) {
        cancelAnimationFrame(DragState.animationFrameId);
        DragState.animationFrameId = 0;
    }
    DragState.scrollVelocity = 0;
}

// --- PHYSICS ENGINE ---

function _calculateDragState(e: DragEvent) {
    const target = e.target as HTMLElement;
    const clientY = e.clientY;
    
    let dropZone = target.closest<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
    if (!dropZone) {
        const wrapper = target.closest<HTMLElement>('.habit-group-wrapper');
        if (wrapper) {
            dropZone = wrapper.querySelector<HTMLElement>(DOM_SELECTORS.DROP_ZONE);
        }
    }
    
    // --- 1. CALCULAR VELOCIDADE POTENCIAL ---
    let potentialVelocity = 0;
    
    if (clientY < _geo_topZoneEnd) {
        const distance = clientY - _geo_containerTop;
        let ratio = (_geo_effectiveZone - distance) * _geo_invEffectiveZone;
        if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
        
        const intensity = ratio * ratio;
        potentialVelocity = -(intensity * MAX_SCROLL_SPEED);
        if (potentialVelocity > -1 && potentialVelocity < 0) potentialVelocity = -1;

    } else if (clientY > _geo_bottomZoneStart) {
        const distance = _geo_containerBottom - clientY;
        let ratio = (_geo_effectiveZone - distance) * _geo_invEffectiveZone;
        if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
        
        const intensity = ratio * ratio;
        potentialVelocity = intensity * MAX_SCROLL_SPEED;
        if (potentialVelocity < 1 && potentialVelocity > 0) potentialVelocity = 1;
    }

    // --- 2. VERIFICAÇÃO DE LIMITES ---
    let finalVelocity = potentialVelocity | 0; // Force int
    
    if (finalVelocity < 0 && DragState.scrollTop <= 0) {
        finalVelocity = 0;
    } else if (finalVelocity > 0) {
        if ((DragState.scrollTop + DragState.clientHeight) >= DragState.scrollHeight) {
            finalVelocity = 0;
        }
    }
    
    DragState.scrollVelocity = finalVelocity; 

    // --- 3. DROP ZONE LOGIC ---
    if (!DragState.cachedScheduleForDay || !DragState.draggedHabitOriginalTime || !dropZone) {
        DragState.nextDropZoneTarget = null;
        DragState.isDropValid = false;
        return;
    }

    DragState.nextDropZoneTarget = dropZone;
    const newTime = dropZone.dataset.time as TimeOfDay;
    
    const isSameGroup = newTime === DragState.draggedHabitOriginalTime;
    let isInvalidDrop = !isSameGroup && DragState.cachedScheduleForDay.includes(newTime);

    if (!isSameGroup && DragState.cachedScheduleForDay.length <= 1) {
        isInvalidDrop = false; 
    }

    DragState.isDropValid = !isInvalidDrop;

    const cardTarget = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
    
    if (cardTarget && cardTarget !== DragState.draggedElement && cardTarget.parentElement === dropZone) {
        const targetId = cardTarget.dataset.habitId;
        const cachedProps = targetId ? cardRectCache.get(targetId) : null;
        
        let midY: number;
        
        if (cachedProps) {
            // HIT TEST: Use cached geometry
            const currentCardTop = _geo_containerTop + cachedProps.offsetTop - DragState.scrollTop;
            midY = currentCardTop + (cachedProps.offsetHeight / 2);
        } else {
            // Fallback (Rare)
            const targetRect = cardTarget.getBoundingClientRect();
            midY = targetRect.top + targetRect.height / 2;
        }
        
        const position = clientY < midY ? 'before' : 'after';
        
        let indicatorY: number;
        
        if (cachedProps) {
            // UI: Use LOCAL offsetTop
            indicatorY = position === 'before'
                ? cachedProps.localTop - DROP_INDICATOR_GAP
                : cachedProps.localTop + cachedProps.offsetHeight + DROP_INDICATOR_GAP;
        } else {
            // Fallback logic
            const tRect = cardTarget.getBoundingClientRect();
            const parentRect = DragState.currentRenderedDropZone?.getBoundingClientRect() || { top: 0 };
            const relTop = tRect.top - parentRect.top; 
            indicatorY = position === 'before'
                ? relTop - DROP_INDICATOR_GAP
                : relTop + tRect.height + DROP_INDICATOR_GAP;
        }

        DragState.nextIndicatorY = indicatorY - (DROP_INDICATOR_HEIGHT / 2);
        DragState.nextReorderTargetId = targetId || null;
        DragState.nextReorderPosition = position;
    } else {
        DragState.nextReorderTargetId = null;
        DragState.nextReorderPosition = null;
        DragState.nextIndicatorY = null; 
    }
}

// --- EVENT HANDLERS ---

function _determineAndExecuteDropAction() {
    if (!DragState.draggedHabitId || !DragState.draggedHabitOriginalTime) return;
    
    const reorderTargetId = DragState.nextReorderTargetId;
    const reorderPosition = DragState.nextReorderPosition;
    const newTime = DragState.nextDropZoneTarget?.dataset.time as TimeOfDay | undefined;

    if (!newTime || !DragState.isDropValid) return;

    const isMovingGroup = newTime !== DragState.draggedHabitOriginalTime;
    const isReordering = reorderTargetId && DragState.draggedHabitId !== reorderTargetId;

    if (isMovingGroup) {
        triggerHaptic('medium');
        handleHabitDrop(
            DragState.draggedHabitId, 
            DragState.draggedHabitOriginalTime, 
            newTime,
            isReordering && reorderTargetId ? { id: reorderTargetId, pos: reorderPosition! } : undefined
        );
    } else if (isReordering) {
        triggerHaptic('medium');
        reorderHabit(DragState.draggedHabitId, reorderTargetId!, reorderPosition!);
    }
}

function _resetDragState() {
    DragState.draggedElement = null;
    DragState.draggedHabitId = null;
    DragState.draggedHabitOriginalTime = null;
    DragState.cachedScheduleForDay = null;
    DragState.dropIndicator = null;
    
    DragState.nextDropZoneTarget = null;
    DragState.currentRenderedDropZone = null;
    DragState.nextIndicatorY = null;
    DragState.currentIndicatorY = null;
    DragState.nextReorderTargetId = null;
    DragState.nextReorderPosition = null;
    DragState.isDropValid = false;
    
    DragState.cachedContainerRect = null;
    cardRectCache.clear();
}

const _handleBodyDragOver = (e: DragEvent) => {
    e.preventDefault(); 
    _calculateDragState(e);
    
    if (DragState.isDropValid) {
        e.dataTransfer!.dropEffect = 'move';
    } else {
        e.dataTransfer!.dropEffect = 'none';
    }
};

const _handleBodyDrop = (e: DragEvent) => {
    e.preventDefault();
    document.body.classList.remove('is-dragging-active');
    _determineAndExecuteDropAction();
};

const _cleanupDrag = () => {
    DragState.draggedElement?.classList.remove(CSS_CLASSES.DRAGGING);
    document.body.classList.remove('is-dragging-active');
    
    if (DragState.container) {
        DragState.container.classList.remove('is-dragging');
        DragState.container.removeEventListener('scroll', _onScroll);
    }
    
    if (DragState.currentRenderedDropZone) {
        DragState.currentRenderedDropZone.classList.remove(CSS_CLASSES.DRAG_OVER, CSS_CLASSES.INVALID_DROP);
    }
    
    DragState.dropIndicator?.remove();
    _stopAnimationLoop();
    
    document.body.removeEventListener('dragover', _handleBodyDragOver);
    document.body.removeEventListener('drop', _handleBodyDrop);
    document.body.removeEventListener('dragend', _cleanupDrag);

    _resetDragState();
};

const _handleDragStart = (e: DragEvent) => {
    if (isCurrentlySwiping()) {
        e.preventDefault();
        return;
    }
    const target = e.target as HTMLElement;
    const cardContent = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
    const card = cardContent?.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
    
    if (card && cardContent && card.dataset.habitId && card.dataset.time) {
        triggerHaptic('light');
        
        DragState.draggedElement = card;
        DragState.draggedHabitId = card.dataset.habitId;
        DragState.draggedHabitOriginalTime = card.dataset.time as TimeOfDay;
        
        const draggedHabitObject = state.habits.find(h => h.id === DragState.draggedHabitId) || null;
        if (draggedHabitObject) {
            DragState.cachedScheduleForDay = getEffectiveScheduleForHabitOnDate(draggedHabitObject, state.selectedDate);
        }
        
        if (DragState.container) {
            DragState.cachedContainerRect = DragState.container.getBoundingClientRect();
            // Pre-calculate physics & layout
            _captureGeometryCache();
            DragState.container.addEventListener('scroll', _onScroll, { passive: true });
        }

        e.dataTransfer!.setData('text/plain', DragState.draggedHabitId);
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
        
        DragState.dropIndicator = document.createElement('div');
        DragState.dropIndicator.className = 'drop-indicator';
        DragState.dropIndicator.style.top = '0';
        DragState.dropIndicator.style.left = 'var(--space-sm)';
        DragState.dropIndicator.style.right = 'var(--space-sm)';
        
        document.body.addEventListener('dragover', _handleBodyDragOver);
        document.body.addEventListener('drop', _handleBodyDrop);
        document.body.addEventListener('dragend', _cleanupDrag, { once: true });

        _startAnimationLoop();

        setTimeout(() => {
            document.body.classList.add('is-dragging-active');
            card.classList.add(CSS_CLASSES.DRAGGING);
            if (DragState.container) DragState.container.classList.add('is-dragging');
        }, 0);
    }
};

export function setupDragHandler(habitContainer: HTMLElement) {
    DragState.container = habitContainer;
    habitContainer.addEventListener('dragstart', _handleDragStart);
}
