
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Módulo criado. Contém helpers de DOM puros.

import { t } from '../i18n';

/**
 * OTIMIZAÇÃO DE PERFORMANCE: Helper para atualizar textContent apenas se o valor mudou.
 * Evita recálculos de layout/paint desnecessários no navegador.
 */
export function setTextContent(element: Element | null, text: string) {
    if (element && element.textContent !== text) {
        element.textContent = text;
    }
}

export function updateReelRotaryARIA(viewportEl: HTMLElement, currentIndex: number, options: readonly string[] | string[], labelKey: string) {
    if (!viewportEl) return;
    viewportEl.setAttribute('role', 'slider');
    viewportEl.setAttribute('aria-label', t(labelKey));
    viewportEl.setAttribute('aria-valuemin', '1');
    viewportEl.setAttribute('aria-valuemax', String(options.length));
    viewportEl.setAttribute('aria-valuenow', String(currentIndex + 1));
    viewportEl.setAttribute('aria-valuetext', options[currentIndex]);
    viewportEl.setAttribute('tabindex', '0');
}

// HELPER: Container para aplicação de inert.
export const getMainContainer = (): HTMLElement | null => document.querySelector('.app-container');
