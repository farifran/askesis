/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { HEX_LUT } from '../utils';

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';
const UUID_REGEX = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
const encoder = new TextEncoder();

// Cache em memória para não ler do disco toda hora
let memoryKey: string | null = null;
let memoryHash: string | null = null;

const SafeStorage = {
    get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
    rem: (k: string) => { try { localStorage.removeItem(k); } catch {} }
};

// --- CORE AUTH LOGIC ---

export const getSyncKey = (): string | null => {
    if (memoryKey) return memoryKey;
    // Recuperação automática (Lazy Load)
    memoryKey = SafeStorage.get(SYNC_KEY_STORAGE_KEY);
    return memoryKey;
};

/**
 * Inicializa a autenticação carregando a chave do storage para a memória.
 * Usado no boot da aplicação.
 */
export const initAuth = () => {
    getSyncKey();
};

export const hasLocalSyncKey = (): boolean => {
    // Verifica memória OU disco chamando getSyncKey() que faz o lazy load
    return !!getSyncKey();
};

export const storeKey = (k: string) => {
    memoryKey = k;
    memoryHash = null; // Invalida hash antigo
    SafeStorage.set(SYNC_KEY_STORAGE_KEY, k);
};

export const clearKey = () => {
    memoryKey = null;
    memoryHash = null;
    SafeStorage.rem(SYNC_KEY_STORAGE_KEY);
};

export const isValidKeyFormat = (k: string) => UUID_REGEX.test(k);

// --- HASHING SEGURO ---

async function hashKey(key: string): Promise<string> {
    if (!key) return '';
    
    if (crypto && crypto.subtle) {
        try {
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
            let hex = '';
            for (let i = 0; i < hash.length; i++) hex += HEX_LUT[hash[i]];
            return hex;
        } catch (e) {
            console.error("Crypto falhou:", e);
            throw e;
        }
    }
    throw new Error("Ambiente inseguro (falta crypto.subtle). Use HTTPS ou Localhost.");
}

export async function getSyncKeyHash(): Promise<string | null> {
    const key = getSyncKey();
    if (!key) return null;
    
    // Retorna cache se existir
    if (memoryHash) return memoryHash;
    
    // Gera novo e salva em cache
    memoryHash = await hashKey(key);
    return memoryHash;
}

// --- FETCH WRAPPER ---

interface ExtendedRequestInit extends RequestInit { timeout?: number; retries?: number; backoff?: number; }

export async function apiFetch(endpoint: string, options: ExtendedRequestInit = {}, includeSyncKey = false): Promise<Response> {
    const { timeout = 15000, retries = 2, backoff = 500, ...fetchOpts } = options;
    const headers = new Headers(options.headers);
    
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    if (includeSyncKey) {
        try {
            const hash = await getSyncKeyHash();
            if (hash) {
                headers.set('X-Sync-Key-Hash', hash);
            } else if (hasLocalSyncKey()) {
                // Se temos a chave mas o hash falhou, aborta para não enviar lixo
                throw new Error("Crypto Failure: Hash generation failed");
            }
        } catch (e) {
            console.error("Auth Error:", e);
            throw e;
        }
    }

    // Lógica de Retry Robusta
    for (let n = 0; n <= retries; n++) {
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), timeout);
        
        try {
            const res = await fetch(endpoint, { ...fetchOpts, headers, signal: ctrl.signal });
            clearTimeout(tId);
            
            // 409 (Conflict), 401 (Auth) e 404 (Not Found) são respostas válidas de API, não erros de rede
            if (res.ok || res.status === 409 || res.status === 401 || res.status === 404) return res;
            
            const errText = await res.text();
            if (n === retries) throw new Error(`HTTP ${res.status}: ${errText}`);
            
        } catch (e: any) {
            clearTimeout(tId);
            if (n === retries) throw e;
            // Backoff exponencial
            await new Promise(r => setTimeout(r, backoff * Math.pow(2, n)));
        }
    }
    throw new Error("Network unreachable");
}