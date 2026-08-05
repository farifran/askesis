/**
 * @file api/reminder.test.ts
 * @description Testes do endpoint de lembrete diário (Vercel Cron -> OneSignal).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

function makeRequest(headers: Record<string, string> = {}) {
    return new Request('https://askesis.vercel.app/api/reminder', { method: 'GET', headers });
}

describe('api/reminder', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('fetch', fetchMock);
        process.env.ONESIGNAL_REST_API_KEY = 'os_v2_test_key';
        process.env.CRON_SECRET = 'segredo';
        delete process.env.ONESIGNAL_APP_ID;
        delete process.env.REMINDER_LOCAL_TIME;
    });

    it('rejeita chamada sem o Bearer do CRON_SECRET', async () => {
        const mod = await import('./reminder');
        const res = await mod.default(makeRequest());
        expect(res.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retorna 500 sem ONESIGNAL_REST_API_KEY', async () => {
        delete process.env.ONESIGNAL_REST_API_KEY;
        const mod = await import('./reminder');
        const res = await mod.default(makeRequest({ authorization: 'Bearer segredo' }));
        expect(res.status).toBe(500);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('cria a notificação com entrega por fuso e idempotência diária', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'notif-1' }), { status: 200 }));

        const mod = await import('./reminder');
        const res = await mod.default(makeRequest({ authorization: 'Bearer segredo' }));
        expect(res.status).toBe(200);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.onesignal.com/notifications');
        expect(init.headers['Authorization']).toBe('Key os_v2_test_key');

        const payload = JSON.parse(init.body);
        expect(payload.included_segments).toEqual(['Subscribed Users']);
        expect(payload.delayed_option).toBe('timezone');
        expect(payload.delivery_time_of_day).toBe('8:00PM');
        expect(payload.ttl).toBe(86400);
        expect(payload.contents.pt).toContain('hábitos');
        expect(payload.headings.en).toBe('Pending habits');
        expect(payload.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
        // Sem o topic, a OneSignal gera uma tag aleatória e o worker não
        // consegue substituir o texto genérico pelo lembrete personalizado.
        expect(payload.web_push_topic).toBe('askesis-reminder');
    });

    it('servidor e worker de push concordam na mesma tag', async () => {
        const { readFileSync } = await import('node:fs');
        const { NOTIFICATION_TAG } = await import('./reminder');

        // Edge runtime e service worker não podem se importar: a única garantia
        // possível é comparar o literal.
        expect(readFileSync('OneSignalSDKWorker.js', 'utf8'))
            .toContain(`var NOTIFICATION_TAG = '${NOTIFICATION_TAG}'`);
    });

    it('a tag do lembrete não colide com a do badge local', async () => {
        const { readFileSync } = await import('node:fs');
        const { NOTIFICATION_TAG } = await import('./reminder');

        // Elas vivem em registrations diferentes (sw.js vs /onesignal/), então
        // reusar a mesma string sugeriria um colapso que não acontece.
        expect(readFileSync('services/badge.ts', 'utf8'))
            .not.toContain(`PENDING_NOTIFICATION_TAG = '${NOTIFICATION_TAG}'`);
    });

    it('web_push_topic respeita o limite de 64 caracteres da OneSignal', async () => {
        const { NOTIFICATION_TAG } = await import('./reminder');
        expect(NOTIFICATION_TAG.length).toBeLessThanOrEqual(64);
    });

    it('idempotency key é estável para a mesma data e distinta entre datas', async () => {
        const { idempotencyKeyForDate } = await import('./reminder');
        const a1 = await idempotencyKeyForDate('2026-08-01');
        const a2 = await idempotencyKeyForDate('2026-08-01');
        const b = await idempotencyKeyForDate('2026-08-02');
        expect(a1).toBe(a2);
        expect(a1).not.toBe(b);
    });

    it('usa auth Basic para chaves legadas', async () => {
        process.env.ONESIGNAL_REST_API_KEY = 'legacy_key_abc';
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

        const mod = await import('./reminder');
        await mod.default(makeRequest({ authorization: 'Bearer segredo' }));
        expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Basic legacy_key_abc');
    });

    it('propaga falha da OneSignal como 502 sem lançar', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: ['bad'] }), { status: 400 }));

        const mod = await import('./reminder');
        const res = await mod.default(makeRequest({ authorization: 'Bearer segredo' }));
        expect(res.status).toBe(502);
    });
});
