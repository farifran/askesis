
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

interface RotaryConfig {
    viewportEl: HTMLElement;
    reelEl: HTMLElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
    optionsCount: number;
    getInitialIndex: () => number;
    onIndexChange: (index: number) => Promise<void> | void;
    render: () => void;
}

export function setupReelRotary({
    viewportEl,
    reelEl,
    prevBtn,
    nextBtn,
    optionsCount,
    getInitialIndex,
    onIndexChange,
    render,
}: RotaryConfig) {

    let currentIndex = getInitialIndex();
    
    const handleIndexChange = async (direction: 'next' | 'prev') => {
        let nextIndex;
        // OTIMIZAÇÃO UX: A lógica de botões permite "dar a volta" (loop infinito),
        // o que é um padrão aceitável para botões de navegação, diferente do swipe linear.
        if (direction === 'next') {
            nextIndex = (currentIndex + 1) % optionsCount;
        } else {
            nextIndex = (currentIndex - 1 + optionsCount) % optionsCount;
        }
        await onIndexChange(nextIndex);
        currentIndex = getInitialIndex(); // Re-sincroniza caso o estado tenha sido atualizado externamente
        render(); // Garante que a UI seja redesenhada e alinhada após a mudança.
    };

    prevBtn.addEventListener('click', () => handleIndexChange('prev'));
    nextBtn.addEventListener('click', () => handleIndexChange('next'));

    viewportEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') handleIndexChange('next');
        else if (e.key === 'ArrowLeft') handleIndexChange('prev');
    });

    // Variáveis de estado para o gesto de swipe
    let startX = 0;
    let isSwiping = false;
    let startTransformX = 0;
    
    // PERFORMANCE [2025-02-23]: Cache da largura do item.
    // Ler `clientWidth` dentro do `pointerMove` causa "Layout Thrashing" (reflow forçado) a cada frame.
    // Agora lemos apenas uma vez no início do gesto (`pointerdown`).
    let cachedItemWidth = 0;
    
    const SWIPE_THRESHOLD = 40;

    const pointerMove = (e: PointerEvent) => {
        if (!isSwiping) return;
        
        // UX CRÍTICA: Previne que o navegador interprete o gesto como rolagem de página ou navegação "voltar".
        // Essencial para a sensação de app nativo em mobile.
        e.preventDefault();
        
        const diffX = e.clientX - startX;
        
        // Usa o valor cacheado em vez de consultar o DOM
        const newTranslateX = startTransformX + diffX;
        
        // Clamping (Limites): Impede arrastar muito além do primeiro ou último item
        const minTranslateX = -(optionsCount - 1) * cachedItemWidth;
        // Permite um leve "over-drag" elástico (opcional, aqui mantemos hard limit para simplicidade)
        const clampedTranslateX = Math.max(minTranslateX, Math.min(0, newTranslateX));
        
        reelEl.style.transform = `translateX(${clampedTranslateX}px)`;
    };

    const endSwipe = (e: PointerEvent) => {
        // Limpeza de listeners globais
        window.removeEventListener('pointermove', pointerMove);
        window.removeEventListener('pointerup', pointerUp);
        window.removeEventListener('pointercancel', endSwipe);
        
        if (!isSwiping) return;
        isSwiping = false;
        
        // UX: Libera a captura do ponteiro para permitir interações normais subsequentes
        try {
            if (viewportEl.hasPointerCapture(e.pointerId)) {
                viewportEl.releasePointerCapture(e.pointerId);
            }
        } catch (err) {
            // Ignora erros se o ponteiro já foi perdido
        }
        
        // Restaura a transição CSS para o efeito de "snap" (o render() recalculará a posição final)
        requestAnimationFrame(() => {
            reelEl.style.transition = '';
        });

        currentIndex = getInitialIndex();
        render();
    };

    const pointerUp = async (e: PointerEvent) => {
        if (!isSwiping) return;
        
        const diffX = e.clientX - startX;
        
        // Lógica de limiar para decidir se muda o índice
        if (Math.abs(diffX) > SWIPE_THRESHOLD) {
            if (diffX < 0) { // Deslize para a esquerda (Próximo Item)
                await onIndexChange(Math.min(optionsCount - 1, currentIndex + 1));
            } else { // Deslize para a direita (Item Anterior)
                await onIndexChange(Math.max(0, currentIndex - 1));
            }
        }
        
        endSwipe(e);
    };

    viewportEl.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return; // Apenas botão esquerdo/toque principal

        // PERFORMANCE: Calcula métricas de layout apenas uma vez no início da interação
        const firstChild = reelEl.firstElementChild;
        if (!firstChild) return;
        cachedItemWidth = firstChild.clientWidth;

        // Estado inicial
        startX = e.clientX;
        isSwiping = true;
        currentIndex = getInitialIndex();
        
        // UX CRÍTICA: Pointer Capture.
        // Garante que os eventos de movimento continuem sendo enviados para este elemento
        // mesmo se o dedo/mouse sair da área do elemento.
        viewportEl.setPointerCapture(e.pointerId);

        // Lê a posição atual da transformação para iniciar o arrasto relativo a ela
        const style = window.getComputedStyle(reelEl);
        const matrix = new DOMMatrix(style.transform);
        startTransformX = matrix.m41;
        
        // Desativa transição CSS para movimento direto e responsivo (1:1 com o dedo)
        reelEl.style.transition = 'none';
        
        // Adiciona listeners à janela para capturar movimentos fora do elemento (backup de segurança)
        window.addEventListener('pointermove', pointerMove, { passive: false }); // passive: false permite preventDefault
        window.addEventListener('pointerup', pointerUp);
        window.addEventListener('pointercancel', endSwipe);
    });
}
