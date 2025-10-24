/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { kv } from '@vercel/kv';
import { TimeOfDay } from '../state';

export const config = {
  runtime: 'edge',
};

interface SchedulePayload {
    schedules: TimeOfDay[];
    timezone: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key-Hash',
};

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    try {
        const keyHash = req.headers.get('x-sync-key-hash');
        if (!keyHash) {
            return new Response(JSON.stringify({ error: 'Unauthorized: Missing sync key hash' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
        
        const payload: SchedulePayload = await req.json();
        if (!payload || !Array.isArray(payload.schedules) || !payload.timezone) {
             return new Response(JSON.stringify({ error: 'Bad Request: Invalid schedule payload' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const scheduleKey = `schedule:${keyHash}`;
        
        if (payload.schedules.length === 0) {
            // Se a lista de agendamentos estiver vazia, remove a chave do KV.
            await kv.del(scheduleKey);
        } else {
            // Caso contrário, salva o agendamento.
            await kv.set(scheduleKey, payload);
        }

        return new Response(JSON.stringify({ success: true }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error in /api/schedules:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}