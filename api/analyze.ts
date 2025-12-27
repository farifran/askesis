
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file api/analyze.ts
 * @description Proxy seguro e otimizado para a Google GenAI API.
 * 
 * [SERVERLESS / EDGE FUNCTION CONTEXT]:
 * Este código roda na Vercel Edge Network (V8 Isolate).
 * - Otimizado para "Warm Starts": Lazy Singleton AI Client.
 * - Zero-Allocation: Respostas e Headers estáticos.
 * - Static JSON Hoisting: Strings de erro pré-computadas.
 */

import { GoogleGenAI } from '@google/genai';

export const config = {
  runtime: 'edge',
};

// --- TYPES ---
interface AnalyzeRequestBody {
    prompt: string;
    systemInstruction: string;
}

// --- STATIC CONFIGURATION (Global Scope / Cold Start) ---

// 1. Static Headers (Frozen for V8 optimization)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const HEADERS_JSON = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json',
};

const HEADERS_TEXT = {
  ...CORS_HEADERS,
  'Content-Type': 'text/plain; charset=utf-8',
};

// 2. Pre-serialized Error Bodies (Zero CPU overhead on request)
const ERR_METHOD_NOT_ALLOWED = JSON.stringify({ error: 'Method Not Allowed' });
const ERR_NO_API_KEY = JSON.stringify({ error: 'Internal Server Error', details: 'Server configuration error.' });
const ERR_INVALID_JSON = JSON.stringify({ error: 'Bad Request: Invalid JSON format' });
const ERR_MISSING_FIELDS = JSON.stringify({ error: 'Bad Request: Missing prompt or systemInstruction' });

// 3. Environment & Constants
const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'gemini-3-flash-preview';

// 4. Lazy Singleton Client (Global Scope)
// Mantém a instância viva entre requisições em ambientes quentes, mas não inicializa até ser necessário.
let aiClient: GoogleGenAI | null = null;

// --- HANDLER ---

export default async function handler(req: Request) {
    // Fast Path: Preflight (OPTIONS) - Zero SDK Overhead
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Fast Path: Method Check
    if (req.method !== 'POST') {
        return new Response(ERR_METHOD_NOT_ALLOWED, {
            status: 405,
            headers: HEADERS_JSON,
        });
    }

    // Fail Fast: Configuração de Servidor (Environment Check)
    // Verificação barata de string antes de qualquer lógica pesada
    if (!API_KEY) {
        console.error("[api/analyze] API_KEY environment variable not set.");
        return new Response(ERR_NO_API_KEY, {
            status: 500,
            headers: HEADERS_JSON,
        });
    }

    // Parse Body
    let body: AnalyzeRequestBody;
    try {
        body = await req.json();
    } catch (e) {
        return new Response(ERR_INVALID_JSON, {
            status: 400,
            headers: HEADERS_JSON,
        });
    }

    // Destructure & Validate (Fail Fast)
    const { prompt, systemInstruction } = body;

    if (!prompt || !systemInstruction) {
        return new Response(ERR_MISSING_FIELDS, {
            status: 400,
            headers: HEADERS_JSON,
        });
    }

    // --- HEAVY LIFTING STARTS HERE ---
    
    // Lazy Initialization: Só instancia o SDK se chegamos até aqui.
    // Economiza CPU/Memória em Cold Starts com requisições inválidas.
    if (!aiClient) {
        aiClient = new GoogleGenAI({ apiKey: API_KEY });
    }

    try {
        // Execution
        const geminiResponse = await aiClient.models.generateContent({
            model: MODEL_NAME,
            contents: prompt,
            config: { systemInstruction },
        });
        
        // Response Validation
        // Direct property access is faster than destructuring for single checks
        if (!geminiResponse.text) {
            const candidate = geminiResponse.candidates?.[0];
            const finishReason = candidate?.finishReason;
            const details = finishReason ? `Finish reason: ${finishReason}` : 'Generation failed.';
            const isSafety = finishReason === 'SAFETY';
            
            // Dynamic error, must serialize
            return new Response(JSON.stringify({ 
                error: isSafety ? 'Bad Request: Blocked by safety settings' : 'Internal Server Error: Generation failed', 
                details 
            }), {
                status: isSafety ? 400 : 500,
                headers: HEADERS_JSON,
            });
        }

        // Success Path
        return new Response(geminiResponse.text, {
            headers: HEADERS_TEXT,
        });

    } catch (error: any) {
        console.error('Critical error in /api/analyze handler:', error);
        // Dynamic error, must serialize
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), {
            status: 500,
            headers: HEADERS_JSON,
        });
    }
}
