/**
 * @license
 * SPDX-License-Identifier: MIT
 * VERSÃO: AES-GCM com envelope versionado
 */

/**
 * @file services/crypto.ts
 * @description Fonte única de verdade para criptografia simétrica.
 *
 * FORMATO DO ENVELOPE (v3, atual):
 *   MAGIC(4) | VERSION(1) | FLAGS(1) | ITERATIONS(4, big-endian) | SALT(16) | IV(12) | CIPHERTEXT+TAG
 *
 * FORMATO v2:
 *   MAGIC(4) | VERSION(1) | ITERATIONS(4, big-endian) | SALT(16) | IV(12) | CIPHERTEXT+TAG
 *
 * FORMATO LEGADO (v1, sem cabeçalho):
 *   SALT(16) | IV(12) | CIPHERTEXT+TAG        — sempre 100.000 iterações
 *
 * O número de iterações viaja dentro do envelope, então elevá-lo no futuro não
 * exige nova versão de formato nem migração: blobs antigos continuam legíveis
 * porque carregam o próprio custo de derivação.
 *
 * COMPRESSÃO (v3): quando FLAG_GZIP está ligado, o plaintext foi comprimido com
 * gzip ANTES de ser cifrado. Comprimir depois é inútil — ciphertext é ruído. O
 * ganho é grande porque os shards são JSON repetitivo: o shard `core` cai de
 * ~105 KB para ~1,7 KB na rede (ver ADR-0007).
 *
 * Comprimir-e-depois-cifrar faz o tamanho do ciphertext variar com a entropia do
 * plaintext. CRIME/BREACH exigem que um atacante injete plaintext escolhido no
 * mesmo contexto de compressão; aqui todo o conteúdo é do próprio usuário e não
 * há canal de injeção. O servidor já observava os tamanhos antes disto.
 */

import { bytesToBase64, base64ToBytes } from './base64';
import { canCompress, gzipBytes, gunzipBytes } from './compression';

const SALT_LEN = 16;
const IV_LEN = 12;

/** "ASK2" — identifica os envelopes com cabeçalho (v2 e v3). */
const MAGIC = Uint8Array.from([0x41, 0x53, 0x4b, 0x32]);
const VERSION_V2 = 2;
const VERSION_V3 = 3;
const HEADER_LEN_V2 = MAGIC.length + 1 + 4;
const HEADER_LEN_V3 = MAGIC.length + 1 + 1 + 4;

/** FLAGS do v3. Bit 0: plaintext comprimido com gzip. */
const FLAG_GZIP = 0x01;

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
 * Lê a versão do envelope com cabeçalho. Devolve `null` para o formato legado v1
 * (que não tem cabeçalho) e para qualquer coisa curta demais para ser um envelope.
 */
function readEnvelopeVersion(bytes: Uint8Array): 2 | 3 | null {
    if (bytes.length < MAGIC.length + 1) return null;
    for (let i = 0; i < MAGIC.length; i++) {
        if (bytes[i] !== MAGIC[i]) return null;
    }

    const version = bytes[MAGIC.length];
    if (version === VERSION_V2 && bytes.length >= HEADER_LEN_V2 + SALT_LEN + IV_LEN) return 2;
    if (version === VERSION_V3 && bytes.length >= HEADER_LEN_V3 + SALT_LEN + IV_LEN) return 3;
    return null;
}

/**
 * Comprime quando compensa. O gzip tem ~20 bytes de cabeçalho, então payloads
 * minúsculos (um shard de logs recém-criado) ficariam maiores — nesses casos o
 * flag sai desligado e o plaintext viaja cru.
 */
async function compressIfSmaller(raw: Uint8Array<ArrayBuffer>): Promise<{ bytes: BufferSource; gzipped: boolean }> {
    if (!canCompress()) return { bytes: raw, gzipped: false };

    try {
        const gzipped = await gzipBytes(raw);
        if (gzipped.length < raw.length) return { bytes: gzipped, gzipped: true };
    } catch {
        // Compressão é otimização: falhar aqui não pode impedir o save.
    }
    return { bytes: raw, gzipped: false };
}

/**
 * Criptografa `text` produzindo sempre um envelope v3, comprimido quando vale.
 */
export async function encrypt(text: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

    const { bytes: payload, gzipped } = await compressIfSmaller(new TextEncoder().encode(text));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);

    const combined = new Uint8Array(HEADER_LEN_V3 + SALT_LEN + IV_LEN + encrypted.byteLength);
    combined.set(MAGIC, 0);
    combined[MAGIC.length] = VERSION_V3;
    combined[MAGIC.length + 1] = gzipped ? FLAG_GZIP : 0;
    new DataView(combined.buffer).setUint32(MAGIC.length + 2, PBKDF2_ITERATIONS, false);
    combined.set(salt, HEADER_LEN_V3);
    combined.set(iv, HEADER_LEN_V3 + SALT_LEN);
    combined.set(new Uint8Array(encrypted), HEADER_LEN_V3 + SALT_LEN + IV_LEN);

    return bytesToBase64(combined);
}

function readIterations(bytes: Uint8Array, offset: number): number {
    const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
    if (iterations < 1 || iterations > MAX_ITERATIONS) {
        throw new Error(`decrypt: iteration count out of range (${iterations})`);
    }
    return iterations;
}

async function decryptHeadered(bytes: Uint8Array, password: string, headerLen: number): Promise<ArrayBuffer> {
    const iterations = readIterations(bytes, headerLen - 4);

    const salt = bytes.slice(headerLen, headerLen + SALT_LEN);
    const iv = bytes.slice(headerLen + SALT_LEN, headerLen + SALT_LEN + IV_LEN);
    const data = bytes.slice(headerLen + SALT_LEN + IV_LEN);

    const key = await deriveKey(password, salt, iterations);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}

async function decryptV3(bytes: Uint8Array, password: string): Promise<string> {
    const flags = bytes[MAGIC.length + 1];
    const plain = await decryptHeadered(bytes, password, HEADER_LEN_V3);

    if ((flags & FLAG_GZIP) === 0) return new TextDecoder().decode(plain);
    if (!canCompress()) {
        throw new Error('decrypt: envelope comprimido e Compression Streams indisponível neste navegador');
    }
    return new TextDecoder().decode(await gunzipBytes(plain));
}

async function decryptV2(bytes: Uint8Array, password: string): Promise<string> {
    return new TextDecoder().decode(await decryptHeadered(bytes, password, HEADER_LEN_V2));
}

/**
 * DEPRECIADO — formato v1 (100k iterações, sem cabeçalho).
 *
 * Introduzido antes de 2026-08-01; o envelope v2 entrou em produção nessa data e
 * o v3 em 2026-08-02. Todo save regrava na versão atual, então os blobs v1
 * desaparecem conforme os dispositivos ressincronizam.
 *
 * CRITÉRIO DE REMOÇÃO (não é prazo de calendário): remover quando for razoável
 * assumir que todos os dispositivos ativos já ressincronizaram ao menos uma vez
 * — na prática, alguns meses após 2026-08-01. Remover cedo demais deixa
 * ilegíveis os dados de quem ficou offline no intervalo, sem recuperação
 * possível: a chave deriva no cliente e o servidor só guarda ciphertext.
 *
 * EVIDÊNCIA: o aviso abaixo é a única sinalização disponível — não há telemetria
 * por decisão de privacidade. Se ninguém vir esse warning no console por um
 * período longo, é o sinal de que o caminho pode cair.
 */
let _warnedLegacy = false;

async function decryptLegacy(bytes: Uint8Array, password: string): Promise<string> {
    // Uma vez por sessão: o sync percorre vários shards e repetir por blob só
    // geraria ruído. `console` direto mantém crypto.ts sem dependências (ele é
    // isomórfico e roda também dentro do Web Worker).
    if (!_warnedLegacy) {
        _warnedLegacy = true;
        console.warn('[crypto] Envelope v1 (depreciado) em uso. Será regravado em v3 no próximo save.');
    }

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
 * Descriptografa envelopes v3, v2 e legados (v1) de forma transparente.
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

    const version = readEnvelopeVersion(bytes);
    if (version === null) {
        return decryptLegacy(bytes, password);
    }

    try {
        return version === 3 ? await decryptV3(bytes, password) : await decryptV2(bytes, password);
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
