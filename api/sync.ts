
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file api/sync.ts
 * @description Endpoint serverless (Edge Function) para sincronização de estado criptografado via Vercel KV.
 * 
 * [SERVERLESS / EDGE FUNCTION CONTEXT]:
 * Otimizado para "Zero-Cost Abstractions".
 * - Headers e Erros estáticos são pré-alocados.
 * - Lógica "Inline" para evitar overhead de chamadas de função desnecessárias.
 * - [2025-05-01] ATOMICIDADE: Implementado Script Lua para garantir integridade em transações concorrentes.
 */

import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// --- CONSTANTS & CONFIG ---
const MAX_PAYLOAD_SIZE = 1 * 1024 * 1024; // 1MB Limit

// --- LUA SCRIPTS ---
// Script para executar a lógica de comparação de timestamp e escrita atomicamente no Redis.
// Isso previne condições de corrida onde uma leitura antiga sobrescreve uma escrita nova.
// Retorna um array: [STATUS, DADOS_OPCIONAIS]
const LUA_ATOMIC_UPDATE = `
local key = KEYS[1]
local newPayload = ARGV[1]
local newTs = tonumber(ARGV[2])

local currentVal = redis.call("GET", key)

if not currentVal then
    redis.call("SET", key, newPayload)
    return { "OK" }
end

-- Decodifica apenas o necessário se possível, mas cjson.decode parseia tudo.
-- Usamos pcall (protected call) para evitar crash se o JSON do banco estiver corrompido.
local status, currentJson = pcall(cjson.decode, currentVal)

if not status then
    -- Se o JSON no banco estiver corrompido, sobrescrevemos (Auto-healing)
    redis.call("SET", key, newPayload)
    return { "OK" }
end

local currentTs = tonumber(currentJson.lastModified)

if not currentTs then
    -- Se não houver timestamp válido, assume dado legado/inválido e sobrescreve
    redis.call("SET", key, newPayload)
    return { "OK" }
end

if newTs == currentTs then
    return { "NOT_MODIFIED" }
end

if newTs < currentTs then
    -- Cliente está desatualizado: Retorna o dado do servidor para resolução de conflito
    return { "CONFLICT", currentVal }
end

-- Last Write Wins (se newTs > currentTs)
redis.call("SET", key, newPayload)
return { "OK" }
`;

// --- STATIC OBJECTS (Zero-Allocation) ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
};

const HEADERS_JSON = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json',
};

// --- STATIC ERRORS (Pre-serialized) ---
// Economiza CPU evitando JSON.stringify repetitivo em erros comuns
const ERR_METHOD_NOT_ALLOWED = JSON.stringify({ error: 'Method not allowed' });
const ERR_UNAUTHORIZED = JSON.stringify({ error: 'Unauthorized: Missing sync key hash' });
const ERR_INVALID_JSON = JSON.stringify({ error: 'Bad Request: Invalid JSON format' });
const ERR_INVALID_PAYLOAD = JSON.stringify({ error: 'Bad Request: Invalid or missing payload data' });
const ERR_PAYLOAD_TOO_LARGE = JSON.stringify({ error: 'Payload Too Large', details: `Payload size exceeds the limit of ${MAX_PAYLOAD_SIZE} bytes.` });
const ERR_LENGTH_REQUIRED = JSON.stringify({ error: 'Length Required', details: 'Content-Length header is missing.' });
const SUCCESS_JSON = '{"success":true}'; // Static success response

// --- TYPES ---
interface SyncPayload {
    lastModified: number;
    state: string;
}

export default async function handler(req: Request) {
    // Fast Path: Preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        // Authentication Check
        const keyHash = req.headers.get('x-sync-key-hash');
        if (!keyHash) {
            return new Response(ERR_UNAUTHORIZED, { status: 401, headers: HEADERS_JSON });
        }
        
        const dataKey = `sync_data:${keyHash}`;

        // --- GET HANDLER ---
        if (req.method === 'GET') {
            const storedData = await kv.get<SyncPayload>(dataKey);
            // kv.get returns null if not found, which JSON.stringify handles correctly ("null")
            return new Response(JSON.stringify(storedData || null), {
                status: 200,
                headers: HEADERS_JSON,
            });
        }

        // --- POST HANDLER ---
        if (req.method === 'POST') {
            // SECURITY: Pre-check Content-Length to prevent OOM
            const contentLengthStr = req.headers.get('content-length');
            if (!contentLengthStr) {
                return new Response(ERR_LENGTH_REQUIRED, { status: 411, headers: HEADERS_JSON });
            }
            
            const contentLength = parseInt(contentLengthStr, 10);
            if (isNaN(contentLength) || contentLength > MAX_PAYLOAD_SIZE) {
                return new Response(ERR_PAYLOAD_TOO_LARGE, { status: 413, headers: HEADERS_JSON });
            }

            let clientPayload: SyncPayload;
            try {
                // Now safe to parse
                clientPayload = await req.json();
            } catch (e) {
                return new Response(ERR_INVALID_JSON, { status: 400, headers: HEADERS_JSON });
            }

            // Validation
            if (!clientPayload || typeof clientPayload.lastModified !== 'number' || typeof clientPayload.state !== 'string') {
                return new Response(ERR_INVALID_PAYLOAD, { status: 400, headers: HEADERS_JSON });
            }
            
            // Double check actual string length (Content-Length might be gzipped or inaccurate)
            if (clientPayload.state.length > MAX_PAYLOAD_SIZE) {
                return new Response(ERR_PAYLOAD_TOO_LARGE, { status: 413, headers: HEADERS_JSON });
            }

            // ATOMIC OPERATION (Redis Lua)
            // Serializa o payload uma vez para enviar ao Redis
            const payloadStr = JSON.stringify(clientPayload);
            
            // kv.eval(script, keys[], args[])
            // O cast é necessário pois a tipagem de retorno do eval é genérica
            const result = await kv.eval(
                LUA_ATOMIC_UPDATE, 
                [dataKey], 
                [payloadStr, clientPayload.lastModified]
            ) as [string, string?];

            const [status, conflictData] = result;

            if (status === 'OK') {
                // Sucesso ou Auto-healing
                return new Response(SUCCESS_JSON, {
                    status: 200,
                    headers: HEADERS_JSON,
                });
            }
            
            if (status === 'NOT_MODIFIED') {
                // Idempotência
                return new Response(null, { status: 304, headers: CORS_HEADERS });
            }

            if (status === 'CONFLICT' && conflictData) {
                // Retorna o dado mais novo do servidor para que o cliente faça o Smart Merge
                return new Response(conflictData, {
                    status: 409, 
                    headers: HEADERS_JSON,
                });
            }

            // Fallback para retorno desconhecido do Lua
            throw new Error(`Unexpected Lua result: ${status}`);
        }

        // Fallback
        return new Response(ERR_METHOD_NOT_ALLOWED, { status: 405, headers: HEADERS_JSON });

    } catch (error: any) {
        console.error("Critical error in api/sync:", error);
        // Dynamic error needs dynamic serialization
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), {
            status: 500,
            headers: HEADERS_JSON,
        });
    }
}
