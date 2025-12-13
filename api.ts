
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// UPDATE [2025-01-17]: Adicionada lógica de retry com backoff exponencial para maior robustez em rede.

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
    // MANUTENIBILIDADE [2024-01-16]: Limpa o cache de hash sempre que a chave muda para garantir consistência.
    keyHashCache = null; 
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
    
    // ROBUSTEZ: crypto.subtle requer um contexto seguro (HTTPS ou localhost).
    // Em um PWA instalado, isso é garantido, mas adicionamos verificação para ambientes de dev.
    if (!crypto.subtle) {
        console.warn("crypto.subtle not available. Ensure you are running on localhost or HTTPS.");
        return '';
    }

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
    retries?: number; // Número máximo de tentativas
    backoff?: number; // Delay inicial em ms
}

/**
 * Wrapper for the fetch API that includes the sync key hash, handles timeouts,
 * and implements exponential backoff retry logic for robust networking.
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

    const { 
        timeout = 15000, 
        retries = 2, // Padrão: tenta 3 vezes no total (1 inicial + 2 retries)
        backoff = 500, // Padrão: espera 500ms antes do primeiro retry
        ...fetchOptions 
    } = options;

    const attemptFetch = async (attempt: number): Promise<Response> => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(endpoint, {
                ...fetchOptions,
                headers,
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            // Lógica de Retry para erros de servidor (5xx) ou falhas de rede.
            // Erros de cliente (4xx) geralmente não devem ser retentados (exceto talvez 408/429, mas simplificamos aqui).
            // 409 (Conflict) é uma resposta válida de lógica de negócios para sync, então retornamos.
            if (!response.ok && response.status !== 409 && response.status >= 500 && attempt < retries) {
                throw new Error(`Server error ${response.status}`);
            }
            
            // Se for um erro não recuperável (4xx) ou se acabaram as tentativas, processamos o erro.
            if (!response.ok && response.status !== 409) {
                let errorBody = '';
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
            
            const isAbortError = error.name === 'AbortError';
            const isNetworkError = error instanceof TypeError || error.message.includes('Server error'); // TypeError geralmente é erro de rede no fetch

            if (attempt < retries && (isAbortError || isNetworkError)) {
                const delay = backoff * Math.pow(2, attempt); // Backoff exponencial: 500, 1000, 2000...
                console.warn(`API attempt ${attempt + 1} failed. Retrying in ${delay}ms...`, error);
                await new Promise(resolve => setTimeout(resolve, delay));
                return attemptFetch(attempt + 1);
            }

            if (isAbortError) {
                throw new Error(`API request to ${endpoint} timed out after ${timeout}ms.`);
            }
            throw error;
        }
    };

    return attemptFetch(0);
}
