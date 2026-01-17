/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// --- Tipos e Interfaces ---
// A estrutura que o cliente envia. O 'state' é uma string criptografada.
interface ClientPayload {
    lastModified: number;
    state: string;
}

// A estrutura que realmente armazenamos no Vercel KV.
interface StoredData {
    lastModified: number;
    state: string; // string criptografada
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
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
            return new Response(JSON.stringify({ error: 'Unauthorized: Missing sync key hash' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
        
        const dataKey = `sync_data:${keyHash}`;

        if (req.method === 'GET') {
            const storedData = await kv.get<StoredData>(dataKey);
            // Retorna o objeto StoredData completo ou nulo se não encontrado.
            return new Response(JSON.stringify(storedData || null), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (req.method === 'POST') {
            const clientPayload: ClientPayload = await req.json();
            const storedData = await kv.get<StoredData>(dataKey);

            if (storedData) {
                // Conflito: os dados do cliente são mais antigos que os do servidor.
                if (clientPayload.lastModified < storedData.lastModified) {
                    return new Response(JSON.stringify(storedData), {
                        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }
                // A lógica 'isStateSignificant' foi removida, pois o servidor não pode mais inspecionar o estado.
            }

            // Sem conflitos, ou é a primeira sincronização. Salva o payload do cliente.
            const dataToStore: StoredData = {
                lastModified: clientPayload.lastModified,
                state: clientPayload.state,
            };
            await kv.set(dataKey, dataToStore);
            
            return new Response(JSON.stringify({ success: true }), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error in /api/sync:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}