/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI } from "@google/genai";

export const config = {
  runtime: 'edge',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
        const { prompt } = await req.json();

        if (!prompt) {
            return new Response(JSON.stringify({ error: 'Prompt is required' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const responseStream = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        const stream = new ReadableStream({
            async start(controller) {
                for await (const chunk of responseStream) {
                    const text = chunk.text;
                    if (text) {
                       controller.enqueue(new TextEncoder().encode(text));
                    }
                }
                controller.close();
            },
        });
        
        return new Response(stream, {
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
        });

    } catch (error) {
        console.error('Error in /api/analyze:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}