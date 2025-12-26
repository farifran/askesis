
// ... (previous code)
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
// ... (rest of function)
}

/**
 * CRITICAL LOGIC: Event Suppression.
 * Se o usuário arrastou o cartão, o evento 'click' subsequente (disparado ao soltar)
 * deve ser interceptado para não ativar a ação de clique do cartão (toggle status).
 * Usa a fase de captura (true) para interceptar antes que chegue aos listeners do cartão.
 */
function _blockSubsequentClick(deltaX: number) {
// ... (rest of function)
}

// PERFORMANCE: Lê o CSS apenas quando necessário (resize), evitando Forced Reflows no hot path.
function updateCachedLayoutValues() {
    const rootStyles = getComputedStyle(document.documentElement);
    // BUGFIX: Fallback seguro para 60 se parseInt falhar (NaN).
    cachedSwipeActionWidth = parseInt(rootStyles.getPropertyValue('--swipe-action-width'), 10) || 60;
}

export function setupSwipeHandler(habitContainer: HTMLElement) {
// ... (rest of the file remains the same)
