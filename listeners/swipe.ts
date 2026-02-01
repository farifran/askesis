
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
    if (SwipeMachine.state !== 'SWIPING' || !SwipeMachine.content) {
        SwipeMachine.rafId = 0;
        return;
    }

    let tx = (SwipeMachine.currentX - SwipeMachine.startX) | 0;
    
    // Ajusta offset se já estava aberto
    if (SwipeMachine.wasOpenLeft) tx += SwipeMachine.actionWidth;
    if (SwipeMachine.wasOpenRight) tx -= SwipeMachine.actionWidth;

    const absX = Math.abs(tx);
    const actionPoint = SwipeMachine.actionWidth; // Ponto onde os ícones aparecem (Standard Position)

    // HAPTICS & VISUAL LOGIC
    
    if (absX >= actionPoint) {
        // LIMIT REACHED: Bloqueio visual e tátil
        
        // 1. Visual Clamp: Não permite passar do ponto de ação
        tx = tx > 0 ? actionPoint : -actionPoint;

        // 2. Continuous Vibration Loop (Tensão)
        if (!SwipeMachine.limitVibrationTimer) {
            triggerHaptic('heavy'); // Impacto inicial
            SwipeMachine.limitVibrationTimer = window.setInterval(() => {
                // Vibração pulsante rápida para simular tensão contínua
                triggerHaptic('medium'); 
            }, 80); 
        }
        
    } else {
        // Zona de Resistência (0 -> actionPoint)
        
        // Se saiu do limite, para a vibração contínua
        _stopLimitVibration();

        // Feedback de aproximação (grão fino)
        const HAPTIC_GRAIN = 8; 
        const currentStep = Math.floor(absX / HAPTIC_GRAIN);

        if (currentStep !== SwipeMachine.lastFeedbackStep) {
            // Só vibra se estiver esticando (aumentando a tensão)
            if (currentStep > SwipeMachine.lastFeedbackStep) {
                // Intensidade aumenta conforme chega perto do ponto de ação
                const ratio = absX / actionPoint;
                if (ratio > 0.6) triggerHaptic('light'); 
                else triggerHaptic('selection');
            }
            SwipeMachine.lastFeedbackStep = currentStep;
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
    _stopLimitVibration();
    
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

        // --- ZONA DE PROTEÇÃO DE LONG PRESS ---
        // Se estamos aguardando o timer (segurando o cartão), aplicamos uma lógica estrita:
        // Qualquer movimento dentro da tolerância é BLOQUEADO nativamente para impedir
        // que o navegador inicie o scroll. Isso cria a "cola" necessária para o timer terminar.
        if (SwipeMachine.longPressTimer !== 0) {
            if (movementDistance <= LONG_PRESS_DRIFT_TOLERANCE) {
                // DENTRO DA TOLERÂNCIA:
                // 1. Bloqueia scroll nativo (Chrome/Safari)
                if (e.cancelable) e.preventDefault();
                
                // 2. Retorno antecipado: Ignora lógica de direção. 
                //    Ficamos em 'DETECTING' esperando o timer ou mais movimento.
                return;
            } else {
                // QUEBROU A TOLERÂNCIA:
                // Movimento excessivo (scroll rápido ou swipe decidido). Cancela o Long Press.
                clearTimeout(SwipeMachine.longPressTimer);
                SwipeMachine.longPressTimer = 0;
                // Código continua para decidir se é Swipe ou Scroll abaixo...
            }
        }

        // 2. Direction Lock Logic (Só alcançado se timer expirou ou cancelado)
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
                // Vertical -> Scroll Intent
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
    _stopLimitVibration();

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
        
        SwipeMachine.lastFeedbackStep = 0;
        SwipeMachine.limitVibrationTimer = 0;

        // 4. Start Long Press Timer
        SwipeMachine.longPressTimer = window.setTimeout(_triggerDrag, LONG_PRESS_DELAY);

        // 5. Attach Global Listeners
        window.addEventListener('pointermove', _onPointerMove, { passive: false });
        window.addEventListener('pointerup', _onPointerUp);
        window.addEventListener('pointercancel', _forceReset);
        window.addEventListener('blur', _forceReset);
    });
}
