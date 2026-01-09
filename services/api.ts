/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { HEX_LUT } from '../utils';

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';
const UUID_REGEX = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
const encoder = new TextEncoder();
const CRYPTO_TIMEOUT_MS = 2000;

let localSyncKey: string | null = null;
let keyHashCache: string | null = null;

const SafeStorage = {
    get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
    rem: (k: string) => { try { localStorage.removeItem(k); } catch {} }
};

export const initAuth = () => localSyncKey = SafeStorage.get(SYNC_KEY_STORAGE_KEY);
export const storeKey = (k: string) => { localSyncKey = k; keyHashCache = null; SafeStorage.set(SYNC_KEY_STORAGE_KEY, k); };
export const clearKey = () => { localSyncKey = keyHashCache = null; SafeStorage.rem(SYNC_KEY_STORAGE_KEY); };
export const hasLocalSyncKey = () => localSyncKey !== null;
export const getSyncKey = () => localSyncKey;
export const isValidKeyFormat = (k: string) => UUID_REGEX.test(k);

async function hashKey(key: string): Promise<string> {
    if (!key || !crypto.subtle) return '';
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
    let hex = '';
    for (let i = 0; i < hash.length; i++) hex += HEX_LUT[hash[i]];
    return hex;
}

export async function getSyncKeyHash(): Promise<string | null> {
    if (!localSyncKey) return null;
    return keyHashCache || (keyHashCache = await hashKey(localSyncKey));
}

interface ExtendedRequestInit extends RequestInit { timeout?: number; retries?: number; backoff?: number; }

export async function apiFetch(endpoint: string, options: ExtendedRequestInit = {}, includeSyncKey = false): Promise<Response> {
    const { timeout = 15000, retries = 2, backoff = 500, ...fetchOpts } = options;
    const headers = new Headers(options.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    if (includeSyncKey) {
        const hash = await Promise.race([getSyncKeyHash(), new Promise<null>(r => setTimeout(() => r(null), CRYPTO_TIMEOUT_MS))]);
        if (hash) headers.set('X-Sync-Key-Hash', hash);
    }

    for (let n = 0; n <= retries; n++) {
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(endpoint, { ...fetchOpts, headers, signal: ctrl.signal, keepalive: true });
            clearTimeout(tId);
            if (res.ok || res.status === 409) return res;
            if (res.status < 500 || n === retries) throw new Error(await res.text());
        } catch (e) {
            clearTimeout(tId);
            if (n === retries) throw e;
            await new Promise(r => setTimeout(r, backoff * Math.pow(2, n)));
        }
    }
    throw new Error("Fetch unreachable");
}
