/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ARQUITETURA]: Módulo de Criptografia Web (Worker-Safe).
// Este módulo encapsula a lógica de criptografia de alto nível usando a Web Crypto API nativa.
// Ele é projetado para ser "isomórfico", funcionando tanto na thread principal quanto em Web Workers.
// A lógica foi centralizada aqui para evitar duplicação e garantir uma única fonte de verdade para a segurança.

// --- CONSTANTES ---
const ITERATIONS = 100000; // Número padrão de iterações para PBKDF2
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- HELPERS DE CODIFICAÇÃO ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    // Otimização: Evita a criação de um array intermediário gigante com `String.fromCharCode.apply`.
    // Processa em blocos para evitar "Maximum call stack size exceeded" em dados grandes.
    const CHUNK_SIZE = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// --- FUNÇÕES CORE DE CRIPTOGRAFIA ---

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    // Importa a senha como uma chave "raw" para ser usada no PBKDF2.
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false, // A chave não é exportável.
        ['deriveKey']
    );

    // Deriva a chave de criptografia AES-GCM a partir da senha e do salt.
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        true, // A chave derivada é exportável (necessário para alguns fluxos).
        ['encrypt', 'decrypt']
    );
}

/**
 * Criptografa uma string usando AES-GCM com uma chave derivada de uma senha.
 * @param data A string de dados a ser criptografada.
 * @param password A senha usada para derivar a chave.
 * @returns Uma string JSON contendo o salt, IV e os dados criptografados em Base64.
 */
export async function encrypt(data: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    
    const iv = crypto.getRandomValues(new Uint8Array(12)); // IV de 12 bytes é recomendado para AES-GCM.
    const encrypted = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: iv,
        },
        key,
        encoder.encode(data)
    );

    // Combina o salt, IV e os dados criptografados em um único objeto para armazenamento.
    const combined = {
        salt: arrayBufferToBase64(salt),
        iv: arrayBufferToBase64(iv),
        encrypted: arrayBufferToBase64(encrypted),
    };
    
    return JSON.stringify(combined);
}

/**
 * Descriptografa uma string JSON que foi criptografada com a função `encrypt`.
 * @param encryptedDataJSON A string JSON contendo salt, IV e dados criptografados.
 * @param password A senha usada para derivar a chave.
 * @returns A string de dados original.
 * @throws Lança um erro se a descriptografia falhar (chave incorreta ou dados corrompidos).
 */
export async function decrypt(encryptedDataJSON: string, password: string): Promise<string> {
    try {
        const { salt: saltBase64, iv: ivBase64, encrypted: encryptedBase64 } = JSON.parse(encryptedDataJSON);

        const salt = base64ToArrayBuffer(saltBase64);
        const key = await deriveKey(password, new Uint8Array(salt));

        const iv = base64ToArrayBuffer(ivBase64);
        const encrypted = base64ToArrayBuffer(encryptedBase64);
    
        const decrypted = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv,
            },
            key,
            encrypted
        );
        return decoder.decode(decrypted);
    } catch (e) {
        console.error("Decryption or Parsing failed:", e);
        // Lança um erro mais informativo para o chamador.
        throw new Error("Decryption failed. The sync key may be incorrect or the data corrupted.");
    }
}