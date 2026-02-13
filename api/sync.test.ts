import { describe, it, expect, beforeEach, vi } from 'vitest';

const evalMock = vi.fn();
const hgetallMock = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class {
    eval = evalMock;
    hgetall = hgetallMock;
    constructor(_args: unknown) {}
  }
}));

const VALID_HASH = 'a'.repeat(64);

async function loadHandler() {
  vi.resetModules();
  const mod = await import('./sync');
  return mod.default;
}

function makePostRequest(body: unknown) {
  return new Request('https://askesis.vercel.app/api/sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sync-key-hash': VALID_HASH,
      'origin': 'https://askesis.vercel.app'
    },
    body: JSON.stringify(body)
  });
}

function makePostRequestWithLegacyBearer(body: unknown, rawKey = 'legacy-sync-key') {
  return new Request('https://askesis.vercel.app/api/sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${rawKey}`,
      'origin': 'https://askesis.vercel.app'
    },
    body: JSON.stringify(body)
  });
}

describe('api/sync payload hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KV_REST_API_URL = 'https://kv.example.com';
    process.env.KV_REST_API_TOKEN = 'token';
    process.env.CORS_ALLOWED_ORIGINS = 'https://askesis.vercel.app';
    process.env.CORS_STRICT = '1';
    process.env.ALLOW_LEGACY_SYNC_AUTH = '0';
    evalMock.mockResolvedValue(['OK']);
    hgetallMock.mockResolvedValue(null);
  });

  it('não expõe Authorization em CORS por padrão', async () => {
    const handler = await loadHandler();

    const response = await handler(new Request('https://askesis.vercel.app/api/sync', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://askesis.vercel.app'
      }
    }));

    expect(response.status).toBe(204);
    const allowed = response.headers.get('Access-Control-Allow-Headers') || '';
    expect(allowed).toContain('Content-Type');
    expect(allowed).toContain('X-Sync-Key-Hash');
    expect(allowed).not.toContain('Authorization');
  });

  it('aceita Authorization legado apenas com feature flag ativa', async () => {
    process.env.ALLOW_LEGACY_SYNC_AUTH = '1';
    const handler = await loadHandler();

    const response = await handler(makePostRequestWithLegacyBearer({
      lastModified: Date.now(),
      shards: {
        core: JSON.stringify({ version: 10 })
      }
    }));

    expect(response.status).toBe(200);
    expect(evalMock).toHaveBeenCalledTimes(1);
  });

  it('rejeita requisição com shards acima do limite', async () => {
    const handler = await loadHandler();
    const shards: Record<string, string> = {};

    for (let i = 0; i < 257; i++) {
      shards[`logs:2024-${String(i).padStart(2, '0')}`] = '0x1';
    }

    const response = await handler(makePostRequest({
      lastModified: Date.now(),
      shards
    }));

    const body = await response.json();
    expect(response.status).toBe(413);
    expect(body.code).toBe('SHARD_LIMIT_EXCEEDED');
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('rejeita shard individual acima de 512KB', async () => {
    const handler = await loadHandler();
    const tooLarge = 'a'.repeat((512 * 1024) + 1);

    const response = await handler(makePostRequest({
      lastModified: Date.now(),
      shards: {
        core: tooLarge
      }
    }));

    const body = await response.json();
    expect(response.status).toBe(413);
    expect(body.code).toBe('SHARD_TOO_LARGE');
    expect(body.detail).toBe('core');
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('rejeita payload total acima de 4MB', async () => {
    const handler = await loadHandler();
    const chunk = 'b'.repeat(500 * 1024); // < 512KB por shard

    const shards: Record<string, string> = {};
    for (let i = 0; i < 9; i++) {
      shards[`logs:2024-${String(i + 1).padStart(2, '0')}`] = chunk;
    }

    const response = await handler(makePostRequest({
      lastModified: Date.now(),
      shards
    }));

    const body = await response.json();
    expect(response.status).toBe(413);
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('aceita payload legítimo dentro dos limites', async () => {
    const handler = await loadHandler();

    const response = await handler(makePostRequest({
      lastModified: Date.now(),
      shards: {
        core: JSON.stringify({ version: 10, habits: [] }),
        'logs:2024-01': JSON.stringify([['h1_2024-01', '0x1']])
      }
    }));

    expect(response.status).toBe(200);
    expect(evalMock).toHaveBeenCalledTimes(1);
  });
});
