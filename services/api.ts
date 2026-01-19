/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * VERSÃO: Direct Storage + Secure Context Guard
 */

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';

// --- GERENCIAMENTO DE CHAVES (Síncrono e Direto) ---

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
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
};

// --- AUTH HASH ---

let cachedHash: string | null = null;
let lastKeyForHash: string | null = null;

async function getSyncKeyHash(): Promise<string | null> {
    const key = getSyncKey();
    if (!key) return null;

    if (cachedHash && lastKeyForHash === key) return cachedHash;

    // CRITICAL FIX: Verifica se crypto.subtle existe. 
    // Em HTTP (inseguro), isso é undefined e causa crash.
    if (!window.crypto || !window.crypto.subtle) {
        const msg = "Ambiente Inseguro: HTTPS necessário para sincronização.";
        console.error(msg);
        throw new Error(msg);
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    
    try {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        
        cachedHash = hashHex;
        lastKeyForHash = key;
        
        return hashHex;
    } catch (e) {
        console.error("Crypto Digest Error:", e);
        throw new Error("Erro de Criptografia no Navegador");
    }
}

// --- API CLIENT ---

export async function apiFetch(endpoint: string, options: RequestInit = {}, includeSyncKey = false): Promise<Response> {
    const headers = new Headers(options.headers || {});
    
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }

    if (includeSyncKey) {
        const hash = await getSyncKeyHash();
        if (hash) {
            headers.set('X-Sync-Key-Hash', hash);
        } else {
            // Se não conseguimos gerar o hash (ex: erro de HTTPS), paramos aqui.
            throw new Error("Falha na autenticação (HTTPS necessário?)");
        }
    }

    const config = {
        ...options,
        headers,
        keepalive: true
    };

    return fetch(endpoint, config);
}

// Compatibilidade
export const initAuth = async () => { };