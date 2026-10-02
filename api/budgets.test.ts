import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ limit: vi.fn(), eval: vi.fn(), generate: vi.fn() }));
vi.mock('./_httpSecurity', async (original) => ({ ...await original<typeof import('./_httpSecurity')>(), checkRateLimit: mocks.limit }));
vi.mock('./_aiSession', () => ({ readAiSession: async () => 'signed-session-id' }));
vi.mock('@upstash/redis', () => ({ Redis: class { eval = mocks.eval; } }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: mocks.generate }; } }));
beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('API_KEY', 'test-key');
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example.com');
    vi.stubEnv('KV_REST_API_TOKEN', 'token');
    mocks.limit.mockResolvedValue({ limited: false });
    mocks.eval.mockResolvedValue(['OK']);
});
const syncRequest = (hash = 'a'.repeat(64), shards = { core: 'encrypted' }) => new Request('https://askesis.vercel.app/api/sync', {
    method: 'POST', headers: { 'x-sync-key-hash': hash, 'x-vercel-forwarded-for': '203.0.113.8' },
    body: JSON.stringify({ lastModified: 100, shards })
});
it('trocar hash não troca a cota do IP e nenhuma escrita acontece após bloqueio', async () => {
    const { default: sync } = await import('./sync');
    mocks.limit.mockResolvedValue({ limited: true, retryAfterSec: 60 });
    expect((await sync(syncRequest())).status).toBe(429);
    expect((await sync(syncRequest('b'.repeat(64)))).status).toBe(429);
    expect(mocks.limit.mock.calls.map(([arg]) => [arg.namespace, arg.key])).toEqual([
        ['sync-ip', '203.0.113.8'], ['sync-ip', '203.0.113.8']
    ]);
    expect(mocks.eval).not.toHaveBeenCalled();
});
it('recusa nomes arbitrários e propaga excesso de armazenamento sem fallback de escrita', async () => {
    const { default: sync } = await import('./sync');
    expect((await sync(syncRequest(undefined, { arbitrary: 'x' } as any))).status).toBe(400);
    expect(mocks.eval).not.toHaveBeenCalled();
    mocks.eval.mockResolvedValue(['ERROR', 'VAULT_QUOTA_EXCEEDED']);
    const response = await sync(syncRequest());
    expect(response.status).toBe(413);
    const [, keys, args] = mocks.eval.mock.calls[0];
    expect(keys).toEqual([`sync_v3:${'a'.repeat(64)}`, 'sync_v3:vault-registry']);
    expect(args.slice(3)).toEqual(['legacy', 16 * 1024 * 1024, 512, 1000]);
});
it('bloqueia custo de IA na cota global mesmo que IP e sessão ainda tenham saldo', async () => {
    const { default: analyze } = await import('./analyze');
    mocks.limit.mockImplementation(async ({ namespace }) => ({ limited: namespace === 'ai-daily-global', retryAfterSec: 86400 }));
    const response = await analyze(new Request('https://askesis.vercel.app/api/analyze', {
        method: 'POST', body: JSON.stringify({ task: 'quote', context: { notes: 'reflexão' } })
    }));
    expect(response.status).toBe(429);
    expect(mocks.limit.mock.calls.map(([arg]) => arg.namespace)).toEqual(['analyze', 'ai-daily-session', 'ai-daily-ip', 'ai-daily-global']);
    expect(mocks.generate).not.toHaveBeenCalled();
});
