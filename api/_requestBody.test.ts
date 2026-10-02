import { afterEach, expect, it, vi } from 'vitest';
import { readRequestBody } from './_requestBody';
afterEach(() => vi.useRealTimers());
it('conta bytes UTF-8 mesmo sem Content-Length', async () => {
    const req = new Request('https://local.test', { method: 'POST', body: 'ááá' });
    await expect(readRequestBody(req, 5)).rejects.toMatchObject({ status: 413 });
});
it('preserva caracteres divididos entre chunks', async () => {
    const bytes = new TextEncoder().encode('αβ');
    const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1)); c.close(); } });
    await expect(readRequestBody({ body, headers: new Headers() } as Request, 4)).resolves.toBe('αβ');
});
it('cancela leitura que excede o prazo', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const pending = expect(readRequestBody({ body, headers: new Headers() } as Request, 100, 1000)).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(cancel).toHaveBeenCalled();
});
