
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { createClient } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

const LUA_ATOMIC_UPDATE = `
local key = KEYS[1]
local newPayload = ARGV[1]
local newTs = tonumber(ARGV[2])

if not newTs then return { "ERROR", "Invalid Timestamp Argument" } end

local currentVal = redis.call("GET", key)
if not currentVal then
    redis.call("SET", key, newPayload)
    return { "OK" }
end

local status, currentJson = pcall(cjson.decode, currentVal)
if not status or type(currentJson) ~= "table" or type(currentJson.lastModified) ~= "number" then
    redis.call("SET", key, newPayload)
    return { "OK" }
end

local currentTs = tonumber(currentJson.lastModified)
if newTs == currentTs then return { "NOT_MODIFIED" } end
if newTs < currentTs then return { "CONFLICT", currentVal } end

redis.call("SET", key, newPayload)
return { "OK" }
`;

const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*', 
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
};

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS_BASE });

    // HYBRID CONNECTION STRATEGY:
    // Tenta conectar usando as variáveis padrão do Vercel KV.
    // Se não existirem, tenta as variáveis da integração direta da Upstash.
    const dbUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const dbToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!dbUrl || !dbToken) {
         console.error("Missing Database Config. Checked for KV_* and UPSTASH_REDIS_* variables.");
         return new Response(JSON.stringify({ error: 'Server Error: Database Configuration Missing' }), { status: 500, headers: HEADERS_BASE });
    }

    // Cria uma instância do cliente dinamicamente com as credenciais encontradas
    const kv = createClient({
        url: dbUrl,
        token: dbToken,
    });

    try {
        const keyHash = req.headers.get('x-sync-key-hash');
        if (!keyHash || !/^[a-f0-9]{64}$/i.test(keyHash)) {
            return new Response(JSON.stringify({ error: 'Unauthorized: Missing or Invalid Key Hash' }), { status: 401, headers: HEADERS_BASE });
        }
        
        const dataKey = `sync_v2:${keyHash}`;

        if (req.method === 'GET') {
            const storedData = await kv.get(dataKey);
            return new Response(JSON.stringify(storedData || null), { status: 200, headers: HEADERS_BASE });
        }

        if (req.method === 'POST') {
            const bodyPromise = req.text();
            const timeoutPromise = new Promise<string>((_, reject) => 
                setTimeout(() => reject(new Error('Body Timeout')), 10000)
            );

            const bodyText = await Promise.race([bodyPromise, timeoutPromise]);

            if (bodyText.length > MAX_PAYLOAD_SIZE * 1.1) {
                return new Response(JSON.stringify({ error: 'Payload Too Large' }), { status: 413, headers: HEADERS_BASE });
            }

            let clientPayload;
            try {
                clientPayload = JSON.parse(bodyText);
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Malformed JSON' }), { status: 400, headers: HEADERS_BASE });
            }

            if (!clientPayload?.lastModified || typeof clientPayload.lastModified !== 'number') {
                return new Response(JSON.stringify({ error: 'Invalid Metadata' }), { status: 400, headers: HEADERS_BASE });
            }

            const result = await kv.eval(LUA_ATOMIC_UPDATE, [dataKey], [bodyText, String(clientPayload.lastModified)]) as [string, string?];

            if (result[0] === 'OK') return new Response('{"success":true}', { status: 200, headers: HEADERS_BASE });
            if (result[0] === 'NOT_MODIFIED') return new Response(null, { status: 304, headers: HEADERS_BASE });
            if (result[0] === 'CONFLICT') return new Response(result[1], { status: 409, headers: HEADERS_BASE });
            if (result[0] === 'ERROR') return new Response(JSON.stringify({ error: result[1] }), { status: 400, headers: HEADERS_BASE });
        }

        return new Response(null, { status: 405 });
    } catch (error: any) {
        console.error("API Sync Error:", error);
        const status = error.message === 'Body Timeout' ? 408 : 500;
        return new Response(JSON.stringify({ error: error.message || 'Server Error' }), { status, headers: HEADERS_BASE });
    }
}
