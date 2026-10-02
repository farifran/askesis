import { checkRateLimit, getClientIp } from './_httpSecurity';
import { createAiSessionCookie, readAiSession } from './_aiSession';
export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store' };
    if (req.method !== 'POST') return new Response(null, { status: 405, headers });
    // Protege emissão por navegação cross-site. Não substitui as quotas antiautomação.
    if (req.headers.get('origin') !== new URL(req.url).origin) return new Response(null, { status: 403, headers });
    try {
        if (await readAiSession(req)) return new Response(null, { status: 204, headers });
        for (const [namespace, key, maxRequests] of [
            ['ai-session-ip', getClientIp(req), 4], ['ai-session-global', 'all', 500]
        ] as const) {
            const limit = await checkRateLimit({ namespace, key, maxRequests, windowMs: 86400000,
                requireDistributed: true, disabled: process.env.NODE_ENV === 'test' });
            if (limit.limited) return new Response(null, { status: 429, headers: { ...headers, 'Retry-After': String(limit.retryAfterSec) } });
        }
        return new Response(null, { status: 204, headers: { ...headers, 'Set-Cookie': await createAiSessionCookie() } });
    } catch {
        return new Response(null, { status: 503, headers });
    }
}
