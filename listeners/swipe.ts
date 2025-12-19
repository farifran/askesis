/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

let isSwiping = false;
let cachedSwipeActionWidth = 0;

const SWIPE_INTENT_THRESHOLD = 10;

export const isCurrentlySwiping = (): boolean => isSwiping;

function _finalizeSwipeState(activeCard: HTMLElement, deltaX: number, wasOpenLeft: boolean, wasOpenRight: boolean) {
    if (wasOpenLeft) {
        if (deltaX < -SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
        }
    } else if (wasOpenRight) {
        if (deltaX > SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
        }
    } else { 
        if (deltaX > SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.add(CSS_CLASSES.IS_OPEN_LEFT);
        } else if (deltaX < -SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.add(CSS_CLASSES.IS_OPEN_RIGHT);
        }
    }
}

function _blockSubsequentClick(deltaX: number) {
    if (Math.abs(deltaX) <= SWIPE_INTENT_THRESHOLD) return;

    const blockClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest(DOM_SELECTORS.SWIPE_DELETE_BTN) || target.closest(DOM_SELECTORS.SWIPE_NOTE_BTN)) {
            window.removeEventListener('click', blockClick, true);
            return;
        }

        e.stopPropagation();
        e.preventDefault();
        window.removeEventListener('click', blockClick, true);
    };
    window.addEventListener('click', blockClick, true);
}

function updateCachedLayoutValues() {
    const rootStyles = getComputedStyle(document.documentElement);
    cachedSwipeActionWidth = parseInt(rootStyles.getPropertyValue('--swipe-action-width'), 10) || 60;
}

export function setupSwipeHandler(habitContainer: HTMLElement) {
    let activeCard: HTMLElement | null = null;
    // PERFORMANCE [2025-03-04]: Cache content wrapper to avoid querySelector in RAF loop
    let activeContent: HTMLElement | null = null;
    
    let startX = 0;
    let startY = 0;
    
    let inputCurrentX = 0;
    
    let swipeDirection: 'horizontal' | 'vertical' | 'none' = 'none';
    let wasOpenLeft = false;
    let wasOpenRight = false;
    let swipeActionWidth = 60; 
    let dragEnableTimer: number | null = null;
    let currentPointerId: number | null = null;
    
    let hasTriggeredHaptic = false;
    const HAPTIC_THRESHOLD = 15;
    
    let rafId: number | null = null;
    
    let resizeDebounceTimer: number;

    updateCachedLayoutValues();
    window.addEventListener('resize', () => {
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = window.setTimeout(updateCachedLayoutValues, 150);
    });

    const _cleanupAndReset = () => {
        if (dragEnableTimer) {
            clearTimeout(dragEnableTimer);
        }
        
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    
        if (activeCard) {
            if (currentPointerId !== null) {
                try {
                    activeCard.releasePointerCapture(currentPointerId);
                } catch (e) {
                }
            }

            activeCard.classList.remove(CSS_CLASSES.IS_SWIPING);
            // Use cached reference if available, otherwise query (fallback)
            const content = activeContent || activeCard.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
            if (content) {
                content.style.transform = '';
                content.draggable = true;
            }
        }
        
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', _cleanupAndReset);
        window.removeEventListener('contextmenu', _cleanupAndReset);
        
        activeCard = null;
        activeContent = null; // Clear reference
        isSwiping = false;
        swipeDirection = 'none';
        dragEnableTimer = null;
        currentPointerId = null;
        hasTriggeredHaptic = false;
    };

    const abortSwipe = () => {
        if (!activeCard) return;
        _cleanupAndReset();
    };

    const updateVisuals = () => {
        // PERFORMANCE: Check activeContent directly instead of DOM query
        if (!activeCard || !activeContent || swipeDirection !== 'horizontal') return;

        const deltaX = inputCurrentX - startX;
        let translateX = deltaX;
        if (wasOpenLeft) translateX += swipeActionWidth;
        if (wasOpenRight) translateX -= swipeActionWidth;

        // Apply transform to cached element
        activeContent.style.transform = `translateX(${translateX}px)`;

        if (!hasTriggeredHaptic && Math.abs(deltaX) > HAPTIC_THRESHOLD) {
            triggerHaptic('light');
            hasTriggeredHaptic = true;
        } else if (hasTriggeredHaptic && Math.abs(deltaX) < HAPTIC_THRESHOLD) {
            hasTriggeredHaptic = false;
        }
        
        rafId = null; 
    };

    const handlePointerMove = (e: PointerEvent) => {
        if (!activeCard) return;

        inputCurrentX = e.clientX;

        if (swipeDirection === 'none') {
            const deltaX = Math.abs(e.clientX - startX);
            const deltaY = Math.abs(e.clientY - startY);

            if (deltaX > 5 || deltaY > 5) {
                if (deltaX > deltaY) {
                    swipeDirection = 'horizontal';
                    isSwiping = true;
                    if (dragEnableTimer) {
                        clearTimeout(dragEnableTimer);
                        dragEnableTimer = null;
                    }
                    activeCard.classList.add(CSS_CLASSES.IS_SWIPING);
                    
                    if (activeContent) activeContent.draggable = false;
                    
                    try {
                        activeCard.setPointerCapture(e.pointerId);
                        currentPointerId = e.pointerId;
                    } catch (err) {
                        console.warn('Failed to set pointer capture', err);
                    }

                } else {
                    swipeDirection = 'vertical';
                    abortSwipe();
                    return;
                }
            }
        }

        if (swipeDirection === 'horizontal') {
            if (!rafId) {
                rafId = requestAnimationFrame(updateVisuals);
            }
        }
    };

    const handlePointerUp = () => {
        if (!activeCard) return;
    
        if (swipeDirection === 'horizontal') {
            const deltaX = inputCurrentX - startX;
            _finalizeSwipeState(activeCard, deltaX, wasOpenLeft, wasOpenRight);
            _blockSubsequentClick(deltaX);
        }
        
        _cleanupAndReset();
    };

    habitContainer.addEventListener('dragstart', () => {
        if (activeCard) {
            abortSwipe();
        }
    });

    habitContainer.addEventListener('pointerdown', e => {
        if (activeCard || e.button !== 0) return;

        const contentWrapper = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        if (!contentWrapper) return;
        
        const targetCard = contentWrapper.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!targetCard) return;

        const currentlyOpenCard = habitContainer.querySelector(`.${CSS_CLASSES.IS_OPEN_LEFT}, .${CSS_CLASSES.IS_OPEN_RIGHT}`);
        if (currentlyOpenCard && currentlyOpenCard !== targetCard) {
            currentlyOpenCard.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
        }

        activeCard = targetCard;
        // CACHE HIT: Store the content wrapper immediately to avoid lookups later
        activeContent = contentWrapper;
        
        startX = e.clientX;
        startY = e.clientY;
        inputCurrentX = startX; 
        
        wasOpenLeft = activeCard.classList.contains(CSS_CLASSES.IS_OPEN_LEFT);
        wasOpenRight = activeCard.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT);
        hasTriggeredHaptic = false;

        swipeActionWidth = cachedSwipeActionWidth || 60;

        // Use cached reference
        if (activeContent) {
            if (e.pointerType !== 'mouse') {
                activeContent.draggable = false;
                dragEnableTimer = window.setTimeout(() => {
                    // Check cached reference
                    if (activeContent && swipeDirection === 'none') {
                        activeContent.draggable = true;
                    }
                    dragEnableTimer = null;
                }, 150);
            }
        }

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', _cleanupAndReset);
        window.addEventListener('contextmenu', _cleanupAndReset);
    });
}