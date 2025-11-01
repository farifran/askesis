/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 95% concluído. O endpoint foi otimizado para lidar com o caso de não modificação (304), melhorando a eficiência. A lógica de tratamento de conflitos e segurança é robusta.
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

// REFACTOR [2024-08-08]: Introduz a função createErrorResponse para centralizar
// a criação de respostas de erro, melhorando a consistência do código e reduzindo a redundância,
// alinhando-se com as práticas de outros endpoints da API como /api/analyze.
const createErrorResponse = (message: string, status: number, details = '') => {
    return new Response(JSON.stringify({ error: message, details }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
                // OTIMIZAÇÃO DE PERFORMANCE E ROBUSTEZ [2024-11-08]: Adiciona uma verificação para o caso de os timestamps serem iguais.
                // Isso previne uma escrita desnecessária no banco de dados se o cliente tentar sincronizar um estado que já é o mais recente no servidor.
                // Retornar 304 Not Modified é semanticamente correto e economiza recursos.
                if (clientPayload.lastModified === storedData.lastModified) {
                    return new Response(null, {
                        status: 304, // Not Modified
                        headers: corsHeaders,
                    });
                }
                
                // Conflito: os dados do cliente são mais antigos que os do servidor.
                if (clientPayload.lastModified < storedData.lastModified) {
                    return new Response(JSON.stringify(storedData), {
                        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }
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

        return createErrorResponse('Method not allowed', 405);

    } catch (error) {
        console.error("Error in sync API handler:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
        return createErrorResponse('Internal Server Error', 500, errorMessage);
    }
}
