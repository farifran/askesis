/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI } from "@google/genai";

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: 'Prompt is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    if (!process.env.API_KEY) {
      return new Response(JSON.stringify({ error: 'API key not configured on server' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    const geminiStream = await ai.models.generateContentStream({
        model: 'gemini-flash-latest',
        contents: prompt,
    });

    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for await (const chunk of geminiStream) {
          const text = chunk.text;
          const jsonChunk = JSON.stringify({ text });
          controller.enqueue(encoder.encode(jsonChunk + '\n'));
        }
        controller.close();
      },
    });

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('Error in /api/generate:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}