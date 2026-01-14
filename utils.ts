
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file utils.ts
 * @description Biblioteca de Utilitários de Infraestrutura e Helpers de Baixo Nível.
 */

declare global {
    // CSS Typed OM Polyfill Types
    // Removed duplicate definitions of CSS and CSSTranslate to avoid conflicts with lib.dom.d.ts
    
    interface Element {
        attributeStyleMap?: {
            set(property: string, value: any): void;
            get(property: string): any;
            clear(): void;
        };
    }

    interface Window {
        OneSignal?: any[];
        OneSignalDeferred?: any[];
        scheduler?: {
            postTask<T>(callback: () => T | Promise<T>, options?: { priority?: 'user-blocking' | 'user-visible' | 'background'; signal?: AbortSignal; delay?: number }): Promise<T>;
        };
        bootWatchdog?: any;
        showFatalError?: (message: string) => void;
    }
}

export const MS_PER_DAY = 86400000;

// --- STATIC LOOKUP TABLES (HOT MEMORY) ---
export const HEX_LUT: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const PAD_LUT: string[] = Array.from({ length: 100 }, (_, i) => i < 10 ? '0' + i : String(i));

// --- CRYPTO FALLBACK (SHA-256 Pure JS) ---
// Permite sincronização em HTTP (IP local) onde crypto.subtle é bloqueado.
// Baseado em implementação minimalista de SHA-256.
export async function sha256Fallback(message: string): Promise<string> {
    const msgBuffer = new TextEncoder().encode(message);
    const msgLen = msgBuffer.length * 8;
    const len = msgBuffer.length;
    
    // Padding
    const k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd192e819, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    // Pre-processing
    const totalLen = ((len + 8) >>> 6) + 1; // 512-bit blocks
    const w = new Uint32Array(64);
    const m = new Uint8Array(totalLen * 64);
    m.set(msgBuffer);
    m[len] = 0x80;
    
    // Set length in bits at the end
    const view = new DataView(m.buffer);
    view.setUint32(m.length - 4, msgLen, false); // Big-endian

    for (let i = 0; i < totalLen; i++) {
        const offset = i * 64;
        for (let j = 0; j < 16; j++) w[j] = view.getUint32(offset + j * 4, false);
        for (let j = 16; j < 64; j++) {
            const s0 = (w[j-15]>>>7|w[j-15]<<25) ^ (w[j-15]>>>18|w[j-15]<<14) ^ (w[j-15]>>>3);
            const s1 = (w[j-2]>>>17|w[j-2]<<15) ^ (w[j-2]>>>19|w[j-2]<<13) ^ (w[j-2]>>>10);
            w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
        }

        let [a, b, c, d, e, f, g, hh] = h;

        for (let j = 0; j < 64; j++) {
            const S1 = (e>>>6|e<<26) ^ (e>>>11|e<<21) ^ (e>>>25|e<<7);
            const ch = (e&f) ^ (~e&g);
            const temp1 = (hh + S1 + ch + k[j] + w[j]) | 0;
            const S0 = (a>>>2|a<<30) ^ (a>>>13|a<<19) ^ (a>>>22|a<<10);
            const maj = (a&b) ^ (a&c) ^ (b&c);
            const temp2 = (S0 + maj) | 0;

            hh = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }

        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    let hex = '';
    for (let i = 0; i < 8; i++) hex += (h[i] >>> 0).toString(16).padStart(8, '0');
    return hex;
}

// --- BASE64 HELPERS ---
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    const chunks: string[] = [];
    const CHUNK_SIZE = 8192;
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

// --- HEX HELPERS ---
export function arrayBufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    let hex = '';
    for (let i = 0; i < len; i++) {
        hex += HEX_LUT[bytes[i]];
    }
    return hex;
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
    if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
    const len = hex.length / 2;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        const h = hex.substring(i * 2, i * 2 + 2);
        bytes[i] = parseInt(h, 16);
    }
    return bytes.buffer;
}

// --- GZIP COMPRESSION (NATIVE BINARY) ---

/**
 * Comprime uma string para um Uint8Array GZIP.
 * Retorna um formato binário puro, ideal para armazenamento (IndexedDB).
 */
export async function compressToBuffer(data: string): Promise<Uint8Array> {
    if (typeof CompressionStream === 'undefined') {
        throw new Error("CompressionStream not supported.");
    }
    const stream = new Blob([data]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
    const response = new Response(compressedStream);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

/**
 * Comprime uma string para Base64 (Compatibilidade Legada).
 * Reutiliza a lógica binária mas converte para string no final.
 */
export async function compressString(data: string): Promise<string> {
    const buffer = await compressToBuffer(data);
    return arrayBufferToBase64(buffer.buffer);
}

/**
 * Descomprime um Buffer Binário GZIP diretamente para string.
 * Aceita Uint8Array ou ArrayBuffer para flexibilidade.
 */
export async function decompressFromBuffer(compressed: Uint8Array | ArrayBuffer): Promise<string> {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error("DecompressionStream not supported.");
    }
    try {
        // Garante que é um buffer válido para o Blob (Uint8Array ou ArrayBuffer são aceitos, 
        // mas normalizamos para Uint8Array para consistência)
        const buffer = (compressed instanceof Uint8Array) ? compressed : new Uint8Array(compressed);
        const stream = new Blob([buffer]).stream();
        const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
        const response = new Response(decompressedStream);
        return await response.text();
    } catch (e) {
        console.error("Binary Decompression failed", e);
        throw new Error("Failed to decompress binary data.");
    }
}

/**
 * Descomprime uma string Base64 GZIP (Compatibilidade Legada).
 */
export async function decompressString(base64Data: string): Promise<string> {
    const buffer = base64ToArrayBuffer(base64Data);
    return await decompressFromBuffer(buffer);
}

// --- UUID ---
export function generateUUID(): string {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}

    const rnds = new Uint8Array(16);
    let usedCrypto = false;
    try {
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(rnds);
            usedCrypto = true;
        }
    } catch (e) {}

    if (!usedCrypto) {
        const timestamp = Date.now();
        const perf = (typeof performance !== 'undefined' && performance.now) ? performance.now() * 1000 : 0;
        for (let i = 0; i < 16; i++) {
            const r = Math.random() * 256;
            const t = (timestamp >> (i * 2)) & 0xFF;
            const p = (perf >> (i * 2)) & 0xFF;
            rnds[i] = (r ^ t ^ p) & 0xFF;
        }
    }

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
    if (isNaN(date.getTime())) throw new Error("CRITICAL: toUTCIsoDateString received Invalid Date.");
    const year = date.getUTCFullYear(); 
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return year + '-' + PAD_LUT[month] + '-' + PAD_LUT[day];
}

export function getTodayUTC(): Date {
    const today = new Date();
    return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

let _cachedTodayISO: string | null = null;
let _lastTodayCheckTime = 0;

export function getTodayUTCIso(): string {
    const now = Date.now();
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
        resetTodayCache();
        document.dispatchEvent(new CustomEvent('dayChanged'));
        setupMidnightLoop();
    }, msToMidnight + 1000);
}

export function parseUTCIsoDate(isoString: string): Date {
    if (!isoString || typeof isoString !== 'string') return new Date(NaN);
    const date = new Date(`${isoString}T00:00:00.000Z`);
    if (isNaN(date.getTime())) return date;
    if (isoString.length === 10) {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        const yStr = parseInt(isoString.substring(0, 4));
        const mStr = parseInt(isoString.substring(5, 7));
        const dStr = parseInt(isoString.substring(8, 10));
        if (year !== yStr || month !== mStr || day !== dStr) return new Date(NaN);
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
    if (!date || !ISO_DATE_REGEX.test(date)) return getTodayUTCIso();
    return date;
}

// --- Formatting ---
const ESCAPE_HTML_REGEX = /[&<>"']/g;
const ESCAPE_REPLACEMENTS: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _escapeReplacer = (match: string) => ESCAPE_REPLACEMENTS[match];
export function escapeHTML(str: string): string { return str ? str.replace(ESCAPE_HTML_REGEX, _escapeReplacer) : ''; }

const MD_INLINE_COMBINED_REGEX = /(\*\*\*(.*?)\*\*\*)|(\*\*(.*?)\*\*)|(\*(.*?)\*)|(~~(.*?)~~)/g;
const MD_ORDERED_LIST_REGEX = /^\d+\.\s/;
const MD_REPLACER = (match: string, g1: string, c1: string, g2: string, c2: string, g3: string, c3: string, g4: string, c4: string) => {
    if (g1) return `<strong><em>${c1}</em></strong>`;
    if (g2) return `<strong>${c2}</strong>`;
    if (g3) return `<em>${c3}</em>`;
    if (g4) return `<del>${c4}</del>`;
    return match;
};
function formatInline(line: string): string { return escapeHTML(line).replace(MD_INLINE_COMBINED_REGEX, MD_REPLACER); }

const MD_H3_REGEX = /^### /;
const MD_H2_REGEX = /^## /;
const MD_H1_REGEX = /^# /;
const MD_UL_REGEX = /^[*+-\s] /; 

export function simpleMarkdownToHTML(text: string): string {
    if (!text) return '';
    const html: string[] = [];
    let inUnorderedList = false;
    let inOrderedList = false;
    const closeLists = () => { if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; } if (inOrderedList) { html.push('</ol>'); inOrderedList = false; } };
    let startIndex = 0;
    let endIndex = 0;
    const len = text.length;
    while (startIndex < len) {
        endIndex = text.indexOf('\n', startIndex);
        if (endIndex === -1) endIndex = len;
        const line = text.substring(startIndex, endIndex);
        const trimmedLine = line.trim();
        if (MD_H3_REGEX.test(trimmedLine)) { closeLists(); html.push(`<h3>${formatInline(line.substring(4))}</h3>`); }
        else if (MD_H2_REGEX.test(trimmedLine)) { closeLists(); html.push(`<h2>${formatInline(line.substring(3))}</h2>`); }
        else if (MD_H1_REGEX.test(trimmedLine)) { closeLists(); html.push(`<h1>${formatInline(line.substring(2))}</h1>`); }
        else if (MD_UL_REGEX.test(trimmedLine)) { if (inOrderedList) { html.push('</ol>'); inOrderedList = false; } if (!inUnorderedList) { html.push('<ul>'); inUnorderedList = true; } html.push(`<li>${formatInline(line.trim().substring(2))}</li>`); }
        else if (trimmedLine.match(MD_ORDERED_LIST_REGEX)) { if (inUnorderedList) { html.push('</ul>'); inUnorderedList = false; } if (!inOrderedList) { html.push('<ol>'); inOrderedList = true; } html.push(`<li>${formatInline(line.replace(MD_ORDERED_LIST_REGEX, ''))}</li>`); }
        else { closeLists(); if (trimmedLine.length > 0) html.push(`<p>${formatInline(line)}</p>`); }
        startIndex = endIndex + 1;
    }
    closeLists();
    return html.join('');
}

export function pushToOneSignal(callback: (oneSignal: any) => void) {
    if (typeof window === 'undefined') return;
    if (typeof window.OneSignal === 'undefined') { window.OneSignalDeferred = window.OneSignalDeferred || []; window.OneSignalDeferred.push(callback); }
    else callback(window.OneSignal);
}

const HAPTIC_PATTERNS = { 'selection': 8, 'light': 12, 'medium': 20, 'heavy': 40, 'success': [15, 50, 15], 'error': [40, 60, 15] };
export function triggerHaptic(type: keyof typeof HAPTIC_PATTERNS) {
    if (typeof navigator !== 'undefined' && navigator.vibrate) try { navigator.vibrate(HAPTIC_PATTERNS[type]); } catch {}
}

let cachedLightContrastColor: string | null = null;
let cachedDarkContrastColor: string | null = null;
function _cacheContrastColors() {
    if (cachedLightContrastColor && cachedDarkContrastColor) return;
    try {
        const rootStyles = getComputedStyle(document.documentElement);
        cachedLightContrastColor = rootStyles.getPropertyValue('--text-primary').trim() || '#e5e5e5';
        cachedDarkContrastColor = rootStyles.getPropertyValue('--bg-color').trim() || '#000000';
    } catch { cachedLightContrastColor = '#e5e5e5'; cachedDarkContrastColor = '#000000'; }
}
function _readHex2(hex: string, offset: number): number {
    let val = 0;
    for (let j = 0; j < 2; j++) {
        const c = hex.charCodeAt(offset + j);
        val <<= 4;
        if (c >= 48 && c <= 57) val |= (c - 48);
        else if (c >= 65 && c <= 70) val |= (c - 55);
        else if (c >= 97 && c <= 102) val |= (c - 87);
    }
    return val;
}
const _contrastCache = new Map<string, string>();
export function getContrastColor(hexColor: string): string {
    const cached = _contrastCache.get(hexColor);
    if (cached) return cached;
    _cacheContrastColors();
    if (!hexColor || hexColor.length < 4) return cachedLightContrastColor!;
    try {
        let fullHex = hexColor;
        if (hexColor.length === 4 && hexColor.charCodeAt(0) === 35) {
            const r = hexColor[1], g = hexColor[2], b = hexColor[3];
            fullHex = `#${r}${r}${g}${g}${b}${b}`;
        }
        const offset = fullHex.charCodeAt(0) === 35 ? 1 : 0;
        const r = _readHex2(fullHex, offset), g = _readHex2(fullHex, offset + 2), b = _readHex2(fullHex, offset + 4);
        const yiq = (r * 299) + (g * 587) + (b * 114);
        const result = (yiq >= 128000) ? cachedDarkContrastColor! : cachedLightContrastColor!;
        if (_contrastCache.size < 100) _contrastCache.set(hexColor, result);
        return result;
    } catch { return cachedLightContrastColor!; }
}
