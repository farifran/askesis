import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const limit = vi.hoisted(() => vi.fn());
vi.mock('./_httpSecurity', () => ({ checkRateLimit: limit, getClientIp: () => '203.0.113.8' }));
import handler from './ai-session';
import { createAiSessionCookie, readAiSession } from './_aiSession';
const request = (headers = {}) => new Request('https://askesis.vercel.app/api/ai-session', {
    method: 'POST', headers: { origin: 'https://askesis.vercel.app', ...headers }
});
beforeEach(() => { vi.stubEnv('AI_SESSION_SECRET', 'test-secret'); limit.mockResolvedValue({ limited: false }); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it('emite cookie assinado HttpOnly e reutiliza sessão válida sem nova emissão', async () => {
    const response = await handler(request());
    expect(response.status).toBe(204);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(await readAiSession(request({ cookie }))).toBeTruthy();
    limit.mockClear();
    const reused = await handler(request({ cookie }));
    expect(reused.headers.get('set-cookie')).toBeNull();
    expect(limit).not.toHaveBeenCalled();
});
it('recusa origem cruzada antes de emitir', async () => {
    expect((await handler(request({ origin: 'https://other.example' }))).status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
});
it('recusa cookie expirado e assinado com outro segredo', async () => {
    const cookie = await createAiSessionCookie();
    vi.stubEnv('AI_SESSION_SECRET', 'different-secret');
    expect(await readAiSession(request({ cookie }))).toBeNull();
    vi.stubEnv('AI_SESSION_SECRET', 'test-secret');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 86400001);
    expect(await readAiSession(request({ cookie }))).toBeNull();
});
it('nega emissão ao atingir cota ou perder o limitador distribuído', async () => {
    limit.mockResolvedValueOnce({ limited: true, retryAfterSec: 60 });
    expect((await handler(request())).status).toBe(429);
    limit.mockRejectedValueOnce(new Error('Redis down'));
    expect((await handler(request())).status).toBe(503);
});
