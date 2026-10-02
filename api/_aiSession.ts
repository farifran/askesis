/** Sessão anônima assinada; a emissão e o uso têm orçamentos independentes. */
const COOKIE = 'askesis_ai_session';
const DAY = 86400;

function secret(): string {
    const value = process.env.AI_SESSION_SECRET || process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (!value) throw new Error('AI session signing unavailable');
    return `askesis:ai-session:v1:${value}`;
}
async function key(): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function hex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function readAiSession(req: Request): Promise<string | null> {
    const token = (req.headers.get('cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 180) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [id, expires, signature] = parts;
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^\d{10}$/.test(expires) || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
    const expiry = Number(expires);
    const now = Math.floor(Date.now() / 1000);
    if (expiry <= now || expiry > now + DAY) return null;
    const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
    return await crypto.subtle.verify('HMAC', await key(), bytes, new TextEncoder().encode(`${id}.${expires}`)) ? id : null;
}
export async function createAiSessionCookie(): Promise<string> {
    const value = `${crypto.randomUUID()}.${Math.floor(Date.now() / 1000) + DAY}`;
    const signature = hex(await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(value)));
    return `${COOKIE}=${value}.${signature}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAY}`;
}
