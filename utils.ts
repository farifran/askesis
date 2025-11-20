
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

declare global {
    interface Window {
        OneSignal?: any[];
        OneSignalDeferred?: any[];
    }
}

// --- UUID ---
export function generateUUID(): string {
    return crypto.randomUUID();
}

// --- Date Helpers ---
export function toUTCIsoDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function getTodayUTC(): Date {
    const today = new Date();
    // CORREÇÃO DE FUSO HORÁRIO [2024-11-26]: Usa componentes locais para determinar o "hoje" do usuário.
    return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

export function getTodayUTCIso(): string {
    return toUTCIsoDateString(getTodayUTC());
}

export function parseUTCIsoDate(isoString: string): Date {
    return new Date(`${isoString}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

// --- Formatting & Localization Performance ---

// Cache para instâncias de Intl.DateTimeFormat.
// A criação desses objetos é custosa, então reutilizá-los melhora significativamente a performance de renderização
// em loops (como no calendário e gráficos).
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Obtém um formatador de data cacheado para o locale e opções especificados.
 * @param locale O código do idioma (ex: 'pt-BR').
 * @param options As opções de formatação do Intl.DateTimeFormat.
 * @returns Uma instância de Intl.DateTimeFormat.
 */
export function getDateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    // Cria uma chave única baseada no locale e nas opções ordenadas (para consistência).
    const optionsKey = JSON.stringify(Object.entries(options).sort((a, b) => a[0].localeCompare(b[0])));
    const key = `${locale}|${optionsKey}`;

    if (!dateTimeFormatCache.has(key)) {
        dateTimeFormatCache.set(key, new Intl.DateTimeFormat(locale, options));
    }
    return dateTimeFormatCache.get(key)!;
}

export function escapeHTML(str: string): string {
    return str.replace(/[&<>"']/g, function (match) {
        switch (match) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return match;
        }
    });
}

// OTIMIZAÇÃO DE PERFORMANCE [2024-12-28]: Expressões regulares movidas para o escopo do módulo
// para serem compiladas apenas uma vez, em vez de a cada chamada da função formatInline.
const MD_BOLD_ITALIC_REGEX = /\*\*\*(.*?)\*\*\*/g;
const MD_BOLD_REGEX = /\*\*(.*?)\*\*/g;
const MD_ITALIC_REGEX = /\*(.*?)\*/g;
const MD_STRIKE_REGEX = /~~(.*?)~~/g;

export function simpleMarkdownToHTML(text: string): string {
    const lines = text.split('\n');
    let html = '';
    let inUnorderedList = false;
    let inOrderedList = false;

    const closeUnorderedList = () => {
        if (inUnorderedList) {
            html += '</ul>';
            inUnorderedList = false;
        }
    };
    const closeOrderedList = () => {
        if (inOrderedList) {
            html += '</ol>';
            inOrderedList = false;
        }
    };

    const formatInline = (line: string): string => {
        return escapeHTML(line)
            .replace(MD_BOLD_ITALIC_REGEX, '<strong><em>$1</em></strong>')
            .replace(MD_BOLD_REGEX, '<strong>$1</strong>')
            .replace(MD_ITALIC_REGEX, '<em>$1</em>')
            .replace(MD_STRIKE_REGEX, '<del>$1</del>');
    };

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith('### ')) {
            closeUnorderedList();
            closeOrderedList();
            html += `<h3>${formatInline(line.substring(4))}</h3>`;
            continue;
        }
        if (trimmedLine.startsWith('## ')) {
            closeUnorderedList();
            closeOrderedList();
            html += `<h2>${formatInline(line.substring(3))}</h2>`;
            continue;
        }
        if (trimmedLine.startsWith('# ')) {
            closeUnorderedList();
            closeOrderedList();
            html += `<h1>${formatInline(line.substring(2))}</h1>`;
            continue;
        }

        if (trimmedLine.startsWith('* ') || trimmedLine.startsWith('- ')) {
            closeOrderedList();
            if (!inUnorderedList) {
                html += '<ul>';
                inUnorderedList = true;
            }
            html += `<li>${formatInline(line.trim().substring(2))}</li>`;
            continue;
        }

        if (trimmedLine.match(/^\d+\.\s/)) {
            closeUnorderedList();
            if (!inOrderedList) {
                html += '<ol>';
                inOrderedList = true;
            }
            html += `<li>${formatInline(line.replace(/^\d+\.\s/, ''))}</li>`;
            continue;
        }
        
        closeUnorderedList();
        closeOrderedList();
        if (trimmedLine.length > 0) {
            html += `<p>${formatInline(line)}</p>`;
        }
    }

    closeUnorderedList();
    closeOrderedList();
    return html;
}

export function debounce<T extends (...args: any[]) => void>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: number | null;
    return function (...args: Parameters<T>) {
        const later = () => {
            timeout = null;
            func(...args);
        };
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = window.setTimeout(later, wait);
    };
}

export function pushToOneSignal(callback: (oneSignal: any) => void) {
    if (typeof window.OneSignal === 'undefined') {
        window.OneSignalDeferred = window.OneSignalDeferred || [];
        window.OneSignalDeferred.push(callback);
    } else {
        callback(window.OneSignal);
    }
}

export function triggerHaptic(type: 'selection' | 'light' | 'medium' | 'heavy' | 'success' | 'error') {
    if (!navigator.vibrate) return;

    try {
        switch (type) {
            case 'selection':
            case 'light':
                navigator.vibrate(10);
                break;
            case 'medium':
                navigator.vibrate(25);
                break;
            case 'heavy':
                navigator.vibrate(50);
                break;
            case 'success':
                navigator.vibrate([50, 50, 50]);
                break;
            case 'error':
                navigator.vibrate([50, 100, 50, 100, 50]);
                break;
        }
    } catch (e) {
        console.warn('Haptic feedback failed:', e);
    }
}

let cachedLightContrastColor: string | null = null;

export function getContrastColor(hexColor: string): string {
    if (!cachedLightContrastColor) {
        try {
            cachedLightContrastColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#e5e5e5';
        } catch (e) {
            cachedLightContrastColor = '#e5e5e5';
        }
    }

    const lightColor = cachedLightContrastColor;
    const darkColor = '#000000';

    if (!hexColor || hexColor.length < 7) return lightColor;
    try {
        const r = parseInt(hexColor.slice(1, 3), 16);
        const g = parseInt(hexColor.slice(3, 5), 16);
        const b = parseInt(hexColor.slice(5, 7), 16);
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        return (yiq >= 128) ? darkColor : lightColor;
    } catch (e) {
        return lightColor;
    }
}
