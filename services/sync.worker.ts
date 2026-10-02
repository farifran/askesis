
/**
 * @license
 * SPDX-License-Identifier: MIT
*/

/**
 * @file services/sync.worker.ts
 * @description Web Worker para Criptografia e Processamento de Dados Pesados.
 */

import { buildAiPrompt, buildAiQuoteAnalysisPrompt } from './aiPrompts';
export { buildAiPrompt, buildAiQuoteAnalysisPrompt } from './aiPrompts';
import { murmurHash3 } from './murmurHash3';
import { encrypt as encryptText, decrypt as decryptText } from './crypto';
import { compressArchive, decompressArchive } from './compression';
import { type WorkerTaskMessage, type WorkerResponseMessage } from '../contracts/worker';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null;
}

function jsonReplacer(key: string, value: unknown) {
    if (typeof value === 'bigint') return { __type: 'bigint', val: value.toString() };
    if (value instanceof Map) return { __type: 'map', val: Array.from(value.entries()) };
    return value;
}

function jsonReviver(key: string, value: unknown) {
    if (isRecord(value)) {
        if (value.__type === 'bigint' && typeof value.val === 'string') return BigInt(value.val);
        if (value.__type === 'map' && Array.isArray(value.val)) return new Map(value.val as Array<[unknown, unknown]>);
    }
    return value;
}

// O envelope criptográfico vive em ./crypto (fonte única de verdade). Aqui ficam
// apenas as camadas de (de)serialização JSON que são específicas do worker.

async function encrypt(payload: unknown, password: string): Promise<string> {
    return encryptText(JSON.stringify(payload, jsonReplacer), password);
}

async function encryptJson(jsonText: string, password: string): Promise<string> {
    return encryptText(jsonText, password);
}

async function decrypt(encryptedBase64: string, password: string): Promise<unknown> {
    return JSON.parse(await decryptText(encryptedBase64, password), jsonReviver);
}

async function decryptWithHash(encryptedBase64: string, password: string): Promise<{ value: unknown; hash: string }> {
    const text = await decryptText(encryptedBase64, password);
    return { value: JSON.parse(text, jsonReviver), hash: murmurHash3(text) };
}

/**
 * Lê um arquivo anual, seja ele envelope gzip ou o JSON puro do formato legado.
 * Devolve `null` quando o conteúdo é ilegível — os chamadores usam isso para
 * PRESERVAR o ano em vez de regravá-lo a partir de um objeto vazio.
 */
async function readArchiveYear(content: unknown): Promise<JsonRecord | null> {
    if (isRecord(content)) return content;
    if (typeof content !== 'string') return null;
    if (!content.trim()) return {};

    try {
        const parsed = JSON.parse(await decompressArchive(content));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Remove todos os rastros de um hábito de dentro dos arquivos anuais.
 */
export async function pruneHabitFromArchives(habitId: string, archives: Record<string, unknown>): Promise<Record<string, string>> {
    const updated: Record<string, string> = {};
    for (const year in archives) {
        const content = await readArchiveYear(archives[year]);
        if (!content) continue;

        let changed = false;
        for (const date in content) {
            const day = content[date];
            if (!isRecord(day)) continue;
            if (day[habitId]) {
                delete day[habitId];
                changed = true;
            }
            if (Object.keys(day).length === 0) delete content[date];
        }

        if (changed) {
            updated[year] = Object.keys(content).length === 0 ? "" : await compressArchive(JSON.stringify(content));
        }
    }
    return updated;
}

self.onmessage = async (e: MessageEvent<WorkerTaskMessage>) => {
    const { id, type, payload, key } = e.data;
    try {
        let result: unknown;
        switch (type) {
            case 'encrypt': result = await encrypt(payload, key!); break;
            case 'encrypt-json': result = await encryptJson(String(payload || ''), key!); break;
            case 'decrypt': result = await decrypt(payload, key!); break;
            case 'decrypt-with-hash': result = await decryptWithHash(payload, key!); break;
            case 'build-ai-prompt': result = buildAiPrompt(payload); break;
            case 'build-quote-analysis-prompt': result = buildAiQuoteAnalysisPrompt(payload); break;
            case 'archive': result = await processArchiving(payload); break;
            case 'prune-habit': {
                const p = isRecord(payload) ? payload : {};
                const habitId = typeof p.habitId === 'string' ? p.habitId : '';
                const archives = isRecord(p.archives) ? p.archives : {};
                result = await pruneHabitFromArchives(habitId, archives);
                break;
            }
            default: throw new Error(`Task unknown: ${type}`);
        }
        const msg: WorkerResponseMessage = { id, status: 'success', result };
        self.postMessage(msg);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const msg: WorkerResponseMessage = { id, status: 'error', error: message };
        self.postMessage(msg);
    }
};

export async function processArchiving(payload: unknown) {
    const data = isRecord(payload) ? payload : {};
    const result: Record<string, string> = {};
    for (const year in data) {
        const yearPayload = isRecord(data[year]) ? data[year] : {};
        const base = await readArchiveYear(yearPayload.base ?? {});
        // Base ilegível: omitir o ano do resultado mantém o arquivo atual intacto e
        // os dias em dailyData para a próxima tentativa. Mesclar sobre `{}` gravaria
        // só as adições por cima de anos inteiros de histórico.
        if (!base) continue;

        const additions = isRecord(yearPayload.additions) ? yearPayload.additions : {};
        const merged = { ...base, ...additions };
        result[year] = await compressArchive(JSON.stringify(merged));
    }
    return result;
}
