/**
 * @file tests/pushWorker.test.ts
 * @description Personalização local do lembrete dentro do OneSignalSDKWorker.js.
 *
 * O worker não é um módulo (roda em contexto de Service Worker e faz
 * `importScripts` do SDK), então aqui ele é avaliado com `self`, `indexedDB` e
 * `registration` falsos. É o trecho mais arriscado do fluxo de push: corre em
 * paralelo com o handler da OneSignal e precisa nunca deixar o usuário sem
 * notificação — no iOS, push sem notificação visível custa a permissão.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const TAG = 'askesis-reminder';
const MARKER = 'askesis-reminder';
const TODAY = new Date().toISOString().slice(0, 10);

type Card = { date: string; lang: string; title: string; body: string } | null;

/** IndexedDB mínimo: só `open -> transaction -> objectStore -> get`. */
function fakeIndexedDB(card: Card, opts: { missingStore?: boolean; failOpen?: boolean } = {}) {
    return {
        open() {
            const req: any = {};
            queueMicrotask(() => {
                if (opts.failOpen) {
                    req.error = new Error('idb indisponível');
                    req.onerror?.();
                    return;
                }
                req.result = {
                    objectStoreNames: { contains: () => !opts.missingStore },
                    transaction: () => ({
                        objectStore: () => ({
                            get() {
                                const r: any = {};
                                queueMicrotask(() => { r.result = card; r.onsuccess?.(); });
                                return r;
                            }
                        })
                    }),
                    close() { /* noop */ }
                };
                req.onsuccess?.();
            });
            return req;
        }
    };
}

function loadWorker(card: Card, existingNotifications: any[], idbOpts = {}) {
    // `importScripts` traria o SDK real da CDN; aqui só interessa o nosso trecho.
    const source = readFileSync('OneSignalSDKWorker.js', 'utf8')
        .replace(/^importScripts\([^)]*\);?\s*$/m, '');

    const shown: { title: string; options: any }[] = [];
    const listeners: Record<string, (event: any) => void> = {};

    const selfStub = {
        addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; },
        registration: {
            // Sem filtro devolve tudo — é assim que a API se comporta, e é como
            // o worker passou a chamar (não depende mais da tag).
            getNotifications: async (filter?: { tag?: string }) =>
                filter?.tag ? existingNotifications.filter(n => n.tag === filter.tag) : existingNotifications,
            showNotification: async (title: string, options: any) => { shown.push({ title, options }); }
        }
    };

    // eslint-disable-next-line no-new-func
    new Function('self', 'indexedDB', source)(selfStub, fakeIndexedDB(card, idbOpts));

    /** Payload real da OneSignal carrega os dados adicionais em `custom.a`. */
    async function firePush(payload: unknown = { custom: { a: { askesis: MARKER } } }) {
        let pending: Promise<unknown> = Promise.resolve();
        listeners.push({
            data: { json: () => payload },
            waitUntil: (p: Promise<unknown>) => { pending = p; }
        });
        await pending;
    }

    return { firePush, shown };
}

/** Notificação genérica que a OneSignal publica antes de nós. */
function oneSignalNotification() {
    return {
        tag: TAG,
        icon: 'https://cdn.onesignal.com/icon.png',
        badge: 'https://cdn.onesignal.com/badge.png',
        data: { url: 'https://askesis.vercel.app/', notificationId: 'os-123' }
    };
}

const CARD_HOJE: Card = { date: TODAY, lang: 'pt', title: 'Hábitos pendentes', body: 'Faltam: Meditar' };

describe('OneSignalSDKWorker — personalização local do lembrete', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it('substitui o texto genérico pelo cartão do dia, reusando a mesma tag', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE, [oneSignalNotification()]);
        await firePush();

        expect(shown).toHaveLength(1);
        expect(shown[0].title).toBe('Hábitos pendentes');
        expect(shown[0].options.body).toBe('Faltam: Meditar');
        // Tag idêntica é o que substitui em vez de empilhar duas notificações.
        expect(shown[0].options.tag).toBe(TAG);
        // Sem renotify a troca é silenciosa: a OneSignal já alertou.
        expect(shown[0].options.renotify).toBe(false);
    });

    it('ignora push sem o marcador (não sequestra anúncio enviado pelo painel)', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE, [oneSignalNotification()]);
        await firePush({ custom: { a: {} }, alert: 'Novidade no Askesis!' });

        expect(shown).toHaveLength(0);
    });

    it('aceita o marcador vindo em `data` além de `custom.a`', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE, [oneSignalNotification()]);
        await firePush({ data: { askesis: MARKER } });

        expect(shown).toHaveLength(1);
    });

    it('substitui mesmo quando a notificação da OneSignal usa outra tag', async () => {
        // Regressão: a 1ª versão filtrava por tag e desistia em silêncio quando
        // `web_push_topic` não virava `Notification.tag`.
        const outraTag = { ...oneSignalNotification(), tag: 'os-uuid-aleatorio' };
        const { firePush, shown } = loadWorker(CARD_HOJE, [outraTag]);
        await firePush();

        expect(shown).toHaveLength(1);
        expect(shown[0].options.tag).toBe('os-uuid-aleatorio');
    });

    it('fecha a original quando ela não tem tag, para não duplicar', async () => {
        const closed: boolean[] = [];
        const semTag = {
            ...oneSignalNotification(),
            tag: '',
            close: () => { closed.push(true); }
        };
        const { firePush, shown } = loadWorker(CARD_HOJE, [semTag]);
        await firePush();

        expect(closed).toHaveLength(1);
        expect(shown).toHaveLength(1);
        expect(shown[0].options.tag).toBeUndefined();
    });

    it('preserva o data da OneSignal para o clique continuar funcionando', async () => {
        const original = oneSignalNotification();
        const { firePush, shown } = loadWorker(CARD_HOJE, [original]);
        await firePush();

        expect(shown[0].options.data).toEqual(original.data);
        expect(shown[0].options.icon).toBe(original.icon);
    });

    it('mantém a notificação genérica quando o cartão é de outro dia', async () => {
        const ontem: Card = { ...CARD_HOJE!, date: '2020-01-01' };
        const { firePush, shown } = loadWorker(ontem, [oneSignalNotification()]);
        await firePush();

        // App não foi aberto hoje: dados velhos seriam pior que o texto genérico.
        expect(shown).toHaveLength(0);
    });

    it('mantém a genérica quando não há cartão', async () => {
        const { firePush, shown } = loadWorker(null, [oneSignalNotification()]);
        await firePush();
        expect(shown).toHaveLength(0);
    });

    it('mantém a genérica quando o cartão está incompleto', async () => {
        const semCorpo = { date: TODAY, lang: 'pt', title: 'Só título', body: '' } as Card;
        const { firePush, shown } = loadWorker(semCorpo, [oneSignalNotification()]);
        await firePush();
        expect(shown).toHaveLength(0);
    });

    it('não quebra se o banco do app ainda não existir', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE, [oneSignalNotification()], { missingStore: true });
        await expect(firePush()).resolves.not.toThrow();
        expect(shown).toHaveLength(0);
    });

    it('não quebra se o IndexedDB falhar ao abrir', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE, [oneSignalNotification()], { failOpen: true });
        await expect(firePush()).resolves.not.toThrow();
        expect(shown).toHaveLength(0);
    });

    it('não cria notificação própria se a da OneSignal nunca aparecer', async () => {
        vi.useFakeTimers();
        const { firePush, shown } = loadWorker(CARD_HOJE, []);

        const done = firePush();
        // Esgota a janela de espera (3s) sem que nada seja publicado.
        await vi.advanceTimersByTimeAsync(3200);
        await done;

        // Criar uma aqui arriscaria duplicar caso a da OneSignal chegasse depois.
        expect(shown).toHaveLength(0);
    });

    it('espera a OneSignal publicar antes de trocar (evita ser sobrescrito)', async () => {
        vi.useFakeTimers();
        const atrasadas: any[] = [];
        const { firePush, shown } = loadWorker(CARD_HOJE, atrasadas);

        const done = firePush();
        await vi.advanceTimersByTimeAsync(120);
        expect(shown).toHaveLength(0); // ainda esperando

        atrasadas.push(oneSignalNotification()); // OneSignal publica agora
        await vi.advanceTimersByTimeAsync(120);
        await done;

        expect(shown).toHaveLength(1);
        expect(shown[0].title).toBe('Hábitos pendentes');
    });
});
