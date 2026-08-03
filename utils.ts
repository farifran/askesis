/**
 * @license
 * SPDX-License-Identifier: MIT
*/

/**
 * @file utils.ts
 * @description Biblioteca de Utilitários de Infraestrutura (Clean & Native).
 */

import { HAPTIC_PATTERNS } from './constants';
import { emitDayChanged } from './events';

export const MS_PER_DAY = 86400000;

// --- TIMERS ---
export type DebouncedFn = (() => void) & { cancel: () => void };

export function createDebounced(fn: () => void, delayMs: number): DebouncedFn {
    let timer: number | undefined;
    const debounced = (() => {
        if (timer !== undefined) clearTimeout(timer);
        timer = window.setTimeout(fn, delayMs);
    }) as DebouncedFn;
    debounced.cancel = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    return debounced;
}

// --- STATIC LOOKUP TABLES (HOT MEMORY) ---
export const HEX_LUT: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const PAD_LUT: string[] = Array.from({ length: 100 }, (_, i) => i < 10 ? '0' + i : String(i));

export function pad2(value: number): string {
    return PAD_LUT[value] ?? String(value).padStart(2, '0');
}

// --- BASE64 HELPERS (Safe Chunking) ---
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    const chunks: string[] = [];
    const CHUNK_SIZE = 8192; // Previne Stack Overflow em buffers grandes
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

// --- UUID (Crypto Strong) ---
export function generateUUID(): string {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}

    const rnds = new Uint8Array(16);
    try {
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(rnds);
        } else {
            throw 0; // Fallback math
        }
    } catch (e) {
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

// --- Date Helpers (UTC Strict) ---
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
        emitDayChanged();
        setupMidnightLoop();
    }, msToMidnight + 1000);
}

export function parseUTCIsoDate(isoString: string): Date {
    if (!isoString || typeof isoString !== 'string') return new Date(NaN);
    const date = new Date(`${isoString}T00:00:00.000Z`);
    if (isNaN(date.getTime())) return date;
    // Fast path validation
    if (isoString.length === 10) {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        if (year !== parseInt(isoString.substring(0, 4)) || 
            month !== parseInt(isoString.substring(5, 7)) || 
            day !== parseInt(isoString.substring(8, 10))) return new Date(NaN);
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

// --- Formatting Helpers ---
const ESCAPE_HTML_REGEX = /[&<>"']/g;
const ESCAPE_REPLACEMENTS: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _escapeReplacer = (match: string) => ESCAPE_REPLACEMENTS[match];
export function escapeHTML(str: string): string { return str ? str.replace(ESCAPE_HTML_REGEX, _escapeReplacer) : ''; }

export function sanitizeText(value: string, maxLength?: number): string {
    if (!value) return '';
    let sanitized = value.replace(/[<>{}]/g, '').trim();
    if (maxLength && sanitized.length > maxLength) {
        sanitized = sanitized.slice(0, maxLength);
    }
    return sanitized;
}

// --- Keyboard Helpers (Cross-Browser Key Normalization) ---
export function normalizeKeyboardKey(key: string): string {
    switch (key) {
        case ' ':
        case 'Space':
        case 'Spacebar':
            return 'Space';
        case 'Esc':
            return 'Escape';
        case 'Left':
            return 'ArrowLeft';
        case 'Right':
            return 'ArrowRight';
        case 'Up':
            return 'ArrowUp';
        case 'Down':
            return 'ArrowDown';
        default:
            return key;
    }
}

export function getNormalizedKeyboardKey(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
    // Use `code` as fallback to keep Space detection stable across layouts.
    if (event.code === 'Space') return 'Space';
    return normalizeKeyboardKey(event.key || '');
}

export function isActivationKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
    const key = getNormalizedKeyboardKey(event);
    return key === 'Enter' || key === 'Space';
}

export function isEscapeKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
    return getNormalizedKeyboardKey(event) === 'Escape';
}

// Simple Markdown Parser (Zero-Dep)
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

// --- Logger (Dev Only) ---
// Política: usar `logger` em código de app; `console` fica restrito a testes/build.
const SHOULD_LOG = (() => {
    const maybeProcess = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    return maybeProcess?.env?.NODE_ENV !== 'production';
})();
export const logger = {
    info: (message: string, data?: unknown) => {
        if (!SHOULD_LOG) return;
        if (data !== undefined) console.log(message, data);
        else console.log(message);
    },
    warn: (message: string, data?: unknown) => {
        if (!SHOULD_LOG) return;
        if (data !== undefined) console.warn(message, data);
        else console.warn(message);
    },
    error: (message: string, data?: unknown) => {
        if (data !== undefined) console.error(message, data);
        else console.error(message);
    }
};
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

// --- OneSignal (web push) ---
//
// Arquitetura estável:
//  - Offline: sw.js (escopo `/`)
//  - Push: OneSignalSDKWorker.js na raiz, escopo `/onesignal/` (não compete com offline)
//  - CSP DEVE permitir script de https://api.onesignal.com (JSONP do init)
//
// Fluxo de opt-in (simples, o que já funcionava no produto):
//  1) permissão nativa no gesto (iOS)
//  2) setLocalPushOptIn(true) imediatamente
//  3) init + requestPermission + optIn em background
//
const ONESIGNAL_SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
const ONESIGNAL_APP_ID = 'd69cf0b6-bc03-4375-b3b7-dd7b37e05a17';
const ONESIGNAL_SAFARI_WEB_ID = 'web.onesignal.auto.2465995d-af39-44d0-9727-0f4afeb298e1';
const ONESIGNAL_OPTIN_STORAGE_KEY = 'askesis_onesignal_opted_in';
const PUSH_PERMISSION_REQUESTED_KEY = 'askesis_push_permission_requested';

type OneSignalLike = {
    init(options: Record<string, unknown>): Promise<void>;
    Notifications: {
        addEventListener(event: 'permissionChange', handler: () => void): void;
        requestPermission(): Promise<void | boolean>;
        permission?: boolean | 'default' | 'denied' | 'granted';
        isPushSupported?(): boolean;
    };
    User: {
        PushSubscription: {
            optIn(): Promise<void>;
            optOut(): Promise<void>;
            optedIn?: boolean;
            id?: string | null;
            token?: string | null;
        };
        setLanguage?(lang: string): void;
    };
};

type OneSignalWindow = Window & {
    OneSignal?: OneSignalLike;
    OneSignalDeferred?: Array<(oneSignal: OneSignalLike) => void | Promise<void>>;
};

let _oneSignalInitPromise: Promise<OneSignalLike> | null = null;

export function getLocalPushOptIn(): boolean | null {
    try {
        const raw = localStorage.getItem(ONESIGNAL_OPTIN_STORAGE_KEY);
        if (raw === '1') return true;
        if (raw === '0') return false;
        return null;
    } catch {
        return null;
    }
}

export function setLocalPushOptIn(value: boolean) {
    try {
        localStorage.setItem(ONESIGNAL_OPTIN_STORAGE_KEY, value ? '1' : '0');
    } catch {}
}

export function hasRequestedPushPermission(): boolean {
    try {
        return localStorage.getItem(PUSH_PERMISSION_REQUESTED_KEY) !== null;
    } catch {
        return false;
    }
}

export function getPushPermissionRequestAgeMs(): number | null {
    try {
        const raw = localStorage.getItem(PUSH_PERMISSION_REQUESTED_KEY);
        if (!raw) return null;
        if (raw === '1') return Number.POSITIVE_INFINITY;
        const ts = Number(raw);
        if (!Number.isFinite(ts) || ts <= 0) return Number.POSITIVE_INFINITY;
        return Math.max(0, Date.now() - ts);
    } catch {
        return null;
    }
}

export function markPushPermissionRequested() {
    try {
        localStorage.setItem(PUSH_PERMISSION_REQUESTED_KEY, String(Date.now()));
    } catch {}
}

export function getNotificationPermission(): NotificationPermission {
    try {
        if (typeof Notification === 'undefined') return 'default';
        const maybe = (Notification as unknown) as { permission?: NotificationPermission };
        return maybe.permission ?? 'default';
    } catch {
        return 'default';
    }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
    try {
        if (typeof Notification === 'undefined') return 'default';
        const req = (Notification as unknown) as { requestPermission?: () => Promise<NotificationPermission> };
        if (typeof req.requestPermission === 'function') {
            return await req.requestPermission();
        }
        return 'default';
    } catch {
        return 'default';
    }
}

function _loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
        if (existing) {
            if ((existing as any)._loaded) return resolve();
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.async = true;
        script.src = src;
        script.addEventListener('load', () => { (script as any)._loaded = true; resolve(); }, { once: true });
        script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        document.head.appendChild(script);
    });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Roda callback se o SDK já estiver no window (sem lazy-load). */
export function pushToOneSignal(callback: (oneSignal: OneSignalLike) => void) {
    if (typeof window === 'undefined') return;
    const oneSignalWindow = window as OneSignalWindow;
    if (typeof oneSignalWindow.OneSignal === 'undefined') return;
    callback(oneSignalWindow.OneSignal);
}

/**
 * Carrega o page.js + espera o es6 (init real) e roda OneSignal.init uma vez.
 */
export async function ensureOneSignalReady(): Promise<OneSignalLike> {
    if (typeof window === 'undefined') throw new Error('OneSignal unavailable');
    const win = window as OneSignalWindow;

    if (_oneSignalInitPromise) return _oneSignalInitPromise;

    _oneSignalInitPromise = (async () => {
        if (!win.OneSignalDeferred) win.OneSignalDeferred = [];

        const ready = new Promise<OneSignalLike>((resolve, reject) => {
            win.OneSignalDeferred!.push(async (OneSignal) => {
                try {
                    await OneSignal.init({
                        appId: ONESIGNAL_APP_ID,
                        safari_web_id: ONESIGNAL_SAFARI_WEB_ID,
                        allowLocalhostAsSecureOrigin: true,
                        autoResubscribe: true,
                        // Isola o worker de push do sw.js offline (escopo `/`).
                        serviceWorkerPath: 'OneSignalSDKWorker.js',
                        serviceWorkerParam: { scope: '/onesignal/' },
                    });
                    resolve(OneSignal);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    // Re-init na mesma página: devolve a instância já pronta.
                    if (/already initialized/i.test(msg) && win.OneSignal) {
                        resolve(win.OneSignal);
                        return;
                    }
                    reject(e);
                }
            });
        });

        await _loadScript(ONESIGNAL_SDK_URL);

        // page.js só enfileira o es6; sem esta espera o init pode nunca rodar a tempo.
        const t0 = Date.now();
        while (!(win.OneSignal && typeof win.OneSignal.init === 'function') && Date.now() - t0 < 15000) {
            await sleep(40);
        }
        if (!win.OneSignal) throw new Error('OneSignal SDK load timeout');

        return await Promise.race([
            ready,
            sleep(20000).then(() => { throw new Error('OneSignal init timeout'); }),
        ]);
    })().catch((e) => {
        _oneSignalInitPromise = null;
        throw e;
    });

    return _oneSignalInitPromise;
}

/**
 * Finaliza inscrição no OneSignal (requestPermission + optIn).
 * Em caso de permissão já granted, mantém intenção local mesmo se o SDK
 * demorar a reportar optedIn (evita toggle “morto” e mensagem de reiniciar).
 */
export async function ensurePushSubscribed(): Promise<{ optedIn: boolean; subscriptionId?: string | null }> {
    const OneSignal = await ensureOneSignalReady();

    try {
        await OneSignal.Notifications.requestPermission();
    } catch (err) {
        logger.error('OneSignal requestPermission failed', err);
    }

    try {
        // Necessário no Chromium quando a permissão nativa já foi dada fora do SDK.
        if (typeof OneSignal.User.PushSubscription.optIn === 'function') {
            await OneSignal.User.PushSubscription.optIn();
        }
    } catch (err) {
        logger.error('OneSignal optIn failed', err);
    }

    for (let i = 0; i < 15; i++) {
        if (OneSignal.User.PushSubscription.optedIn) break;
        await sleep(200);
    }

    const optedIn = !!OneSignal.User.PushSubscription.optedIn;
    const subscriptionId = OneSignal.User.PushSubscription.id ?? null;
    const nativeGranted = getNotificationPermission() === 'granted';

    // Intenção do usuário + permissão do browser: mantém opt-in local.
    // Só zera se o browser recusou (denied/default).
    if (optedIn || nativeGranted) {
        setLocalPushOptIn(true);
    } else {
        setLocalPushOptIn(false);
    }

    if (!optedIn) {
        logger.error('OneSignal subscription not confirmed yet', {
            permission: getNotificationPermission(),
            sdkPermission: OneSignal.Notifications.permission,
            id: subscriptionId,
            token: !!OneSignal.User.PushSubscription.token,
        });
    }

    return { optedIn, subscriptionId };
}

export function triggerHaptic(type: keyof typeof HAPTIC_PATTERNS) {
    if (typeof navigator !== 'undefined' && navigator.vibrate) try { navigator.vibrate(HAPTIC_PATTERNS[type] as any); } catch {}
}

// --- Color Contrast Cache (Hot Path) ---
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
