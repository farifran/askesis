
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
 * DEPENDÊNCIAS CRÍTICAS:
 * - `crypto.subtle`: Requer contexto seguro (HTTPS/localhost).
 * - `utils.ts`: Utilitários de codificação Base64.
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
 * 
 * ZERO-COPY OPTIMIZATION: Se 'data' for ArrayBuffer ou Uint8Array, ele é passado diretamente
 * para o motor criptográfico, evitando a conversão dispendiosa para string UTF-8.
 * 
 * @param data A string ou buffer a ser criptografado.
 * @param password A senha usada para derivar a chave.
 * @returns Uma string JSON contendo o salt, IV e os dados criptografados em Base64.
 */
export async function encrypt(data: string | ArrayBuffer | Uint8Array, password: string): Promise<string> {
    // SECURITY: Gera Salt e IV aleatórios a cada criptografia.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    
    const iv = crypto.getRandomValues(new Uint8Array(12)); // IV de 12 bytes é recomendado para AES-GCM (96 bits).
    
    // PREPARE DATA: Avoid GC if possible
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

    // Combina o salt, IV e os dados criptografados em um único objeto para armazenamento.
    const combined = {
        salt: arrayBufferToBase64(salt),
        iv: arrayBufferToBase64(iv),
        encrypted: arrayBufferToBase64(encrypted),
    };
    
    return JSON.stringify(combined);
}

/**
 * Descriptografa uma string JSON para um ArrayBuffer bruto.
 * Útil para recuperar dados binários (como Bitmasks ou GZIP) sem forçar decode para string.
 * 
 * @param encryptedDataJSON A string JSON contendo salt, IV e dados criptografados.
 * @param password A senha usada para derivar a chave.
 * @returns O ArrayBuffer descriptografado.
 */
export async function decryptToBuffer(encryptedDataJSON: string, password: string): Promise<ArrayBuffer> {
    try {
        const { salt: saltBase64, iv: ivBase64, encrypted: encryptedBase64 } = JSON.parse(encryptedDataJSON);

        const salt = base64ToArrayBuffer(saltBase64);
        // CRITICAL LOGIC: Recria a mesma chave usando o Salt armazenado.
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
        return decrypted;
    } catch (e) {
        console.error("Decryption or Parsing failed:", e);
        throw new Error("Decryption failed. The sync key may be incorrect or the data corrupted.");
    }
}

/**
 * Descriptografa uma string JSON e retorna como String UTF-8.
 * Wrapper de compatibilidade sobre `decryptToBuffer`.
 * 
 * @param encryptedDataJSON A string JSON.
 * @param password A senha.
 * @returns A string original.
 */
export async function decrypt(encryptedDataJSON: string, password: string): Promise<string> {
    const buffer = await decryptToBuffer(encryptedDataJSON, password);
    return decoder.decode(buffer);
}
