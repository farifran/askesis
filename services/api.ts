/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * VERSÃO: Direct Storage Access (Corrige perda de senha ao atualizar)
 */

import { HEX_LUT } from '../utils';

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';

// --- GERENCIAMENTO DE CHAVES (Direto no Disco) ---

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

// --- VALIDAÇÃO DE FORMATO ---
export const isValidKeyFormat = (key: string): boolean => {
    // Validates standard UUID format (8-4-4-4-12 hex digits)
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
};

// --- CRIPTOGRAFIA DO HASH (Para Autenticação no Servidor) ---
// O Backend exige o cabeçalho 'X-Sync-Key-Hash'

let cachedHash: string | null = null;
let lastKeyForHash: string | null = null;

async function getSyncKeyHash(): Promise<string | null> {
    const key = getSyncKey();
    if (!key) return null;

    // Se a chave não mudou, retorna o hash cacheado (Performance)
    if (cachedHash && lastKeyForHash === key) return cachedHash;

    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    
    // Converte ArrayBuffer para Hex String
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    cachedHash = hashHex;
    lastKeyForHash = key;
    
    return hashHex;
}

// --- API FETCH WRAPPER ---

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
            console.warn("Tentativa de sync sem chave configurada.");
            throw new Error("No Sync Key");
        }
    }

    // Configuração robusta de Fetch
    const config = {
        ...options,
        headers,
        keepalive: true // Importante para salvar dados ao fechar o app
    };

    const res = await fetch(endpoint, config);
    return res;
}

// Função de compatibilidade
export const initAuth = async () => { /* No-op: LocalStorage is sync */ };