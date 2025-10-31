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

// Helper para enviar uma resposta de erro JSON padronizada
const createErrorResponse = (message: string, status: number, details = '') => {
    return new Response(JSON.stringify({ error: message, details }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
};

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method !== 'POST') {
        return createErrorResponse('Method Not Allowed', 405);
    }

    try {
        const { prompt, systemInstruction } = await req.json();

        if (!prompt || !systemInstruction) {
            return createErrorResponse('Bad Request: Missing prompt or systemInstruction', 400);
        }
        
        const apiKey = process.env.API_KEY;
        if (!apiKey) {
            console.error("[api/analyze] API_KEY environment variable not set.");
            return createErrorResponse('Internal Server Error', 500, 'Server configuration error.');
        }
        
        const ai = new GoogleGenAI({ apiKey });

        const geminiResponse = await ai.models.generateContentStream({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
            },
        });
        
        // REATORAÇÃO: Em vez de transmitir para o cliente, agregue a resposta aqui no servidor.
        // Isso é mais robusto contra erros de rede intermediários que causam "Load failed" no cliente.
        let fullText = '';
        for await (const chunk of geminiResponse.stream) {
            const text = chunk.text;
            if (text) {
                fullText += text;
            }
        }
        
        // Envia a resposta completa como uma única carga útil.
        return new Response(fullText, {
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
        });

    } catch (error) {
        console.error('Critical error in /api/analyze handler:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return createErrorResponse('Internal Server Error', 500, errorMessage);
    }
}
