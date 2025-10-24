/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge',
};

// Interface for the payload the client sends
interface SubscriptionPayload {
    subscription: any; // The PushSubscription type is not available on the Edge server
    lang: 'pt' | 'en' | 'es';
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
        
        const payload: SubscriptionPayload = await req.json();
        if (!payload || !payload.subscription || !payload.subscription.endpoint || !payload.lang) {
             return new Response(JSON.stringify({ error: 'Bad Request: Invalid subscription payload' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const dataKey = `push_sub:${keyHash}`;
        // Save the whole object, which includes both the subscription and the language
        await kv.set(dataKey, payload);

        return new Response(JSON.stringify({ success: true }), {
            status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error('Error in /api/subscribe:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}