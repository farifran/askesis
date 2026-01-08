
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI } from '@google/genai';

export const config = {
  runtime: 'edge',
};

const MAX_PROMPT_SIZE = 150 * 1024; // 150KB

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'gemini-3-flash-preview';
let aiClient: GoogleGenAI | null = null;

export default async function handler(req: Request) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    if (!API_KEY) return new Response(JSON.stringify({ error: 'Server Configuration' }), { status: 500, headers: CORS_HEADERS });

    try {
        // CHAOS DEFENSE: Timeout de leitura do prompt para evitar workers pendentes
        const bodyText = await Promise.race([
            req.text(),
            new Promise<string>((_, r) => setTimeout(() => r('TIMEOUT'), 8000))
        ]);

        if (bodyText === 'TIMEOUT') return new Response(null, { status: 408 });
        if (bodyText.length > MAX_PROMPT_SIZE) return new Response(null, { status: 413 });

        const body = JSON.parse(bodyText);
        const { prompt, systemInstruction } = body;

        if (!prompt || !systemInstruction) return new Response(null, { status: 400 });

        if (!aiClient) aiClient = new GoogleGenAI({ apiKey: API_KEY });

        // PROTEÇÃO CONTRA ZUMBIFICAÇÃO: Timeout de execução da IA
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const geminiResponse = await aiClient.models.generateContent({
            model: MODEL_NAME,
            contents: prompt,
            config: { 
                systemInstruction,
                temperature: 0.7,
            },
        });

        clearTimeout(timeoutId);
        
        const responseText = geminiResponse.text;
        if (!responseText) throw new Error('Empty AI response');

        return new Response(responseText, { 
            headers: { 
                ...CORS_HEADERS, 
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store' 
            } 
        });

    } catch (error: any) {
        if (error.name === 'AbortError') return new Response('AI Gateway Timeout', { status: 504, headers: CORS_HEADERS });
        return new Response(JSON.stringify({ error: 'AI processing failed' }), { status: 500, headers: CORS_HEADERS });
    }
}
