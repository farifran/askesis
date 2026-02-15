/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/workerClient.ts
 * @description Cliente RPC mínimo para o sync.worker (zero-deps).
 */

import { generateUUID, logger } from '../utils';

export type WorkerTaskType =
    | 'encrypt'
    | 'encrypt-json'
    | 'decrypt'
    | 'decrypt-with-hash'
    | 'build-ai-prompt'
    | 'build-quote-analysis-prompt'
    | 'prune-habit'
    | 'archive';

export type WorkerTaskMessage = {
    id: string;
    type: WorkerTaskType;
    payload: any;
    key?: string;
};

type WorkerResponseMessage =
    | { id: string; status: 'success'; result: any }
    | { id: string; status: 'error'; error: string };

type PendingCallback = {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timeoutId: number;
};

let syncWorker: Worker | null = null;
const pending = new Map<string, PendingCallback>();

function rejectAllPending(reason: string) {
    const err = new Error(reason);
    for (const cb of pending.values()) {
        clearTimeout(cb.timeoutId);
        cb.reject(err);
    }
    pending.clear();
}

function resetWorker(reason: string) {
    try {
        if (syncWorker) syncWorker.terminate();
    } catch {}
    syncWorker = null;
    rejectAllPending(reason);
}

function ensureWorker(workerUrl: string): Worker {
    if (syncWorker) return syncWorker;

    syncWorker = new Worker(workerUrl, { type: 'module' });

    syncWorker.onmessage = (e: MessageEvent) => {
        const data = e.data as WorkerResponseMessage | undefined;
        const id = data && typeof (data as any).id === 'string' ? (data as any).id : null;
        if (!id) return;

        const cb = pending.get(id);
        if (!cb) return;

        pending.delete(id);
        clearTimeout(cb.timeoutId);

        if ((data as any).status === 'success') cb.resolve((data as any).result);
        else cb.reject(new Error(String((data as any).error || 'Worker error')));
    };

    syncWorker.onerror = (e) => {
        logger.error('Critical Worker Error:', e);
        resetWorker('Worker crashed');
    };

    return syncWorker;
}

export function runWorkerTask<T>(
    type: WorkerTaskType,
    payload: any,
    options: { key?: string; timeoutMs: number; workerUrl?: string } = { timeoutMs: 0 }
): Promise<T> {
    const workerUrl = options.workerUrl || './sync-worker.js';
    const timeoutMs = options.timeoutMs;

    return new Promise<T>((resolve, reject) => {
        const id = generateUUID();
        const timeoutId = window.setTimeout(() => {
            pending.delete(id);
            reject(new Error('Worker timeout'));
        }, timeoutMs);

        pending.set(id, { resolve, reject, timeoutId });

        try {
            const worker = ensureWorker(workerUrl);
            const msg: WorkerTaskMessage = { id, type, payload, key: options.key };
            worker.postMessage(msg);
        } catch (err) {
            clearTimeout(timeoutId);
            pending.delete(id);
            reject(err);
        }
    });
}
