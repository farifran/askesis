/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// NOTA: Para este arquivo funcionar no seu projeto Vercel, você precisará:
// 1. Instalar o SDK do Vercel KV: `npm install @vercel/kv`
// 2. Configurar um armazenamento Vercel KV no seu projeto Vercel.
//
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// Define os cabeçalhos CORS para reutilização.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
};

// Extrai o hash da chave de sincronização do cabeçalho personalizado.
// Os nomes dos cabeçalhos são insensíveis a maiúsculas e minúsculas, então usamos letras minúsculas por convenção.
const getSyncKeyHash = (req: Request): string | null => {
    return req.headers.get('x-sync-key-hash');
};


export default async function handler(req: Request) {
    // Adicionado: Manipulador para solicitações de preflight OPTIONS do CORS.
    // Isso é crucial para que os navegadores permitam solicitações com cabeçalhos personalizados como 'X-Sync-Key-Hash'.
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204, // No Content
            headers: corsHeaders,
        });
    }

    try {
        const keyHash = getSyncKeyHash(req);

        if (!keyHash) {
            return new Response(JSON.stringify({ error: 'Unauthorized: Missing sync key hash' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
        
        const dataKey = `sync_data:${keyHash}`;

        if (req.method === 'GET') {
            const data = await kv.get(dataKey);

            // Retorna os dados se encontrados, ou nulo se não. Sempre com status 200 OK.
            return new Response(JSON.stringify(data || null), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (req.method === 'POST') {
            const body = await req.json();
            
            await kv.set(dataKey, body);
            
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error in /api/sync:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}