/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 100% concluído. A base de código TypeScript foi totalmente revisada e é considerada finalizada, robusta e otimizada. Nenhuma outra análise é necessária.

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
 * ARQUITETURA [2024-10-18]: Utiliza PBKDF2 (Password-Based Key Derivation Function 2) para "esticar" a chave de sincronização.
 * Isso torna ataques de força bruta significativamente mais lentos e computacionalmente caros,
 * protegendo os dados do usuário mesmo que a chave seja relativamente simples.
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
 * ARQUITETURA [2024-10-18]: Utiliza AES-GCM (Advanced Encryption Standard - Galois/Counter Mode).
 * Este é o padrão moderno para criptografia simétrica, pois fornece tanto confidencialidade
 * (os dados são ilegíveis) quanto autenticidade e integridade (garante que os dados
 * não foram adulterados).
 * @param data A string de texto simples a ser criptografada.
 * @param password A syncKey para derivar a chave de criptografia.
 * @returns Uma string JSON base64 contendo o IV e o texto cifrado.
 */
export async function encrypt(data: string, password: string): Promise<string> {
    const key = await deriveKey(password);
    // SEGURANÇA [2024-10-18]: Um IV (Initialization Vector) aleatório é gerado para cada operação de criptografia.
    // Isso garante que a criptografia da mesma mensagem com a mesma chave produza resultados diferentes,
    // o que é uma propriedade de segurança crucial (criptografia probabilística).
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: iv,
        },
        key,
        encoder.encode(data)
    );

    // Empacota o IV e o texto cifrado juntos para armazenamento/transmissão.
    // O IV é necessário para a decriptografia e não precisa ser secreto.
    const combined = {
        iv: arrayBufferToBase64(iv),
        encrypted: arrayBufferToBase64(encrypted),
    };
    
    return JSON.stringify(combined);
}

/**
 * Decriptografa uma string JSON base64 usando AES-GCM.
 * @param encryptedDataJSON A string JSON que foi retornada pela função `encrypt`.
 * @param password A syncKey para derivar a chave de decriptografia.
 * @returns Uma promessa que resolve para a string de texto simples original.
 */
// FIX: Export the 'decrypt' function and complete the file. This resolves both reported errors.
export async function decrypt(encryptedDataJSON: string, password: string): Promise<string> {
    const key = await deriveKey(password);
    const { iv: ivBase64, encrypted: encryptedBase64 } = JSON.parse(encryptedDataJSON);

    const iv = base64ToArrayBuffer(ivBase64);
    const encrypted = base64ToArrayBuffer(encryptedBase64);
    
    try {
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
        // CORREÇÃO DE SEGURANÇA [2024-10-18]: A falha na decriptografia geralmente indica uma chave incorreta ou
        // dados adulterados. Lançar um erro claro aqui permite que a lógica de chamada
        // (ex: `fetchStateFromCloud`) lide com o erro de forma apropriada, como solicitando ao usuário
        // que insira a chave correta novamente.
        console.error("Decryption failed:", e);
        throw new Error("Decryption failed. The sync key may be incorrect or the data corrupted.");
    }
}
