/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file listeners/overscroll.ts
 * @description Efeito elástico (overscroll) visual para o container de hábitos.
 * Quando o usuário tenta rolar além do topo/fundo, o container desloca-se até
 * `MAX_OVERSCROLL_PX` e retorna com animação elástica.
 */

const MAX_OVERSCROLL_PX = 10; // deslocamento máximo visual
const SCALE_FACTOR = 0.35; // reduz impacto do delta do gesto
const RELEASE_ANIM_CLASS = 'overscroll-release';

export function setupOverscroll(container: HTMLElement) {
    if (!container) return;

    let activeOffset = 0; // px, + = downwards, - = upwards
    let lastTouchY = 0;
    let isTouching = false;
    let wheelResetTimer: number | null = null;

    function applyOffset(px: number) {
        activeOffset = Math.max(-MAX_OVERSCROLL_PX, Math.min(MAX_OVERSCROLL_PX, px));
        // set CSS var used by release animation and also apply immediate transform
        container.style.setProperty('--overscroll', `${activeOffset}px`);
        container.style.transform = `translateY(${activeOffset}px)`;
        // hint for compositor
        container.style.willChange = 'transform';
    }

    function resetOffsetWithAnimation() {
        if (activeOffset === 0) return;
        // Ensure CSS var is set so keyframes can reference it
        container.style.setProperty('--overscroll', `${activeOffset}px`);
        // Trigger animation class which uses --overscroll variable
        container.classList.add(RELEASE_ANIM_CLASS);
        const onAnimEnd = () => {
            container.classList.remove(RELEASE_ANIM_CLASS);
            container.style.transform = '';
            container.style.removeProperty('--overscroll');
            container.style.willChange = '';
            activeOffset = 0;
            container.removeEventListener('animationend', onAnimEnd);
        };
        container.addEventListener('animationend', onAnimEnd);
    }

    // TOUCH HANDLERS
    function onTouchStart(e: TouchEvent) {
        if (e.touches.length !== 1) return;
        isTouching = true;
        lastTouchY = e.touches[0].clientY;
        if (wheelResetTimer) { clearTimeout(wheelResetTimer); wheelResetTimer = null; }
    }

    function onTouchMove(e: TouchEvent) {
        if (!isTouching) return;
        if (e.touches.length !== 1) return;

        const touchY = e.touches[0].clientY;
        const dy = touchY - lastTouchY; // positive = pulling down
        lastTouchY = touchY;

        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        const atTop = container.scrollTop <= 0;
        const atBottom = container.scrollTop >= maxScroll - 0.5;

        // If the user attempts to scroll beyond bounds, activate overscroll visual
        if ((atTop && dy > 0) || (atBottom && dy < 0)) {
            // Prevent native overscroll & page scroll
            e.preventDefault();
            const sign = dy > 0 ? 1 : -1;
            const additional = Math.abs(dy) * SCALE_FACTOR;
            applyOffset(activeOffset + sign * additional);
        } else if (activeOffset !== 0) {
            // User moved back into range: reduce offset smoothly
            applyOffset(activeOffset * 0.6);
        }
    }

    function onTouchEnd() {
        isTouching = false;
        resetOffsetWithAnimation();
    }

    // WHEEL HANDLER (desktop)
    function onWheel(e: WheelEvent) {
        if (e.deltaY === 0) return;
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        const atTop = container.scrollTop <= 0;
        const atBottom = container.scrollTop >= maxScroll - 0.5;

        if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0) || maxScroll === 0) {
            // Prevent default scrolling beyond bounds and show overscroll effect
            e.preventDefault();
            const sign = e.deltaY > 0 ? -1 : 1; // wheel down -> negative offset
            const delta = Math.abs(e.deltaY) * 0.02; // gentle mapping
            applyOffset(activeOffset + sign * delta);

            // Reset after user stops wheel (debounced)
            if (wheelResetTimer) clearTimeout(wheelResetTimer);
            wheelResetTimer = window.setTimeout(() => {
                wheelResetTimer = null;
                resetOffsetWithAnimation();
            }, 120);
        }
    }

    // Respect interaction and dragging modes
    const shouldIgnore = () => document.body.classList.contains('is-dragging-active') || document.body.classList.contains('is-interaction-active') || container.classList.contains('is-dragging');

    // Wrapped handlers with guard
    const _onTouchStart = (e: TouchEvent) => { if (shouldIgnore()) return; onTouchStart(e); };
    const _onTouchMove = (e: TouchEvent) => { if (shouldIgnore()) return; onTouchMove(e); };
    const _onTouchEnd = (e: TouchEvent) => { if (shouldIgnore()) return onTouchEnd(); onTouchEnd(); };
    const _onWheel = (e: WheelEvent) => { if (shouldIgnore()) return; onWheel(e); };

    container.addEventListener('touchstart', _onTouchStart, { passive: true });
    // touchmove must be non-passive so we can preventDefault when overscrolling
    container.addEventListener('touchmove', _onTouchMove as EventListener, { passive: false });
    container.addEventListener('touchend', _onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', _onTouchEnd, { passive: true });

    // wheel needs to be non-passive to call preventDefault
    container.addEventListener('wheel', _onWheel as EventListener, { passive: false });
}

export default setupOverscroll;
