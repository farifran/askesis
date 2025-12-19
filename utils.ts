
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [NOTA COMPARATIVA]: Nível de Engenharia: Infraestrutura/Utilitário. Código puro e de alta performance.
// Substitui bibliotecas pesadas (Moment.js, Marked) por implementações nativas leves e cacheadas.
// PERFORMANCE [2025-02-23]: Regex e funções auxiliares movidas para escopo de módulo para evitar recriação em loops.

declare global {
    interface Window {
        OneSignal?: any[];
        OneSignalDeferred?: any[];
    }
}

// --- UUID ---

// PERFORMANCE [2025-02-23]: Hoisted helper to avoid allocation on every generateUUID call.
const getRandomByte = () => {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        try {
            return crypto.getRandomValues(new Uint8Array(1))[0];
        } catch (e) {
            // Fallback se getRandomValues falhar (ex: contexto inseguro em alguns browsers antigos)
        }
    }
    // Último recurso: Math.random (menos seguro, mas funcional para IDs de UI não-críticos)
    return Math.floor(Math.random() * 256);
};

export function generateUUID(): string {
    // ROBUSTEZ [2025-01-18]: Fallback para ambientes não seguros ou navegadores antigos
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        try {
            return crypto.randomUUID();
        } catch (e) {
            console.warn('crypto.randomUUID failed, using fallback', e);
        }
    }

    // Fallback compatível com RFC4122 v4
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
        (parseInt(c, 10) ^ (getRandomByte() & 15) >> (parseInt(c, 10) / 4)).toString(16)
    );
}

// --- Date Helpers ---

/**
 * PERFORMANCE UPDATE [2025-01-20]: Optimized Date-to-String conversion.
 * Avoiding `toISOString().slice(0, 10)` reduces garbage collection pressure
 * and execution time in hot-paths (like calendar loops and streak calculations).
 */
export function toUTCIsoDateString(date: Date): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();

    // Manual string concatenation is significantly faster than template literals
    // or padStart in tight loops for this specific format.
    return year + 
           (month < 10 ? '-0' : '-') + month + 
           (day < 10 ? '-0' : '-') + day;
}

export function getTodayUTC(): Date {
    const today = new Date();
    // CORREÇÃO DE FUSO HORÁRIO [2024-11-26]: Usa componentes locais para determinar o "hoje" do usuário.
    return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

// OTIMIZAÇÃO [2025-03-09]: Memoização de "Hoje".
// A data atual muda raramente (1x por dia). Evitamos alocar 'new Date()' a cada renderização.
// Usamos um TTL de 60 segundos para garantir atualização se o app ficar aberto na virada do dia.
let _cachedTodayISO: string | null = null;
let _lastTodayCheckTime = 0;

export function getTodayUTCIso(): string {
    const now = Date.now();
    // Revalida a cada 60 segundos (60000 ms)
    if (!_cachedTodayISO || (now - _lastTodayCheckTime > 60000)) {
        _cachedTodayISO = toUTCIsoDateString(getTodayUTC());
        _lastTodayCheckTime = now;
    }
    return _cachedTodayISO;
}

export function parseUTCIsoDate(isoString: string): Date {
    return new Date(`${isoString}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

/**
 * HELPER: Safely retrieves a valid date string.
 * If the provided date is corrupted (e.g., empty or invalid format), it defaults to Today.
 * This prevents actions from failing silently.
 */
export function getSafeDate(date: string | undefined | null): string {
    if (!date || date.length < 10 || isNaN(parseUTCIsoDate(date).getTime())) {
        console.warn("Detected invalid date in action, defaulting to Today");
        return getTodayUTCIso();
    }
    return date;
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
    // MICRO-OTIMIZAÇÃO: Geração manual da chave de cache para evitar sobrecarga de JSON.stringify.
    const keys = Object.keys(options).sort();
    let optionsKey = '';
    for (const key of keys) {
        optionsKey += `${key}:${options[key as keyof Intl.DateTimeFormatOptions]};`;
    }
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
// PERFORMANCE [2025-02-23]: Regex de lista ordenada movida para escopo global.
const MD_ORDERED_LIST_REGEX = /^\d+\.\s/;

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

        if (trimmedLine.match(MD_ORDERED_LIST_REGEX)) {
            closeUnorderedList();
            if (!inOrderedList) {
                html += '<ol>';
                inOrderedList = true;
            }
            html += `<li>${formatInline(line.replace(MD_ORDERED_LIST_REGEX, ''))}</li>`;
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

    // UX REFINEMENT [2025-01-17]: Micro-haptics mais nítidos e curtos.
    // Em vez de vibrações longas (25-50ms), usamos pulsos ultracurtos (8-15ms) para interações de UI
    // como seleção e toggle. Isso dá uma sensação mais "premium" e física, menos "zumbido".
    try {
        switch (type) {
            case 'selection':
                navigator.vibrate(8); // Extremamente sutil para cliques em calendário/listas
                break;
            case 'light':
                navigator.vibrate(12); // Toggle de checkbox, botões menores
                break;
            case 'medium':
                navigator.vibrate(20); // Ações de swipe, botões principais
                break;
            case 'heavy':
                navigator.vibrate(40); // Ações destrutivas ou significativas
                break;
            case 'success':
                // Padrão: Curto-pausa-Curto (Tick-Tick)
                navigator.vibrate([15, 50, 15]);
                break;
            case 'error':
                // Padrão: Longo-pausa-Curto (Buzz-Tick)
                navigator.vibrate([40, 60, 15]);
                break;
        }
    } catch (e) {
        console.warn('Haptic feedback failed:', e);
    }
}

let cachedLightContrastColor: string | null = null;
let cachedDarkContrastColor: string | null = null;

export function getContrastColor(hexColor: string): string {
    // Otimização: Cacheia as cores de contraste lidas do CSS para evitar leituras repetidas do DOM.
    if (!cachedLightContrastColor || !cachedDarkContrastColor) {
        try {
            const rootStyles = getComputedStyle(document.documentElement);
            cachedLightContrastColor = rootStyles.getPropertyValue('--text-primary').trim() || '#e5e5e5';
            cachedDarkContrastColor = rootStyles.getPropertyValue('--bg-color').trim() || '#000000';
        } catch (e) {
            // Fallback em caso de erro (ex: ambiente de teste sem DOM)
            cachedLightContrastColor = '#e5e5e5';
            cachedDarkContrastColor = '#000000';
        }
    }

    if (!hexColor || hexColor.length < 7) return cachedLightContrastColor;
    
    try {
        const r = parseInt(hexColor.slice(1, 3), 16);
        const g = parseInt(hexColor.slice(3, 5), 16);
        const b = parseInt(hexColor.slice(5, 7), 16);
        // Fórmula de luminância YIQ
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        return (yiq >= 128) ? cachedDarkContrastColor : cachedLightContrastColor;
    } catch (e) {
        // Retorna a cor clara como um fallback seguro em caso de erro de parsing.
        return cachedLightContrastColor;
    }
}
