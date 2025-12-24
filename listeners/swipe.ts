
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file listeners/swipe.ts
 * @description Motor de Gestos para Interações de Deslize Horizontal (Swipe-to-Reveal).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo processa eventos de entrada brutos (Pointer Events) em alta frequência.
 * 
 * ARQUITETURA:
 * - State Machine: Gerencia transições entre 'Idle', 'Measuring' (detectando intenção) e 'Swiping'.
 * - Direction Locking: Determina heuristicamente se o usuário quer rolar a página (Vertical - Nativo)
 *   ou abrir o cartão (Horizontal - JS), bloqueando o outro eixo.
 * - Input Throttling: Desacopla a frequência de eventos do mouse/touch (120Hz+) da taxa de atualização
 *   da tela (60Hz) usando `requestAnimationFrame`.
 * 
 * DECISÕES TÉCNICAS:
 * 1. Geometry Caching: A largura da ação (`--swipe-action-width`) é lida apenas no resize,
 *    nunca durante o gesto, para evitar "Layout Thrashing".
 * 2. Pointer Capture: Garante que o gesto continue mesmo se o dedo sair do elemento.
 * 3. Event Suppression: Bloqueia cliques acidentais após um swipe.
 */

import { triggerHaptic } from '../utils';
import { DOM_SELECTORS, CSS_CLASSES } from '../render/constants';

let isSwiping = false;
// PERFORMANCE: Cache global para evitar leitura de estilos computados (lento) a cada gesto.
let cachedSwipeActionWidth = 0;

const SWIPE_INTENT_THRESHOLD = 10;

export const isCurrentlySwiping = (): boolean => isSwiping;

/**
 * Decide se o cartão deve "encaixar" (snap) aberto ou fechado ao final do gesto.
 */
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

/**
 * CRITICAL LOGIC: Event Suppression.
 * Se o usuário arrastou o cartão, o evento 'click' subsequente (disparado ao soltar)
 * deve ser interceptado para não ativar a ação de clique do cartão (toggle status).
 * Usa a fase de captura (true) para interceptar antes que chegue aos listeners do cartão.
 */
function _blockSubsequentClick(deltaX: number) {
    if (Math.abs(deltaX) <= SWIPE_INTENT_THRESHOLD) return;

    const blockClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        // Exceção: Permite clicar nos botões de ação revelados
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

// PERFORMANCE: Lê o CSS apenas quando necessário (resize), evitando Forced Reflows no hot path.
function updateCachedLayoutValues() {
    const rootStyles = getComputedStyle(document.documentElement);
    cachedSwipeActionWidth = parseInt(rootStyles.getPropertyValue('--swipe-action-width'), 10) || 60;
}

export function setupSwipeHandler(habitContainer: HTMLElement) {
    // STATE VARIABLES (HOT PATH)
    let activeCard: HTMLElement | null = null;
    // PERFORMANCE [2025-03-04]: Cache content wrapper to avoid querySelector in RAF loop.
    let activeContent: HTMLElement | null = null;
    
    let startX = 0;
    let startY = 0;
    
    // Variável para armazenar o input mais recente entre frames de animação
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
    // PERFORMANCE: Debounce no resize para evitar thrashing.
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
            // UX: Libera o ponteiro para devolver o controle ao sistema.
            if (currentPointerId !== null) {
                try {
                    activeCard.releasePointerCapture(currentPointerId);
                } catch (e) {
                    // Ignora erro se o ponteiro já foi perdido
                }
            }

            activeCard.classList.remove(CSS_CLASSES.IS_SWIPING);
            // Use cached reference directly
            if (activeContent) {
                activeContent.style.transform = '';
                activeContent.draggable = true; // Restaura drag-and-drop nativo
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

    /**
     * [RENDER LOOP]
     * Executado via requestAnimationFrame.
     * Separa a leitura de inputs (alta freq) da escrita no DOM (60Hz).
     */
    const updateVisuals = () => {
        // PERFORMANCE: Check activeContent directly instead of DOM query
        if (!activeCard || !activeContent || swipeDirection !== 'horizontal') return;

        const deltaX = inputCurrentX - startX;
        let translateX = deltaX;
        if (wasOpenLeft) translateX += swipeActionWidth;
        if (wasOpenRight) translateX -= swipeActionWidth;

        // GPU COMPOSITION: Usa transform para movimento suave na thread do compositor.
        activeContent.style.transform = `translateX(${translateX}px)`;

        // Feedback Tátil baseada em posição
        if (!hasTriggeredHaptic && Math.abs(deltaX) > HAPTIC_THRESHOLD) {
            triggerHaptic('light');
            hasTriggeredHaptic = true;
        } else if (hasTriggeredHaptic && Math.abs(deltaX) < HAPTIC_THRESHOLD) {
            hasTriggeredHaptic = false;
        }
        
        rafId = null; // Libera flag para permitir agendamento do próximo frame
    };

    /**
     * [INPUT HANDLER]
     * Processa Pointer Events e determina a intenção do usuário.
     */
    const handlePointerMove = (e: PointerEvent) => {
        if (!activeCard) return;

        inputCurrentX = e.clientX;

        // FASE 1: Detecção de Intenção (Direction Locking)
        if (swipeDirection === 'none') {
            const deltaX = Math.abs(e.clientX - startX);
            const deltaY = Math.abs(e.clientY - startY);

            // Só decide após um movimento mínimo (5px) para filtrar ruído.
            if (deltaX > 5 || deltaY > 5) {
                if (deltaX > deltaY) {
                    // Intenção Horizontal: Bloqueia scroll vertical e inicia swipe JS.
                    swipeDirection = 'horizontal';
                    isSwiping = true;
                    if (dragEnableTimer) {
                        clearTimeout(dragEnableTimer);
                        dragEnableTimer = null;
                    }
                    activeCard.classList.add(CSS_CLASSES.IS_SWIPING);
                    
                    // UX: Desativa drag nativo para não conflitar com o swipe.
                    if (activeContent) activeContent.draggable = false;
                    
                    try {
                        // CRITICAL UX: Captura o ponteiro para rastrear mesmo se sair do elemento.
                        activeCard.setPointerCapture(e.pointerId);
                        currentPointerId = e.pointerId;
                    } catch (err) {
                        console.warn('Failed to set pointer capture', err);
                    }

                } else {
                    // Intenção Vertical: Aborta swipe JS e deixa o browser rolar a página.
                    swipeDirection = 'vertical';
                    abortSwipe();
                    return;
                }
            }
        }

        // FASE 2: Animação
        if (swipeDirection === 'horizontal') {
            // PERFORMANCE: Throttling via RAF.
            if (!rafId) {
                rafId = requestAnimationFrame(updateVisuals);
            }
        }
    };

    const handlePointerUp = () => {
        if (!activeCard) return;
    
        if (swipeDirection === 'horizontal') {
            const deltaX = inputCurrentX - startX;
            // Cálculos finais de física/snap
            _finalizeSwipeState(activeCard, deltaX, wasOpenLeft, wasOpenRight);
            _blockSubsequentClick(deltaX);
        }
        
        _cleanupAndReset();
    };

    // Conflito com Drag & Drop: Se um drag nativo começar, aborta nosso swipe.
    habitContainer.addEventListener('dragstart', () => {
        if (activeCard) {
            abortSwipe();
        }
    });

    // Ponto de Entrada do Gesto
    habitContainer.addEventListener('pointerdown', e => {
        if (activeCard || e.button !== 0) return;

        // Single-pass delegation check
        const contentWrapper = (e.target as HTMLElement).closest<HTMLElement>(DOM_SELECTORS.HABIT_CONTENT_WRAPPER);
        if (!contentWrapper) return;
        
        const targetCard = contentWrapper.closest<HTMLElement>(DOM_SELECTORS.HABIT_CARD);
        if (!targetCard) return;

        // Auto-close outros cartões
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

        // UX: Previne que o navegador inicie um drag nativo (imagem fantasma)
        // se a intenção for swipe. Pequeno delay para diferenciar.
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
