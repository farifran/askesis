/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file api/reminder.ts
 * @description Lembrete diário via OneSignal (badge de reengajamento no Android).
 *
 * Disparado pelo Vercel Cron (ver vercel.json). Cria UMA notificação por dia na
 * OneSignal com entrega por fuso horário: cada assinante recebe às
 * REMINDER_LOCAL_TIME no seu horário local. No Android, a notificação não lida é
 * o que produz o badge no ícone do launcher (a Badging API não existe lá).
 *
 * PRIVACIDADE: o servidor não sabe quem tem pendências (estado é E2E cifrado);
 * o texto é genérico e a entrega vai só a quem optou por push (assinantes).
 *
 * ENV VARS (Vercel):
 * - ONESIGNAL_REST_API_KEY (obrigatória; prefixo os_v2_ usa auth "Key")
 * - CRON_SECRET (recomendada; Vercel a envia como Bearer automaticamente)
 * - ONESIGNAL_APP_ID (opcional; default = app id público do cliente)
 * - REMINDER_LOCAL_TIME (opcional; default "8:00PM")
 */

export const config = {
    runtime: 'edge',
};

const DEFAULT_APP_ID = 'd69cf0b6-bc03-4375-b3b7-dd7b37e05a17';
const ONESIGNAL_API_URL = 'https://api.onesignal.com/notifications';

/**
 * Tag da notificação no navegador (`web_push_topic` -> Notification.tag).
 *
 * Precisa bater com OneSignalSDKWorker.js, que a usa para substituir este texto
 * genérico pelo lembrete personalizado montado no aparelho — há teste garantindo
 * isso em api/reminder.test.ts.
 *
 * Deliberadamente DIFERENTE de PENDING_NOTIFICATION_TAG (services/badge.ts): a
 * substituição por tag vale por service worker registration, e o badge vive no
 * sw.js (scope '/') enquanto o push vive no worker da OneSignal ('/onesignal/').
 * Tags iguais não colapsariam — só criariam a ilusão de que colapsam.
 */
export const NOTIFICATION_TAG = 'askesis-reminder';

const HEADINGS = {
    en: 'Pending habits',
    pt: 'Hábitos pendentes',
    es: 'Hábitos pendientes'
};

const CONTENTS = {
    en: 'How are your habits today? Open Askesis and log your progress.',
    pt: 'Como estão seus hábitos hoje? Abra o Askesis e registre seu progresso.',
    es: '¿Cómo van tus hábitos hoy? Abre Askesis y registra tu progreso.'
};

function json(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * Chave de idempotência determinística por data (UTC): se o cron reexecutar no
 * mesmo dia (retry/redeploy), a OneSignal deduplica em vez de enviar duas vezes.
 * Formato UUID exigido pela API, derivado de SHA-256 da data.
 */
export async function idempotencyKeyForDate(dateISO: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`askesis-reminder|${dateISO}`));
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    // Formata como UUID v4-like (nibbles de versão/variante fixos para validade).
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function getAuthHeader(restKey: string): string {
    // Chaves novas da OneSignal (prefixo os_v2_) usam o esquema "Key";
    // chaves legadas usam "Basic".
    return restKey.startsWith('os_') ? `Key ${restKey}` : `Basic ${restKey}`;
}

export default async function handler(req: Request) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return new Response(null, { status: 405 });
    }

    // AUTENTICAÇÃO: o Vercel Cron envia Authorization: Bearer ${CRON_SECRET}.
    // Sem isso, qualquer um poderia disparar notificações para toda a base.
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = req.headers.get('authorization') || '';
        if (auth !== `Bearer ${cronSecret}`) {
            return json(401, { error: 'Unauthorized' });
        }
    }

    const restKey = process.env.ONESIGNAL_REST_API_KEY;
    if (!restKey) {
        return json(500, { error: 'Server Configuration: Missing ONESIGNAL_REST_API_KEY' });
    }

    const appId = process.env.ONESIGNAL_APP_ID || DEFAULT_APP_ID;
    const deliveryTime = process.env.REMINDER_LOCAL_TIME || '8:00PM';
    const todayISO = new Date().toISOString().slice(0, 10);

    const payload = {
        app_id: appId,
        included_segments: ['Subscribed Users'],
        headings: HEADINGS,
        contents: CONTENTS,
        url: 'https://askesis.vercel.app/',
        // Entrega no horário local de cada assinante.
        delayed_option: 'timezone',
        delivery_time_of_day: deliveryTime,
        // Expira sem entrega após 24h (evita lembrete atrasado no dia seguinte).
        ttl: 86400,
        // Vira o `tag` da Notification no navegador. É o que permite ao
        // OneSignalSDKWorker.js substituir este texto genérico pelo lembrete
        // personalizado montado no aparelho, sem empilhar duas notificações.
        // Mesma tag do badge local (services/badge.ts) para colapsarem numa só.
        web_push_topic: NOTIFICATION_TAG,
        idempotency_key: await idempotencyKeyForDate(todayISO)
    };

    try {
        const res = await fetch(ONESIGNAL_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': getAuthHeader(restKey)
            },
            body: JSON.stringify(payload)
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            return json(502, { error: 'OneSignal request failed', status: res.status, details: body });
        }
        return json(200, { ok: true, date: todayISO, id: (body as { id?: string }).id ?? null });
    } catch (error) {
        return json(502, { error: 'OneSignal request failed', details: String(error).slice(0, 200) });
    }
}
