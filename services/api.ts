
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * VERSÃO: Direct Storage + Secure Context Fallback
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

    // CLIENT-SIDE HASHING (Preferred)
    // Disponível apenas em Contextos Seguros (HTTPS/Localhost)
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
            console.warn("Crypto Digest failed (Security restrictions?), falling back to raw key", e);
        }
    } else {
        console.warn("Crypto Subtle API unavailable. Using fallback auth.");
    }

    // FALLBACK: Retorna null para sinalizar que devemos usar a estratégia de envio de Chave Bruta
    return null;
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
            // ESTRATÉGIA 1: Hash gerado no cliente (Mais seguro, não trafega a chave bruta)
            headers.set('X-Sync-Key-Hash', hash);
        } else {
            // ESTRATÉGIA 2 (FALLBACK): Envia chave bruta para hash no servidor
            // Necessário para ambientes HTTP inseguros ou browsers antigos
            const rawKey = getSyncKey();
            if (rawKey) {
                headers.set('Authorization', `Bearer ${rawKey}`);
            } else {
                throw new Error("Chave de sincronização não encontrada.");
            }
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
