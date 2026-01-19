
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * VERSÃO: Production Grade - Hash-Based Multi-Tenancy
 * Ajustada para aceitar 'Authorization: Bearer' e gerar hash no servidor.
 * INCLUI: Server-Side Logging para Diagnóstico.
*/

import { createClient } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

// Script Lua para garantir atualizações atômicas e resolver conflitos de timestamp
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
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash, Authorization',
};

async function sha256(message: string) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS_BASE });

    const dbUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const dbToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!dbUrl || !dbToken) {
         console.error("[API] CRITICAL: Missing Database Config");
         return new Response(JSON.stringify({ error: 'Server Config Error' }), { status: 500, headers: HEADERS_BASE });
    }

    const kv = createClient({ url: dbUrl, token: dbToken });

    try {
        console.log(`[API] Incoming Request: ${req.method}`);

        // --- AUTENTICAÇÃO FLEXÍVEL ---
        let keyHash = req.headers.get('x-sync-key-hash');
        let authMethod = 'HashHeader';
        
        if (!keyHash) {
            const authHeader = req.headers.get('Authorization');
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const rawKey = authHeader.replace('Bearer ', '').trim();
                if (rawKey.length >= 8) {
                    keyHash = await sha256(rawKey);
                    authMethod = 'BearerFallback';
                }
            }
        }

        if (!keyHash || !/^[a-f0-9]{64}$/i.test(keyHash)) {
            console.warn(`[API] Auth Failed. Method: ${authMethod}, HashValid: ${!!keyHash}`);
            return new Response(JSON.stringify({ error: 'Unauthorized: Missing or Invalid Key' }), { status: 401, headers: HEADERS_BASE });
        }
        
        console.log(`[API] Auth Success (${authMethod}). Hash prefix: ${keyHash.substring(0, 8)}...`);
        
        const dataKey = `sync_v2:${keyHash}`;

        if (req.method === 'GET') {
            const storedData = await kv.get(dataKey);
            console.log(`[API] GET: ${storedData ? 'Data found' : 'No data'}`);
            return new Response(JSON.stringify(storedData || null), { status: 200, headers: HEADERS_BASE });
        }

        if (req.method === 'POST') {
            const bodyText = await req.text();
            
            if (bodyText.length > MAX_PAYLOAD_SIZE * 1.1) {
                console.warn(`[API] POST: Payload too large (${bodyText.length} bytes)`);
                return new Response(JSON.stringify({ error: 'Payload Too Large' }), { status: 413, headers: HEADERS_BASE });
            }

            let clientPayload;
            try { clientPayload = JSON.parse(bodyText); } 
            catch { return new Response(JSON.stringify({ error: 'Malformed JSON' }), { status: 400, headers: HEADERS_BASE }); }

            if (!clientPayload?.lastModified || typeof clientPayload.lastModified !== 'number') {
                clientPayload.lastModified = Date.now();
            }

            const result = await kv.eval(LUA_ATOMIC_UPDATE, [dataKey], [bodyText, String(clientPayload.lastModified)]) as [string, string?];
            
            console.log(`[API] POST Result: ${result[0]}`);

            if (result[0] === 'OK') return new Response('{"success":true}', { status: 200, headers: HEADERS_BASE });
            if (result[0] === 'NOT_MODIFIED') return new Response(null, { status: 304, headers: HEADERS_BASE });
            if (result[0] === 'CONFLICT') return new Response(result[1], { status: 409, headers: HEADERS_BASE });
            return new Response(JSON.stringify({ error: result[1] }), { status: 400, headers: HEADERS_BASE });
        }

        return new Response(null, { status: 405 });

    } catch (error: any) {
        console.error("[API] Unhandled Error:", error);
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), { status: 500, headers: HEADERS_BASE });
    }
}
