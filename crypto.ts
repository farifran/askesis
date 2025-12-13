
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

const ITERATIONS = 100000; // Um número padrão de iterações para PBKDF2

// Helpers para conversão de string para ArrayBuffer e vice-versa
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Helpers de Base64 para ArrayBuffers
/**
 * OTIMIZAÇÃO DE PERFORMANCE [2024-12-26]: A conversão de ArrayBuffer para Base64 foi refatorada.
 * A implementação anterior, que concatenava caracteres em um loop, era ineficiente para dados maiores.
 * A nova versão processa os dados em "chunks" (pedaços), usando `String.fromCharCode` com o operador spread
 * em subarrays. Isso é significativamente mais rápido e previne erros de "Maximum call stack size exceeded"
 * que poderiam ocorrer com estados de aplicação muito grandes.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const CHUNK_SIZE = 8192; // Tamanho de pedaço comum para evitar estouro de pilha
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        // Usar o operador spread é mais moderno e legível que .apply
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
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
 * Deriva uma chave criptográfica a partir da senha fornecida pelo usuário (syncKey) e de um salt.
 * ARQUITETURA [2024-10-18]: Utiliza PBKDF2 (Password-Based Key Derivation Function 2) para "esticar" a chave de sincronização.
 * Isso torna ataques de força bruta significativamente mais lentos e computacionalmente caros,
 * protegendo os dados do usuário mesmo que a chave seja relativamente simples.
 * @param password A string da syncKey.
 * @param salt O salt a ser usado na derivação da chave.
 * @returns Uma CryptoKey adequada para AES-GCM.
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
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
            salt: salt,
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
 * @returns Uma string JSON base64 contendo o salt, o IV e o texto cifrado.
 */
export async function encrypt(data: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    
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

    // Empacota o salt, o IV e o texto cifrado juntos para armazenamento/transmissão.
    // O IV e o salt são necessários para a decriptografia e não precisam ser secretos.
    const combined = {
        salt: arrayBufferToBase64(salt),
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
export async function decrypt(encryptedDataJSON: string, password: string): Promise<string> {
    try {
        // [2025-01-16] ROBUSTEZ: O parsing do JSON e conversão de buffers foram movidos para dentro do bloco try/catch.
        // Isso garante que se o payload estiver corrompido (JSON inválido ou base64 malformado),
        // o erro seja capturado corretamente e tratado como falha de descriptografia,
        // em vez de lançar uma exceção não tratada.
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
        // CORREÇÃO DE SEGURANÇA [2024-10-18]: A falha na decriptografia geralmente indica uma chave incorreta ou
        // dados adulterados. Lançar um erro claro aqui permite que a lógica de chamada
        // (ex: `fetchStateFromCloud`) lide com o erro de forma apropriada, como solicitando ao usuário
        // que insira a chave correta novamente.
        console.error("Decryption or Parsing failed:", e);
        throw new Error("Decryption failed. The sync key may be incorrect or the data corrupted.");
    }
}
