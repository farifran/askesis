/**
 * @license
 * SPDX-License-Identifier: MIT
*/

/**
 * @file render/dom.ts
 * @description Abstrações de Baixo Nível para Manipulação do DOM (DOM Utils).
 */

import { t } from '../i18n';

/**
 * OTIMIZAÇÃO DE PERFORMANCE: Helper para atualizar texto do DOM.
 */
export function setTextContent(element: Element | null, text: string) {
    if (!element) return;
    if (element.firstChild && element.firstChild.nodeType === 3 && !element.firstChild.nextSibling) {
        if (element.firstChild.nodeValue !== text) {
            element.firstChild.nodeValue = text;
        }
    } else {
        if (element.textContent !== text) {
            element.textContent = text;
        }
    }
}

/**
 * Atualiza os atributos ARIA para o componente 'Reel Rotary'.
 */
export function updateReelRotaryARIA(viewportEl: HTMLElement, currentIndex: number, options: readonly string[] | string[], labelKey: string) {
    if (!viewportEl) return;
    viewportEl.setAttribute('role', 'slider');
    viewportEl.setAttribute('aria-label', t(labelKey));
    viewportEl.setAttribute('aria-valuemin', '1');
    viewportEl.setAttribute('aria-valuemax', String(options.length));
    viewportEl.setAttribute('aria-valuenow', String(currentIndex + 1));
    viewportEl.setAttribute('aria-valuetext', options[currentIndex] || '');
    viewportEl.setAttribute('tabindex', '0');
}

/**
 * Renderiza SVG confiavel sem usar innerHTML no elemento de destino.
 */
export function setTrustedSvgContent(element: Element | null, svgOrText: string) {
    if (!element) return;
    if (!svgOrText) {
        element.replaceChildren();
        return;
    }

    if (!svgOrText.trim().startsWith('<svg')) {
        element.textContent = svgOrText;
        return;
    }

    try {
        const parsed = new DOMParser().parseFromString(svgOrText, 'image/svg+xml');
        const svg = parsed.documentElement;
        if (svg.nodeName.toLowerCase() !== 'svg') {
            element.textContent = svgOrText;
            return;
        }
        const imported = document.importNode(svg, true);
        element.replaceChildren(imported);
    } catch {
        element.textContent = svgOrText;
    }
}

/**
 * Renderiza markup leve e confiavel usando DocumentFragment, sem atribuicao de innerHTML.
 */
export function setTrustedHtmlFragment(target: HTMLElement | null, html: string) {
    if (!target) return;
    const normalized = html || '';
    const current = target.getAttribute('data-rendered-html') || '';
    if (current === normalized) return;

    if (!normalized) {
        target.replaceChildren();
        target.setAttribute('data-rendered-html', '');
        return;
    }

    const fragment = document.createRange().createContextualFragment(normalized);
    target.replaceChildren(fragment);
    target.setAttribute('data-rendered-html', normalized);
}

/**
 * Analisa uma string HTML, remove tags e atributos perigosos e retorna um DocumentFragment seguro.
 * Bloqueia: script, iframe, object, embed, link, meta, style, handlers on*, javascript: hrefs.
 */
export function sanitizeHtmlToFragment(html: string): DocumentFragment {
    const template = document.createElement('template');
    template.innerHTML = html;

    const blockedTags = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style'];
    for (const tag of blockedTags) {
        template.content.querySelectorAll(tag).forEach(node => node.remove());
    }

    const elements = template.content.querySelectorAll('*');
    for (const el of elements) {
        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
            const attrName = attr.name.toLowerCase();
            const attrValue = attr.value.trim().toLowerCase();
            if (attrName.startsWith('on')) {
                el.removeAttribute(attr.name);
                continue;
            }
            if ((attrName === 'href' || attrName === 'src' || attrName === 'xlink:href') && attrValue.startsWith('javascript:')) {
                el.removeAttribute(attr.name);
            }
        }
    }

    return template.content;
}