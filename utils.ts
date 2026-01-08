
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
        // @fix: Added scheduler to global Window interface
        scheduler?: {
            postTask<T>(callback: () => T | Promise<T>, options?: { priority?: 'user-blocking' | 'user-visible' | 'background'; signal?: AbortSignal; delay?: number }): Promise<T>;
        };
        // @fix: Added bootWatchdog to global Window interface
        bootWatchdog?: any;
        // @fix: Added showFatalError to global Window interface
        showFatalError?: (message: string) => void;
    }
}

// --- CONSTANTS ---
// PERF: Centralized constant to avoid magic numbers and redundancy.
export const MS_PER_DAY = 86400000;

// --- STATIC LOOKUP TABLES (HOT MEMORY) ---

// PERF: LUT para conversão Byte -> Hex (00-FF). Evita .toString(16) e padding em loops.
// Exportado para uso em services/api.ts (Hashing) e services/crypto.ts.
export const HEX_LUT: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

// PERF: LUT para padding de datas (00-99). Remove branches ternários em loops de calendário.
const PAD_LUT: string[] = Array.from({ length: 100 }, (_, i) => i < 10 ? '0' + i : String(i));

// --- BASE64 HELPERS (High Performance) ---

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    // MEMORY FIX [2025-05-18]: Use Array join instead of string concatenation.
    const chunks: string[] = [];
    const CHUNK_SIZE = 8192;
    
    // PERF: Bound Check Elimination via while loop explícito.
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        const end = (i + CHUNK_SIZE) > len ? len : i + CHUNK_SIZE;
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, end) as unknown as number[]));
    }
    return btoa(chunks.join(''));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i = (i + 1) | 0) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// --- GZIP COMPRESSION (Stream API) ---

export async function compressString(data: string): Promise<string> {
    // COMPATIBILITY GUARD: Prevent crash on older iOS/Android WebViews
    if (typeof CompressionStream === 'undefined') {
        throw new Error("CompressionStream not supported on this device.");
    }
    const stream = new Blob([data]).stream();
    const compressedReadableStream = stream.pipeThrough(new CompressionStream('gzip'));
    const compressedResponse = new Response(compressedReadableStream);
    const blob = await compressedResponse.blob();
    const buffer = await blob.arrayBuffer();
    return arrayBufferToBase64(buffer);
}

export async function decompressString(base64Data: string): Promise<string> {
    // COMPATIBILITY GUARD
    if (typeof DecompressionStream === 'undefined') {
        throw new Error("DecompressionStream not supported on this device.");
    }
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
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
    } catch (e) { /* Fallback */ }

    // Fallback SOTA: Buffer-based generation
    const rnds = new Uint8Array(16);
    let usedCrypto = false;

    try {
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(rnds);
            usedCrypto = true;
        }
    } catch (e) { /* Fallback */ }

    if (!usedCrypto) {
        // SECURITY UPDATE [2025-05-20]: Enhanced Entropy.
        const timestamp = Date.now();
        const perf = (typeof performance !== 'undefined' && performance.now) ? performance.now() * 1000 : 0;
        
        for (let i = 0; i < 16; i++) {
            const r = Math.random() * 256;
            const t = (timestamp >> (i * 2)) & 0xFF;
            const p = (perf >> (i * 2)) & 0xFF;
            rnds[i] = (r ^ t ^ p) & 0xFF;
        }
    }

    // Version 4, Variant RFC4122
    rnds[6] = (rnds[6] & 0x0f) | 0x40;
    rnds[8] = (rnds[8] & 0x3f) | 0x80;

    return HEX_LUT[rnds[0]] + HEX_LUT[rnds[1]] + HEX_LUT[rnds[2]] + HEX_LUT[rnds[3]] + '-' +
           HEX_LUT[rnds[4]] + HEX_LUT[rnds[5]] + '-' +
           HEX_LUT[rnds[6]] + HEX_LUT[rnds[7]] + '-' +
           HEX_LUT[rnds[8]] + HEX_LUT[rnds[9]] + '-' +
           HEX_LUT[rnds[10]] + HEX_LUT[rnds[11]] + HEX_LUT[rnds[12]] + 
           HEX_LUT[rnds[13]] + HEX_LUT[rnds[14]] + HEX_LUT[rnds[15]];
}

// --- Date Helpers ---

export function toUTCIsoDateString(date: Date): string {
    // DATA CORRUPTION GUARD [2025-05-18]: FAIL-FAST.
    if (isNaN(date.getTime())) {
        const errorMsg = "CRITICAL: toUTCIsoDateString received Invalid Date.";
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    const year = date.getUTCFullYear(); 
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();

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

let _midnightTimer: number | undefined;

export function setupMidnightLoop() {
    if (_midnightTimer) {
        clearTimeout(_midnightTimer);
        _midnightTimer = undefined;
    }

    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const msToMidnight = Math.max(1000, tomorrow.getTime() - now.getTime());

    _midnightTimer = window.setTimeout(() => {
        console.log("Midnight detected. Refreshing day context.");
        resetTodayCache();
        document.dispatchEvent(new CustomEvent('dayChanged'));
        setupMidnightLoop();
    }, msToMidnight + 1000);
}

export function parseUTCIsoDate(isoString: string): Date {
    if (!isoString || typeof isoString !== 'string') return new Date(NaN);
    
    // DATA INTEGRITY GUARD [2025-05-20]: Date Rolling Prevention.
    const date = new Date(`${isoString}T00:00:00.000Z`);
    
    if (isNaN(date.getTime())) return date;

    if (isoString.length === 10) {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        
        // Fast numeric check
        const yStr = parseInt(isoString.substring(0, 4));
        const mStr = parseInt(isoString.substring(5, 7));
        const dStr = parseInt(isoString.substring(8, 10));

        if (year !== yStr || month !== mStr || day !== dStr) {
            console.warn(`Date Rolling detected: ${isoString}. Returning Invalid Date.`);
            return new Date(NaN);
        }
    }

    return date;
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
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
};

const _escapeReplacer = (match: string) => ESCAPE_REPLACEMENTS[match];

export function escapeHTML(str: string): string {
    if (!str) return '';
    return str.replace(ESCAPE_HTML_REGEX, _escapeReplacer);
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
    if (!text) return '';

    const html: string[] = [];
    let inUnorderedList = false;
    let inOrderedList = false;

    // DRY Helper: Closes any open lists
    const closeLists = () => {
        if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; }
        if (inOrderedList) { html.push('</ol>'); inOrderedList = false; }
    };

    let startIndex = 0;
    let endIndex = 0;
    const len = text.length;

    while (startIndex < len) {
        endIndex = text.indexOf('\n', startIndex);
        if (endIndex === -1) endIndex = len;

        const line = text.substring(startIndex, endIndex);
        const trimmedLine = line.trim();

        if (MD_H3_REGEX.test(trimmedLine)) {
            closeLists();
            html.push(`<h3>${formatInline(line.substring(4))}</h3>`);
        } else if (MD_H2_REGEX.test(trimmedLine)) {
            closeLists();
            html.push(`<h2>${formatInline(line.substring(3))}</h2>`);
        } else if (MD_H1_REGEX.test(trimmedLine)) {
            closeLists();
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
            closeLists();
            if (trimmedLine.length > 0) {
                html.push(`<p>${formatInline(line)}</p>`);
            }
        }

        startIndex = endIndex + 1;
    }

    closeLists(); // Cleanup at end of text
    
    return html.join('');
}

export function pushToOneSignal(callback: (oneSignal: any) => void) {
    if (typeof window === 'undefined') return;

    if (typeof window.OneSignal === 'undefined') {
        window.OneSignalDeferred = window.OneSignalDeferred || [];
        window.OneSignalDeferred.push(callback);
    } else {
        callback(window.OneSignal);
    }
}

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
    } catch (e) { /* Silently fail */ }
}

let cachedLightContrastColor: string | null = null;
let cachedDarkContrastColor: string | null = null;

function _cacheContrastColors() {
    if (cachedLightContrastColor && cachedDarkContrastColor) return;
    try {
        if (typeof document === 'undefined' || !document.documentElement) throw new Error("Root missing");
        
        const rootStyles = getComputedStyle(document.documentElement);
        cachedLightContrastColor = rootStyles.getPropertyValue('--text-primary').trim() || '#e5e5e5';
        cachedDarkContrastColor = rootStyles.getPropertyValue('--bg-color').trim() || '#000000';
    } catch (e) {
        cachedLightContrastColor = '#e5e5e5';
        cachedDarkContrastColor = '#000000';
    }
}

function _readHex2(hex: string, offset: number): number {
    let val = 0;
    for (let j = 0; j < 2; j++) {
        const c = hex.charCodeAt(offset + j);
        val <<= 4;
        if (c >= 48 && c <= 57) val |= (c - 48);      // 0-9
        else if (c >= 65 && c <= 70) val |= (c - 55); // A-F
        else if (c >= 97 && c <= 102) val |= (c - 87);// a-f
    }
    return val;
}

const _contrastCache = new Map<string, string>();

/**
 * Calculates contrast color using direct bitwise parsing.
 */
export function getContrastColor(hexColor: string): string {
    const cached = _contrastCache.get(hexColor);
    if (cached) return cached;

    _cacheContrastColors();

    if (!hexColor || hexColor.length < 4) return cachedLightContrastColor!;
    
    try {
        // ROBUSTNESS [2025-05-20]: Normalize Shorthand Hex (#FFF -> #FFFFFF)
        let fullHex = hexColor;
        const isShorthand = hexColor.length === 4 && hexColor.charCodeAt(0) === 35; // '#abc'
        
        if (isShorthand) {
            const r = hexColor[1];
            const g = hexColor[2];
            const b = hexColor[3];
            fullHex = `#${r}${r}${g}${g}${b}${b}`;
        }

        const offset = fullHex.charCodeAt(0) === 35 ? 1 : 0; // 35 is '#'

        const r = _readHex2(fullHex, offset);
        const g = _readHex2(fullHex, offset + 2);
        const b = _readHex2(fullHex, offset + 4);

        // Formula: ((r * 299) + (g * 587) + (b * 114)) / 1000 >= 128
        const yiq = (r * 299) + (g * 587) + (b * 114);
        
        const result = (yiq >= 128000) ? cachedDarkContrastColor! : cachedLightContrastColor!;
        
        if (_contrastCache.size < 100) {
            _contrastCache.set(hexColor, result);
        }
        
        return result;
    } catch (e) {
        return cachedLightContrastColor!;
    }
}
