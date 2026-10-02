
/**
 * @license
 * SPDX-License-Identifier: MIT
*/

import { readRequestBody, RequestBodyError } from './_requestBody';
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

const SHOULD_LOG = typeof process !== 'undefined' && !!process.env && process.env.NODE_ENV !== 'production';
const logger = {
        error: (message: string, error?: unknown) => {
                if (!SHOULD_LOG) return;
                if (error !== undefined) console.error(message, error);
                else console.error(message);
        }
};

export const LUA_SHARDED_UPDATE = `
local key = KEYS[1]
local registry = KEYS[2]
local newTs = tonumber(ARGV[1])
local purge = ARGV[3] == "1"
local generation = ARGV[4]
local maxBytes = tonumber(ARGV[5])
local maxShards = tonumber(ARGV[6])
local maxVaults = tonumber(ARGV[7])
local exists = redis.call('EXISTS', key) == 1
local currentTs = tonumber(redis.call('HGET', key, 'lastModified') or 0)
local currentGeneration = redis.call('HGET', key, 'accountGeneration') or 'legacy'
if not newTs then return {'ERROR', 'INVALID_TS'} end
if purge and exists and generation == currentGeneration then return {'OK'} end
if not purge and exists and (generation ~= currentGeneration or newTs < currentTs) then
    return {'CONFLICT', redis.call('HGETALL', key)}
end
local ok, shards = pcall(cjson.decode, ARGV[2])
if not ok or type(shards) ~= 'table' then return {'ERROR', 'INVALID_JSON'} end
local total = 0
local count = 0
local old = {}
if not purge then
    local fields = redis.call('HGETALL', key)
    for i = 1, #fields, 2 do
        local name = fields[i]
        if name ~= 'lastModified' and name ~= 'resetAt' and name ~= 'accountGeneration' then
            old[name] = fields[i+1]
            total = total + string.len(fields[i+1])
            count = count + 1
        end
    end
end
for name, data in pairs(shards) do
    if type(data) ~= 'string' then return {'ERROR', 'INVALID_SHARD_TYPE'} end
    if old[name] then total = total - string.len(old[name]) else count = count + 1 end
    total = total + string.len(data)
end
if total > maxBytes or count > maxShards then return {'ERROR', 'VAULT_QUOTA_EXCEEDED'} end
if not exists and redis.call('SCARD', registry) >= maxVaults then return {'ERROR', 'VAULT_CAPACITY_REACHED'} end
-- Todas as validações precedem o DEL/HSET: falha nunca deixa reset parcial.
if purge then
    redis.call('DEL', key)
    newTs = math.max(newTs, currentTs + 1)
    redis.call('HSET', key, 'resetAt', newTs)
end
redis.call('SADD', registry, key)
for name, data in pairs(shards) do redis.call('HSET', key, name, data) end
redis.call('HSET', key, 'lastModified', newTs, 'accountGeneration', generation)
return {'OK'}
`;

const MAX_SHARDS_PER_REQUEST = 256;
const MAX_SHARD_VALUE_BYTES = 512 * 1024; // 512KB por shard
const MAX_TOTAL_SHARDS_BYTES = 4 * 1024 * 1024; // 4MB total
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024; // 5MB total bruto

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
const CORS_STRICT = process.env.CORS_STRICT === '1';
const SYNC_HASH_REGEX = /^[a-f0-9]{64}$/i;

function getCorsOrigin(req: Request): string {
    return getCorsOriginFromRules(req, ALLOWED_ORIGINS);
}

function getResponseHeaders(req: Request): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': getCorsOrigin(req),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
        'Vary': 'Origin'
    };
}

function withEtag(headers: Record<string, string>, etag: string): Record<string, string> {
    return {
        ...headers,
        'ETag': etag
    };
}

function isRequestBodyTooLarge(req: Request): boolean {
    const contentLength = req.headers.get('content-length');
    if (!contentLength) return false;

    const parsed = Number(contentLength);
    return Number.isFinite(parsed) && parsed > MAX_REQUEST_BODY_BYTES;
}

async function sha256(message: string) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const SYNC_RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.SYNC_RATE_LIMIT_WINDOW_MS, 60_000);
const SYNC_RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(process.env.SYNC_RATE_LIMIT_MAX_REQUESTS, 120);
const SYNC_RATE_LIMIT_DISABLED = process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === '1';

type ErrorLike = { message?: string };

type SyncPostBody = {
    lastModified?: unknown;
    shards?: Record<string, unknown>;
    purge?: unknown;
    accountGeneration?: unknown;
};

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && typeof (error as ErrorLike).message === 'string') return (error as ErrorLike).message as string;
    return 'Internal Server Error';
}

/**
 * O cliente envia apenas o HASH da chave de sync (X-Sync-Key-Hash). A chave bruta
 * nunca sai do dispositivo: ela deriva a criptografia dos dados, então o servidor
 * conhecê-la anularia a premissa zero-knowledge.
 */
function extractKeyHash(req: Request): string | null {
    const directHash = req.headers.get('x-sync-key-hash')?.trim() || '';
    return SYNC_HASH_REGEX.test(directHash) ? directHash : null;
}

export default async function handler(req: Request) {
    const reqOrigin = req.headers.get('origin') || '';
    const HEADERS_BASE = getResponseHeaders(req);
    if (CORS_STRICT && ALLOWED_ORIGINS.length > 0 && reqOrigin && !isOriginAllowed(req, reqOrigin, ALLOWED_ORIGINS)) {
        return new Response(JSON.stringify({ error: 'Origin not allowed', code: 'CORS_DENIED' }), {
            status: 403,
            headers: HEADERS_BASE
        });
    }

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS_BASE });

    const dbUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const dbToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!dbUrl || !dbToken) {
         return new Response(JSON.stringify({ error: 'Server Config Error' }), { status: 500, headers: HEADERS_BASE });
    }

    const kv = new Redis({ url: dbUrl, token: dbToken });

    try {
        const keyHash = extractKeyHash(req);

        if (!keyHash || !SYNC_HASH_REGEX.test(keyHash)) {
            return new Response(JSON.stringify({ error: 'Auth Required' }), { status: 401, headers: HEADERS_BASE });
        }

        const ip = getClientIp(req);
        const limitOptions = {
            windowMs: SYNC_RATE_LIMIT_WINDOW_MS, maxRequests: SYNC_RATE_LIMIT_MAX_REQUESTS,
            disabled: SYNC_RATE_LIMIT_DISABLED, requireDistributed: true
        };
        const ipLimit = await checkRateLimit({ ...limitOptions, namespace: 'sync-ip', key: ip });
        const identityLimit = ipLimit.limited ? ipLimit
            : await checkRateLimit({ ...limitOptions, namespace: 'sync-vault', key: keyHash });
        const limiter = identityLimit.limited ? identityLimit
            : await checkRateLimit({ ...limitOptions, namespace: 'sync-global', key: 'all',
                maxRequests: parsePositiveInt(process.env.SYNC_GLOBAL_RATE_LIMIT, 600) });
        if (limiter.limited) {
            return new Response(JSON.stringify({ error: 'Too Many Requests', code: 'RATE_LIMITED' }), {
                status: 429,
                headers: {
                    ...HEADERS_BASE,
                    'Retry-After': String(limiter.retryAfterSec)
                }
            });
        }
        
        const dataKey = `sync_v3:${keyHash}`;

        if (req.method === 'GET') {
            const allData = await kv.hgetall(dataKey);
            if (!allData) return new Response('null', { status: 200, headers: HEADERS_BASE });
            const payload = JSON.stringify(allData);
            const etag = `"${await sha256(payload)}"`;
            const ifNoneMatch = req.headers.get('if-none-match');
            if (ifNoneMatch && ifNoneMatch === etag) {
                return new Response(null, { status: 304, headers: withEtag(HEADERS_BASE, etag) });
            }
            return new Response(payload, { status: 200, headers: withEtag(HEADERS_BASE, etag) });
        }

        if (req.method === 'POST') {
            if (isRequestBodyTooLarge(req)) {
                return new Response(JSON.stringify({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE', detail: 'content-length' }), { status: 413, headers: HEADERS_BASE });
            }

            const rawBody = await readRequestBody(req, MAX_REQUEST_BODY_BYTES);
            const rawBodyBytes = new TextEncoder().encode(rawBody).length;
            if (rawBodyBytes > MAX_REQUEST_BODY_BYTES) {
                return new Response(JSON.stringify({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE', detail: 'body' }), { status: 413, headers: HEADERS_BASE });
            }

            let body: SyncPostBody;
            try {
                body = JSON.parse(rawBody) as SyncPostBody;
            } catch {
                return new Response(JSON.stringify({ error: 'Invalid JSON', code: 'INVALID_JSON' }), { status: 400, headers: HEADERS_BASE });
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return new Response(null, { status: 400, headers: HEADERS_BASE });
            }
            const { lastModified, shards, purge } = body;
            const generation = body.accountGeneration ?? (purge === true ? crypto.randomUUID() : 'legacy');
            if (typeof generation !== 'string' || !/^(legacy|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(generation) || (purge === true && generation === 'legacy')) {
                return new Response(JSON.stringify({ code: 'INVALID_GENERATION' }), { status: 400, headers: HEADERS_BASE });
            }

            if (purge !== undefined && typeof purge !== 'boolean') {
                return new Response(JSON.stringify({ error: 'Invalid purge flag', code: 'INVALID_PURGE' }), { status: 400, headers: HEADERS_BASE });
            }

            if (lastModified === undefined) {
                return new Response(JSON.stringify({ error: 'Missing lastModified' }), { status: 400, headers: HEADERS_BASE });
            }
            if (!shards || typeof shards !== 'object' || Array.isArray(shards)) {
                return new Response(JSON.stringify({ error: 'Invalid or missing shards' }), { status: 400, headers: HEADERS_BASE });
            }

            const shardEntries = Object.entries(shards);
            if (shardEntries.length > MAX_SHARDS_PER_REQUEST) {
                return new Response(JSON.stringify({ error: 'Too many shards', code: 'SHARD_LIMIT_EXCEEDED' }), { status: 413, headers: HEADERS_BASE });
            }

            const lastModifiedNum = Number(lastModified);
            if (!Number.isSafeInteger(lastModifiedNum) || lastModifiedNum < 0) {
                return new Response(JSON.stringify({ error: 'Invalid lastModified', code: 'INVALID_TS' }), { status: 400, headers: HEADERS_BASE });
            }

            let totalBytes = 0;
            for (const [shardName, shardValue] of shardEntries) {
                if (!/^(core|logs:\d{4}-(0[1-9]|1[0-2])|archive:\d{4})$/.test(shardName)) {
                    return new Response(JSON.stringify({ code: 'INVALID_SHARD_NAME' }), { status: 400, headers: HEADERS_BASE });
                }
                if (typeof shardValue !== 'string') {
                    return new Response(JSON.stringify({ error: 'Invalid shard type', code: 'INVALID_SHARD_TYPE', detail: shardName, detailType: typeof shardValue }), { status: 400, headers: HEADERS_BASE });
                }
                const shardBytes = new TextEncoder().encode(shardValue).length;
                if (shardBytes > MAX_SHARD_VALUE_BYTES) {
                    return new Response(JSON.stringify({ error: 'Shard too large', code: 'SHARD_TOO_LARGE', detail: shardName }), { status: 413, headers: HEADERS_BASE });
                }
                totalBytes += shardBytes;
                if (totalBytes > MAX_TOTAL_SHARDS_BYTES) {
                    return new Response(JSON.stringify({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' }), { status: 413, headers: HEADERS_BASE });
                }
            }

            let result: unknown = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                result = await kv.eval(LUA_SHARDED_UPDATE, [dataKey, 'sync_v3:vault-registry'], [String(lastModifiedNum), JSON.stringify(shards), purge === true ? '1' : '0', generation,
                    parsePositiveInt(process.env.SYNC_MAX_VAULT_BYTES, 16 * 1024 * 1024),
                    parsePositiveInt(process.env.SYNC_MAX_VAULT_SHARDS, 512),
                    parsePositiveInt(process.env.SYNC_MAX_VAULTS, 1000)]);
                if (Array.isArray(result)) break;
                await sleep(50);
            }

            if (!Array.isArray(result)) {
                return new Response(JSON.stringify({
                    error: 'Atomic sync unavailable',
                    code: 'LUA_UNAVAILABLE',
                    detail: 'Non-atomic fallback disabled to prevent shard desynchronization'
                }), { status: 503, headers: HEADERS_BASE });
            }
            
            if (result[0] === 'OK') return new Response('{"success":true}', { status: 200, headers: HEADERS_BASE });

            if (typeof result[0] === 'number') {
                return new Response(JSON.stringify({
                    error: 'Atomic sync unavailable',
                    code: 'LUA_UNAVAILABLE',
                    detail: 'Lua engine returned invalid format'
                }), { status: 503, headers: HEADERS_BASE });
            }
            
            if (result[0] === 'CONFLICT') {
                // Lua returns a flat array [key, val, key, val...] for HGETALL
                const rawList = Array.isArray(result[1]) ? (result[1] as string[]) : [];
                const conflictShards: Record<string, string> = {};
                for (let i = 0; i < rawList.length; i += 2) {
                    conflictShards[rawList[i]] = rawList[i+1];
                }
                return new Response(JSON.stringify(conflictShards), { status: 409, headers: HEADERS_BASE });
            }

            if (result[1] === 'VAULT_QUOTA_EXCEEDED' || result[1] === 'VAULT_CAPACITY_REACHED') {
                return new Response(JSON.stringify({ error: 'Storage capacity reached', code: result[1] }), { status: 413, headers: HEADERS_BASE });
            }
            const code = typeof result[1] === 'string' ? result[1] : 'UNKNOWN';
            const detail = typeof result[2] === 'string' ? result[2] : undefined;
            const detailType = typeof result[3] === 'string' ? result[3] : undefined;
            return new Response(JSON.stringify({ error: 'Lua Execution Error', code, detail, detailType, raw: result }), { status: 400, headers: HEADERS_BASE });
        }

        return new Response(null, { status: 405 });
    } catch (error: unknown) {
        if (error instanceof RequestBodyError) return new Response(JSON.stringify({ code: error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'REQUEST_TIMEOUT' }), { status: error.status, headers: HEADERS_BASE });
        logger.error('KV Error:', error);
        return new Response(JSON.stringify({ error: getErrorMessage(error) }), { status: 500, headers: HEADERS_BASE });
    }
}
