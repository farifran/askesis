// ANÁLISE DO ARQUIVO: 100% concluído. As funções utilitárias são eficientes. A função 'getContrastColor' foi refatorada para ler dinamicamente a partir das variáveis CSS, melhorando a manutenibilidade. A análise está finalizada.
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { Habit, TimeOfDay, getEffectiveScheduleForHabitOnDate, shouldHabitAppearOnDate, state } from './state';
import { getSyncKeyHash } from './sync';

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
    // CORREÇÃO DE FUSO HORÁRIO [2024-11-26]: A determinação de "hoje" foi corrigida para usar os componentes da data local do usuário (`getFullYear`, `getMonth`, `getDate`) em vez dos componentes UTC.
    // Isso garante que o dia da aplicação corresponda ao dia local do usuário (de meia-noite a meia-noite), corrigindo o bug onde o dia avançava prematuramente em fusos horários a oeste de UTC.
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

/**
 * REATORAÇÃO DE ROBUSTEZ [2024-09-20]: A lógica de parsing de listas foi refatorada para maior clareza.
 * O helper monolítico `closeLists` foi substituído por duas funções específicas (`closeUnorderedList` e `closeOrderedList`).
 * Isso torna a intenção do código explícita ao transicionar entre tipos de lista e elementos de bloco,
 * melhorando a manutenibilidade sem alterar o resultado final.
 * MANUTENIBILIDADE [2024-10-18]: Adicionado comentário de escopo. Este parser é projetado para o output confiável da IA,
 * não para entradas de usuário arbitrárias que poderiam conter vetores de XSS se o parser fosse mais complexo.
 */
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

    // MELHORIA DE ROBUSTEZ NO PARSER [2024-09-24]: A formatação inline foi corrigida para lidar
    // com aninhamento de negrito/itálico e para adicionar suporte a texto tachado. A ordem das
    // substituições agora prioriza os marcadores mais específicos, resolvendo bugs de renderização.
    const formatInline = (line: string): string => {
        return escapeHTML(line)
            .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/~~(.*?)~~/g, '<del>$1</del>');
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
            closeOrderedList(); // Fecha a lista oposta se estiver aberta
            if (!inUnorderedList) {
                html += '<ul>';
                inUnorderedList = true;
            }
            html += `<li>${formatInline(line.trim().substring(2))}</li>`;
            continue;
        }

        if (trimmedLine.match(/^\d+\.\s/)) {
            closeUnorderedList(); // Fecha a lista oposta se estiver aberta
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

    // FIX: Close any open lists at the end of the document.
    closeUnorderedList();
    closeOrderedList();
    return html;
}

// FIX: Add missing debounce function to resolve import error in listeners.ts.
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

// FIX: Add missing pushToOneSignal function to resolve import errors.
/**
 * Adiciona um callback a uma fila para ser executado quando o SDK do OneSignal estiver pronto.
 * @param callback A função a ser executada.
 */
export function pushToOneSignal(callback: (oneSignal: any) => void) {
    // A API OneSignal pode não estar imediatamente disponível.
    // Usamos uma fila (array) para armazenar chamadas até que ela esteja pronta.
    if (typeof window.OneSignal === 'undefined') {
        window.OneSignalDeferred = window.OneSignalDeferred || [];
        window.OneSignalDeferred.push(callback);
    } else {
        callback(window.OneSignal);
    }
}

// FIX: Add missing apiFetch function to resolve import errors.
/**
 * Wrapper para a API fetch, que inclui o hash da chave de sincronização e lida com erros de rede.
 * @param endpoint O endpoint da API a ser chamado.
 * @param options As opções para a requisição fetch.
 * @param includeSyncKey Se deve incluir o cabeçalho X-Sync-Key-Hash.
 * @returns A resposta da requisição.
 */
export async function apiFetch(endpoint: string, options: RequestInit = {}, includeSyncKey = false): Promise<Response> {
    // FIX: The spread operator `...options.headers` is not type-safe for all
    // possible `HeadersInit` types (e.g., string[][]), causing a TypeScript error.
    // This logic is refactored to use the standard `Headers` object, which correctly
    // handles all `HeadersInit` types while preserving the intended override behavior.
    const headers = new Headers({
        'Content-Type': 'application/json',
    });
    if (options.headers) {
        new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    }

    if (includeSyncKey) {
        const keyHash = await getSyncKeyHash();
        if (keyHash) {
            headers.set('X-Sync-Key-Hash', keyHash);
        }
    }

    const response = await fetch(endpoint, {
        ...options,
        headers,
    });

    if (!response.ok && response.status !== 409) { // 409 (Conflict) é tratado pelo chamador
        const errorBody = await response.text();
        console.error(`API request failed to ${endpoint}:`, errorBody);
        throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
    }

    return response;
}

// FIX: Add missing getActiveHabitsForDate function to resolve multiple import errors.
/**
 * PERFORMANCE [2024-08-12]: Nova função com cache para obter hábitos ativos e seus horários para uma data.
 * @param date A data para a qual obter os hábitos.
 * @returns Um array de objetos, cada um contendo o hábito e seu agendamento para o dia.
 */
export function getActiveHabitsForDate(date: Date): Array<{ habit: Habit; schedule: TimeOfDay[] }> {
    const dateStr = toUTCIsoDateString(date);
    const cacheKey = dateStr;
    if (state.activeHabitsCache[cacheKey]) {
        return state.activeHabitsCache[cacheKey];
    }
    
    const activeHabits = state.habits
        .filter(habit => shouldHabitAppearOnDate(habit, date))
        .map(habit => ({
            habit,
            schedule: getEffectiveScheduleForHabitOnDate(habit, dateStr),
        }));

    state.activeHabitsCache[cacheKey] = activeHabits;
    return activeHabits;
}

// OTIMIZAÇÃO DE MANUTENIBILIDADE [2024-12-07]: O valor da cor de texto clara para contraste é lido e
// armazenado em cache dinamicamente a partir das variáveis CSS, evitando a duplicação de valores e
// garantindo que a lógica de contraste de cor se adapte automaticamente a mudanças no tema.
let cachedLightContrastColor: string | null = null;

/**
 * Calculates a contrasting text color (black or light gray) for a given hex background color.
 * @param hexColor The background color in hex format (e.g., "#RRGGBB").
 * @returns The contrasting color ('#000000' for light backgrounds, or the theme's primary text color for dark).
 */
export function getContrastColor(hexColor: string): string {
    if (!cachedLightContrastColor) {
        try {
            // Lê a cor clara diretamente das variáveis CSS para garantir a consistência do tema.
            cachedLightContrastColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#e5e5e5';
        } catch (e) {
            // Fallback para o caso de a função ser chamada em um ambiente sem DOM (improvável para este app).
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
        // Formula to determine brightness (YIQ)
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        return (yiq >= 128) ? darkColor : lightColor;
    } catch (e) {
        return lightColor; // Fallback for invalid hex
    }
}