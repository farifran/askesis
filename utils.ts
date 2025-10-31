/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// --- UUID ---
export function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- Date Helpers ---
export function toUTCIsoDateString(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function getTodayUTC(): Date {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
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

// --- Formatting ---
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

export function simpleMarkdownToHTML(text: string): string {
    const lines = text.split('\n');
    let html = '';
    let inUnorderedList = false;
    let inOrderedList = false;

    const closeLists = () => {
        if (inUnorderedList) {
            html += '</ul>';
            inUnorderedList = false;
        }
        if (inOrderedList) {
            html += '</ol>';
            inOrderedList = false;
        }
    };

    const formatInline = (line: string): string => {
        return line
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');
    };

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith('### ')) {
            closeLists();
            html += `<h3>${formatInline(line.substring(4))}</h3>`;
            continue;
        }
        if (trimmedLine.startsWith('## ')) {
            closeLists();
            html += `<h2>${formatInline(line.substring(3))}</h2>`;
            continue;
        }
        if (trimmedLine.startsWith('# ')) {
            closeLists();
            html += `<h1>${formatInline(line.substring(2))}</h1>`;
            continue;
        }

        if (trimmedLine.startsWith('* ') || trimmedLine.startsWith('- ')) {
            if (inOrderedList) closeLists();
            if (!inUnorderedList) {
                html += '<ul>';
                inUnorderedList = true;
            }
            html += `<li>${formatInline(line.trim().substring(2))}</li>`;
            continue;
        }

        if (trimmedLine.match(/^\d+\.\s/)) {
            if (inUnorderedList) closeLists();
            if (!inOrderedList) {
                html += '<ol>';
                inOrderedList = true;
            }
            html += `<li>${formatInline(line.replace(/^\d+\.\s/, ''))}</li>`;
            continue;
        }
        
        closeLists();
        if (trimmedLine.length > 0) {
            html += `<p>${formatInline(line)}</p>`;
        }
    }

    closeLists();
    return html;
}

/**
 * Encapsula a lógica para interagir com a API assíncrona do OneSignal.
 * @param callback A função a ser executada assim que o SDK do OneSignal estiver pronto.
 */
export function pushToOneSignal(callback: (oneSignal: any) => void) {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(callback);
}

/**
 * Cria uma função "debounced" que atrasa a invocação de `func` até que `wait`
 * milissegundos tenham se passado desde a última vez que a função debounced foi invocada.
 */
export function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: number | null = null;
    return function(this: ThisParameterType<T>, ...args: Parameters<T>): void {
        const context = this;
        if (timeout !== null) clearTimeout(timeout);
        timeout = window.setTimeout(() => {
            timeout = null;
            func.apply(context, args);
        }, wait);
    };
}