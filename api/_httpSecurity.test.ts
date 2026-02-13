import { describe, it, expect } from 'vitest';
import {
  checkRateLimit,
  getCorsOrigin,
  isOriginAllowed,
  matchesOriginRule,
  parseAllowedOrigins
} from './_httpSecurity';

function makeReq(headers: Record<string, string>): Request {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null
    }
  } as unknown as Request;
}

describe('api/_httpSecurity', () => {
  it('aplica regras de origem com wildcard controlado', () => {
    const allowed = parseAllowedOrigins('https://askesis.vercel.app,https://*.vercel.app');
    const req = makeReq({
      origin: 'https://feature-git-main-askesis.vercel.app',
      host: 'api.example.com'
    });

    expect(matchesOriginRule('https://feature-git-main-askesis.vercel.app', 'https://*.vercel.app')).toBe(true);
    expect(isOriginAllowed(req, 'https://feature-git-main-askesis.vercel.app', allowed)).toBe(true);
    expect(getCorsOrigin(req, allowed)).toBe('https://feature-git-main-askesis.vercel.app');
  });

  it('retorna null para origem não permitida quando lista existe', () => {
    const allowed = parseAllowedOrigins('https://askesis.vercel.app');
    const req = makeReq({
      origin: 'https://evil.example.com',
      host: 'api.example.com'
    });

    expect(getCorsOrigin(req, allowed)).toBe('null');
  });

  it('rate limit local bloqueia após exceder máximo', async () => {
    const base = {
      namespace: 'test-local',
      key: 'k1',
      windowMs: 10_000,
      maxRequests: 2,
      disabled: false,
      localMaxEntries: 10
    } as const;

    expect((await checkRateLimit(base)).limited).toBe(false);
    expect((await checkRateLimit(base)).limited).toBe(false);

    const third = await checkRateLimit(base);
    expect(third.limited).toBe(true);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });
});
