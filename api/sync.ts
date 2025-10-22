/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// --- Tipos e Interfaces ---
// Uma definição simplificada da estrutura de dados para validação no lado do servidor.
interface AppState {
    lastModified: number;
    habits: { id: string }[];
    dailyData: Record<string, any>;
}

// A estrutura que realmente armazenamos no Vercel KV.
interface StoredData {
    lastModified: number;
    state: AppState;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
};

const getSyncKeyHash = (req: Request): string | null => {
    return req.headers.get('x-sync-key-hash');
};

/**
 * Heurística para determinar se um estado de aplicativo é "significativo".
 * Usado para prevenir que um estado "vazio" (de um novo dispositivo/reset)
 * sobrescreva um estado com dados substanciais.
 */
const isStateSignificant = (state: AppState): boolean => {
    // Mais de 2 hábitos OU mais de 5 dias de dados é considerado significativo.
    return state.habits.length > 2 || Object.keys(state.dailyData).length > 5;
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
            return new Response(JSON.stringify(storedData ? storedData.state : null), {
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (req.method === 'POST') {
            const clientState: AppState = await req.json();
            const storedData = await kv.get<StoredData>(dataKey);

            if (storedData) {
                // Conflito 1: Os dados do cliente são mais antigos que os do servidor.
                if (clientState.lastModified < storedData.lastModified) {
                    return new Response(JSON.stringify(storedData.state), {
                        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }

                // Conflito 2: Proteção contra sobrescrita por estado trivial.
                // Previne que um reset acidental em um dispositivo apague os dados da nuvem.
                const isClientDataTrivial = !isStateSignificant(clientState);
                const isServerDataSignificant = isStateSignificant(storedData.state);

                if (isClientDataTrivial && isServerDataSignificant) {
                    return new Response(JSON.stringify(storedData.state), {
                        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }
            }

            // Sem conflitos, ou é a primeira sincronização. Salva os dados.
            const dataToStore: StoredData = {
                lastModified: clientState.lastModified,
                state: clientState,
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