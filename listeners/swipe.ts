/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/swipe.ts
 * @description Motor de Gestos para Interações de Deslize Horizontal (Swipe-to-Reveal).
 * 
 * [MAIN THREAD CONTEXT]:
 * Processamento de Pointer Events em alta frequência (~120Hz).
 * 
 * ARQUITETURA (Static State Machine & Integer Physics):
 * - Memory Locality: Estado em objeto estático para evitar alocações em frames.
 * - Smi Optimization: Coordenadas forçadas para Int32 (| 0).
 */

import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { renderApp } from '../render';
import { state } from '../state';

// CONSTANTS (Smi Values)
const DIR_NONE = 0, DIR_HORIZ = 1, DIR_VERT = 2;
const INTENT_THRESHOLD = 5, ACTION_THRESHOLD = 10, HAPTIC_THRESHOLD = 15;

const SwipeState = {
    isActive: 0, startX: 0, startY: 0, currentX: 0, direction: DIR_NONE,
    wasOpenLeft: 0, wasOpenRight: 0, actionWidth: 60, pointerId: -1,
    rafId: 0, hasHaptics: 0, card: null as HTMLElement | null,
    content: null as HTMLElement | null, hasTypedOM: false
};

export const isCurrentlySwiping = () => SwipeState.isActive === 1;

function updateCachedLayoutValues() {
    const root = getComputedStyle(document.documentElement);
    SwipeState.actionWidth = parseInt(root.getPropertyValue('--swipe-action-width')) || 60;
    SwipeState.hasTypedOM = !!(window.CSS && window.CSSTranslate && CSS.px);
}

function _finalizeSwipeState(deltaX: number) {
    const { card, wasOpenLeft, wasOpenRight, actionWidth } = SwipeState;
    if (!card) return;

    if (wasOpenLeft) {
        if (deltaX < -ACTION_THRESHOLD) card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
    } else if (wasOpenRight) {
        if (deltaX > ACTION_THRESHOLD) card.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
    } else {
        if (deltaX > ACTION_THRESHOLD) card.classList.add(CSS_CLASSES.IS_OPEN_LEFT);
        else if (deltaX < -ACTION_THRESHOLD) card.classList.add(CSS_CLASSES.IS_OPEN_RIGHT);
    }
}

function _blockSubsequentClick(deltaX: number) {
    if ((deltaX < 0 ? -deltaX : deltaX) <= ACTION_THRESHOLD) return;
    const block = (e: MouseEvent) => {
        const t = e.target as HTMLElement;
        if (!t.closest(DOM_SELECTORS.SWIPE_DELETE_BTN) && !t.closest(DOM_SELECTORS.SWIPE_NOTE_BTN)) {
            e.stopPropagation(); e.preventDefault();
        }
        window.removeEventListener('click', block, true);
    };
    window.addEventListener('click', block, true);
    setTimeout(() => window.removeEventListener('click', block, true), 150);
}

const _updateVisuals = () => {
    if (!SwipeState.card || !SwipeState.content || SwipeState.direction !== DIR_HORIZ) {
        SwipeState.rafId = 0; return;
    }

    let tx = (SwipeState.currentX - SwipeState.startX) | 0;
    if (SwipeState.wasOpenLeft) tx += SwipeState.actionWidth;
    if (SwipeState.wasOpenRight) tx -= SwipeState.actionWidth;

    if (SwipeState.hasTypedOM && SwipeState.content.attributeStyleMap) {
        SwipeState.content.attributeStyleMap.set('transform', new CSSTranslate(CSS.px(tx), CSS.px(0)));
    } else {
        SwipeState.content.style.transform = `translateX(${tx}px)`;
    }

    const absX = tx < 0 ? -tx : tx;
    if (!SwipeState.hasHaptics && absX > HAPTIC_THRESHOLD) {
        triggerHaptic('light'); SwipeState.hasHaptics = 1;
    } else if (SwipeState.hasHaptics && absX < HAPTIC_THRESHOLD) {
        SwipeState.hasHaptics = 0;
    }
    SwipeState.rafId = 0;
};

const _reset = () => {
    if (SwipeState.rafId) cancelAnimationFrame(SwipeState.rafId);
    const { card, content, pointerId } = SwipeState;
    if (card) {
        if (pointerId !== -1) try { card.releasePointerCapture(pointerId); } catch(e){}
        card.classList.remove(CSS_CLASSES.IS_SWIPING);
        if (content) {
            if (SwipeState.hasTypedOM && content.attributeStyleMap) content.attributeStyleMap.clear();
            else content.style.transform = '';
            content.draggable = true;
        }
    }
    document.body.classList.remove('is-interaction-active');
    if (state.uiDirtyState.habitListStructure) requestAnimationFrame(() => renderApp());
    
    window.removeEventListener('pointermove', _handlePointerMove);
    window.removeEventListener('pointerup', _handlePointerUp);
    window.removeEventListener('pointercancel', _reset);
    SwipeState.card = SwipeState.content = null;
    SwipeState.isActive = 0; SwipeState.direction = DIR_NONE; SwipeState.pointerId = -1;
};

const _handlePointerMove = (e: PointerEvent) => {
    if (!SwipeState.card) return;
    SwipeState.currentX = e.clientX | 0;
    if (SwipeState.direction === DIR_NONE) {
        const dx = Math.abs(SwipeState.currentX - SwipeState.startX), dy = Math.abs((e.clientY | 0) - SwipeState.startY);
        if (dx > INTENT_THRESHOLD || dy > INTENT_THRESHOLD) {
            if (dx > dy) {
                SwipeState.direction = DIR_HORIZ; SwipeState.isActive = 1;
                document.body.classList.add('is-interaction-active');
                SwipeState.card.classList.add(CSS_CLASSES.IS_SWIPING);
                if (SwipeState.content) SwipeState.content.draggable = false;
                try { SwipeState.card.setPointerCapture(e.pointerId); SwipeState.pointerId = e.pointerId; } catch(e){}
            } else {
                SwipeState.direction = DIR_VERT; _reset(); return;
            }
        }
    }
    if (SwipeState.direction === DIR_HORIZ && !SwipeState.rafId) {
        SwipeState.rafId = requestAnimationFrame(_updateVisuals);
    }
};

const _handlePointerUp = () => {
    if (SwipeState.card && SwipeState.direction === DIR_HORIZ) {
        const dx = (SwipeState.currentX - SwipeState.startX) | 0;
        _finalizeSwipeState(dx); _blockSubsequentClick(dx);
    }
    _reset();
};

export function setupSwipeHandler(container: HTMLElement) {
    updateCachedLayoutValues();
    container.addEventListener('pointerdown', (e) => {
        if (SwipeState.card || e.button !== 0) return;
        const cw = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        const card = cw?.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!card || !cw) return;

        const open = container.querySelector(`.${CSS_CLASSES.IS_OPEN_LEFT}, .${CSS_CLASSES.IS_OPEN_RIGHT}`);
        if (open && open !== card) open.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);

        SwipeState.card = card; SwipeState.content = cw;
        SwipeState.startX = SwipeState.currentX = e.clientX | 0;
        SwipeState.startY = e.clientY | 0;
        SwipeState.wasOpenLeft = card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT) ? 1 : 0;
        SwipeState.wasOpenRight = card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT) ? 1 : 0;
        SwipeState.hasHaptics = 0;

        window.addEventListener('pointermove', _handlePointerMove, { passive: true });
        window.addEventListener('pointerup', _handlePointerUp);
        window.addEventListener('pointercancel', _reset);
    });
}