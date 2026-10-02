import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateContentMock = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: generateContentMock
    };
    constructor(_args: unknown) {}
  }
}));

let cookie = '';
function makeAnalyzeRequest(prompt = 'hello', systemInstruction = 'sys') {
  return new Request('https://askesis.vercel.app/api/analyze', {
    method: 'POST',
    headers: {
      'cookie': cookie,
      'content-type': 'application/json',
      'origin': 'https://askesis.vercel.app',
      'x-vercel-forwarded-for': '203.0.113.10'
    },
    body: JSON.stringify({ task: 'habits', language: 'pt', context: { analysisType: 'monthly', habits: [{ id: 'h', scheduleHistory: [{ name: prompt }] }] }, systemInstruction })
  });
}

describe('api/analyze quota cooldown', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.API_KEY = 'test-key';
    process.env.CORS_ALLOWED_ORIGINS = 'https://askesis.vercel.app';
    process.env.CORS_STRICT = '1';
    process.env.DISABLE_RATE_LIMIT = '1';
    process.env.AI_QUOTA_COOLDOWN_MS = '120000';
    const { createAiSessionCookie } = await import('./_aiSession');
    cookie = (await createAiSessionCookie()).split(';')[0];
  });

  it('rejeita ausência de sessão, assinatura inválida e API antiga sem gastar tokens', async () => {
    const { default: handler } = await import('./analyze');
    const missing = makeAnalyzeRequest();
    missing.headers.delete('cookie');
    expect((await handler(missing)).status).toBe(401);
    const tampered = makeAnalyzeRequest();
    tampered.headers.set('cookie', cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0'));
    expect((await handler(tampered)).status).toBe(401);
    const legacy = new Request('https://askesis.vercel.app/api/analyze', {
      method: 'POST', headers: { cookie, origin: 'https://askesis.vercel.app' },
      body: JSON.stringify({ prompt: 'any request', systemInstruction: 'do anything' })
    });
    expect((await handler(legacy)).status).toBe(400);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('chama o modelo esperado sem parâmetros de amostragem depreciados', async () => {
    // temperature/top_p/top_k são desaconselhados em toda a família Gemini 3.x
    // (interferem na otimização de raciocínio). O determinismo vem da
    // systemInstruction. Este teste impede que voltem por descuido.
    generateContentMock.mockResolvedValueOnce({ text: '{"ok":true}' });

    const mod = await import('./analyze');
    await mod.default(makeAnalyzeRequest('p', 's'));

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const args = generateContentMock.mock.calls[0][0];
    expect(args.model).toBe('gemini-3.5-flash-lite');
    expect(args.config.systemInstruction).not.toBe('s');
    expect(args.config.systemInstruction).toContain('untrusted data');
    expect(args.config.maxOutputTokens).toBe(4096);
    expect(args.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(args.config).not.toHaveProperty('temperature');
    expect(args.config).not.toHaveProperty('topP');
    expect(args.config).not.toHaveProperty('topK');
  });

  it('usa schema confiável para citações, ignorando o schema do cliente', async () => {
    generateContentMock.mockResolvedValueOnce({ text: '{"ok":true}' });
    const schema = { type: 'object', properties: { a: { type: 'string' } } };

    const mod = await import('./analyze');
    await mod.default(new Request('https://askesis.vercel.app/api/analyze', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://askesis.vercel.app', 'x-vercel-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({ task: 'quote', language: 'pt', context: { notes: 'reflexão' }, responseSchema: schema })
    }));

    const cfg = generateContentMock.mock.calls[0][0].config;
    expect(cfg.responseMimeType).toBe('application/json');
    const { QUOTE_ANALYSIS_SCHEMA } = await import('../contracts/ai');
    expect(cfg.responseSchema).toEqual(QUOTE_ANALYSIS_SCHEMA);
    expect(cfg.responseSchema).not.toEqual(schema);
  });

  it('mantém resposta em prosa quando não há responseSchema (avaliação de hábitos)', async () => {
    generateContentMock.mockResolvedValueOnce({ text: '# Relatório' });

    const mod = await import('./analyze');
    await mod.default(makeAnalyzeRequest('p', 's'));

    const cfg = generateContentMock.mock.calls[0][0].config;
    expect(cfg).not.toHaveProperty('responseMimeType');
    expect(cfg).not.toHaveProperty('responseSchema');
  });

  it('ativa cooldown após erro de quota e bloqueia nova chamada ao provedor', async () => {
    generateContentMock.mockRejectedValueOnce(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }));

    const mod = await import('./analyze');
    const handler = mod.default;

    const first = await handler(makeAnalyzeRequest('p1', 's1'));
    expect(first.status).toBe(429);

    const second = await handler(makeAnalyzeRequest('p2', 's2'));
    expect(second.status).toBe(429);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(second.headers.get('Retry-After')).toBeTruthy();
  });

  it('responde cache hit mesmo durante cooldown sem chamar provedor', async () => {
    generateContentMock.mockResolvedValueOnce({ text: 'cached answer' });
    generateContentMock.mockRejectedValueOnce(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }));

    const mod = await import('./analyze');
    const handler = mod.default;

    const first = await handler(makeAnalyzeRequest('same', 'sys'));
    expect(first.status).toBe(200);

    const second = await handler(makeAnalyzeRequest('other', 'sys'));
    expect(second.status).toBe(429);

    const third = await handler(makeAnalyzeRequest('same', 'sys'));
    expect(third.status).toBe(200);
    expect(third.headers.get('X-Cache')).toBe('HIT');

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });
});
