/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file api/sync.ts
 * @description Vercel Edge Function — Sincronização atômica de shards criptografados via Upstash Redis.
 *
 * POST /api/sync  → grava shards (compare-and-swap atômico via Lua)
 * GET  /api/sync  → retorna shards armazenados
 */

import { Redis } from '@upstash/redis';
import {
    checkRateLimit,
    getClientIp,
    getCorsOrigin as getCorsOriginFromRules,
    isOriginAllowed,
    parseAllowedOrigins,
    parsePositiveInt
} from './_httpSecurity';


export const config = {
    runtime: 'edge',
};


/* ── Limites de payload ─────────────────────────────────────────── */
const MAX_SHARDS = 256;
const MAX_SHARD_SIZE = 512 * 1024;        // 512 KB por shard
const MAX_PAYLOAD_SIZE = 4 * 1024 * 1024; // 4 MB total
const SYNC_KEY_HASH_LEN = 64;

/* ── Configuração (re-avaliada a cada import via resetModules nos testes) ── */
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const CORS_STRICT = process.env.CORS_STRICT === '1';
const ALLOW_LEGACY_SYNC_AUTH = process.env.ALLOW_LEGACY_SYNC_AUTH === '1';

const SYNC_RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.SYNC_RATE_LIMIT_WINDOW_MS, 60_000);
const SYNC_RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(process.env.SYNC_RATE_LIMIT_MAX_REQUESTS, 30);
const SYNC_RATE_LIMIT_DISABLED = process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === '1';

/* ── Redis (lazy singleton) ─────────────────────────────────────── */
let redis: Redis | null = null;

function getRedis(): Redis {
    if (!redis) {
        const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
        if (!url || !token) throw new Error('Redis not configured');
        redis = new Redis({ url, token });
    }
    return redis;
}

/* ── CORS ───────────────────────────────────────────────────────── */
function getCorsOrigin(req: Request): string {
    return getCorsOriginFromRules(req, ALLOWED_ORIGINS);
}

function getCorsHeaders(req: Request): Record<string, string> {
    const allowedHeaders = ALLOW_LEGACY_SYNC_AUTH
        ? 'Content-Type, X-Sync-Key-Hash, Authorization'
        : 'Content-Type, X-Sync-Key-Hash';

    return {
        'Access-Control-Allow-Origin': getCorsOrigin(req),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': allowedHeaders,
        'Vary': 'Origin',
    };
}

/* ── Autenticação ───────────────────────────────────────────────── */
async function hashRawKey(rawKey: string): Promise<string> {
    const data = new TextEncoder().encode(rawKey);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function extractKeyHash(req: Request): Promise<string | null> {
    const direct = req.headers.get('x-sync-key-hash');
    if (direct && direct.length === SYNC_KEY_HASH_LEN && /^[0-9a-f]+$/i.test(direct)) {
        return direct.toLowerCase();
    }

    if (ALLOW_LEGACY_SYNC_AUTH) {
        const auth = req.headers.get('authorization');
        if (auth?.startsWith('Bearer ')) {
            const rawKey = auth.slice(7).trim();
            if (rawKey) return await hashRawKey(rawKey);
        }
    }

    return null;
}

/* ── Validação de payload ───────────────────────────────────────── */
function validateShards(shards: Record<string, string>):
    { valid: true } | { valid: false; status: number; code: string; detail?: string } {

    const keys = Object.keys(shards);
    if (keys.length > MAX_SHARDS) {
        return { valid: false, status: 413, code: 'SHARD_LIMIT_EXCEEDED' };
    }

    let totalSize = 0;
    for (const key of keys) {
        const size = typeof shards[key] === 'string' ? shards[key].length : 0;
        if (size > MAX_SHARD_SIZE) {
            return { valid: false, status: 413, code: 'SHARD_TOO_LARGE', detail: key };
        }
        totalSize += size;
    }

    if (totalSize > MAX_PAYLOAD_SIZE) {
        return { valid: false, status: 413, code: 'PAYLOAD_TOO_LARGE' };
    }

    return { valid: true };
}

/* ── Lua script: compare-and-swap atômico ───────────────────────── */
const LUA_SYNC_WRITE = `
local key = KEYS[1]
local clientTs = ARGV[1]
local serverTs = redis.call('hget', key, 'lastModified')

if serverTs and tonumber(serverTs) > tonumber(clientTs) then
  return {'CONFLICT'}
end

for i = 2, #ARGV, 2 do
  redis.call('hset', key, ARGV[i], ARGV[i+1])
end
redis.call('hset', key, 'lastModified', clientTs)

return {'OK'}
`;

/* ── GET /api/sync ──────────────────────────────────────────────── */
async function handleGet(keyHash: string, corsHeaders: Record<string, string>): Promise<Response> {
    const db = getRedis();
    const shards = await db.hgetall(`sync:${keyHash}`);
    return new Response(JSON.stringify(shards ?? {}), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

/* ── POST /api/sync ─────────────────────────────────────────────── */
async function handlePost(req: Request, keyHash: string, corsHeaders: Record<string, string>): Promise<Response> {
    const bodyText = await Promise.race([
        req.text(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000)),
    ]);

    let body: unknown;
    try {
        body = JSON.parse(bodyText);
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_BODY' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const { lastModified, shards } = body as Record<string, unknown>;
    if (typeof lastModified !== 'number' || !shards || typeof shards !== 'object' || Array.isArray(shards)) {
        return new Response(JSON.stringify({ error: 'Bad Request', code: 'INVALID_PAYLOAD' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const validation = validateShards(shards as Record<string, string>);
    if (!validation.valid) {
        const errBody: Record<string, string> = { error: validation.code, code: validation.code };
        if (validation.detail) errBody.detail = validation.detail;
        return new Response(JSON.stringify(errBody), {
            status: validation.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const db = getRedis();
    const redisKey = `sync:${keyHash}`;

    // Build ARGV: [lastModified, shardKey1, shardVal1, ...]
    const args: string[] = [String(lastModified)];
    for (const [k, v] of Object.entries(shards as Record<string, string>)) {
        args.push(k, String(v));
    }

    try {
        const result = await db.eval(LUA_SYNC_WRITE, [redisKey], args) as string[];

        if (Array.isArray(result) && result[0] === 'CONFLICT') {
            const serverShards = await db.hgetall(redisKey);
            return new Response(JSON.stringify(serverShards ?? {}), {
                status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({}), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (luaErr: unknown) {
        // Fallback: escrita não-atômica quando Lua está indisponível
        const msg = luaErr instanceof Error ? luaErr.message : '';
        if (msg.includes('NOSCRIPT') || msg.includes('ERR')) {
            try {
                for (const [k, v] of Object.entries(shards as Record<string, string>)) {
                    await db.hset(redisKey, { [k]: String(v) });
                }
                await db.hset(redisKey, { lastModified: String(lastModified) });
                return new Response(JSON.stringify({ fallback: true }), {
                    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            } catch {
                return new Response(JSON.stringify({ error: 'Storage error', code: 'STORAGE_ERROR' }), {
                    status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
        }

        return new Response(JSON.stringify({ error: 'Atomic sync unavailable', code: 'LUA_UNAVAILABLE' }), {
            status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}

/* ── Handler principal ──────────────────────────────────────────── */
export default async function handler(req: Request) {
    const reqOrigin = req.headers.get('origin') || '';
    const corsHeaders = getCorsHeaders(req);

    if (CORS_STRICT && ALLOWED_ORIGINS.length > 0 && reqOrigin && !isOriginAllowed(req, reqOrigin, ALLOWED_ORIGINS)) {
        return new Response(JSON.stringify({ error: 'Origin not allowed', code: 'CORS_DENIED' }), {
            status: 403, headers: corsHeaders,
        });
    }

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
        return new Response(null, { status: 405 });
    }

    const ip = getClientIp(req);
    const limiter = await checkRateLimit({
        namespace: 'sync',
        key: ip,
        windowMs: SYNC_RATE_LIMIT_WINDOW_MS,
        maxRequests: SYNC_RATE_LIMIT_MAX_REQUESTS,
        disabled: SYNC_RATE_LIMIT_DISABLED,
        localMaxEntries: 4000,
    });
    if (limiter.limited) {
        return new Response(JSON.stringify({ error: 'Too Many Requests', code: 'RATE_LIMITED' }), {
            status: 429, headers: { ...corsHeaders, 'Retry-After': String(limiter.retryAfterSec) },
        });
    }

    const keyHash = await extractKeyHash(req);
    if (!keyHash) {
        return new Response(JSON.stringify({ error: 'Unauthorized', code: 'AUTH_MISSING' }), {
            status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    if (req.method === 'GET') return handleGet(keyHash, corsHeaders);
    return handlePost(req, keyHash, corsHeaders);
}

