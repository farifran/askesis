/**
 * @license SPDX-License-Identifier: Apache-2.0
 * @file services/crypto.ts
 * @description Criptografia AES-GCM Zero-Copy / Zero-Allocation (Binary Protocol).
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '../utils';

const ITERATIONS = 100000;
const SALT_LEN = 16;
const IV_LEN = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- FUNÇÕES CORE DE CRIPTOGRAFIA ---

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
}

/**
 * [ZERO-COST OUTPUT]
 * Retorna um Uint8Array contendo [SALT (16b) + IV (12b) + CIPHERTEXT].
 * Elimina 33% de overhead de Base64 e JSON.stringification na camada de criptografia.
 */
export async function encrypt(data: string | ArrayBuffer | Uint8Array, password: string): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(password, salt);
    
    let dataBuffer: BufferSource = typeof data === 'string' ? encoder.encode(data) : data;

    const encryptedContent = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataBuffer);

    // ALOCAÇÃO ÚNICA: Cria o buffer final do tamanho exato
    const result = new Uint8Array(SALT_LEN + IV_LEN + encryptedContent.byteLength);
    
    // Memory copy ultra-rápido
    result.set(salt, 0);
    result.set(iv, SALT_LEN);
    result.set(new Uint8Array(encryptedContent), SALT_LEN + IV_LEN);
    
    return result;
}

export async function decryptToBuffer(data: ArrayBuffer | Uint8Array | string, password: string): Promise<ArrayBuffer> {
    // SUPORTE LEGADO (Migração suave): Se for string, assume formato antigo JSON/Base64
    if (typeof data === 'string') {
        try {
            const legacy = JSON.parse(data);
            return await _legacyDecrypt(legacy, password);
        } catch { throw new Error("Formato inválido"); }
    }

    // PROTOCOLO BINÁRIO V8
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    
    // Fatiamento Zero-Copy (Subarray cria views, não cópias)
    const salt = input.subarray(0, SALT_LEN);
    const iv = input.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const ciphertext = input.subarray(SALT_LEN + IV_LEN);

    const key = await deriveKey(password, salt);

    try {
        return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    } catch (e) {
        throw new Error("Decryption failed. Bad Key or Corrupted Data.");
    }
}

// Helper para manter compatibilidade com dados antigos durante a transição
async function _legacyDecrypt(legacy: any, password: string): Promise<ArrayBuffer> {
    const salt = base64ToArrayBuffer(legacy.salt);
    const iv = base64ToArrayBuffer(legacy.iv);
    const encrypted = base64ToArrayBuffer(legacy.encrypted);
    const key = await deriveKey(password, new Uint8Array(salt));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
}

export async function decrypt(data: ArrayBuffer | string, password: string): Promise<string> {
    const buffer = await decryptToBuffer(data, password);
    return decoder.decode(buffer);
}