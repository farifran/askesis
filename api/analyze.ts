/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// ANÁLISE DO ARQUIVO: 0% concluído. Todos os arquivos precisam ser revisados. Quando um arquivo atingir 100%, não será mais necessário revisá-lo.
// [2024-12-23]: Refatoração final para padronizar a criação de respostas de sucesso, melhorando a consistência e a manutenibilidade do código.
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

// [2024-12-23]: Adicionado helper para respostas de sucesso para padronizar cabeçalhos e tipo de conteúdo.
const createSuccessResponse = (body: string) => {
    return new Response(body, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
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

        const geminiResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
            },
        });
        
        const fullText = geminiResponse.text;
        
        // [2024-12-23]: Utiliza o novo helper para garantir consistência.
        return createSuccessResponse(fullText);

    } catch (error) {
        console.error('Critical error in /api/analyze handler:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return createErrorResponse('Internal Server Error', 500, errorMessage);
    }
}