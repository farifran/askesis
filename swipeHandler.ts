/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state } from './state';
import { getTodayUTCIso } from './utils';

let isSwiping = false;

/**
 * Permite que outros módulos verifiquem se um gesto de deslize está em andamento.
 * @returns {boolean} Verdadeiro se o usuário está arrastando um cartão lateralmente.
 */
export const isCurrentlySwiping = (): boolean => isSwiping;

export function setupSwipeHandler(habitContainer: HTMLElement) {
    let activeCard: HTMLElement | null = null;
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let swipeDirection: 'horizontal' | 'vertical' | 'none' = 'none';
    let wasOpenLeft = false;
    let wasOpenRight = false;
    let swipeActionWidth = 60; // Valor padrão
    let dragEnableTimer: number | null = null;
    const SWIPE_INTENT_THRESHOLD = 10; // Um limiar baixo para detectar a intenção de deslizar.

    const handlePointerMove = (e: PointerEvent) => {
        if (!activeCard) return;

        // Se a direção ainda não foi determinada
        if (swipeDirection === 'none') {
            const deltaX = Math.abs(e.clientX - startX);
            const deltaY = Math.abs(e.clientY - startY);

            // Usa um pequeno limiar para decidir
            if (deltaX > 5 || deltaY > 5) {
                if (deltaX > deltaY) {
                    swipeDirection = 'horizontal';
                    isSwiping = true;
                    // Se um deslize começa, cancela o timer que reativaria o arrastar
                    if (dragEnableTimer) {
                        clearTimeout(dragEnableTimer);
                        dragEnableTimer = null;
                    }
                    activeCard.classList.add('is-swiping');
                    const content = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
                    // Desativa explicitamente o arrastar ao iniciar o deslize
                    if (content) {
                        content.draggable = false;
                    }
                } else {
                    swipeDirection = 'vertical';
                    cleanup(); // Permite a rolagem vertical
                    return;
                }
            }
        }

        if (swipeDirection === 'horizontal') {
            currentX = e.clientX;
            const deltaX = currentX - startX;

            const rootStyles = getComputedStyle(document.documentElement);
            swipeActionWidth = parseInt(rootStyles.getPropertyValue('--swipe-action-width'), 10) || 60;

            let translateX = deltaX;
            if (wasOpenLeft) translateX += swipeActionWidth;
            if (wasOpenRight) translateX -= swipeActionWidth;

            const content = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
            if (content) {
                content.style.transform = `translateX(${translateX}px)`;
            }
        }
    };

    const cleanup = () => {
        if (dragEnableTimer) {
            clearTimeout(dragEnableTimer);
            dragEnableTimer = null;
        }

        if (!activeCard) return;

        const content = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
        if (content) {
            content.draggable = true; // Sempre reativa o arrastar ao final da interação
            content.style.transform = ''; // Deixa o CSS cuidar da transição
        }

        const deltaX = currentX - startX;
        activeCard.classList.remove('is-swiping');

        // Processa o resultado do deslize apenas se a direção foi confirmada como horizontal
        if (swipeDirection === 'horizontal') {
            if (wasOpenLeft) {
                // Se estava aberto à esquerda, um deslize para a ESQUERDA o fecha
                if (deltaX < -SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.remove('is-open-left');
                }
            } else if (wasOpenRight) {
                // Se estava aberto à direita, um deslize para a DIREITA o fecha
                if (deltaX > SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.remove('is-open-right');
                }
            } else { // O cartão estava fechado
                // Se deslizou para a direita, abre à esquerda (excluir)
                if (deltaX > SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.add('is-open-left');
                // Se deslizou para a esquerda, abre à direita (nota)
                } else if (deltaX < -SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.add('is-open-right');
                }
            }

            // Se um deslize real ocorreu, previne o evento de 'clique' que se segue.
            if (Math.abs(deltaX) > SWIPE_INTENT_THRESHOLD) {
                const blockClick = (e: MouseEvent) => {
                    const target = e.target as HTMLElement;
                    // Permite cliques intencionais nos próprios botões de ação.
                    if (target.closest('.swipe-delete-btn') || target.closest('.swipe-note-btn')) {
                        window.removeEventListener('click', blockClick, true); // Limpa o listener e permite o evento
                        return;
                    }
            
                    // Bloqueia cliques acidentais em outros elementos.
                    e.stopPropagation();
                    e.preventDefault();
                    window.removeEventListener('click', blockClick, true);
                };
                // Adiciona no modo de captura para garantir que seja executado antes de outros listeners.
                window.addEventListener('click', blockClick, true);
            }
        }
        
        // Reseta todas as variáveis de estado
        activeCard = null;
        swipeDirection = 'none';
        isSwiping = false; // Reseta o estado de deslize imediatamente para permitir o arrasto.
        
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
    };

    habitContainer.addEventListener('dragstart', () => {
        if (activeCard) {
            // Uma operação de arrastar teve precedência sobre um deslize.
            // Devemos abortar a interação de deslize completamente para evitar conflitos de estado.
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', cleanup);
            window.removeEventListener('pointercancel', cleanup);

            if (dragEnableTimer) {
                clearTimeout(dragEnableTimer);
            }

            // Restaura o cartão para seu estado pré-interação.
            activeCard.classList.remove('is-swiping');
            const content = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
            if (content) {
                content.style.transform = '';
                content.draggable = true;
            }
            
            // Reseta todas as variáveis de estado para o handler de deslize.
            activeCard = null;
            isSwiping = false;
            swipeDirection = 'none';
            dragEnableTimer = null;
        }
    });

    habitContainer.addEventListener('pointerdown', e => {
        if (activeCard || e.button !== 0) return; // Só permite um deslize por vez e o botão esquerdo do mouse

        // O gesto de deslize deve se originar da área de conteúdo do cartão.
        const contentWrapper = (e.target as HTMLElement).closest<HTMLElement>('.habit-content-wrapper');
        if (!contentWrapper) return;
        
        const targetCard = contentWrapper.closest<HTMLElement>('.habit-card');
        if (!targetCard) return;

        // Fecha qualquer outro cartão que possa estar aberto para garantir que apenas um esteja ativo por vez.
        const currentlyOpenCard = habitContainer.querySelector('.habit-card.is-open-left, .habit-card.is-open-right');
        if (currentlyOpenCard && currentlyOpenCard !== targetCard) {
            currentlyOpenCard.classList.remove('is-open-left', 'is-open-right');
        }

        activeCard = targetCard;
        startX = e.clientX;
        startY = e.clientY;
        currentX = startX;
        wasOpenLeft = activeCard.classList.contains('is-open-left');
        wasOpenRight = activeCard.classList.contains('is-open-right');

        const content = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
        if (content) {
            content.draggable = false; // Desativa o arrastar por padrão no início do toque
            // Inicia um timer para reativar o arrastar se o toque for longo
            dragEnableTimer = window.setTimeout(() => {
                if (content && swipeDirection === 'none') {
                    content.draggable = true;
                }
                dragEnableTimer = null;
            }, 150);
        }

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', cleanup);
        window.addEventListener('pointercancel', cleanup);
    });
}
