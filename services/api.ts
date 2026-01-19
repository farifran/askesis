/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { HEX_LUT } from '../utils';

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';
const UUID_REGEX = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
const encoder = new TextEncoder();

// --- PERSISTENCE LAYER: INDEXEDDB (BACKUP COFFRE) ---
// Usado como backup robusto caso o localStorage seja limpo pelo OS.
const AUTH_DB_NAME = 'AskesisAuth';
const AUTH_STORE = 'keys';

function getAuthDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(AUTH_DB_NAME, 1);
        req.onupgradeneeded = (e: any) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(AUTH_STORE)) {
                db.createObjectStore(AUTH_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function backupKeyToDB(key: string) {
    try {
        const db = await getAuthDB();
        const tx = db.transaction(AUTH_STORE, 'readwrite');
        tx.objectStore(AUTH_STORE).put(key, SYNC_KEY_STORAGE_KEY);
    } catch (e) {
        console.warn('AuthDB Write Failed', e);
    }
}

async function restoreKeyFromDB(): Promise<string | null> {
    try {
        const db = await getAuthDB();
        return new Promise((resolve) => {
            const tx = db.transaction(AUTH_STORE, 'readonly');
            const req = tx.objectStore(AUTH_STORE).get(SYNC_KEY_STORAGE_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (e) {
        return null;
    }
}

async function clearKeyFromDB() {
    try {
        const db = await getAuthDB();
        const tx = db.transaction(AUTH_STORE, 'readwrite');
        tx.objectStore(AUTH_STORE).delete(SYNC_KEY_STORAGE_KEY);
    } catch (e) {}
}

// --- CORE AUTH LOGIC ---

// Cache em memória para acesso síncrono (Hot Path)
let memoryKey: string | null = null;
let memoryHash: string | null = null;

const SafeStorage = {
    get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
    rem: (k: string) => { try { localStorage.removeItem(k); } catch {} }
};

export const getSyncKey = (): string | null => {
    // 1. Memória (Mais rápido)
    if (memoryKey) return memoryKey;
    
    // 2. LocalStorage (Rápido)
    // Se a memória caiu (refresh), tentamos recuperar do disco síncrono.
    const local = SafeStorage.get(SYNC_KEY_STORAGE_KEY);
    if (local) {
        memoryKey = local;
        return local;
    }
    
    return null;
};

/**
 * Inicializa a autenticação. Deve ser chamada no boot do app (await).
 * Tenta recuperar a chave de todas as camadas de persistência.
 */
export const initAuth = async (): Promise<void> => {
    // Se já temos em memória, ok.
    if (memoryKey) return;

    // Tenta LocalStorage primeiro
    let key = SafeStorage.get(SYNC_KEY_STORAGE_KEY);
    
    // Se falhar (Amnésia), tenta IndexedDB
    if (!key) {
        key = await restoreKeyFromDB();
        if (key) {
            console.log("[Auth] Chave recuperada do cofre de backup (IDB). Restaurando...");
            // Cura o LocalStorage
            SafeStorage.set(SYNC_KEY_STORAGE_KEY, key);
        }
    }

    // Define em memória
    if (key) {
        memoryKey = key;
    }
};

export const hasLocalSyncKey = (): boolean => {
    return !!getSyncKey();
};

export const storeKey = (k: string) => {
    memoryKey = k;
    memoryHash = null; 
    SafeStorage.set(SYNC_KEY_STORAGE_KEY, k);
    // Salva backup assíncrono
    backupKeyToDB(k);
};

export const clearKey = () => {
    memoryKey = null;
    memoryHash = null;
    SafeStorage.rem(SYNC_KEY_STORAGE_KEY);
    // Limpa backup assíncrono
    clearKeyFromDB();
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
    
    if (memoryHash) return memoryHash;
    
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
                throw new Error("Crypto Failure: Hash generation failed");
            } else {
                // Se chegamos aqui e includeSyncKey é true, mas não temos chave,
                // significa que perdemos a sessão.
                throw new Error("Missing Sync Key");
            }
        } catch (e) {
            console.error("Auth Error:", e);
            throw e;
        }
    }

    const finalOpts = { ...fetchOpts, cache: 'no-store' as RequestCache };

    for (let n = 0; n <= retries; n++) {
        const ctrl = new AbortController();
        const tId = setTimeout(() => ctrl.abort(), timeout);
        
        try {
            const res = await fetch(endpoint, { ...finalOpts, headers, signal: ctrl.signal });
            clearTimeout(tId);
            
            if (res.ok || res.status === 409 || res.status === 401 || res.status === 404) return res;
            
            const errText = await res.text();
            if (n === retries) throw new Error(`HTTP ${res.status}: ${errText}`);
            
        } catch (e: any) {
            clearTimeout(tId);
            if (n === retries) throw e;
            await new Promise(r => setTimeout(r, backoff * Math.pow(2, n)));
        }
    }
    throw new Error("Network unreachable");
}