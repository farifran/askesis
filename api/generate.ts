/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// @deprecated: Esta função serverless não é mais necessária.
// A chamada para a API Gemini foi movida diretamente para o lado do cliente
// em modalListeners.ts para reduzir a latência e simplificar a arquitetura.
// Este arquivo agora está obsoleto e pode ser removido.

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request) {
    return new Response(JSON.stringify({ 
      error: 'This API endpoint is deprecated and no longer functional.' 
    }), {
      status: 410, // Gone
      headers: { 'Content-Type': 'application/json' },
    });
}
