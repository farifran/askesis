/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [NOTA COMPARATIVA]: Nível de Engenharia: Crítico/Interativo. Implementa física de gestos com alta performance (60fps) usando 'requestAnimationFrame' e transformações GPU. A lógica de 'Pointer Capture' e detecção de intenção (Direction Locking) é robusta, prevenindo conflitos com a rolagem vertical nativa (depende de 'touch-action: pan-y' no CSS).

import { triggerHaptic } from './utils';
import { DOM_SELECTORS, CSS_CLASSES } from './domConstants';

let isSwiping = false;
// PERFORMANCE [2025-01-30]: Cache for the swipe action width to avoid getComputedStyle on every touch.
let cachedSwipeActionWidth = 0;

/**
 * Permite que outros módulos verifiquem se um gesto de deslize está em andamento.
 * @returns {boolean} Verdadeiro se o usuário está arrastando um cartão lateralmente.
 */
export const isCurrentlySwiping = (): boolean => isSwiping;

/**
 * REATORAÇÃO DE CLAREZA [2024-09-21]: A lógica que determina o estado final de um cartão após um deslize
 * foi extraída para esta função auxiliar para melhorar a legibilidade da função `cleanup`.
 * @param activeCard O elemento do cartão que está sendo deslizado.
 * @param deltaX O deslocamento horizontal total do gesto de deslize.
 * @param wasOpenLeft Se o cartão já estava aberto à esquerda no início do gesto.
 * @param wasOpenRight Se o cartão já estava aberto à direita no início do gesto.
 */
function _finalizeSwipeState(activeCard: HTMLElement, deltaX: number, wasOpenLeft: boolean, wasOpenRight: boolean) {
    const SWIPE_INTENT_THRESHOLD = 10;
    
    if (wasOpenLeft) {
        // Se estava aberto à esquerda, um deslize para a ESQUERDA o fecha
        if (deltaX < -SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.remove(CSS_CLASSES.IS_OPEN_LEFT);
        }
    } else if (wasOpenRight) {
        // Se estava aberto à direita, um deslize para a DIREITA o fecha
        if (deltaX > SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.remove(CSS_CLASSES.IS_OPEN_RIGHT);
        }
    } else { // O cartão estava fechado
        // Se deslizou para a direita, abre à esquerda (excluir)
        if (deltaX > SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.add(CSS_CLASSES.IS_OPEN_LEFT);
        // Se deslizou para a esquerda, abre à direita (nota)
        } else if (deltaX < -SWIPE_INTENT_THRESHOLD) {
            activeCard.classList.add(CSS_CLASSES.IS_OPEN_RIGHT);
        }
    }
}

/**
 * REATORAÇÃO DE CLAREZA [2024-09-21]: A lógica para prevenir um clique acidental após um deslize
 * foi movida para esta função auxiliar para mejorar a organización do código.
 * @param deltaX O deslocamento horizontal total do gesto de deslize.
 */
function _blockSubsequentClick(deltaX: number) {
    const SWIPE_INTENT_THRESHOLD = 10;
    // Só bloqueia o clique se o deslize foi significativo.
    if (Math.abs(deltaX) <= SWIPE_INTENT_THRESHOLD) return;

    const blockClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        // Permite cliques intencionais nos próprios botões de ação.
        if (target.closest(DOM_SELECTORS.SWIPE_DELETE_BTN) || target.closest(DOM_SELECTORS.SWIPE_NOTE_BTN)) {
            window.removeEventListener('click', blockClick, true);
            return;
        }

        e.stopPropagation();
        e.preventDefault();
        window.removeEventListener('click', blockClick, true);
    };
    // Adiciona no modo de captura para garantir que seja executado antes de outros listeners.
    window.addEventListener('click', blockClick, true);
}

// PERFORMANCE: Helper to update cached layout values
function updateCachedLayoutValues() {
    const rootStyles = getComputedStyle(document.documentElement);
    cachedSwipeActionWidth = parseInt(rootStyles.getPropertyValue('--swipe-action-width'), 10) || 60;
}

export function setupSwipeHandler(habitContainer: HTMLElement) {
    let activeCard: HTMLElement | null = null;
    let startX = 0;
    let startY = 0;
    
    // Input coordinates (Updated by pointermove)
    let inputCurrentX = 0;
    
    let swipeDirection: 'horizontal' | 'vertical' | 'none' = 'none';
    let wasOpenLeft = false;
    let wasOpenRight = false;
    let swipeActionWidth = 60; // Valor padrão local, atualizado via cache
    let dragEnableTimer: number | null = null;
    let currentPointerId: number | null = null;
    
    // UX: Estado para rastrear se o haptic feedback já foi disparado neste gesto
    let hasTriggeredHaptic = false;
    const HAPTIC_THRESHOLD = 15; // Limiar ligeiramente maior que a ativação visual para feedback firme
    
    // PERFORMANCE [2025-01-20]: RAF ID for throttling
    let rafId: number | null = null;

    // Init layout cache
    updateCachedLayoutValues();
    window.addEventListener('resize', updateCachedLayoutValues);

    // REATORAÇÃO DE DRY: Centraliza toda a lógica de limpeza e reset de estado.
    const _cleanupAndReset = () => {
        if (dragEnableTimer) {
            clearTimeout(dragEnableTimer);
        }
        
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    
        if (activeCard) {
            // UX IMPROVEMENT: Release pointer capture to allow normal interaction again
            if (currentPointerId !== null) {
                try {
                    activeCard.releasePointerCapture(currentPointerId);
                } catch (e) {
                    // Ignore errors if pointer was already released/lost
                }
            }

            activeCard.classList.remove(CSS_CLASSES.IS_SWIPING);
            const content = activeCard.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
            if (content) {
                content.style.transform = '';
                content.draggable = true;
            }
        }
        
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', _cleanupAndReset);
        // Clean up contextmenu listener to prevent leaks
        window.removeEventListener('contextmenu', _cleanupAndReset);
        
        activeCard = null;
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

    // PERFORMANCE [2025-01-20]: Separate visual update logic.
    // This function runs aligned with the display refresh rate (60/120Hz).
    const updateVisuals = () => {
        if (!activeCard || swipeDirection !== 'horizontal') return;

        const deltaX = inputCurrentX - startX;
        let translateX = deltaX;
        if (wasOpenLeft) translateX += swipeActionWidth;
        if (wasOpenRight) translateX -= swipeActionWidth;

        const content = activeCard.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        if (content) {
            // Using transform3d or simple translateX is standard for GPU acceleration
            content.style.transform = `translateX(${translateX}px)`;
        }

        // UX [2025-01-18]: Feedback tátil ao cruzar o limiar de ativação
        if (!hasTriggeredHaptic && Math.abs(deltaX) > HAPTIC_THRESHOLD) {
            triggerHaptic('light');
            hasTriggeredHaptic = true;
        } else if (hasTriggeredHaptic && Math.abs(deltaX) < HAPTIC_THRESHOLD) {
            hasTriggeredHaptic = false;
        }
        
        rafId = null; // Allow scheduling next frame
    };

    const handlePointerMove = (e: PointerEvent) => {
        if (!activeCard) return;

        // Update input state immediately
        inputCurrentX = e.clientX;

        // Direction Locking Logic (executes once at start of gesture)
        if (swipeDirection === 'none') {
            const deltaX = Math.abs(e.clientX - startX);
            const deltaY = Math.abs(e.clientY - startY);

            // Usa um pequeno limiar para decidir
            if (deltaX > 5 || deltaY > 5) {
                if (deltaX > deltaY) {
                    swipeDirection = 'horizontal';
                    isSwiping = true;
                    if (dragEnableTimer) {
                        clearTimeout(dragEnableTimer);
                        dragEnableTimer = null;
                    }
                    activeCard.classList.add(CSS_CLASSES.IS_SWIPING);
                    const content = activeCard.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
                    if (content) content.draggable = false;
                    
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

        // Throttled Visual Updates
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
        startX = e.clientX;
        startY = e.clientY;
        inputCurrentX = startX; // Initialize input X
        
        wasOpenLeft = activeCard.classList.contains(CSS_CLASSES.IS_OPEN_LEFT);
        wasOpenRight = activeCard.classList.contains(CSS_CLASSES.IS_OPEN_RIGHT);
        hasTriggeredHaptic = false;

        // PERFORMANCE FIX [2025-01-30]: Use cached width instead of querying DOM
        swipeActionWidth = cachedSwipeActionWidth || 60;

        const content = activeCard.querySelector<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        if (content) {
            // FIX [2025-02-26]: Só desabilitamos 'draggable' se NÃO for mouse.
            // Para mouse, queremos que o arrasto nativo (Drag & Drop) inicie instantaneamente sem delay.
            // Para touch, precisamos desabilitar brevemente para permitir a detecção de swipe ou long-press.
            if (e.pointerType !== 'mouse') {
                content.draggable = false;
                dragEnableTimer = window.setTimeout(() => {
                    if (content && swipeDirection === 'none') {
                        content.draggable = true;
                    }
                    dragEnableTimer = null;
                }, 150);
            }
        }

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', _cleanupAndReset);
        // UX FIX [2025-02-02]: Cancel swipe on contextmenu (prevents stuck cards on mobile long-press)
        window.addEventListener('contextmenu', _cleanupAndReset);
    });
}