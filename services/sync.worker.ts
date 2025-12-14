
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { encrypt, decrypt } from './crypto';

// Definição de Tipos para Mensagens
type WorkerRequest = 
    | { id: string; type: 'encrypt'; payload: any; key: string }
    | { id: string; type: 'decrypt'; payload: string; key: string };

type WorkerResponse = 
    | { id: string; status: 'success'; result: any }
    | { id: string; status: 'error'; error: string };

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    const { id, type, payload, key } = e.data;

    try {
        let result;

        if (type === 'encrypt') {
            // CPU INTENSIVE: Serialização JSON ocorre na thread do worker
            const jsonString = JSON.stringify(payload);
            // CPU/CRYPTO INTENSIVE: Criptografia
            result = await encrypt(jsonString, key);
        } else if (type === 'decrypt') {
            // CPU/CRYPTO INTENSIVE: Decriptografia
            const jsonString = await decrypt(payload, key);
            // CPU INTENSIVE: Parsing JSON ocorre na thread do worker
            result = JSON.parse(jsonString);
        } else {
            throw new Error(`Unknown operation type: ${(e.data as any).type}`);
        }

        const response: WorkerResponse = { id, status: 'success', result };
        self.postMessage(response);

    } catch (error: any) {
        console.error(`Worker error during ${type}:`, error);
        const response: WorkerResponse = { 
            id, 
            status: 'error', 
            error: error.message || 'Unknown worker error' 
        };
        self.postMessage(response);
    }
};
