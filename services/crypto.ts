/**
 * @license
 * SPDX-License-Identifier: MIT
 * VERSÃO: AES-GCM com envelope versionado
 */

/**
 * @file services/crypto.ts
 * @description Fonte única de verdade para criptografia simétrica.
 *
 * FORMATO DO ENVELOPE (v2):
 *   MAGIC(4) | VERSION(1) | ITERATIONS(4, big-endian) | SALT(16) | IV(12) | CIPHERTEXT+TAG
 *
 * FORMATO LEGADO (v1, sem cabeçalho):
 *   SALT(16) | IV(12) | CIPHERTEXT+TAG        — sempre 100.000 iterações
 *
 * O número de iterações viaja dentro do envelope, então elevá-lo no futuro não
 * exige nova versão de formato nem migração: blobs antigos continuam legíveis
 * porque carregam o próprio custo de derivação.
 */

const SALT_LEN = 16;
const IV_LEN = 12;

/** "ASK2" — identifica o envelope v2. */
const MAGIC = Uint8Array.from([0x41, 0x53, 0x4b, 0x32]);
const VERSION_V2 = 2;
const HEADER_LEN = MAGIC.length + 1 + 4;

/** OWASP (2023+) para PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;

/** Custo do formato legado, fixo por definição. */
const LEGACY_ITERATIONS = 100_000;

/**
 * Teto defensivo: o contador de iterações vem de dados não confiáveis (o blob
 * remoto). Sem limite, um envelope forjado com 2^32 iterações travaria a aba.
 */
const MAX_ITERATIONS = 10_000_000;

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const exactSalt = new Uint8Array(salt);
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: exactSalt, iterations, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
}

/**
 * Base64 em blocos. `btoa(String.fromCharCode(...bytes))` estoura o limite de
 * argumentos da engine (RangeError) para payloads grandes — e o estado inteiro
 * do app, cifrado, chega lá com poucos anos de histórico.
 */
const B64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
    }
    return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
    const str = atob(base64);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes;
}

function hasV2Header(bytes: Uint8Array): boolean {
    if (bytes.length < HEADER_LEN + SALT_LEN + IV_LEN) return false;
    for (let i = 0; i < MAGIC.length; i++) {
        if (bytes[i] !== MAGIC[i]) return false;
    }
    return bytes[MAGIC.length] === VERSION_V2;
}

/**
 * Criptografa `text` produzindo sempre um envelope v2.
 */
export async function encrypt(text: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));

    const combined = new Uint8Array(HEADER_LEN + SALT_LEN + IV_LEN + encrypted.byteLength);
    combined.set(MAGIC, 0);
    combined[MAGIC.length] = VERSION_V2;
    new DataView(combined.buffer).setUint32(MAGIC.length + 1, PBKDF2_ITERATIONS, false);
    combined.set(salt, HEADER_LEN);
    combined.set(iv, HEADER_LEN + SALT_LEN);
    combined.set(new Uint8Array(encrypted), HEADER_LEN + SALT_LEN + IV_LEN);

    return bytesToBase64(combined);
}

async function decryptV2(bytes: Uint8Array, password: string): Promise<string> {
    const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getUint32(MAGIC.length + 1, false);
    if (iterations < 1 || iterations > MAX_ITERATIONS) {
        throw new Error(`decrypt: iteration count out of range (${iterations})`);
    }

    const salt = bytes.slice(HEADER_LEN, HEADER_LEN + SALT_LEN);
    const iv = bytes.slice(HEADER_LEN + SALT_LEN, HEADER_LEN + SALT_LEN + IV_LEN);
    const data = bytes.slice(HEADER_LEN + SALT_LEN + IV_LEN);

    const key = await deriveKey(password, salt, iterations);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(decrypted);
}

async function decryptLegacy(bytes: Uint8Array, password: string): Promise<string> {
    const minLength = SALT_LEN + IV_LEN + 1;
    if (bytes.length < minLength) {
        throw new Error(`decrypt: ciphertext too short (${bytes.length} < ${minLength})`);
    }

    const salt = bytes.slice(0, SALT_LEN);
    const iv = bytes.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const data = bytes.slice(SALT_LEN + IV_LEN);

    const key = await deriveKey(password, salt, LEGACY_ITERATIONS);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(decrypted);
}

/**
 * Descriptografa envelopes v2 e legados (v1) de forma transparente.
 */
export async function decrypt(encryptedBase64: string, password: string): Promise<string> {
    if (!encryptedBase64 || typeof encryptedBase64 !== 'string') {
        throw new Error('decrypt: invalid input — expected non-empty base64 string');
    }
    if (!password || typeof password !== 'string') {
        throw new Error('decrypt: invalid password');
    }

    let bytes: Uint8Array;
    try {
        bytes = base64ToBytes(encryptedBase64);
    } catch {
        throw new Error('decrypt: malformed base64 input');
    }

    if (!hasV2Header(bytes)) {
        return decryptLegacy(bytes, password);
    }

    try {
        return await decryptV2(bytes, password);
    } catch (error) {
        // Um salt legado aleatório tem ~2^-40 de chance de imitar MAGIC+VERSION.
        // Improvável, mas o AES-GCM é autenticado: a leitura errada falha de forma
        // limpa, então o fallback é seguro e torna a detecção inequívoca.
        try {
            return await decryptLegacy(bytes, password);
        } catch {
            throw error;
        }
    }
}
