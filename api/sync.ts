/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// --- Constantes ---
// MELHORIA DE ROBUSTEZ: Define um limite de tamanho para o payload (1MB) para prevenir abuso.
const MAX_PAYLOAD_SIZE = 1 * 1024 * 1024; 

// --- Tipos e Interfaces ---
// CONSOLIDAÇÃO DE TIPO: As interfaces ClientPayload e StoredData foram unificadas em SyncPayload para eliminar redundância.
interface SyncPayload {
    lastModified: number;
    state: string; // string criptografada
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
};

const createErrorResponse = (message: string, status: number, details = '') => {
    return new Response(JSON.stringify({ error: message, details }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
};

const getSyncKeyHash = (req: Request): string | null => {
    return req.headers.get('x-sync-key-hash');
};

/**
 * REATORAÇÃO DE MODULARIDADE: Lida com requisições GET.
 * @param dataKey A chave para buscar no Vercel KV.
 * @returns Uma resposta com os dados armazenados ou nulo.
 */
async function handleGetRequest(dataKey: string): Promise<Response> {
    const storedData = await kv.get<SyncPayload>(dataKey);
    return new Response(JSON.stringify(storedData || null), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

/**
 * REATORAÇÃO DE MODULARIDADE: Lida com requisições POST.
 * @param req O objeto da requisição.
 * @param dataKey A chave para buscar/armazenar no Vercel KV.
 * @returns Uma resposta indicando sucesso, conflito ou não modificação.
 */
async function handlePostRequest(req: Request, dataKey: string): Promise<Response> {
    let clientPayload: SyncPayload;
    try {
        clientPayload = await req.json();
    } catch (e) {
        return createErrorResponse('Bad Request: Invalid JSON format', 400);
    }

    if (!clientPayload || typeof clientPayload.lastModified !== 'number' || typeof clientPayload.state !== 'string') {
        return createErrorResponse('Bad Request: Invalid or missing payload data', 400);
    }
    
    // MELHORIA DE ROBUSTEZ: Verifica o tamanho do payload para evitar sobrecarga do armazenamento.
    if (clientPayload.state.length > MAX_PAYLOAD_SIZE) {
        return createErrorResponse('Payload Too Large', 413, `Payload size exceeds the limit of ${MAX_PAYLOAD_SIZE} bytes.`);
    }

    const storedData = await kv.get<SyncPayload>(dataKey);

    if (storedData) {
        if (clientPayload.lastModified === storedData.lastModified) {
            return new Response(null, {
                status: 304, // Not Modified
                headers: corsHeaders,
            });
        }
        
        if (clientPayload.lastModified < storedData.lastModified) {
            return new Response(JSON.stringify(storedData), {
                status: 409, // Conflict
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    }

    await kv.set(dataKey, clientPayload);
    
    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        const keyHash = getSyncKeyHash(req);

        if (!keyHash) {
            return createErrorResponse('Unauthorized: Missing sync key hash', 401);
        }
        
        const dataKey = `sync_data:${keyHash}`;

        if (req.method === 'GET') {
            return await handleGetRequest(dataKey);
        }

        if (req.method === 'POST') {
            return await handlePostRequest(req, dataKey);
        }

        return createErrorResponse('Method not allowed', 405);

    } catch (error) {
        console.error("Error in sync API handler:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        return createErrorResponse('Internal Server Error', 500, errorMessage);
    }
}