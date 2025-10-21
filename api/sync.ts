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

// Extrai o hash da chave de sincronização do cabeçalho personalizado.
const getSyncKeyHash = (req: Request): string | null => {
    return req.headers.get('X-Sync-Key-Hash');
};


export default async function handler(req: Request) {
    try {
        const keyHash = getSyncKeyHash(req);

        if (!keyHash) {
            return new Response(JSON.stringify({ error: 'Unauthorized: Missing sync key hash' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        
        const dataKey = `sync_data:${keyHash}`;

        if (req.method === 'GET') {
            // Busca no Vercel KV
            const data = await kv.get(dataKey);

            if (!data) {
                return new Response(JSON.stringify({ message: 'No data found for this sync key.' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            return new Response(JSON.stringify(data), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (req.method === 'POST') {
            const body = await req.json();
            
            // Escrita no Vercel KV
            await kv.set(dataKey, body);
            
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error in /api/sync:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}