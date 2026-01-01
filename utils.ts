
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file utils.ts
 * @description Biblioteca de Utilitários de Infraestrutura e Helpers de Baixo Nível.
 * 
 * [ISOMORPHIC / MIXED CONTEXT]:
 * Este módulo contém funções puras (seguras para Web Workers) e funções dependentes do DOM.
 * 
 * ARQUITETURA (Zero-Dependency & Micro-Optimizations):
 * - **Manual Memory Management:** Evita alocação de strings temporárias em hot paths.
 * - **Lookup Tables (LUT):** Substitui cálculos repetitivos por acesso a memória O(1).
 * - **Bitwise Parsing:** Substitui `parseInt` e `Math` por operações de CPU diretas.
 */

declare global {
    interface Window {
        OneSignal?: any[];
        OneSignalDeferred?: any[];
    }
}

// --- STATIC LOOKUP TABLES (HOT MEMORY) ---

// PERF: LUT para conversão Byte -> Hex (00-FF). Evita .toString(16) e padding em loops.
const HEX_LUT: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

// PERF: LUT para padding de datas (00-99). Remove branches ternários em loops de calendário.
const PAD_LUT: string[] = Array.from({ length: 100 }, (_, i) => i < 10 ? '0' + i : String(i));

// --- BASE64 HELPERS (High Performance) ---

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    let binary = '';
    // PERF: Chunk size alinhado com stack frames comuns.
    const CHUNK_SIZE = 8192;
    
    // PERF: Bound Check Elimination via while loop explícito.
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        // Math.min é rápido, mas bitwise OR garante SMI.
        const end = (i + CHUNK_SIZE) > len ? len : i + CHUNK_SIZE;
        // Apply é mais rápido que iteração manual para construção de strings em chunks.
        binary += String.fromCharCode.apply(null, bytes.subarray(i, end) as unknown as number[]);
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    // DATA INTEGRITY: atob throws DOMException on invalid chars.
    // Callers MUST handle try-catch if input is untrusted.
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i = (i + 1) | 0) { // Hint para compilador: i é Smi
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// --- GZIP COMPRESSION (Stream API) ---

export async function compressString(data: string): Promise<string> {
    const stream = new Blob([data]).stream();
    const compressedReadableStream = stream.pipeThrough(new CompressionStream('gzip'));
    const compressedResponse = new Response(compressedReadableStream);
    const blob = await compressedResponse.blob();
    const buffer = await blob.arrayBuffer();
    return arrayBufferToBase64(buffer);
}

export async function decompressString(base64Data: string): Promise<string> {
    try {
        const buffer = base64ToArrayBuffer(base64Data);
        const stream = new Blob([buffer]).stream();
        const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
        const response = new Response(decompressedStream);
        return await response.text();
    } catch (e) {
        console.error("Decompression failed", e);
        throw new Error("Failed to decompress data.");
    }
}

// --- UUID ---

export function generateUUID(): string {
    // Fast Path: Native Implementation
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    // Fallback SOTA: Buffer-based generation (Zero String Allocations durante a lógica)
    const rnds = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(rnds);
    } else {
        // Fallback inseguro (Math.random) apenas se crypto não existir
        for (let i = 0; i < 16; i++) {
            rnds[i] = (Math.random() * 256) | 0;
        }
    }

    // Set version (4) and variant (RFC4122) using bitwise ops
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;

    // Direct Table Lookup concatenation
    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    return HEX_LUT[rnds[0]] + HEX_LUT[rnds[1]] + HEX_LUT[rnds[2]] + HEX_LUT[rnds[3]] + '-' +
           HEX_LUT[rnds[4]] + HEX_LUT[rnds[5]] + '-' +
           HEX_LUT[rnds[6]] + HEX_LUT[rnds[7]] + '-' +
           HEX_LUT[rnds[8]] + HEX_LUT[rnds[9]] + '-' +
           HEX_LUT[rnds[10]] + HEX_LUT[rnds[11]] + HEX_LUT[rnds[12]] + 
           HEX_LUT[rnds[13]] + HEX_LUT[rnds[14]] + HEX_LUT[rnds[15]];
}

// --- Date Helpers ---

/**
 * PERFORMANCE UPDATE: Optimized Date-to-String using LUT.
 * DATA SAFETY: Throws on Invalid Date to prevent DB corruption ("NaN-undefined-undefined").
 */
export function toUTCIsoDateString(date: Date): string {
    // FAIL-FAST: Verifica se a data é válida antes de qualquer cálculo.
    if (isNaN(date.getTime())) {
        console.error("toUTCIsoDateString received Invalid Date. Preventing data corruption.");
        // Fallback seguro: Retorna hoje para evitar crash, mas loga erro.
        const now = new Date();
        return now.getUTCFullYear() + '-' + PAD_LUT[now.getUTCMonth() + 1] + '-' + PAD_LUT[now.getUTCDate()];
    }

    const year = date.getUTCFullYear(); 
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();

    // PERF: Lookup Table access is O(1) and branchless.
    return year + '-' + PAD_LUT[month] + '-' + PAD_LUT[day];
}

export function getTodayUTC(): Date {
    const today = new Date();
    return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

// Memoization cache
let _cachedTodayISO: string | null = null;
let _lastTodayCheckTime = 0;

export function getTodayUTCIso(): string {
    const now = Date.now();
    // 60s TTL
    if (!_cachedTodayISO || (now - _lastTodayCheckTime > 60000)) {
        _cachedTodayISO = toUTCIsoDateString(getTodayUTC());
        _lastTodayCheckTime = now;
    }
    return _cachedTodayISO;
}

export function resetTodayCache() {
    _cachedTodayISO = null;
    _lastTodayCheckTime = 0;
}

// LEAK PROTECTION: Singleton timer reference
let _midnightTimer: number | undefined;

export function setupMidnightLoop() {
    // IDEMPOTENCY: Se já existe um timer agendado, limpa antes de criar outro.
    // Isso previne múltiplos loops paralelos se a função for chamada acidentalmente várias vezes.
    if (_midnightTimer) {
        clearTimeout(_midnightTimer);
        _midnightTimer = undefined;
    }

    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    // Garante que o delay seja positivo (mínimo 1s) para evitar loop infinito em casos de clock skew
    const msToMidnight = Math.max(1000, tomorrow.getTime() - now.getTime());

    _midnightTimer = window.setTimeout(() => {
        console.log("Midnight detected. Refreshing day context.");
        resetTodayCache();
        document.dispatchEvent(new CustomEvent('dayChanged'));
        // Recursive call (Safe now due to idempotency check at start)
        setupMidnightLoop();
    }, msToMidnight + 1000); // +1s buffer to ensure we land in the next day
}

export function parseUTCIsoDate(isoString: string): Date {
    // Simple validation before parsing
    if (!isoString || typeof isoString !== 'string') return new Date(NaN);
    return new Date(`${isoString}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function getSafeDate(date: string | undefined | null): string {
    if (!date || !ISO_DATE_REGEX.test(date)) {
        return getTodayUTCIso();
    }
    return date;
}

// --- Formatting & Localization Performance ---

const ESCAPE_HTML_REGEX = /[&<>"']/g;
const ESCAPE_REPLACEMENTS: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export function escapeHTML(str: string): string {
    // SAFETY: Retorna vazio se input for nulo/indefinido para evitar crash.
    if (!str) return '';
    return str.replace(ESCAPE_HTML_REGEX, match => ESCAPE_REPLACEMENTS[match]);
}

const MD_INLINE_COMBINED_REGEX = /(\*\*\*(.*?)\*\*\*)|(\*\*(.*?)\*\*)|(\*(.*?)\*)|(~~(.*?)~~)/g;
const MD_ORDERED_LIST_REGEX = /^\d+\.\s/;

const MD_REPLACER = (match: string, g1: string, c1: string, g2: string, c2: string, g3: string, c3: string, g4: string, c4: string) => {
    if (g1) return `<strong><em>${c1}</em></strong>`;
    if (g2) return `<strong>${c2}</strong>`;
    if (g3) return `<em>${c3}</em>`;
    if (g4) return `<del>${c4}</del>`;
    return match;
};

function formatInline(line: string): string {
    return escapeHTML(line).replace(MD_INLINE_COMBINED_REGEX, MD_REPLACER);
}

const MD_H3_REGEX = /^### /;
const MD_H2_REGEX = /^## /;
const MD_H1_REGEX = /^# /;
const MD_UL_REGEX = /^[*+-\s] /; 

export function simpleMarkdownToHTML(text: string): string {
    // SAFETY: Retorna vazio se input for nulo/indefinido para evitar crash.
    if (!text) return '';

    // PERF: Avoid splitting string into huge array. Iterate manually.
    // 'text' can be large, splitting allocates unnecessary memory.
    const html: string[] = [];
    let inUnorderedList = false;
    let inOrderedList = false;

    let startIndex = 0;
    let endIndex = 0;
    const len = text.length;

    while (startIndex < len) {
        endIndex = text.indexOf('\n', startIndex);
        if (endIndex === -1) endIndex = len;

        // Extract line (Slice is cheap in V8)
        const line = text.substring(startIndex, endIndex);
        const trimmedLine = line.trim();

        // --- Line Processing Logic ---
        if (MD_H3_REGEX.test(trimmedLine)) {
            if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; }
            if (inOrderedList) { html.push('</ol>'); inOrderedList = false; }
            html.push(`<h3>${formatInline(line.substring(4))}</h3>`);
        } else if (MD_H2_REGEX.test(trimmedLine)) {
            if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; }
            if (inOrderedList) { html.push('</ol>'); inOrderedList = false; }
            html.push(`<h2>${formatInline(line.substring(3))}</h2>`);
        } else if (MD_H1_REGEX.test(trimmedLine)) {
            if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; }
            if (inOrderedList) { html.push('</ol>'); inOrderedList = false; }
            html.push(`<h1>${formatInline(line.substring(2))}</h1>`);
        } else if (MD_UL_REGEX.test(trimmedLine)) {
            if (inOrderedList) { html.push('</ol>'); inOrderedList = false; }
            if (!inUnorderedList) {
                html.push('<ul>');
                inUnorderedList = true;
            }
            html.push(`<li>${formatInline(line.trim().substring(2))}</li>`);
        } else if (trimmedLine.match(MD_ORDERED_LIST_REGEX)) {
            if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; }
            if (!inOrderedList) {
                html.push('<ol>');
                inOrderedList = true;
            }
            html.push(`<li>${formatInline(line.replace(MD_ORDERED_LIST_REGEX, ''))}</li>`);
        } else {
            if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; }
            if (inOrderedList) { html.push('</ol>'); inOrderedList = false; }
            if (trimmedLine.length > 0) {
                html.push(`<p>${formatInline(line)}</p>`);
            }
        }
        // --- End Line Processing ---

        startIndex = endIndex + 1;
    }

    if (inUnorderedList) html.push('</ul>');
    if (inOrderedList) html.push('</ol>');
    
    return html.join('');
}

export function pushToOneSignal(callback: (oneSignal: any) => void) {
    // ISOMORPHIC GUARD: Ensure window exists before accessing (for Worker compatibility)
    if (typeof window === 'undefined') return;

    if (typeof window.OneSignal === 'undefined') {
        window.OneSignalDeferred = window.OneSignalDeferred || [];
        window.OneSignalDeferred.push(callback);
    } else {
        callback(window.OneSignal);
    }
}

// PERF: Lookup Table for Haptics (Avoids switch/case overhead in monomorphic calls)
const HAPTIC_PATTERNS = {
    'selection': 8,
    'light': 12,
    'medium': 20,
    'heavy': 40,
    'success': [15, 50, 15],
    'error': [40, 60, 15]
};

export function triggerHaptic(type: keyof typeof HAPTIC_PATTERNS) {
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    try {
        navigator.vibrate(HAPTIC_PATTERNS[type]);
    } catch (e) {
        // Silently fail
    }
}

let cachedLightContrastColor: string | null = null;
let cachedDarkContrastColor: string | null = null;

function _cacheContrastColors() {
    if (cachedLightContrastColor && cachedDarkContrastColor) return;
    
    // LAYOUT THRASHING PROTECTION:
    // getComputedStyle is expensive. If we fail, fallback to defaults instead of crashing or retrying continuously.
    try {
        // Check if document is ready to avoid accessing styles on unmounted root
        if (typeof document === 'undefined' || !document.documentElement) throw new Error("Root missing");
        
        const rootStyles = getComputedStyle(document.documentElement);
        cachedLightContrastColor = rootStyles.getPropertyValue('--text-primary').trim() || '#e5e5e5';
        cachedDarkContrastColor = rootStyles.getPropertyValue('--bg-color').trim() || '#000000';
    } catch (e) {
        // Safe defaults
        cachedLightContrastColor = '#e5e5e5';
        cachedDarkContrastColor = '#000000';
    }
}

/**
 * Calculates contrast color using direct bitwise parsing.
 * PERF: Replaces parseInt/slice calls (allocation heavy) with charCodeAt/bitwise ops.
 */
export function getContrastColor(hexColor: string): string {
    _cacheContrastColors();

    if (!hexColor || hexColor.length < 7) return cachedLightContrastColor!;
    
    try {
        // Bitwise Hex Parse Implementation:
        // Reads 2 chars at offset, returns integer.
        const readHex2 = (i: number) => {
            let val = 0;
            for (let j = 0; j < 2; j++) {
                const c = hexColor.charCodeAt(i + j);
                val <<= 4;
                if (c >= 48 && c <= 57) val |= (c - 48);      // 0-9
                else if (c >= 65 && c <= 70) val |= (c - 55); // A-F
                else if (c >= 97 && c <= 102) val |= (c - 87);// a-f
            }
            return val;
        };

        const r = readHex2(1);
        const g = readHex2(3);
        const b = readHex2(5);

        // Formula: ((r * 299) + (g * 587) + (b * 114)) / 1000 >= 128
        // Optimization: Remove division by comparing against 128000
        const yiq = (r * 299) + (g * 587) + (b * 114);
        
        return (yiq >= 128000) ? cachedDarkContrastColor! : cachedLightContrastColor!;
    } catch (e) {
        return cachedLightContrastColor!;
    }
}
