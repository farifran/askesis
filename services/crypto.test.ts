/**
 * @file services/crypto.test.ts
 * @description Testes para o módulo de criptografia AES-GCM.
 * P0 - Crítico: Perda de dados se encrypt/decrypt falhar.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, bytesToBase64, PBKDF2_ITERATIONS } from './crypto';

/**
 * Reproduz o formato legado (v1): SALT(16) | IV(12) | CIPHERTEXT, 100k iterações,
 * sem cabeçalho. Serve para garantir que dados já sincronizados na nuvem antes da
 * introdução do envelope versionado continuem legíveis.
 */
async function encryptLegacyV1(text: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyMaterial = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    const combined = new Uint8Array(16 + 12 + encrypted.byteLength);
    combined.set(salt);
    combined.set(iv, 16);
    combined.set(new Uint8Array(encrypted), 28);
    return bytesToBase64(combined);
}

describe('🔐 Criptografia AES-GCM (crypto.ts)', () => {

    describe('Roundtrip encrypt → decrypt', () => {
        it('deve criptografar e descriptografar texto simples', async () => {
            const plaintext = 'Hábito concluído com sucesso!';
            const password = 'minha-senha-segura-123';

            const encrypted = await encrypt(plaintext, password);
            const decrypted = await decrypt(encrypted, password);

            expect(decrypted).toBe(plaintext);
        });

        it('deve funcionar com texto vazio', async () => {
            const encrypted = await encrypt('', 'senha');
            const decrypted = await decrypt(encrypted, 'senha');
            expect(decrypted).toBe('');
        });

        it('deve funcionar com caracteres especiais e emojis', async () => {
            const text = '🏛️ Ἄσκησις — "treinamento" (ação & reflexão) <script>alert("xss")</script>';
            const password = 'p@$$w0rd!#€';

            const encrypted = await encrypt(text, password);
            const decrypted = await decrypt(encrypted, password);

            expect(decrypted).toBe(text);
        });

        it('deve funcionar com texto longo (5 anos de dados simulados)', async () => {
            const longText = JSON.stringify({
                habits: Array.from({ length: 50 }, (_, i) => ({
                    id: `habit-${i}`,
                    data: 'x'.repeat(1000)
                }))
            });

            const encrypted = await encrypt(longText, 'long-password');
            const decrypted = await decrypt(encrypted, 'long-password');

            expect(decrypted).toBe(longText);
        });

        it('deve funcionar com caracteres Unicode multibyte', async () => {
            const text = '日本語テスト 中文测试 العربية тест';
            const password = 'unicode-password';

            const encrypted = await encrypt(text, password);
            const decrypted = await decrypt(encrypted, password);

            expect(decrypted).toBe(text);
        });
    });

    describe('Propriedades criptográficas', () => {
        it('deve produzir outputs diferentes para o mesmo input (salt/iv aleatórios)', async () => {
            const text = 'mesmo texto';
            const password = 'mesma-senha';

            const encrypted1 = await encrypt(text, password);
            const encrypted2 = await encrypt(text, password);

            // Salt e IV aleatórios garantem outputs diferentes
            expect(encrypted1).not.toBe(encrypted2);

            // Ambos devem descriptografar corretamente
            expect(await decrypt(encrypted1, password)).toBe(text);
            expect(await decrypt(encrypted2, password)).toBe(text);
        });

        it('deve produzir output Base64 válido', async () => {
            const encrypted = await encrypt('teste', 'senha');
            // Base64 regex
            expect(encrypted).toMatch(/^[A-Za-z0-9+/]+=*$/);
        });

        it('output deve ter tamanho mínimo (SALT + IV + dados)', async () => {
            const encrypted = await encrypt('a', 'b');
            const bytes = atob(encrypted);
            // SALT(16) + IV(12) + pelo menos 1 byte de dados cifrados + tag GCM(16)
            expect(bytes.length).toBeGreaterThanOrEqual(16 + 12 + 1 + 16);
        });
    });

    describe('Envelope versionado e retrocompatibilidade', () => {
        it('deve usar 600.000 iterações (recomendação OWASP)', () => {
            expect(PBKDF2_ITERATIONS).toBe(600_000);
        });

        it('deve descriptografar blobs no formato legado v1 (100k iterações, sem cabeçalho)', async () => {
            const text = 'dados sincronizados antes da migração';
            const password = 'senha-antiga';

            const legacyBlob = await encryptLegacyV1(text, password);
            expect(await decrypt(legacyBlob, password)).toBe(text);
        });

        it('deve rejeitar blob legado com senha errada em vez de aceitar silenciosamente', async () => {
            const legacyBlob = await encryptLegacyV1('segredo', 'senha-certa');
            await expect(decrypt(legacyBlob, 'senha-errada')).rejects.toThrow();
        });

        it('deve gravar o cabeçalho v2 (MAGIC "ASK2" + versão + iterações)', async () => {
            const encrypted = await encrypt('teste', 'senha');
            const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));

            expect(Array.from(bytes.slice(0, 4))).toEqual([0x41, 0x53, 0x4b, 0x32]);
            expect(bytes[4]).toBe(2);

            const iterations = new DataView(bytes.buffer).getUint32(5, false);
            expect(iterations).toBe(PBKDF2_ITERATIONS);
        });

        it('deve rejeitar envelope forjado com contagem de iterações abusiva (DoS)', async () => {
            const encrypted = await encrypt('teste', 'senha');
            const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
            new DataView(bytes.buffer).setUint32(5, 0xffffffff, false);

            await expect(decrypt(bytesToBase64(bytes), 'senha')).rejects.toThrow(/out of range/);
        });
    });

    describe('Payloads grandes', () => {
        it('deve cifrar payload de ~2MB sem estourar a pilha de argumentos', async () => {
            // `btoa(String.fromCharCode(...bytes))` lança RangeError nessa ordem de
            // grandeza; a codificação em blocos precisa segurar o caso.
            const bigText = 'x'.repeat(2_000_000);

            const encrypted = await encrypt(bigText, 'senha');
            expect(await decrypt(encrypted, 'senha')).toBe(bigText);
        });
    });

    describe('Segurança: Falhas de descriptografia', () => {
        it('deve falhar com senha incorreta', async () => {
            const encrypted = await encrypt('dados secretos', 'senha-correta');

            await expect(decrypt(encrypted, 'senha-errada')).rejects.toThrow();
        });

        it('deve falhar com dados corrompidos (bit flip)', async () => {
            const encrypted = await encrypt('dados importantes', 'senha');
            // Corrompe um byte no meio (altera o ciphertext)
            const chars = encrypted.split('');
            const mid = Math.floor(chars.length / 2);
            chars[mid] = chars[mid] === 'A' ? 'B' : 'A';
            const corrupted = chars.join('');

            await expect(decrypt(corrupted, 'senha')).rejects.toThrow();
        });

        it('deve falhar com Base64 inválido', async () => {
            await expect(decrypt('!!!não-é-base64!!!', 'senha')).rejects.toThrow();
        });

        it('deve falhar com string muito curta (sem salt/iv)', async () => {
            const tooShort = btoa('abc'); // Menor que SALT_LEN + IV_LEN
            await expect(decrypt(tooShort, 'senha')).rejects.toThrow();
        });
    });

    describe('Consistência e idempotência', () => {
        it('deve descriptografar consistentemente após múltiplas operações', async () => {
            const original = 'consistência é chave';
            const password = 'pass123';

            // Criptografa e descriptografa 10 vezes
            for (let i = 0; i < 10; i++) {
                const encrypted = await encrypt(original, password);
                const decrypted = await decrypt(encrypted, password);
                expect(decrypted).toBe(original);
            }
        });

        it('deve funcionar com senhas de diferentes tamanhos', async () => {
            const text = 'teste de tamanho de senha';

            const passwords = ['a', 'ab', 'senha-media', 'a'.repeat(256), 'a'.repeat(1024)];

            for (const pwd of passwords) {
                const encrypted = await encrypt(text, pwd);
                const decrypted = await decrypt(encrypted, pwd);
                expect(decrypted).toBe(text);
            }
        });
    });
});
