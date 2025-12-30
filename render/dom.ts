
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render/dom.ts
 * @description Abstrações de Baixo Nível para Manipulação do DOM (DOM Utils).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo contém funções utilitárias invocadas frequentemente (Hot Paths) pelo motor de renderização.
 * 
 * ARQUITETURA (Micro-Optimizations):
 * - **Responsabilidade Única:** Prover métodos seguros e performáticos para escrita no DOM.
 * - **Typed OM:** Utiliza `attributeStyleMap` para manipulação de estilos sem overhead de parsing de string.
 * - **Layout Thrashing Prevention:** Implementa padrões de "Dirty Checking".
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Direct Node Access:** Prefere `firstChild.nodeValue` sobre `textContent`.
 * 2. **Type Safety:** Wrappers para APIs experimentais do CSS.
 */

import { t } from '../i18n';

// --- POLYFILL TYPES PARA TYPED OM ---
declare global {
    interface Element {
        attributeStyleMap?: StylePropertyMap;
    }
    interface StylePropertyMap {
        set(property: string, value: any): void;
        get(property: string): any;
        delete(property: string): void;
        clear(): void;
    }
    // SOTA FIX: Definições globais removidas pois causam conflito de identificador duplicado
    // em ambientes com lib DOM atualizada (TypeScript 4.4+ / ES2020+).
    // As interfaces CSS, CSSTransformValue, CSSTranslate e CSSUnparsedValue já existem no escopo global.
}

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
 * Atualiza os atributos ARIA para o componente 'Reel Rotary' (Carrossel).
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
 * SOTA: Aplica transformação de translação X usando CSS Typed OM.
 */
export function setTransformX(el: HTMLElement, x: number) {
    if (el.attributeStyleMap) {
        try {
            el.attributeStyleMap.set('transform', new CSSTransformValue([
                new CSSTranslate(CSS.px(x), CSS.px(0))
            ]));
        } catch (e) {
            el.style.transform = `translateX(${x}px)`;
        }
    } else {
        el.style.transform = `translateX(${x}px)`;
    }
}

/**
 * SOTA: Aplica transformação de translação Y (Vertical) usando CSS Typed OM.
 */
export function setTransformY(el: HTMLElement, y: number) {
    if (el.attributeStyleMap) {
        try {
            el.attributeStyleMap.set('transform', new CSSTransformValue([
                new CSSTranslate(CSS.px(0), CSS.px(y), CSS.px(0))
            ]));
        } catch (e) {
            el.style.transform = `translate3d(0, ${y}px, 0)`;
        }
    } else {
        el.style.transform = `translate3d(0, ${y}px, 0)`;
    }
}

/**
 * SOTA: Aplica transformação composta (2 Steps) usando Typed OM.
 * Útil para Tooltips: translate(px, px) + translate(%, %).
 */
export function setTransformComposite(el: HTMLElement, pxX: number, pxY: number, percentX: number, percentY: number) {
    if (el.attributeStyleMap) {
        try {
            el.attributeStyleMap.set('transform', new CSSTransformValue([
                new CSSTranslate(CSS.px(pxX), CSS.px(pxY)),
                new CSSTranslate(CSS.percent(percentX), CSS.percent(percentY))
            ]));
        } catch (e) {
            el.style.transform = `translate3d(${pxX}px, ${pxY}px, 0) translate3d(${percentX}%, ${percentY}%, 0)`;
        }
    } else {
        el.style.transform = `translate3d(${pxX}px, ${pxY}px, 0) translate3d(${percentX}%, ${percentY}%, 0)`;
    }
}

/**
 * SOTA: Define uma propriedade de estilo pixel (top, left, height, etc) usando Typed OM.
 */
export function setStylePixels(el: HTMLElement, property: string, value: number) {
    if (el.attributeStyleMap) {
        try {
            el.attributeStyleMap.set(property, CSS.px(value));
        } catch (e) {
            el.style.setProperty(property, `${value}px`);
        }
    } else {
        el.style.setProperty(property, `${value}px`);
    }
}

/**
 * SOTA: Define uma Variável CSS (Custom Property) com tipos numéricos.
 */
export function setCSSVariable(el: HTMLElement, property: string, value: number, unit: 'px' | '%' | 'deg' | 'number' = 'number') {
    if (el.attributeStyleMap) {
        try {
            let typedValue: any;
            if (unit === 'px') typedValue = CSS.px(value);
            else if (unit === '%') typedValue = CSS.percent(value);
            else if (unit === 'deg') typedValue = CSS.deg(value);
            else typedValue = CSS.number(value);
            
            el.attributeStyleMap.set(property, typedValue);
        } catch (e) {
            const suffix = unit === 'number' ? '' : unit;
            el.style.setProperty(property, `${value}${suffix}`);
        }
    } else {
        const suffix = unit === 'number' ? '' : unit;
        el.style.setProperty(property, `${value}${suffix}`);
    }
}

/**
 * SOTA: Define uma Variável CSS (Custom Property) do tipo String (ex: Cores).
 * Utiliza CSSUnparsedValue para compatibilidade com Typed OM.
 */
export function setCSSVariableString(el: HTMLElement, property: string, value: string) {
    if (el.attributeStyleMap) {
        try {
            el.attributeStyleMap.set(property, new CSSUnparsedValue([value]));
        } catch (e) {
            el.style.setProperty(property, value);
        }
    } else {
        el.style.setProperty(property, value);
    }
}

/**
 * SOTA: Define cores usando Typed OM.
 */
export function setStyleColor(el: HTMLElement, property: 'color' | 'background-color' | 'border-color', value: string) {
    if (el.attributeStyleMap) {
        try {
            el.attributeStyleMap.set(property, value);
        } catch (e) {
            if (property === 'background-color') el.style.backgroundColor = value;
            else if (property === 'border-color') el.style.borderColor = value;
            else el.style.color = value;
        }
    } else {
        if (property === 'background-color') el.style.backgroundColor = value;
        else if (property === 'border-color') el.style.borderColor = value;
        else el.style.color = value;
    }
}
