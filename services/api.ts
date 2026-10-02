
/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file services/api.ts
 * @description Cliente de API e Gerenciamento de Chaves de Sincronização.
 */

import { logger } from '../utils';
import { API_TIMEOUT_MS, API_MAX_RETRIES, API_RETRY_DELAY_MS } from '../constants';

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';

const LOG_PREFIX = '[API]';

function logWarn(message: string, error?: unknown) {
    if (error !== undefined) logger.warn(`${LOG_PREFIX} ${message}`, error);
    else logger.warn(`${LOG_PREFIX} ${message}`);
}

function logError(message: string, error?: unknown) {
    if (error !== undefined) logger.error(`${LOG_PREFIX} ${message}`, error);
    else logger.error(`${LOG_PREFIX} ${message}`);
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });
    return controller.signal;
}

function mergeSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
    if (!secondary) return primary;

    if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).any === 'function') {
        return (AbortSignal as any).any([primary, secondary]);
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    primary.addEventListener('abort', abort, { once: true });
    secondary.addEventListener('abort', abort, { once: true });
    return controller.signal;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    const timeoutSignal = createTimeoutSignal(timeoutMs);
    const signal = mergeSignals(timeoutSignal, init.signal || undefined);
    return await fetch(input, { ...init, signal });
}

// --- GERENCIAMENTO DE CHAVES ---

export const hasLocalSyncKey = (): boolean => {
    return !!localStorage.getItem(SYNC_KEY_STORAGE_KEY);
};

export const getSyncKey = (): string | null => {
    return localStorage.getItem(SYNC_KEY_STORAGE_KEY);
};

export const storeKey = (k: string) => {
    if (!k) return;
    localStorage.setItem(SYNC_KEY_STORAGE_KEY, k);
};

export const clearKey = () => {
    localStorage.removeItem(SYNC_KEY_STORAGE_KEY);
};

// --- VALIDAÇÃO ---
export const isValidKeyFormat = (key: string): boolean => {
    // Formato UUID v4 básico
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
};

// --- AUTH HASH (SHA-256) ---
let cachedHash: string | null = null;
let lastKeyForHash: string | null = null;

/**
 * Gera um hash da chave para usar como identificador no banco (Privacidade).
 * A chave real nunca sai do dispositivo em texto claro.
 */
async function getSyncKeyHash(): Promise<string | null> {
    const key = getSyncKey();
    if (!key) return null;

    if (cachedHash && lastKeyForHash === key) return cachedHash;

    if (window.crypto && window.crypto.subtle) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(key);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            
            cachedHash = hashHex;
            lastKeyForHash = key;
            
            return hashHex;
        } catch (e) {
            logWarn('Crypto Digest failed; authentication unavailable', e);
        }
    }
    return null;
}

// --- API CLIENT ---

/**
 * Wrapper de Fetch com injeção automática de Headers de Sync.
 */
let aiSessionRequest: Promise<Response> | null = null;
async function ensureAiSession(): Promise<Response> {
    if (!aiSessionRequest) {
        aiSessionRequest = fetchWithTimeout('/api/ai-session', { method: 'POST', credentials: 'same-origin' }, API_TIMEOUT_MS)
            .finally(() => { aiSessionRequest = null; });
    }
    return aiSessionRequest;
}

export async function apiFetch(endpoint: string, options: RequestInit = {}, includeSyncKey = false): Promise<Response> {
    if (endpoint === '/api/analyze') {
        const session = await ensureAiSession();
        if (!session.ok) return session;
    }
    const headers = new Headers(options.headers || {});
    
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }

    if (includeSyncKey) {
        const hash = await getSyncKeyHash();
        if (hash) {
            // O servidor usa o hash para encontrar o registro no KV/Redis
            headers.set('X-Sync-Key-Hash', hash);
        } else {
            // Degraded mode: SubtleCrypto may be absent or digest failed. Proceed without hash
            // and let the server respond; calling code should handle 401/unauthorized.
            logWarn('Sync Key hash unavailable; proceeding in degraded mode (server may reject unauthenticated requests).');
        }
    }

    const config = {
        ...options,
        headers,
        // Corpos grandes de sync/IA usam fetch normal; keepalive tem teto de 64 KiB.
        keepalive: options.keepalive ?? false
    };

    const isAnalysis = endpoint === '/api/analyze';
    const maxRetries = isAnalysis ? 0 : API_MAX_RETRIES;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchWithTimeout(endpoint, config, isAnalysis ? 35000 : API_TIMEOUT_MS);

            // Gestão de Resiliência: Se o servidor diz que a chave não existe mais, limpa localmente
            if (response.status === 401 && includeSyncKey && hasLocalSyncKey()) {
                clearKey();
                cachedHash = null;
                lastKeyForHash = null;
                logWarn('Unauthorized. Sync key cleared.');
            }

            return response;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                await wait(API_RETRY_DELAY_MS * (attempt + 1));
                continue;
            }
            logError('Network error during apiFetch', error);
        }
    }

    if (lastError instanceof Error) Object.assign(lastError, { code: 'NETWORK_ERROR' });
    throw lastError;
}

export const initAuth = async () => {
    if (!hasLocalSyncKey()) return;
    try {
        await getSyncKeyHash();
    } catch (error) {
        logWarn('initAuth failed', error);
    }
};
