
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { t } from '../i18n';

/**
 * OTIMIZAÇÃO DE PERFORMANCE: Helper para atualizar texto do DOM.
 * Verifica primeiro se é um TextNode simples para usar `nodeValue` (mais rápido),
 * caso contrário usa `textContent`, sempre evitando escritas desnecessárias (layout thrashing).
 */
export function setTextContent(element: Element | null, text: string) {
    if (!element) return;

    // Fast path: Se o elemento contém apenas um nó de texto simples, atualiza o valor do nó diretamente.
    // Isso é mais performático que .textContent porque pula passos de normalização do DOM.
    if (element.firstChild && element.firstChild.nodeType === 3 && !element.firstChild.nextSibling) {
        if (element.firstChild.nodeValue !== text) {
            element.firstChild.nodeValue = text;
        }
    } else {
        // Fallback seguro ou para elementos com estrutura mista
        if (element.textContent !== text) {
            element.textContent = text;
        }
    }
}

export function updateReelRotaryARIA(viewportEl: HTMLElement, currentIndex: number, options: readonly string[] | string[], labelKey: string) {
    if (!viewportEl) return;
    viewportEl.setAttribute('role', 'slider');
    viewportEl.setAttribute('aria-label', t(labelKey));
    viewportEl.setAttribute('aria-valuemin', '1');
    viewportEl.setAttribute('aria-valuemax', String(options.length));
    viewportEl.setAttribute('aria-valuenow', String(currentIndex + 1));
    // A11Y FIX [2025-03-08]: Guard against undefined index access to prevent "undefined" string in ARIA.
    viewportEl.setAttribute('aria-valuetext', options[currentIndex] || '');
    viewportEl.setAttribute('tabindex', '0');
}
