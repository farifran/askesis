
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/swipe.ts
 * @description Motor de Gestos Isolado (Swipe & Manual Scroll).
 * 
 * [ISOLATION PRINCIPLE]:
 * Este módulo gerencia exclusivamente o ciclo de vida do gesto horizontal E vertical (Manual Scroll).
 * Como `touch-action: none` é usado nos cartões para prevenir o cancelamento do Long Press,
 * este módulo deve reimplementar a rolagem vertical (1:1) quando o usuário não está segurando.
 */

import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';
import { renderApp } from '../render';
import { state } from '../state';
import { startDragSession, isDragging as isDragActive } from './drag'; 
import {
    SWIPE_ACTION_THRESHOLD,
    SWIPE_BLOCK_CLICK_MS
} from '../constants';

// CONFIGURAÇÃO FÍSICA
const DIRECTION_LOCKED_THRESHOLD = 5; // Pixels para definir intenção direcional
// UPDATE: Aumentado para 24px. Permite que o dedo oscile verticalmente enquanto segura sem cancelar o gesto.
const LONG_PRESS_DRIFT_TOLERANCE = 24; 
const ACTION_THRESHOLD = SWIPE_ACTION_THRESHOLD;
const LONG_PRESS_DELAY = 500; 

// STATE MACHINE (Módulo Local)
const SwipeMachine = {
    state: 'IDLE' as 'IDLE' | 'DETECTING' | 'SWIPING' | 'SCROLLING' | 'LOCKED_OUT',
    card: null as HTMLElement | null,
    content: null as HTMLElement | null,
    scrollContainer: null as HTMLElement | null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    lastY: 0, // Para delta scroll
    pointerId: -1,
    rafId: 0,
    
    // State Flags
    wasOpenLeft: false,
    wasOpenRight: false,
    
    // Progressive Haptics
    lastFeedbackStep: 0,
    limitVibrationTimer: 0, // Timer para vibração contínua no limite
    
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

const _stopLimitVibration = () => {
    if (SwipeMachine.limitVibrationTimer) {
        clearInterval(SwipeMachine.limitVibrationTimer);
        SwipeMachine.limitVibrationTimer = 0;
        // Para a vibração do navegador imediatamente se possível
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(0);
    }
};

// --- VISUAL ENGINE ---

const _renderFrame = () => {
    if (!SwipeMachine.content) {
        SwipeMachine.rafId = 0;
        return;
    }

    // RENDER: SWIPE HORIZONTAL
    if (SwipeMachine.state === 'SWIPING') {
        let tx = (SwipeMachine.currentX - SwipeMachine.startX) | 0;
        
        // Ajusta offset se já estava aberto
        if (SwipeMachine.wasOpenLeft) tx += SwipeMachine.actionWidth;
        if (SwipeMachine.wasOpenRight) tx -= SwipeMachine.actionWidth;

        const absX = Math.abs(tx);
        const actionPoint = SwipeMachine.actionWidth; 

        // HAPTICS & VISUAL LOGIC
        if (absX >= actionPoint) {
            // LIMIT REACHED: Bloqueio visual e tátil
            tx = tx > 0 ? actionPoint : -actionPoint;

            if (!SwipeMachine.limitVibrationTimer) {
                triggerHaptic('heavy');
                SwipeMachine.limitVibrationTimer = window.setInterval(() => {
                    triggerHaptic('medium'); 
                }, 80); 
            }
        } else {
            _stopLimitVibration();
            const HAPTIC_GRAIN = 8; 
            const currentStep = Math.floor(absX / HAPTIC_GRAIN);
            if (currentStep !== SwipeMachine.lastFeedbackStep) {
                if (currentStep > SwipeMachine.lastFeedbackStep) {
                    const ratio = absX / actionPoint;
                    if (ratio > 0.6) triggerHaptic('light'); 
                    else triggerHaptic('selection');
                }
                SwipeMachine.lastFeedbackStep = currentStep;
            }
        }

        if (SwipeMachine.hasTypedOM && SwipeMachine.content.attributeStyleMap) {
            SwipeMachine.content.attributeStyleMap.set('transform', new (window as any).CSSTranslate(CSS.px(tx), CSS.px(0)));
        } else {
            SwipeMachine.content.style.transform = `translateX(${tx}px)`;
        }
    }
    
    // RENDER: MANUAL SCROLL (VERTICAL)
    else if (SwipeMachine.state === 'SCROLLING' && SwipeMachine.scrollContainer) {
        const dy = SwipeMachine.currentY - SwipeMachine.lastY;
        if (dy !== 0) {
            SwipeMachine.scrollContainer.scrollTop -= dy;
            SwipeMachine.lastY = SwipeMachine.currentY;
        }
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
    _stopLimitVibration();
    
    // 2. Clean DOM State
    const { card, content, pointerId } = SwipeMachine;
    if (card) {
        card.classList.remove(CSS_CLASSES.IS_SWIPING);
        if (pointerId !== -1) {
            try { card.releasePointerCapture(pointerId); } catch(e){}
        }
    }
    if (content) {
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
    SwipeMachine.scrollContainer = null;
    SwipeMachine.initialEvent = null;
    SwipeMachine.pointerId = -1;
    SwipeMachine.rafId = 0;
    
    // 5. Render Recovery
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
        if (finalDeltaX < -threshold) card.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
    } else if (wasOpenRight) {
        if (finalDeltaX > threshold) card.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
    } else {
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
    _stopLimitVibration();
    
    if (SwipeMachine.state !== 'DETECTING' || !SwipeMachine.card || !SwipeMachine.content || !SwipeMachine.initialEvent) return;

    triggerHaptic('medium');
    startDragSession(SwipeMachine.card, SwipeMachine.content, SwipeMachine.initialEvent);
    
    _cleanListeners();
    SwipeMachine.state = 'IDLE';
    SwipeMachine.card.classList.remove(CSS_CLASSES.IS_SWIPING);
    
    if (SwipeMachine.hasTypedOM && SwipeMachine.content.attributeStyleMap) {
        SwipeMachine.content.attributeStyleMap.clear();
    } else {
        SwipeMachine.content.style.transform = '';
    }
};

const _onPointerMove = (e: PointerEvent) => {
    if (SwipeMachine.state === 'IDLE' || SwipeMachine.state === 'LOCKED_OUT') return;
    
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
    SwipeMachine.currentY = y;

    // PHASE: DETECTING
    if (SwipeMachine.state === 'DETECTING') {
        const movementDistance = Math.max(absDx, absDy);

        // --- ZONA DE PROTEÇÃO DE LONG PRESS ---
        if (SwipeMachine.longPressTimer !== 0) {
            // Se estamos na tolerância, ignoramos tudo e continuamos esperando o timer.
            // O evento nativo de scroll está bloqueado via CSS (touch-action: none).
            if (movementDistance <= LONG_PRESS_DRIFT_TOLERANCE) {
                return;
            } else {
                // QUEBROU A TOLERÂNCIA:
                // Movimento excessivo. Cancela o Long Press.
                clearTimeout(SwipeMachine.longPressTimer);
                SwipeMachine.longPressTimer = 0;
            }
        }

        // 2. Decision Logic (Timer expired or broke tolerance)
        if (absDx > DIRECTION_LOCKED_THRESHOLD || absDy > DIRECTION_LOCKED_THRESHOLD) {
            if (absDx > absDy) {
                // Horizontal -> Start Swipe
                if (SwipeMachine.longPressTimer) clearTimeout(SwipeMachine.longPressTimer);
                
                SwipeMachine.state = 'SWIPING';
                document.body.classList.add('is-interaction-active');
                if (SwipeMachine.card) {
                    SwipeMachine.card.classList.add(CSS_CLASSES.IS_SWIPING);
                    try { SwipeMachine.card.setPointerCapture(e.pointerId); SwipeMachine.pointerId = e.pointerId; } catch(e){}
                }
            } else {
                // Vertical -> Manual Scroll (Fallback for touch-action: none)
                SwipeMachine.state = 'SCROLLING';
                SwipeMachine.lastY = y; // Reset delta baseline
                
                // Release capture so we don't trap pointer forever if logic fails,
                // but since we do manual scroll, we actually WANT to keep receiving events.
                // We do NOT release capture here. We consume events to scroll manually.
            }
        }
    }

    // PHASE: SWIPING or SCROLLING
    if (SwipeMachine.state === 'SWIPING' || SwipeMachine.state === 'SCROLLING') {
        // e.preventDefault() is implicitly handled by touch-action: none in CSS
        if (!SwipeMachine.rafId) {
            SwipeMachine.rafId = requestAnimationFrame(_renderFrame);
        }
    }
};

const _onPointerUp = (e: PointerEvent) => {
    if (SwipeMachine.longPressTimer) clearTimeout(SwipeMachine.longPressTimer);
    _stopLimitVibration();

    if (SwipeMachine.state === 'SWIPING') {
        const dx = SwipeMachine.currentX - SwipeMachine.startX;
        _finalizeAction(dx);
        
        const blockClick = (ev: MouseEvent) => {
            const t = ev.target as HTMLElement;
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
    
    // O container principal é usado para o Scroll Manual
    SwipeMachine.scrollContainer = container;
    
    container.addEventListener('pointerdown', (e) => {
        _forceReset();

        if (e.button !== 0 || isDragActive()) return;
        const cw = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        const card = cw?.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!card || !cw) return;

        // CRITICAL: Set Capture immediately to ensure we get all events, 
        // effectively disabling any residual native behavior if CSS failed (defense in depth).
        try {
            cw.setPointerCapture(e.pointerId);
        } catch(err) {
            // Ignore if capture fails (rare)
        }

        const openCards = container.querySelectorAll(`.${CSS_CLASSES.IS_OPEN_LEFT}, .${CSS_CLASSES.IS_OPEN_RIGHT}`);
        openCards.forEach(c => {
            if (c !== card) c.classList.remove(CSS_CLASSES.IS_OPEN_LEFT, CSS_CLASSES.IS_OPEN_RIGHT);
        });

        SwipeMachine.state = 'DETECTING';
        SwipeMachine.card = card;
        SwipeMachine.content = cw;
        SwipeMachine.scrollContainer = container; // Re-bind for safety
        SwipeMachine.initialEvent = e;
        SwipeMachine.startX = SwipeMachine.currentX = e.clientX | 0;
        SwipeMachine.startY = SwipeMachine.currentY = e.clientY | 0;
        SwipeMachine.wasOpenLeft = card.classList.contains(CSS_CLASSES.IS_OPEN_LEFT);
        SwipeMachine.wasOpenRight = card.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT);
        
        SwipeMachine.lastFeedbackStep = 0;
        SwipeMachine.limitVibrationTimer = 0;

        SwipeMachine.longPressTimer = window.setTimeout(_triggerDrag, LONG_PRESS_DELAY);

        window.addEventListener('pointermove', _onPointerMove, { passive: false });
        window.addEventListener('pointerup', _onPointerUp);
        window.addEventListener('pointercancel', _forceReset);
        window.addEventListener('blur', _forceReset);
    });
}
