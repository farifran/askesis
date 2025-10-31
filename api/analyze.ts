/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI } from '@google/genai';

export const config = {
  runtime: 'edge',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function createStreamingResponse(stream: AsyncGenerator<any, any, unknown>) {
  const readableStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          controller.enqueue(encoder.encode(text));
        }
      }
      controller.close();
    },
  });
  return new Response(readableStream, {
    headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }
    
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    try {
        const { prompt, systemInstruction } = await req.json();

        if (!prompt || !systemInstruction) {
            return new Response('Bad Request: Missing prompt or systemInstruction', { status: 400, headers: corsHeaders });
        }
        
        // Adiciona log para depuração
        console.log(`[api/analyze] Received request. Prompt snippet: "${prompt.substring(0, 150)}..."`);

        const apiKey = process.env.API_KEY;
        if (!apiKey) {
            console.error("[api/analyze] API_KEY environment variable not set.");
            throw new Error("API_KEY environment variable not set.");
        }
        
        const ai = new GoogleGenAI({ apiKey });

        const response = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
            },
        });
        
        return createStreamingResponse(response.stream);

    } catch (error) {
        // Log do erro mais detalhado
        console.error('Error in /api/analyze:', error instanceof Error ? error.stack : JSON.stringify(error));
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), { 
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}