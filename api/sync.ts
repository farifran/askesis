/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 0% concluído. Todos os arquivos precisam ser revisados. Quando um arquivo atingir 100%, não será mais necessário revisá-lo.
// [2024-12-23]: Refatoração final para remover "magic strings" e padronizar a criação de respostas HTTP.
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// --- Tipos e Interfaces ---
interface ClientPayload {
    lastModified: number;
    state: string;
}

interface StoredData {
    lastModified: number;
    state: string;
}

// --- Constantes ---
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
};

// [2024-12-23]: Remove a "magic string" para a chave do KV, melhorando a manutenibilidade.
const SYNC_DATA_PREFIX = 'sync_data:';

// --- Helpers de Resposta ---
const createErrorResponse = (message: string, status: number, details = '') => {
    return new Response(JSON.stringify({ error: message, details }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
};

// [2024-12-23]: Adicionados helpers para padronizar todas as respostas HTTP.
const createSuccessResponse = (body: any, status = 200) => {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
};

const createConflictResponse = (body: StoredData) => {
    return new Response(JSON.stringify(body), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
};

const createNotModifiedResponse = () => {
    return new Response(null, {
        status: 304,
        headers: corsHeaders,
    });
};


const getSyncKeyHash = (req: Request): string | null => {
    return req.headers.get('x-sync-key-hash');
};

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
        const keyHash = getSyncKeyHash(req);

        if (!keyHash) {
            return createErrorResponse('Unauthorized: Missing sync key hash', 401);
        }
        
        // [2024-12-23]: Utiliza a constante em vez da string literal.
        const dataKey = `${SYNC_DATA_PREFIX}${keyHash}`;

        if (req.method === 'GET') {
            const storedData = await kv.get<StoredData>(dataKey);
            return createSuccessResponse(storedData || null);
        }

        if (req.method === 'POST') {
            const clientPayload: ClientPayload = await req.json();

            if (!clientPayload || typeof clientPayload.lastModified !== 'number' || typeof clientPayload.state !== 'string') {
                return createErrorResponse('Bad Request: Invalid or missing payload data', 400);
            }

            const storedData = await kv.get<StoredData>(dataKey);

            if (storedData) {
                if (clientPayload.lastModified === storedData.lastModified) {
                    // [2024-12-23]: Utiliza o helper de resposta.
                    return createNotModifiedResponse();
                }
                
                if (clientPayload.lastModified < storedData.lastModified) {
                    // [2024-12-23]: Utiliza o helper de resposta de conflito.
                    return createConflictResponse(storedData);
                }
            }

            const dataToStore: StoredData = {
                lastModified: clientPayload.lastModified,
                state: clientPayload.state,
            };
            await kv.set(dataKey, dataToStore);
            
            // [2024-12-23]: Utiliza o helper de resposta de sucesso.
            return createSuccessResponse({ success: true });
        }

        return createErrorResponse('Method not allowed', 405);

    } catch (error) {
        console.error("Error in sync API handler:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        return createErrorResponse('Internal Server Error', 500, errorMessage);
    }
}