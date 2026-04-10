/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file listeners/overscroll.ts
 * @description Elastic overscroll visual feedback for `#habit-container`.
 *
 * Implements a lightweight JS-based elastic effect when the user attempts to scroll
 * past the top or bottom of the habit list. The effect is intentionally non-invasive:
 * - Does not change scrollTop (visual-only)
 * - Respects existing interaction locks (drag/swipe)
 * - Uses a damping factor and clamps overshoot
 */

const DAMPING = 0.35;
const MAX_OVERSCROLL = 96; // px
const DIRECTION_LOCK_THRESHOLD = 6;

function wrapContent(container: HTMLElement) {
    const existing = container.querySelector('.habit-scroll-content') as HTMLElement | null;
    if (existing) return existing;

    const wrapper = document.createElement('div');
    wrapper.className = 'habit-scroll-content';
    // Move children into wrapper
    while (container.firstChild) wrapper.appendChild(container.firstChild);
    container.appendChild(wrapper);
    return wrapper;
}

export function setupOverscrollHandler(container: HTMLElement) {
    if (!container) return;
    // Avoid double-install
    if ((container as any).__overscroll_installed) return;
    (container as any).__overscroll_installed = true;

    const content = wrapContent(container);

    let tracking = false;
    let startY = 0;
    let startX = 0;
    let startScrollTop = 0;
    let pointerId = -1;
    let directionLocked = false;
    let currentTranslate = 0;

    const setTransform = (y: number) => {
        currentTranslate = y;
        // disable transition while dragging
        content.style.transition = 'none';
        content.style.transform = `translateY(${y}px)`;
        container.classList.toggle('is-overscrolling', y !== 0);
    };

    const resetTransform = () => {
        if (currentTranslate === 0) return;
        content.style.transition = 'transform 520ms cubic-bezier(0.22,0.8,0.28,1)';
        content.style.transform = '';
        container.classList.remove('is-overscrolling');
        currentTranslate = 0;
        const cleanup = () => {
            content.style.transition = '';
            content.removeEventListener('transitionend', cleanup);
        };
        content.addEventListener('transitionend', cleanup);
    };

    const onPointerDown = (e: PointerEvent) => {
        // Only track touch/pen interactions for the elastic effect
        if (e.button !== 0) return;
        if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
        // Skip if other heavy interactions are active
        if (document.body.classList.contains('is-interaction-active') || document.body.classList.contains('is-dragging-active')) return;

        tracking = true;
        pointerId = e.pointerId;
        startY = e.clientY;
        startX = e.clientX;
        startScrollTop = container.scrollTop;
        directionLocked = false;

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerCancel);
    };

    const onPointerMove = (e: PointerEvent) => {
        if (!tracking || e.pointerId !== pointerId) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!directionLocked) {
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > DIRECTION_LOCK_THRESHOLD) {
                // Horizontal interaction -> do not treat as vertical overscroll
                directionLocked = true;
                // Stop tracking vertical overscroll for this gesture
                return;
            }
            if (Math.abs(dy) > DIRECTION_LOCK_THRESHOLD) directionLocked = true;
        }

        // No vertical significant movement yet
        if (Math.abs(dy) < 2) return;

        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

        // TOP overscroll
        if (startScrollTop <= 0 && dy > 0) {
            const damped = Math.min(MAX_OVERSCROLL, dy * DAMPING);
            setTransform(damped);
            // Prevent browser from doing anything unexpected
            if (e.cancelable) e.preventDefault();
            return;
        }

        // BOTTOM overscroll
        if (startScrollTop >= maxScroll && dy < 0) {
            const damped = Math.max(-MAX_OVERSCROLL, dy * DAMPING);
            setTransform(damped);
            if (e.cancelable) e.preventDefault();
            return;
        }

        // If the user moved back into bounds while we had a transform applied, reset it
        if (currentTranslate !== 0) {
            resetTransform();
        }
    };

    const cleanupPointers = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
    };

    const onPointerUp = (_e: PointerEvent) => {
        tracking = false;
        pointerId = -1;
        directionLocked = false;
        cleanupPointers();
        resetTransform();
    };

    const onPointerCancel = (_e: PointerEvent) => {
        tracking = false;
        pointerId = -1;
        directionLocked = false;
        cleanupPointers();
        resetTransform();
    };

    container.addEventListener('pointerdown', onPointerDown);

    // Desktop 'wheel' gentle feedback (subtle, non-blocking)
    const onWheel = (e: WheelEvent) => {
        // Only act when at edge and user still attempts to scroll further
        const delta = e.deltaY;
        const st = container.scrollTop;
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        if (st <= 0 && delta < 0) {
            // small visual nudge
            setTransform(Math.max(-8, Math.min(24, -delta * 0.06)));
            window.setTimeout(resetTransform, 160);
        } else if (st >= maxScroll && delta > 0) {
            setTransform(Math.min(8, Math.max(-24, -delta * 0.06)));
            window.setTimeout(resetTransform, 160);
        }
    };

    container.addEventListener('wheel', onWheel, { passive: true });
}

export default setupOverscrollHandler;
