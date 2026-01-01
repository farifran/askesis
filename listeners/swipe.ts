
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/swipe.ts
 * @description Motor de Gestos para Interações de Deslize Horizontal (Swipe-to-Reveal).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo processa eventos de entrada brutos (Pointer Events) em alta frequência (~120Hz).
 * 
 * ARQUITETURA (Static State Machine & Integer Physics):
 * - **Static Memory Layout:** Todo o estado mutável reside em um único objeto estático (`SwipeState`) 
 *   para garantir localidade de cache e evitar alocação de closures.
 * - **Integer Arithmetic:** Coordenadas e Deltas são forçados para Int32 (`| 0`) para otimização V8 Smi.
 * - **SNIPER OPTIMIZATION (Typed OM):** Atualização de layout via `attributeStyleMap` para zero-parsing overhead.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Direction Locking:** Bloqueia o eixo oposto após exceder o `INTENT_THRESHOLD`.
 * 2. **Pointer Capture:** Garante rastreamento contínuo mesmo saindo do elemento.
 */

import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

// --- CONSTANTS (Int32) ---
const DIR_NONE = 0;
const DIR_HORIZ = 1;
const DIR_VERT = 2;

const INTENT_THRESHOLD = 5; // Pixels to lock direction
const ACTION_THRESHOLD = 10; // Pixels to trigger open/close
const HAPTIC_THRESHOLD = 15; // Pixels to trigger haptic feedback

// --- STATIC STATE (Monomorphic Singleton) ---
// Hot memory block. Accessed continuously during gestures.
const SwipeState = {
    isActive: 0,        // 0 (false) | 1 (true)
    startX: 0,
    startY: 0,
    currentX: 0,
    direction: DIR_NONE,
    wasOpenLeft: 0,     // 0 (false) | 1 (true)
    wasOpenRight: 0,    // 0 (false) | 1 (true)
    actionWidth: 60,    // Cached CSS value
    pointerId: -1,
    rafId: 0,
    hasHaptics: 0,      // 0 (false) | 1 (true)
    // DOM References (Weakly held logically, managed explicitly)
    card: null as HTMLElement | null,
    content: null as HTMLElement | null,
    // SNIPER OPTIMIZATION: Typed OM Detection Cache
    hasTypedOM: false
};

// --- LOGIC ---

export const isCurrentlySwiping = (): boolean => SwipeState.isActive === 1;

/**
 * Reads CSS variable once.
 * Called on resize via debounce.
 */
function updateCachedLayoutValues() {
    const rootStyles = getComputedStyle(document.documentElement);
    const rawValue = rootStyles.getPropertyValue('--swipe-action-width').trim();
    const parsed = parseInt(rawValue, 10);
    // Bitwise OR with 0 forces int, though parseInt does it too. Fallback to 60.
    SwipeState.actionWidth = (isNaN(parsed) || parsed === 0) ? 60 : parsed;
    
    // Feature detection for Typed OM
    SwipeState.hasTypedOM = !!(window.CSS && window.CSSTranslate && CSS.px);
}

/**
 * Decide state snap at the end of the gesture.
 */
function _finalizeSwipeState(deltaX: number) {
    const card = SwipeState.card;
    if (!card) return;

    // Logic simplification using Int32 booleans
    if (SwipeState.wasOpenLeft) {
        if (deltaX < -ACTION_THRESHOLD) {
            card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
        }
    } else if (SwipeState.wasOpenRight) {
        if (deltaX > ACTION_THRESHOLD) {
            card.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
        }
    } else { 
        if (deltaX > ACTION_THRESHOLD) {
            card.classList.add(CSS_CLASSES.IS_OPEN_LEFT);
        } else if (deltaX < -ACTION_THRESHOLD) {
            card.classList.add(CSS_CLASSES.IS_OPEN_RIGHT);
        }
    }
}

/**
 * Suppress click event if swipe occurred.
 */
function _blockSubsequentClick(deltaX: number) {
    // Fast absolute value via conditional
    const absDelta = deltaX < 0 ? -deltaX : deltaX;
    
    if (absDelta <= ACTION_THRESHOLD) return;

    const blockClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        // Exception: Allow action buttons
        if (target.closest(DOM_SELECTORS.SWIPE_DELETE_BTN) || target.closest(DOM_SELECTORS.SWIPE_NOTE_BTN)) {
            window.removeEventListener('click', blockClick, true);
            return;
        }

        e.stopPropagation();
        e.preventDefault();
        window.removeEventListener('click', blockClick, true);
    };
    
    // Capture phase to intercept before bubbles reach the card
    window.addEventListener('click', blockClick, true);

    // SAFETY VALVE [2025-05-02]: Timeout para limpar o bloqueador.
    setTimeout(() => {
        window.removeEventListener('click', blockClick, true);
    }, 100);
}

// --- HOT PATH: RENDER LOOP ---

const _updateVisualsStatic = () => {
    // Check active state without property lookup overhead if possible, 
    // but object property access is very fast in V8.
    if (!SwipeState.card || !SwipeState.content || SwipeState.direction !== DIR_HORIZ) {
        SwipeState.rafId = 0;
        return;
    }

    const deltaX = (SwipeState.currentX - SwipeState.startX) | 0;
    let translateX = deltaX;
    
    if (SwipeState.wasOpenLeft) translateX = (translateX + SwipeState.actionWidth) | 0;
    if (SwipeState.wasOpenRight) translateX = (translateX - SwipeState.actionWidth) | 0;

    // SNIPER OPTIMIZATION: Direct DOM Write via Typed OM (Fast Path) or String (Fallback)
    if (SwipeState.hasTypedOM && SwipeState.content.attributeStyleMap) {
        SwipeState.content.attributeStyleMap.set('transform', new CSSTranslate(CSS.px(translateX), CSS.px(0)));
    } else {
        SwipeState.content.style.transform = `translateX(${translateX}px)`;
    }

    // Haptics Logic
    const absDelta = deltaX < 0 ? -deltaX : deltaX;
    
    if (SwipeState.hasHaptics === 0 && absDelta > HAPTIC_THRESHOLD) {
        triggerHaptic('light');
        SwipeState.hasHaptics = 1;
    } else if (SwipeState.hasHaptics === 1 && absDelta < HAPTIC_THRESHOLD) {
        SwipeState.hasHaptics = 0;
    }
    
    SwipeState.rafId = 0;
};

// --- HOT PATH: INPUT HANDLERS ---

const _cleanupAndReset = () => {
    if (SwipeState.rafId) {
        cancelAnimationFrame(SwipeState.rafId);
        SwipeState.rafId = 0;
    }

    const card = SwipeState.card;
    if (card) {
        // Pointer Release
        if (SwipeState.pointerId !== -1) {
            try {
                card.releasePointerCapture(SwipeState.pointerId);
            } catch (e) { /* Ignore */ }
        }

        card.classList.remove(CSS_CLASSES.IS_SWIPING);
        
        const content = SwipeState.content;
        if (content) {
            if (SwipeState.hasTypedOM && content.attributeStyleMap) {
                content.attributeStyleMap.clear(); // Clears inline transform
            } else {
                content.style.transform = '';
            }
            content.draggable = true;
        }
    }
    
    // Detach global listeners
    // PERFORMANCE: 'passive: true' removed here as it is only needed on addEventListener
    window.removeEventListener('pointermove', _handlePointerMove);
    window.removeEventListener('pointerup', _handlePointerUp);
    window.removeEventListener('pointercancel', _cleanupAndReset);
    window.removeEventListener('contextmenu', _cleanupAndReset);
    
    // Reset State
    SwipeState.card = null;
    SwipeState.content = null;
    SwipeState.isActive = 0;
    SwipeState.direction = DIR_NONE;
    SwipeState.pointerId = -1;
    SwipeState.hasHaptics = 0;
};

const _handlePointerMove = (e: PointerEvent) => {
    if (!SwipeState.card) return;

    // Update Input State (Integer)
    SwipeState.currentX = e.clientX | 0;

    // PHASE 1: Intent Detection
    if (SwipeState.direction === DIR_NONE) {
        const deltaX = Math.abs((e.clientX | 0) - SwipeState.startX);
        const deltaY = Math.abs((e.clientY | 0) - SwipeState.startY);

        if (deltaX > INTENT_THRESHOLD || deltaY > INTENT_THRESHOLD) {
            if (deltaX > deltaY) {
                // Horizontal Lock
                SwipeState.direction = DIR_HORIZ;
                SwipeState.isActive = 1;
                
                SwipeState.card.classList.add(CSS_CLASSES.IS_SWIPING);
                if (SwipeState.content) SwipeState.content.draggable = false;
                
                try {
                    SwipeState.card.setPointerCapture(e.pointerId);
                    SwipeState.pointerId = e.pointerId;
                } catch (err) { /* Ignore */ }

            } else {
                // Vertical Lock (Scroll) - Abort Custom Swipe
                // O navegador cuidará do scroll nativo pois o listener é passive: true
                SwipeState.direction = DIR_VERT;
                _cleanupAndReset();
                return;
            }
        }
    }

    // PHASE 2: Animation Request
    if (SwipeState.direction === DIR_HORIZ) {
        if (SwipeState.rafId === 0) {
            SwipeState.rafId = requestAnimationFrame(_updateVisualsStatic);
        }
    }
};

const _handlePointerUp = () => {
    if (!SwipeState.card) return;

    if (SwipeState.direction === DIR_HORIZ) {
        const deltaX = (SwipeState.currentX - SwipeState.startX) | 0;
        _finalizeSwipeState(deltaX);
        _blockSubsequentClick(deltaX);
    }
    
    _cleanupAndReset();
};

export function setupSwipeHandler(habitContainer: HTMLElement) {
    // Initial Layout Check
    updateCachedLayoutValues();
    
    // Debounced Resize Listener
    let resizeTimer: number;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(updateCachedLayoutValues, 150);
    });

    // Conflict with Native Drag
    habitContainer.addEventListener('dragstart', () => {
        if (SwipeState.card) {
            _cleanupAndReset();
        }
    });

    // Entry Point
    habitContainer.addEventListener('pointerdown', (e) => {
        // Ignore secondary buttons or if already active
        if (SwipeState.card || e.button !== 0) return;

        const target = e.target as HTMLElement;
        
        // Single-pass delegation check
        const contentWrapper = target.closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        if (!contentWrapper) return;
        
        const card = contentWrapper.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!card) return;

        // Auto-close others
        const currentlyOpen = habitContainer.querySelector(`.${CSS_CLASSES.IS_OPEN_LEFT}, .${CSS_CLASSES.IS_OPEN_RIGHT}`);
        if (currentlyOpen && currentlyOpen !== card) {
            currentlyOpen.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
        }

        // Initialize State
        SwipeState.card = card;
        SwipeState.content = contentWrapper;
        SwipeState.startX = e.clientX | 0;
        SwipeState.startY = e.clientY | 0;
        SwipeState.currentX = SwipeState.startX;
        
        SwipeState.wasOpenLeft = card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT) ? 1 : 0;
        SwipeState.wasOpenRight = card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT) ? 1 : 0;
        SwipeState.hasHaptics = 0;
        
        // Attach global listeners
        // PERFORMANCE: passive: true para permitir scroll da página sem bloqueio
        // O controle horizontal vs vertical é feito via touch-action: pan-y no CSS + lógica de Intent.
        window.addEventListener('pointermove', _handlePointerMove, { passive: true }); 
        window.addEventListener('pointerup', _handlePointerUp);
        window.addEventListener('pointercancel', _cleanupAndReset);
        window.addEventListener('contextmenu', _cleanupAndReset);
    });
}
