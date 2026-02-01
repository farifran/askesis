
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/swipe.ts
 * @description Motor de Gestos Isolado (Swipe).
 * 
 * [ISOLATION PRINCIPLE]:
 * Este módulo gerencia exclusivamente o ciclo de vida do gesto horizontal.
 * Se um gesto se qualificar como Drag (Long Press), este módulo aborta 
 * e passa o controle para o módulo de Drag, limpando seu próprio estado.
 */

import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { renderApp } from '../render';
import { state } from '../state';
import { startDragSession, isDragging as isDragActive } from './drag'; 
import {
    SWIPE_ACTION_THRESHOLD,
    SWIPE_HAPTIC_THRESHOLD,
    SWIPE_BLOCK_CLICK_MS
} from '../constants';

// CONFIGURAÇÃO FÍSICA
const DIRECTION_LOCKED_THRESHOLD = 5; // Pixels para definir intenção direcional
const LONG_PRESS_DRIFT_TOLERANCE = 15; // Pixels de tolerância para "tremedeira" antes de cancelar o Long Press
const ACTION_THRESHOLD = SWIPE_ACTION_THRESHOLD;
const LONG_PRESS_DELAY = 500; 
const MAX_SWIPE_MULTIPLIER = 2.5; 

// STATE MACHINE (Módulo Local)
const SwipeMachine = {
    state: 'IDLE' as 'IDLE' | 'DETECTING' | 'SWIPING' | 'LOCKED_OUT',
    card: null as HTMLElement | null,
    content: null as HTMLElement | null,
    startX: 0,
    startY: 0,
    currentX: 0,
    pointerId: -1,
    rafId: 0,
    
    // State Flags
    wasOpenLeft: false,
    wasOpenRight: false,
    hasHitLimit: false,
    
    // Progressive Haptics
    lastFeedbackStep: 0,
    
    // Long Press
    longPressTimer: 0,
    initialEvent: null as PointerEvent | null,
    
    // Cached Layout
    actionWidth: 60,
    hasTypedOM: false
};

// --- CORE UTILS ---

function updateLayoutMetrics() {
    const root = getComputedStyle(document.documentElement);
    SwipeMachine.actionWidth = parseInt(root.getPropertyValue('--swipe-action-width')) || 60;
    SwipeMachine.hasTypedOM = typeof window !== 'undefined' && !!(window.CSS && (window as any).CSSTranslate && CSS.px);
}

// --- VISUAL ENGINE ---

const _renderFrame = () => {
    if (SwipeMachine.state !== 'SWIPING' || !SwipeMachine.content) {
        SwipeMachine.rafId = 0;
        return;
    }

    let tx = (SwipeMachine.currentX - SwipeMachine.startX) | 0;
    
    // Ajusta offset se já estava aberto
    if (SwipeMachine.wasOpenLeft) tx += SwipeMachine.actionWidth;
    if (SwipeMachine.wasOpenRight) tx -= SwipeMachine.actionWidth;

    // PHYSICS LIMIT (Elasticidade ou Hard Stop)
    const limit = (SwipeMachine.actionWidth * MAX_SWIPE_MULTIPLIER) | 0;
    const absX = Math.abs(tx);

    // PROGRESSIVE HAPTICS (Feedback Tátil Incremental - Resistance Effect)
    // Config: Trigger every ~10-12px to simulate mechanical resistance
    const HAPTIC_GRAIN = 12; 

    if (!SwipeMachine.hasHitLimit) {
        const currentStep = Math.floor(absX / HAPTIC_GRAIN);

        if (currentStep !== SwipeMachine.lastFeedbackStep) {
            // Only trigger if we are pulling further out (increasing tension)
            const isExpanding = currentStep > SwipeMachine.lastFeedbackStep;
            
            if (isExpanding) {
                // Calculate position relative to the Action Threshold (usually 60px)
                const ratio = absX / SwipeMachine.actionWidth;
                
                // Ramp up intensity as we approach the action point
                if (ratio < 0.5) {
                    // 0-50% (0-30px): Subtle mechanical clicks
                    triggerHaptic('selection');
                } else if (ratio < 1.0) {
                    // 50%-100% (30-60px): Stronger resistance ticks
                    triggerHaptic('light');
                } else {
                    // > 100% (Elastic Stretching): Pronounced feedback
                    triggerHaptic('medium');
                }
            }
            
            SwipeMachine.lastFeedbackStep = currentStep;
        }
    }

    if (absX >= limit) {
        // Hard Clamp
        tx = tx > 0 ? limit : -limit;

        // Sensory Feedback (One-shot at limit)
        if (!SwipeMachine.hasHitLimit) {
            triggerHaptic('heavy'); // Hard stop collision
            SwipeMachine.hasHitLimit = true;
            SwipeMachine.content.classList.add('limit-reached');
        }
    } else {
        if (SwipeMachine.hasHitLimit) {
            SwipeMachine.hasHitLimit = false;
            SwipeMachine.content.classList.remove('limit-reached');
        }
    }

    // Direct DOM Manipulation (High Performance)
    if (SwipeMachine.hasTypedOM && SwipeMachine.content.attributeStyleMap) {
        SwipeMachine.content.attributeStyleMap.set('transform', new (window as any).CSSTranslate(CSS.px(tx), CSS.px(0)));
    } else {
        SwipeMachine.content.style.transform = `translateX(${tx}px)`;
    }
    
    SwipeMachine.rafId = 0;
};

// --- LIFECYCLE MANAGEMENT ---

const _cleanListeners = () => {
    window.removeEventListener('pointermove', _onPointerMove);
    window.removeEventListener('pointerup', _onPointerUp);
    window.removeEventListener('pointercancel', _forceReset);
    window.removeEventListener('blur', _forceReset);
};

const _forceReset = () => {
    // 1. Stop Loops & Timers
    if (SwipeMachine.rafId) cancelAnimationFrame(SwipeMachine.rafId);
    if (SwipeMachine.longPressTimer) clearTimeout(SwipeMachine.longPressTimer);
    
    // 2. Clean DOM State
    const { card, content, pointerId } = SwipeMachine;
    if (card) {
        card.classList.remove(CSS_CLASSES.IS_SWIPING);
        if (pointerId !== -1) {
            try { card.releasePointerCapture(pointerId); } catch(e){}
        }
    }
    if (content) {
        content.classList.remove('limit-reached');
        if (SwipeMachine.hasTypedOM && content.attributeStyleMap) {
            content.attributeStyleMap.clear();
        } else {
            content.style.transform = '';
        }
    }
    
    // 3. Global Cleanup
    document.body.classList.remove('is-interaction-active');
    
    // 4. Reset Memory State
    SwipeMachine.state = 'IDLE';
    SwipeMachine.card = null;
    SwipeMachine.content = null;
    SwipeMachine.initialEvent = null;
    SwipeMachine.pointerId = -1;
    SwipeMachine.rafId = 0;
    
    // 5. Render Recovery (if needed)
    if (state.uiDirtyState.habitListStructure && !isDragActive()) {
        requestAnimationFrame(() => renderApp());
    }
    
    _cleanListeners();
};

const _finalizeAction = (finalDeltaX: number) => {
    if (!SwipeMachine.card) return;
    
    const { card, wasOpenLeft, wasOpenRight } = SwipeMachine;
    const threshold = ACTION_THRESHOLD;

    if (wasOpenLeft) {
        // Closing Left
        if (finalDeltaX < -threshold) card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
    } else if (wasOpenRight) {
        // Closing Right
        if (finalDeltaX > threshold) card.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
    } else {
        // Opening
        if (finalDeltaX > threshold) {
            card.classList.add(CSS_CLASSES.IS_OPEN_LEFT);
        } else if (finalDeltaX < -threshold) {
            card.classList.add(CSS_CLASSES.IS_OPEN_RIGHT);
        }
    }
};

// --- GESTURE HANDLERS ---

const _triggerDrag = () => {
    SwipeMachine.longPressTimer = 0;
    
    // Guard: State must be valid
    if (SwipeMachine.state !== 'DETECTING' || !SwipeMachine.card || !SwipeMachine.content || !SwipeMachine.initialEvent) return;

    // 1. Handover to Drag Module
    triggerHaptic('medium');
    startDragSession(SwipeMachine.card, SwipeMachine.content, SwipeMachine.initialEvent);
    
    // 2. Silent Abort for Swipe (CLEAN STATE)
    _cleanListeners();
    SwipeMachine.state = 'IDLE';
    SwipeMachine.card.classList.remove(CSS_CLASSES.IS_SWIPING);
    
    // BUGFIX: Clean visual artifacts from content before Drag takes over
    SwipeMachine.content.classList.remove('limit-reached');
    if (SwipeMachine.hasTypedOM && SwipeMachine.content.attributeStyleMap) {
        SwipeMachine.content.attributeStyleMap.clear();
    } else {
        SwipeMachine.content.style.transform = '';
    }
};

const _onPointerMove = (e: PointerEvent) => {
    if (SwipeMachine.state === 'IDLE' || SwipeMachine.state === 'LOCKED_OUT') return;
    
    // External Interruption (e.g. another touch started drag)
    if (isDragActive()) {
        _forceReset();
        return;
    }

    const x = e.clientX | 0;
    const y = e.clientY | 0;
    const dx = x - SwipeMachine.startX;
    const dy = y - SwipeMachine.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    SwipeMachine.currentX = x;

    // PHASE: DETECTING
    if (SwipeMachine.state === 'DETECTING') {
        const movementDistance = Math.max(absDx, absDy);

        // 1. Movement Check for Long Press Cancellation
        // Só cancela o timer se o movimento for significativo (drift tolerance).
        if (movementDistance > LONG_PRESS_DRIFT_TOLERANCE) {
            if (SwipeMachine.longPressTimer) {
                clearTimeout(SwipeMachine.longPressTimer);
                SwipeMachine.longPressTimer = 0;
            }
        }

        // 2. Direction Lock Logic
        if (absDx > DIRECTION_LOCKED_THRESHOLD || absDy > DIRECTION_LOCKED_THRESHOLD) {
            if (absDx > absDy) {
                // Horizontal -> Start Swipe
                // Cancela long press se for swipe horizontal decidido
                if (SwipeMachine.longPressTimer) clearTimeout(SwipeMachine.longPressTimer);
                
                SwipeMachine.state = 'SWIPING';
                document.body.classList.add('is-interaction-active');
                if (SwipeMachine.card) {
                    SwipeMachine.card.classList.add(CSS_CLASSES.IS_SWIPING);
                    try { SwipeMachine.card.setPointerCapture(e.pointerId); SwipeMachine.pointerId = e.pointerId; } catch(e){}
                }
            } else {
                // Vertical -> Scroll Intent?
                // FIX: Se o timer de Long Press ainda estiver ativo e o movimento for pequeno (dentro da tolerância),
                // IGNORAMOS o bloqueio de rolagem para dar chance ao Drag de ativar.
                const isWaitingForLongPress = SwipeMachine.longPressTimer !== 0;
                
                if (isWaitingForLongPress && absDy <= LONG_PRESS_DRIFT_TOLERANCE) {
                    // Do nothing (Wait for timer or more movement)
                    return;
                }

                // Vertical scroll confirmado ou movimento excessivo
                SwipeMachine.state = 'LOCKED_OUT';
                _forceReset(); // Let native scroll take over
                return;
            }
        }
    }

    // PHASE: SWIPING
    if (SwipeMachine.state === 'SWIPING') {
        e.preventDefault(); // Stop native scroll/selection
        if (!SwipeMachine.rafId) {
            SwipeMachine.rafId = requestAnimationFrame(_renderFrame);
        }
    }
};

const _onPointerUp = (e: PointerEvent) => {
    if (SwipeMachine.longPressTimer) clearTimeout(SwipeMachine.longPressTimer);

    if (SwipeMachine.state === 'SWIPING') {
        const dx = SwipeMachine.currentX - SwipeMachine.startX;
        _finalizeAction(dx);
        
        // Prevent Click Ghost
        const blockClick = (ev: MouseEvent) => {
            const t = ev.target as HTMLElement;
            // Allow clicking the action buttons themselves
            if (!t.closest(DOM_SELECTORS.SWIPE_DELETE_BTN) && !t.closest(DOM_SELECTORS.SWIPE_NOTE_BTN)) {
                ev.stopPropagation(); ev.preventDefault();
            }
            window.removeEventListener('click', blockClick, true);
        };
        if (Math.abs(dx) > ACTION_THRESHOLD) {
            window.addEventListener('click', blockClick, true);
            setTimeout(() => window.removeEventListener('click', blockClick, true), SWIPE_BLOCK_CLICK_MS);
        }
    }

    _forceReset();
};

// --- INITIALIZER ---

export function setupSwipeHandler(container: HTMLElement) {
    updateLayoutMetrics();
    
    container.addEventListener('pointerdown', (e) => {
        // FAIL-SAFE: Always start clean
        _forceReset();

        // 1. Validate Target
        if (e.button !== 0 || isDragActive()) return;
        const cw = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        const card = cw?.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!card || !cw) return;

        // 2. Auto-Close Others
        const openCards = container.querySelectorAll(`.${CSS_CLASSES.IS_OPEN_LEFT}, .${CSS_CLASSES.IS_OPEN_RIGHT}`);
        openCards.forEach(c => {
            if (c !== card) c.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
        });

        // 3. Initialize State
        SwipeMachine.state = 'DETECTING';
        SwipeMachine.card = card;
        SwipeMachine.content = cw;
        SwipeMachine.initialEvent = e;
        SwipeMachine.startX = SwipeMachine.currentX = e.clientX | 0;
        SwipeMachine.startY = e.clientY | 0;
        SwipeMachine.wasOpenLeft = card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT);
        SwipeMachine.wasOpenRight = card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT);
        SwipeMachine.hasHitLimit = false;
        SwipeMachine.lastFeedbackStep = 0;

        // 4. Start Long Press Timer
        SwipeMachine.longPressTimer = window.setTimeout(_triggerDrag, LONG_PRESS_DELAY);

        // 5. Attach Global Listeners
        window.addEventListener('pointermove', _onPointerMove, { passive: false });
        window.addEventListener('pointerup', _onPointerUp);
        window.addEventListener('pointercancel', _forceReset);
        window.addEventListener('blur', _forceReset);
    });
}
