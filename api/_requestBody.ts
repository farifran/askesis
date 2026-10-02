/** Limita bytes durante a leitura, inclusive sem Content-Length. */
export class RequestBodyError extends Error {
    constructor(public readonly status: number) { super(status === 413 ? 'Payload too large' : 'Request timeout'); }
}

export async function readRequestBody(req: Request, maxBytes: number, timeoutMs = 8000): Promise<string> {
    if (Number(req.headers.get('content-length')) > maxBytes) throw new RequestBodyError(413);
    const reader = req.body?.getReader();
    if (!reader) return '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            reject(new RequestBodyError(408));
            void reader.cancel().catch(() => {});
        }, timeoutMs);
    });
    const read = async () => {
        const decoder = new TextDecoder();
        let total = 0;
        let text = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (timedOut) throw new RequestBodyError(408);
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                void reader.cancel().catch(() => {});
                throw new RequestBodyError(413);
            }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    };
    try { return await Promise.race([read(), timeout]); }
    finally { clearTimeout(timer); }
}
