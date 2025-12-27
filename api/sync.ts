
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
 */

import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// --- CONSTANTS & CONFIG ---
const MAX_PAYLOAD_SIZE = 1 * 1024 * 1024; // 1MB Limit

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
            let clientPayload: SyncPayload;
            try {
                clientPayload = await req.json();
            } catch (e) {
                return new Response(ERR_INVALID_JSON, { status: 400, headers: HEADERS_JSON });
            }

            // Validation
            if (!clientPayload || typeof clientPayload.lastModified !== 'number' || typeof clientPayload.state !== 'string') {
                return new Response(ERR_INVALID_PAYLOAD, { status: 400, headers: HEADERS_JSON });
            }
            
            if (clientPayload.state.length > MAX_PAYLOAD_SIZE) {
                return new Response(ERR_PAYLOAD_TOO_LARGE, { status: 413, headers: HEADERS_JSON });
            }

            // Optimistic Locking
            const storedData = await kv.get<SyncPayload>(dataKey);

            if (storedData) {
                // Idempotency: Se timestamp é igual, não gasta escrita (304 Not Modified)
                if (clientPayload.lastModified === storedData.lastModified) {
                    return new Response(null, { status: 304, headers: CORS_HEADERS });
                }
                
                // Conflict: Cliente está desatualizado (409 Conflict)
                if (clientPayload.lastModified < storedData.lastModified) {
                    return new Response(JSON.stringify(storedData), {
                        status: 409, 
                        headers: HEADERS_JSON,
                    });
                }
            }

            // Write (Last Write Wins if timestamp is newer)
            await kv.set(dataKey, clientPayload);
            
            // Static Success Response
            return new Response(SUCCESS_JSON, {
                status: 200,
                headers: HEADERS_JSON,
            });
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
