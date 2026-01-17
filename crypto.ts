/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

const SALT = 'a-random-static-salt-for-the-habit-tracker-app'; // Um salt estático é aceitável para PBKDF2
const ITERATIONS = 100000; // Um número padrão de iterações para PBKDF2

// Helpers para conversão de string para ArrayBuffer e vice-versa
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Helpers de Base64 para ArrayBuffers
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Deriva uma chave criptográfica a partir da senha fornecida pelo usuário (syncKey).
 * @param password A string da syncKey.
 * @returns Uma CryptoKey adequada para AES-GCM.
 */
async function deriveKey(password: string): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode(SALT),
            iterations: ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Criptografa uma string usando AES-GCM.
 * @param data A string de texto simples a ser criptografada.
 * @param password A syncKey para derivar a chave de criptografia.
 * @returns Uma string JSON base64 contendo o IV e o texto cifrado.
 */
export async function encrypt(data: string, password: string): Promise<string> {
    const key = await deriveKey(password);
    const iv = crypto.getRandomValues(new Uint8Array(12)); // IV de 96 bits para AES-GCM
    const encodedData = encoder.encode(data);

    const ciphertext = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: iv,
        },
        key,
        encodedData
    );

    const encryptedPayload = {
        iv: arrayBufferToBase64(iv),
        ciphertext: arrayBufferToBase64(ciphertext),
    };

    return JSON.stringify(encryptedPayload);
}

/**
 * Decriptografa uma string que foi criptografada com AES-GCM.
 * @param encryptedData A string JSON base64 contendo IV e texto cifrado.
 * @param password A syncKey para derivar a chave de decriptografia.
 * @returns A string de texto simples original.
 */
export async function decrypt(encryptedData: string, password: string): Promise<string> {
    const key = await deriveKey(password);
    
    const payload = JSON.parse(encryptedData);
    const iv = base64ToArrayBuffer(payload.iv);
    const ciphertext = base64ToArrayBuffer(payload.ciphertext);

    const decrypted = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: iv,
        },
        key,
        ciphertext
    );

    return decoder.decode(decrypted);
}
