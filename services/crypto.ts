/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/crypto.ts
 * @description Primitivas de Criptografia Isomórficas (Web Crypto API Wrapper).
 * 
 * [ISOMORPHIC CONTEXT]:
 * Este módulo é seguro para execução tanto na Main Thread quanto em Web Workers.
 * 
 * ARQUITETURA (Security & Performance):
 * - **Responsabilidade Única:** Prover criptografia autenticada (AES-GCM) derivada de senha (PBKDF2).
 * - **Zero Dependencies:** Utiliza exclusivamente a `crypto.subtle` nativa do navegador.
 * - **Zero-Copy Support:** Suporta encriptação direta de ArrayBuffers para evitar overhead de string em dados binários.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **PBKDF2 com 100k iterações:** Balanceamento entre segurança contra força bruta e performance em dispositivos móveis.
 * 2. **AES-GCM:** Escolhido por prover confidencialidade e integridade (autenticação) simultaneamente.
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '../utils';

// --- CONSTANTES ---
// CRITICAL LOGIC: Alterar estes parâmetros tornará dados antigos ilegíveis.
// DO NOT REFACTOR: 100.000 iterações é o padrão OWASP recomendado para performance/segurança web.
const ITERATIONS = 100000; 
const SALT_BYTES = 16;
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    // CRITICAL LOGIC: A combinação Salt + Senha + Iterações deve ser exata para regenerar a chave.
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
 * Criptografa dados (string ou binário) usando AES-GCM com uma chave derivada de uma senha.
 * Retorna um único buffer binário no formato [SALT (16b)][IV (12b)][CIPHERTEXT (...)].
 * 
 * ZERO-COPY OPTIMIZATION: Se 'data' for ArrayBuffer ou Uint8Array, ele é passado diretamente
 * para o motor criptográfico, evitando a conversão dispendiosa para string UTF-8.
 * 
 * @param data A string ou buffer a ser criptografado.
 * @param password A senha usada para derivar a chave.
 * @returns Um Uint8Array contendo os dados criptografados concatenados.
 */
export async function encrypt(data: string | ArrayBuffer | Uint8Array, password: string): Promise<Uint8Array> {
    // SECURITY: Gera Salt e IV aleatórios a cada criptografia.
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await deriveKey(password, salt);
    
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES)); // IV de 12 bytes é recomendado para AES-GCM (96 bits).
    
    let dataBuffer: BufferSource;
    if (typeof data === 'string') {
        dataBuffer = encoder.encode(data);
    } else {
        dataBuffer = data;
    }

    const encrypted = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: iv,
        },
        key,
        dataBuffer
    );

    // Concatena [SALT][IV][CIPHERTEXT] em um único buffer.
    const combined = new Uint8Array(SALT_BYTES + IV_BYTES + encrypted.byteLength);
    combined.set(salt, 0);
    combined.set(iv, SALT_BYTES);
    combined.set(new Uint8Array(encrypted), SALT_BYTES + IV_BYTES);
    
    return combined;
}

/**
 * Descriptografa um buffer binário concatenado para um ArrayBuffer bruto.
 * Útil para recuperar dados binários (como Bitmasks ou GZIP) sem forçar decode para string.
 * 
 * @param encryptedData O buffer concatenado [SALT][IV][CIPHERTEXT].
 * @param password A senha usada para derivar a chave.
 * @returns O ArrayBuffer descriptografado.
 */
export async function decryptToBuffer(encryptedData: Uint8Array, password: string): Promise<ArrayBuffer> {
    try {
        // Extrai os componentes do buffer concatenado.
        const salt = encryptedData.slice(0, SALT_BYTES);
        const iv = encryptedData.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
        const encrypted = encryptedData.slice(SALT_BYTES + IV_BYTES);

        // CRITICAL LOGIC: Recria a mesma chave usando o Salt armazenado.
        const key = await deriveKey(password, salt);
    
        const decrypted = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv,
            },
            key,
            encrypted
        );
        return decrypted;
    } catch (e) {
        console.error("Decryption failed:", e);
        throw new Error("Decryption failed. The sync key may be incorrect or the data corrupted.");
    }
}

/**
 * Descriptografa um buffer binário e retorna como String UTF-8.
 * Wrapper de compatibilidade sobre `decryptToBuffer`.
 * 
 * @param encryptedData O buffer binário concatenado.
 * @param password A senha.
 * @returns A string original.
 */
export async function decrypt(encryptedData: Uint8Array, password: string): Promise<string> {
    const buffer = await decryptToBuffer(encryptedData, password);
    return decoder.decode(buffer);
}
