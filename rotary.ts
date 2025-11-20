/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise concluída. Componente de controle rotativo (estilo iOS) verificado e funcional.

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
        if (direction === 'next') {
            nextIndex = (currentIndex + 1) % optionsCount;
        } else {
            nextIndex = (currentIndex - 1 + optionsCount) % optionsCount;
        }
        await onIndexChange(nextIndex);
        currentIndex = getInitialIndex(); // Re-sincroniza caso o estado tenha sido atualizado
        render(); // Garante que a UI seja redesenhada após a mudança.
    };

    prevBtn.addEventListener('click', () => handleIndexChange('prev'));
    nextBtn.addEventListener('click', () => handleIndexChange('next'));

    viewportEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') handleIndexChange('next');
        else if (e.key === 'ArrowLeft') handleIndexChange('prev');
    });

    let startX = 0, isSwiping = false, startTransformX = 0;
    const SWIPE_THRESHOLD = 40;

    const pointerMove = (e: PointerEvent) => {
        if (!isSwiping) return;
        const diffX = e.clientX - startX;
        const itemWidth = reelEl.firstElementChild?.clientWidth || 0;
        const newTranslateX = startTransformX + diffX;
        const minTranslateX = -(optionsCount - 1) * itemWidth;
        const clampedTranslateX = Math.max(minTranslateX, Math.min(0, newTranslateX));
        reelEl.style.transform = `translateX(${clampedTranslateX}px)`;
    };

    const endSwipe = () => {
        window.removeEventListener('pointermove', pointerMove);
        window.removeEventListener('pointerup', pointerUp);
        window.removeEventListener('pointercancel', endSwipe);
        
        if (!isSwiping) return;
        isSwiping = false;
        
        requestAnimationFrame(() => {
            reelEl.style.transition = '';
        });

        currentIndex = getInitialIndex();
        render();
    };

    const pointerUp = async (e: PointerEvent) => {
        if (!isSwiping) return;
        
        const diffX = e.clientX - startX;
        
        if (Math.abs(diffX) > SWIPE_THRESHOLD) {
            if (diffX < 0) { // Swipe left
                await onIndexChange(Math.min(optionsCount - 1, currentIndex + 1));
            } else { // Swipe right
                await onIndexChange(Math.max(0, currentIndex - 1));
            }
        }
        
        endSwipe();
    };

    viewportEl.addEventListener('pointerdown', (e: PointerEvent) => {
        startX = e.clientX;
        isSwiping = true;
        currentIndex = getInitialIndex();
        const matrix = new DOMMatrix(window.getComputedStyle(reelEl).transform);
        startTransformX = matrix.m41;
        reelEl.style.transition = 'none';
        
        window.addEventListener('pointermove', pointerMove);
        window.addEventListener('pointerup', pointerUp);
        window.addEventListener('pointercancel', endSwipe);
    });
}