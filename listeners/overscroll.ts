/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file listeners/overscroll.ts
 * @description Elastic overscroll visual effect for the habit container.
 */

export function setupHabitOverscroll(container: HTMLElement) {
    if (!container) return;
    if ((container as any).__overscrollAttached) return;
    (container as any).__overscrollAttached = true;

    const MAX_OVERSCROLL_PX = 140;
    const RESISTANCE = 0.35;
    let activePointerId: number | null = null;
    let startY = 0;
    let offset = 0;
    let raf = 0;
    let isOverscrolling = false;

    const maxScroll = () => Math.max(0, container.scrollHeight - container.clientHeight);
    const shouldSkip = () => document.body.classList.contains('is-dragging-active') ||
                             document.body.classList.contains('is-interaction-active') ||
                             container.classList.contains('is-locking-scroll') ||
                             container.classList.contains('is-dragging');

    function applyTransform(y: number) {
        container.style.transform = y ? `translateY(${y}px)` : '';
    }

    function scheduleUpdate() {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            if (isOverscrolling) {
                container.style.transition = 'none';
                container.style.willChange = 'transform';
                applyTransform(offset);
            }
        });
    }

    function onPointerDown(e: PointerEvent) {
        if (shouldSkip()) return;
        if (e.button && e.button !== 0) return;
        activePointerId = e.pointerId;
        startY = e.clientY;
        try { container.setPointerCapture(activePointerId); } catch {}
    }

    function onPointerMove(e: PointerEvent) {
        if (activePointerId !== e.pointerId) return;
        if (shouldSkip()) return;

        const dy = e.clientY - startY;
        const atTop = container.scrollTop <= 0;
        const atBottom = container.scrollTop >= maxScroll() - 1;

        if ((atTop && dy > 0) || (atBottom && dy < 0)) {
            isOverscrolling = true;
            const sign = Math.sign(dy);
            const abs = Math.abs(dy);
            offset = sign * Math.min(MAX_OVERSCROLL_PX, Math.pow(abs, 0.95) * RESISTANCE + 0.5);
            scheduleUpdate();
            e.preventDefault();
        } else if (isOverscrolling) {
            isOverscrolling = false;
            offset = 0;
            scheduleUpdate();
        }
    }

    function finishOverscroll() {
        if (!isOverscrolling && !!container.style.transform) {
            container.style.transition = 'transform 260ms cubic-bezier(.22,.9,.32,1)';
            applyTransform(0);
            const onTr = () => {
                container.style.transition = '';
                container.style.willChange = '';
                container.removeEventListener('transitionend', onTr);
            };
            container.addEventListener('transitionend', onTr);
            return;
        }
        if (isOverscrolling) {
            isOverscrolling = false;
            container.style.transition = 'transform 260ms cubic-bezier(.22,.9,.32,1)';
            applyTransform(0);
            const onTr = () => {
                container.style.transition = '';
                container.style.willChange = '';
                container.removeEventListener('transitionend', onTr);
            };
            container.addEventListener('transitionend', onTr);
            offset = 0;
        }
    }

    function onPointerUp(e: PointerEvent) {
        if (activePointerId !== null && activePointerId === e.pointerId) {
            try { container.releasePointerCapture(e.pointerId); } catch {}
            activePointerId = null;
        } else {
            activePointerId = null;
        }
        finishOverscroll();
    }

    container.addEventListener('pointerdown', onPointerDown, { passive: true });
    container.addEventListener('pointermove', onPointerMove, { passive: false });
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
}
