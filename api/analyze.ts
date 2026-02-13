
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI } from '@google/genai';

export const config = {
  runtime: 'edge',
};

const MAX_PROMPT_SIZE = 150 * 1024; // 150KB
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const CACHE_MAX_ENTRIES = 500;

const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const CORS_STRICT = process.env.CORS_STRICT === '1';

function isSameDeploymentOrigin(req: Request, origin: string): boolean {
    if (!origin) return false;
    try {
        const originUrl = new URL(origin);
        const requestHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
        return !!requestHost && originUrl.host === requestHost;
    } catch {
        return false;
    }
}

function matchesOriginRule(origin: string, rule: string): boolean {
    if (!origin || !rule) return false;
    if (rule === '*') return true;
    if (rule === origin) return true;

    const wildcardMatch = rule.match(/^(https?):\/\/\*\.(.+)$/i);
    if (!wildcardMatch) return false;

    try {
        const originUrl = new URL(origin);
        const expectedProtocol = wildcardMatch[1].toLowerCase();
        const expectedHostSuffix = wildcardMatch[2].toLowerCase();
        const host = originUrl.hostname.toLowerCase();
        return originUrl.protocol.replace(':', '').toLowerCase() === expectedProtocol
            && host.endsWith(`.${expectedHostSuffix}`);
    } catch {
        return false;
    }
}

function isOriginAllowed(req: Request, origin: string): boolean {
    if (!origin) return false;
    if (isSameDeploymentOrigin(req, origin)) return true;
    return ALLOWED_ORIGINS.some(rule => matchesOriginRule(origin, rule));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getCorsOrigin(req: Request): string {
    const origin = req.headers.get('origin') || '';
    if (ALLOWED_ORIGINS.length === 0) {
        if (isSameDeploymentOrigin(req, origin)) return origin;
        return '*';
    }
    return isOriginAllowed(req, origin) ? origin : 'null';
}

function getCorsHeaders(req: Request): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': getCorsOrigin(req),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

// ROBUSTNESS: Support both standard naming conventions
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY;
// MODEL UPDATE: Use supported Gemini 3 model.
const MODEL_NAME = 'gemini-3-flash-preview';

let aiClient: GoogleGenAI | null = null;
const responseCache = new Map<string, { value: string; ts: number }>();

async function computeCacheKey(prompt: string, systemInstruction: string): Promise<string> {
    const data = new TextEncoder().encode(`${MODEL_NAME}|${prompt}|${systemInstruction}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCachedResponse(key: string): string | null {
    const entry = responseCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        responseCache.delete(key);
        return null;
    }
    return entry.value;
}

function setCachedResponse(key: string, value: string) {
    responseCache.set(key, { value, ts: Date.now() });
    if (responseCache.size <= CACHE_MAX_ENTRIES) return;
    // Evict oldest entries when cache grows beyond limit.
    const entries = Array.from(responseCache.entries());
    entries.sort((a, b) => a[1].ts - b[1].ts);
    const excess = responseCache.size - CACHE_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
        responseCache.delete(entries[i][0]);
    }
}

const ANALYZE_RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.ANALYZE_RATE_LIMIT_WINDOW_MS, 60_000);
const ANALYZE_RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(process.env.ANALYZE_RATE_LIMIT_MAX_REQUESTS, 20);
const analyzeRateLimitStore = new Map<string, { count: number; resetAt: number }>();
const ANALYZE_RATE_LIMIT_DISABLED = process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === '1';

function checkRateLimitAnalyze(key: string): { limited: boolean; retryAfterSec: number } {
    if (ANALYZE_RATE_LIMIT_DISABLED) return { limited: false, retryAfterSec: 0 };
    const now = Date.now();
    if (analyzeRateLimitStore.size > 4000) {
        for (const [k, v] of analyzeRateLimitStore.entries()) {
            if (v.resetAt <= now) analyzeRateLimitStore.delete(k);
        }
    }

    const current = analyzeRateLimitStore.get(key);
    if (!current || current.resetAt <= now) {
        analyzeRateLimitStore.set(key, { count: 1, resetAt: now + ANALYZE_RATE_LIMIT_WINDOW_MS });
        return { limited: false, retryAfterSec: 0 };
    }

    if (current.count >= ANALYZE_RATE_LIMIT_MAX_REQUESTS) {
        return { limited: true, retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }

    current.count += 1;
    return { limited: false, retryAfterSec: 0 };
}

export default async function handler(req: Request) {
    const reqOrigin = req.headers.get('origin') || '';
    const CORS_HEADERS = getCorsHeaders(req);
    if (CORS_STRICT && ALLOWED_ORIGINS.length > 0 && reqOrigin && !isOriginAllowed(req, reqOrigin)) {
        return new Response(JSON.stringify({ error: 'Origin not allowed', code: 'CORS_DENIED' }), {
            status: 403,
            headers: CORS_HEADERS
        });
    }

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const origin = req.headers.get('origin') || 'unknown';
    const limiter = checkRateLimitAnalyze(`${ip}:${origin}`);
    if (limiter.limited) {
        return new Response(JSON.stringify({ error: 'Too Many Requests', code: 'RATE_LIMITED' }), {
            status: 429,
            headers: {
                ...CORS_HEADERS,
                'Retry-After': String(limiter.retryAfterSec)
            }
        });
    }

    if (!API_KEY) {
        console.error("Server Config Error: API_KEY or GEMINI_API_KEY not found in environment.");
        return new Response(JSON.stringify({ error: 'Server Configuration: Missing API Key' }), { status: 500, headers: CORS_HEADERS });
    }

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

        const cacheKey = await computeCacheKey(prompt, systemInstruction);
        const cached = getCachedResponse(cacheKey);
        if (cached) {
            return new Response(cached, {
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Cache': 'HIT'
                }
            });
        }

        if (!aiClient) aiClient = new GoogleGenAI({ apiKey: API_KEY });

        // PROTEÇÃO CONTRA ZUMBIFICAÇÃO: Timeout de execução da IA
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                const timeoutError = new Error('AI generation timeout');
                (timeoutError as any).name = 'AbortError';
                reject(timeoutError);
            }, 30000);
        });

        const geminiResponse = await Promise.race([
            aiClient.models.generateContent({
                model: MODEL_NAME,
                contents: prompt,
                config: { 
                    systemInstruction,
                    temperature: 0.7,
                },
            }),
            timeoutPromise
        ]);

        if (timeoutId) clearTimeout(timeoutId);
        
        const responseText = geminiResponse.text;
        if (!responseText) throw new Error('Empty AI response');

        setCachedResponse(cacheKey, responseText);

        return new Response(responseText, { 
            headers: { 
                ...CORS_HEADERS, 
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Cache': 'MISS'
            } 
        });

    } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("AI Analysis Failed:", errorMessage);

        if (error.name === 'AbortError') return new Response('AI Gateway Timeout', { status: 504, headers: CORS_HEADERS });

        const status = Number((error as any)?.status || (error as any)?.code || 0);
        const normalizedMessage = errorMessage.toLowerCase();
        const isRateLimit = status === 429
            || normalizedMessage.includes('429')
            || normalizedMessage.includes('resource_exhausted')
            || normalizedMessage.includes('quota')
            || normalizedMessage.includes('rate limit');

        if (isRateLimit) {
            return new Response(JSON.stringify({ error: 'AI quota reached', details: 'RESOURCE_EXHAUSTED' }), {
                status: 429,
                headers: {
                    ...CORS_HEADERS,
                    'Retry-After': '300'
                }
            });
        }

        // SECURITY FIX: Truncate and sanitize error details to prevent information leakage
        const safeDetails = errorMessage.substring(0, 200).replace(/[<>"'&]/g, '');
        return new Response(JSON.stringify({ error: 'AI processing failed', details: safeDetails }), { status: 500, headers: CORS_HEADERS });
    }
}
