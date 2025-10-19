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
    const SWIPE_INTENT_THRESHOLD = 10; // Um limiar baixo para detectar a intenção de deslizar.

    const cleanup = () => {
        if (!activeCard) return;

        const content = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
        if (content) {
            content.draggable = true;
            content.style.transform = ''; // Deixa o CSS cuidar da transição
        }

        const deltaX = currentX - startX;
        activeCard.classList.remove('is-swiping');

        // Processa o resultado do deslize apenas se a direção foi confirmada como horizontal
        if (swipeDirection === 'horizontal') {
            if (wasOpenLeft) {
                // Se deslizou para a esquerda (fechando), fecha
                if (deltaX < -SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.remove('is-open-left');
                }
            } else if (wasOpenRight) {
                // Se deslizou para a direita (fechando), fecha
                if (deltaX > SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.remove('is-open-right');
                }
            } else { // O cartão estava fechado
                // Se deslizou para a direita, abre à esquerda
                if (deltaX > SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.add('is-open-left');
                // Se deslizou para a esquerda, abre à direita
                } else if (deltaX < -SWIPE_INTENT_THRESHOLD) {
                    activeCard.classList.add('is-open-right');
                }
            }
        }
        
        // Reseta todas as variáveis de estado
        activeCard = null;
        swipeDirection = 'none';
        
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);

        // Um atraso para prevenir cliques acidentais após um deslize,
        // alinhado com a duração da transição CSS (300ms + 50ms de margem).
        setTimeout(() => { isSwiping = false; }, 350);
    };

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
                    activeCard.classList.add('is-swiping');
                    const contentWrapper = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
                    if (contentWrapper) {
                        contentWrapper.draggable = false;
                    }
                } else {
                    swipeDirection = 'vertical';
                }
            }
        }

        if (swipeDirection === 'horizontal') {
            e.preventDefault(); // Previne a rolagem e outras ações
            currentX = e.clientX;
            // Transforma manualmente durante o deslize para feedback imediato
            const content = activeCard.querySelector<HTMLElement>('.habit-content-wrapper');
            if (content) {
                let baseTranslate = 0;
                if (wasOpenLeft) baseTranslate = swipeActionWidth;
                else if (wasOpenRight) baseTranslate = -swipeActionWidth;
                
                const deltaX = currentX - startX;
                const newTranslateX = baseTranslate + deltaX;
                const dragLimit = swipeActionWidth * 1.5;
                const clampedTranslateX = Math.max(-dragLimit, Math.min(dragLimit, newTranslateX));
                
                content.style.transform = `translateX(${clampedTranslateX}px)`;
            }
        } else if (swipeDirection === 'vertical') {
            // Se decidimos que é uma rolagem vertical, aborta o deslize.
            cleanup();
        }
    };

    habitContainer.addEventListener('pointerdown', (e) => {
        const card = (e.target as HTMLElement).closest<HTMLElement>('.habit-card');
        // Ignora se estiver clicando nos controles de meta
        if (!card || (e.target as HTMLElement).closest('.goal-control-btn')) return;

        // Fecha qualquer outro cartão aberto
        const currentlyOpen = document.querySelector('.habit-card.is-open-left, .habit-card.is-open-right');
        if (currentlyOpen && currentlyOpen !== card) {
            currentlyOpen.classList.remove('is-open-left', 'is-open-right');
        }

        activeCard = card;
        // Lê a largura da ação do CSS para garantir que JS e CSS estejam sempre sincronizados
        swipeActionWidth = parseFloat(getComputedStyle(activeCard).getPropertyValue('--swipe-action-width')) || 60;
        
        startX = e.clientX;
        startY = e.clientY;
        currentX = e.clientX; // Inicializa currentX
        swipeDirection = 'none'; // Reseta a direção
        wasOpenLeft = activeCard.classList.contains('is-open-left');
        wasOpenRight = activeCard.classList.contains('is-open-right');
        isSwiping = false; // Será definido como true apenas se um deslize horizontal for detectado

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', cleanup);
        window.addEventListener('pointercancel', cleanup);
    });
}