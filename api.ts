
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Arquivo revisado e otimizado. Tratamento de erros blindado e lógica de headers simplificada. Nenhuma ação pendente detectada.

const SYNC_KEY_STORAGE_KEY = 'habitTrackerSyncKey';
const UUID_REGEX = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

let localSyncKey: string | null = null;
let keyHashCache: string | null = null;

// --- Authentication / Key Management ---

export function initAuth() {
    localSyncKey = localStorage.getItem(SYNC_KEY_STORAGE_KEY);
}

export function storeKey(key: string) {
    localSyncKey = key;
    keyHashCache = null; // [2024-01-16] Limpa o cache para forçar re-hash na próxima chamada.
    localStorage.setItem(SYNC_KEY_STORAGE_KEY, key);
}

export function clearKey() {
    localSyncKey = null;
    keyHashCache = null;
    localStorage.removeItem(SYNC_KEY_STORAGE_KEY);
}

export function hasLocalSyncKey(): boolean {
    return localSyncKey !== null;
}

export function getSyncKey(): string | null {
    return localSyncKey;
}

export function isValidKeyFormat(key: string): boolean {
    return UUID_REGEX.test(key);
}

async function hashKey(key: string): Promise<string> {
    if (!key) return '';
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getSyncKeyHash(): Promise<string | null> {
    if (!localSyncKey) {
        return null;
    }
    if (keyHashCache) {
        return keyHashCache;
    }
    keyHashCache = await hashKey(localSyncKey);
    return keyHashCache;
}

// --- Networking ---

interface ExtendedRequestInit extends RequestInit {
    timeout?: number;
}

/**
 * Wrapper for the fetch API that includes the sync key hash and handles timeouts.
 * Moved from utils.ts to prevent circular dependencies.
 */
export async function apiFetch(endpoint: string, options: ExtendedRequestInit = {}, includeSyncKey = false): Promise<Response> {
    // [2024-01-16] REFACTOR: Uso da classe Headers para manipulação mais limpa e segura de headers.
    // Inicializa com os headers fornecidos nas opções (se houver)
    const headers = new Headers(options.headers);

    // Define Content-Type padrão se não tiver sido sobrescrito pelo chamador
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }

    if (includeSyncKey) {
        const keyHash = await getSyncKeyHash();
        if (keyHash) {
            headers.set('X-Sync-Key-Hash', keyHash);
        }
    }

    const { timeout = 15000, ...fetchOptions } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(endpoint, {
            ...fetchOptions,
            headers,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // 409 (Conflict) é tratado especificamente pela lógica de sincronização (cloud.ts),
        // então permitimos que ele passe sem lançar erro aqui.
        if (!response.ok && response.status !== 409) {
            let errorBody = '';
            // [2024-01-16] ROBUSTNESS: Try/Catch no parsing do corpo do erro.
            // Se a resposta não tiver corpo ou não for texto (ex: erro 500 fatal), 
            // response.text() poderia falhar e mascarar o erro original.
            try {
                errorBody = await response.text();
            } catch (e) {
                errorBody = '[No response body or failed to parse]';
            }
            
            console.error(`API request failed to ${endpoint}:`, errorBody);
            throw new Error(`API request failed with status ${response.status}: ${errorBody}`);
        }

        return response;
    } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error(`API request to ${endpoint} timed out after ${timeout}ms.`);
        }
        throw error;
    }
}
