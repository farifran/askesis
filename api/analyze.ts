
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

// --- CONSTANTS ---
const MAX_PROMPT_SIZE = 100 * 1024; // 100KB Limit for Text Prompts

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
const ERR_PAYLOAD_TOO_LARGE = JSON.stringify({ error: 'Payload Too Large', details: 'Request exceeds limit.' });
const ERR_INTERNAL = JSON.stringify({ error: 'Internal Server Error', details: 'An unexpected error occurred.' });

// 3. Environment & Constants
const API_KEY = process.env.API_KEY;
// MODEL SAFETY: Use 'gemini-3-flash-preview' as requested, but be aware of deprecation.
const MODEL_NAME = 'gemini-3-flash-preview';

// 4. Lazy Singleton Client (Global Scope)
let aiClient: GoogleGenAI | null = null;

// --- HANDLER ---

export default async function handler(req: Request) {
    // Fast Path: Preflight (OPTIONS)
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== 'POST') {
        return new Response(ERR_METHOD_NOT_ALLOWED, { status: 405, headers: HEADERS_JSON });
    }

    if (!API_KEY) {
        console.error("[api/analyze] API_KEY environment variable not set.");
        return new Response(ERR_NO_API_KEY, { status: 500, headers: HEADERS_JSON });
    }

    // SECURITY: Robust Payload Size Check (Clone & Blob)
    // Trusts header first for speed, but validates actual size to prevent OOM DOS.
    const contentLengthStr = req.headers.get('content-length');
    if (contentLengthStr) {
        const length = parseInt(contentLengthStr, 10);
        if (!isNaN(length) && length > MAX_PROMPT_SIZE) {
            return new Response(ERR_PAYLOAD_TOO_LARGE, { status: 413, headers: HEADERS_JSON });
        }
    }

    // Parse Body Safe
    let body: any;
    try {
        // BLINDAGEM: Clonamos a requisição para ler como Blob e verificar tamanho real antes do JSON parse.
        // Isso evita que um ataque de compressão ou spoofing de header estoure a memória no JSON.parse.
        const blob = await req.clone().blob();
        if (blob.size > MAX_PROMPT_SIZE) {
             return new Response(ERR_PAYLOAD_TOO_LARGE, { status: 413, headers: HEADERS_JSON });
        }
        body = JSON.parse(await blob.text());
    } catch (e) {
        return new Response(ERR_INVALID_JSON, { status: 400, headers: HEADERS_JSON });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return new Response(ERR_INVALID_JSON, { status: 400, headers: HEADERS_JSON });
    }

    const { prompt, systemInstruction } = body as Partial<AnalyzeRequestBody>;

    if (!prompt || !systemInstruction) {
        return new Response(ERR_MISSING_FIELDS, { status: 400, headers: HEADERS_JSON });
    }

    if (!aiClient) {
        aiClient = new GoogleGenAI({ apiKey: API_KEY });
    }

    try {
        const geminiResponse = await aiClient.models.generateContent({
            model: MODEL_NAME,
            contents: prompt,
            config: { systemInstruction },
        });
        
        if (!geminiResponse.text) {
            const candidate = geminiResponse.candidates?.[0];
            const finishReason = candidate?.finishReason;
            // Sanitized error for Safety blocking
            if (finishReason === 'SAFETY') {
                 return new Response(JSON.stringify({ error: 'Bad Request', details: 'Blocked by safety settings.' }), { status: 400, headers: HEADERS_JSON });
            }
            return new Response(JSON.stringify({ error: 'Internal Server Error', details: 'Generation failed.' }), { status: 500, headers: HEADERS_JSON });
        }

        return new Response(geminiResponse.text, { headers: HEADERS_TEXT });

    } catch (error: unknown) {
        console.error('Critical error in /api/analyze handler:', error);
        // SECURITY: Do not leak error.message to client in production.
        return new Response(ERR_INTERNAL, { status: 500, headers: HEADERS_JSON });
    }
}
