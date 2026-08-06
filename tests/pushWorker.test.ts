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

/** Notificação genérica que a OneSignal publica em resposta ao push. */
function oneSignalNotification(overrides: Record<string, unknown> = {}) {
    return {
        tag: TAG,
        title: 'Hábitos pendentes',
        body: 'Como estão seus hábitos hoje?',
        timestamp: 2000,
        icon: 'https://cdn.onesignal.com/icon.png',
        badge: 'https://cdn.onesignal.com/badge.png',
        data: { url: 'https://askesis.vercel.app/', notificationId: 'os-123' },
        close: () => { /* noop */ },
        ...overrides
    };
}

interface WorkerOptions {
    /** Já estava na bandeja antes do push (lembrete de ontem, por exemplo). */
    tray?: any[];
    /** O que a OneSignal publica em resposta a ESTE push. */
    incoming?: any[] | null;
    idb?: { missingStore?: boolean; failOpen?: boolean };
}

function loadWorker(card: Card, options: WorkerOptions = {}) {
    // `importScripts` traria o SDK real da CDN; aqui só interessa o nosso trecho.
    const source = readFileSync('OneSignalSDKWorker.js', 'utf8')
        .replace(/^importScripts\([^)]*\);?\s*$/m, '');

    const tray: any[] = [...(options.tray ?? [])];
    const shown: { title: string; options: any }[] = [];
    const listeners: Record<string, (event: any) => void> = {};

    const selfStub = {
        addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; },
        registration: {
            getNotifications: async (filter?: { tag?: string }) =>
                filter?.tag ? tray.filter(n => n.tag === filter.tag) : [...tray],
            showNotification: async (title: string, opts: any) => { shown.push({ title, options: opts }); }
        }
    };

    // eslint-disable-next-line no-new-func
    new Function('self', 'indexedDB', source)(selfStub, fakeIndexedDB(card, options.idb));

    /** Payload real da OneSignal carrega os dados adicionais em `custom.a`. */
    async function firePush(payload: unknown = { custom: { a: { askesis: MARKER } } }) {
        let pending: Promise<unknown> = Promise.resolve();
        listeners.push({
            data: { json: () => payload },
            waitUntil: (p: Promise<unknown>) => { pending = p; }
        });

        // A OneSignal publica a dela em paralelo, logo depois do nosso handler
        // começar. `null` simula o caso em que ela nunca chega.
        if (options.incoming !== null) {
            setTimeout(() => tray.push(...(options.incoming ?? [oneSignalNotification()])), 10);
        }

        await pending;
    }

    return { firePush, shown, tray };
}

const CARD_HOJE: Card = { date: TODAY, lang: 'pt', title: 'Hábitos pendentes', body: 'Faltam: Meditar' };

describe('OneSignalSDKWorker — personalização local do lembrete', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it('substitui o texto genérico pelo cartão do dia', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE);
        await firePush();

        expect(shown).toHaveLength(1);
        expect(shown[0].title).toBe('Hábitos pendentes');
        expect(shown[0].options.body).toBe('Faltam: Meditar');
        // Tag própria e fixa: lembretes seguidos colapsam entre si.
        expect(shown[0].options.tag).toBe(TAG);
        // Sem renotify a troca é silenciosa: a OneSignal já alertou.
        expect(shown[0].options.renotify).toBe(false);
    });

    it('ignora push sem o marcador (não sequestra anúncio enviado pelo painel)', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE);
        await firePush({ custom: { a: {} }, alert: 'Novidade no Askesis!' });

        expect(shown).toHaveLength(0);
    });

    it('aceita o marcador vindo em `data` além de `custom.a`', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE);
        await firePush({ data: { askesis: MARKER } });

        expect(shown).toHaveLength(1);
    });

    it('fecha sempre a original, para não empilhar duas notificações', async () => {
        // Regressão: contar com colisão de tag deixava DUAS na bandeja quando a
        // tag da OneSignal vinha vazia ou diferente da nossa.
        const closed: string[] = [];
        const original = oneSignalNotification({ tag: '', close: () => { closed.push('fechada'); } });
        const { firePush, shown } = loadWorker(CARD_HOJE, { incoming: [original] });
        await firePush();

        expect(closed).toEqual(['fechada']);
        expect(shown).toHaveLength(1);
        expect(shown[0].options.tag).toBe(TAG);
    });

    it('ignora notificação antiga da bandeja e espera a nova', async () => {
        // Regressão: aceitar "alguma" notificação fazia o worker reescrever uma
        // antiga enquanto a nova aparecia do lado — duas na bandeja.
        const antiga = oneSignalNotification({ title: 'lembrete de ontem', timestamp: 1 });
        const { firePush, shown } = loadWorker(CARD_HOJE, { tray: [antiga] });
        await firePush();

        expect(shown).toHaveLength(1);
        expect(shown[0].options.body).toBe('Faltam: Meditar');
    });

    it('preserva o data da OneSignal para o clique continuar funcionando', async () => {
        const original = oneSignalNotification();
        const { firePush, shown } = loadWorker(CARD_HOJE, { incoming: [original] });
        await firePush();

        expect(shown[0].options.data).toEqual(original.data);
        expect(shown[0].options.icon).toBe(original.icon);
    });

    it('mantém a notificação genérica quando o cartão é de outro dia', async () => {
        const ontem: Card = { ...CARD_HOJE!, date: '2020-01-01' };
        const { firePush, shown } = loadWorker(ontem);
        await firePush();

        // App não foi aberto hoje: dados velhos seriam pior que o texto genérico.
        expect(shown).toHaveLength(0);
    });

    it('mantém a genérica quando não há cartão', async () => {
        const { firePush, shown } = loadWorker(null);
        await firePush();
        expect(shown).toHaveLength(0);
    });

    it('mantém a genérica quando o cartão está incompleto', async () => {
        const semCorpo = { date: TODAY, lang: 'pt', title: 'Só título', body: '' } as Card;
        const { firePush, shown } = loadWorker(semCorpo);
        await firePush();
        expect(shown).toHaveLength(0);
    });

    it('não quebra se o banco do app ainda não existir', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE, { idb: { missingStore: true } });
        await expect(firePush()).resolves.not.toThrow();
        expect(shown).toHaveLength(0);
    });

    it('não quebra se o IndexedDB falhar ao abrir', async () => {
        const { firePush, shown } = loadWorker(CARD_HOJE, { idb: { failOpen: true } });
        await expect(firePush()).resolves.not.toThrow();
        expect(shown).toHaveLength(0);
    });

    it('não cria notificação própria se a da OneSignal nunca aparecer', async () => {
        vi.useFakeTimers();
        const { firePush, shown } = loadWorker(CARD_HOJE, { incoming: null });

        const done = firePush();
        // Esgota a janela de espera (3s) sem que nada seja publicado.
        await vi.advanceTimersByTimeAsync(3200);
        await done;

        // Criar uma aqui arriscaria duplicar caso a da OneSignal chegasse depois.
        expect(shown).toHaveLength(0);
    });
});
