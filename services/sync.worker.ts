/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/sync.worker.ts
 * @description Web Worker para Processamento Pesado (CPU-Bound Tasks).
 * Inclui: Criptografia, Merge de Estados e Limpeza de Arquivos (Pruning).
 */

import type { AppState, Habit, HabitDailyInfo, TimeOfDay, HabitSchedule } from '../state';
import { toUTCIsoDateString, parseUTCIsoDate, decompressString, MS_PER_DAY, compressToBuffer, decompressFromBuffer, arrayBufferToBase64, base64ToArrayBuffer } from '../utils';
import { encrypt, decryptToBuffer } from './crypto';
import { mergeStates } from './dataMerge';

// --- CONSTANTS (Isolation) ---
// Réplicas de constantes para evitar importar arquivos que tocam no DOM
const HABIT_STATE = { NULL: 0, DONE: 1, DEFERRED: 2, DONE_PLUS: 3 };
const PERIOD_OFFSET: Record<string, number> = { 'Morning': 0, 'Afternoon': 2, 'Evening': 4 };

// --- BITMASK HELPERS ---

function _getLogKey(habitId: string, dateISO: string): string {
    return `${habitId}_${dateISO.substring(0, 7)}`; // ID_YYYY-MM
}

function _getStatusFromBitmask(habitId: string, dateISO: string, time: TimeOfDay, logs?: Map<string, bigint>): number {
    if (!logs) return HABIT_STATE.NULL;
    const key = _getLogKey(habitId, dateISO);
    const log = logs.get(key);
    
    if (log !== undefined) {
        const day = parseInt(dateISO.substring(8, 10), 10);
        const offset = PERIOD_OFFSET[time] ?? 0;
        const bitPos = BigInt(((day - 1) * 6) + offset);
        return Number((log >> bitPos) & 0b11n);
    }
    return HABIT_STATE.NULL;
}

// --- WORKER MESSAGE HANDLER ---

self.onmessage = async (e: MessageEvent) => {
    const { id, type, payload, key } = e.data;
    let result: any;

    try {
        if (type === 'encrypt') {
            // Cifragem Binária (Zero-Copy)
            const jsonStr = JSON.stringify(payload, (key, value) => {
                // Serializer especial para Maps e BigInts
                if (key === 'monthlyLogs' && value instanceof Map) {
                    return Array.from(value.entries()).map(([k, v]) => [k, v.toString(16)]);
                }
                if (value instanceof Uint8Array) {
                    // Buffer Copy para segurança
                    const copy = new Uint8Array(value);
                    return 'B64:' + arrayBufferToBase64(copy.buffer);
                }
                return value;
            });
            
            const compressedBuffer = await compressToBuffer(jsonStr);
            const encryptedBuffer = await encrypt(compressedBuffer, key);
            // Retorna como Base64 String para transporte JSON seguro na API
            result = arrayBufferToBase64(encryptedBuffer);
        }
        else if (type === 'decrypt') {
            // Descifragem: Base64 -> Buffer -> Decrypt -> Decompress -> Parse
            let inputBuffer: Uint8Array;
            if (typeof payload === 'string') {
                inputBuffer = new Uint8Array(base64ToArrayBuffer(payload));
            } else {
                inputBuffer = payload;
            }
            
            const decryptedBuffer = await decryptToBuffer(inputBuffer, key);
            const decompressedJSON = await decompressFromBuffer(decryptedBuffer);
            
            result = JSON.parse(decompressedJSON, (key, value) => {
                // Reviver especial para Maps e Binários
                if (typeof value === 'string' && value.startsWith('B64:')) {
                    return new Uint8Array(base64ToArrayBuffer(value.substring(4)));
                }
                if (key === 'monthlyLogs' && Array.isArray(value)) {
                    const map = new Map<string, bigint>();
                    for (const [k, v] of value) {
                        try { map.set(k, BigInt("0x" + v)); } catch {}
                    }
                    return map;
                }
                return value;
            });
        }
        else if (type === 'merge') {
            result = await mergeStates(payload.local, payload.incoming);
        }
        else if (type === 'prune-habit') {
            // FIX: Implementação robusta da função de limpeza
            result = await pruneHabitFromArchives(payload);
        }
        else if (type === 'build-ai-prompt') {
            // Placeholder: Lógica de IA seria implementada aqui se necessário
            result = ""; 
        }
        else if (type === 'build-quote-analysis-prompt') {
             // Placeholder
             result = "";
        }
        else if (type === 'archive') {
            // Placeholder para arquivamento anual
            result = payload; 
        }
        else {
            throw new Error(`Unknown worker task type: ${type}`);
        }
        
        self.postMessage({ id, status: 'success', result });
    } catch (err: any) {
        console.error(`[Worker Error] Task ${type} failed:`, err);
        self.postMessage({ id, status: 'error', error: err.message || "Worker Internal Error" });
    }
};

// --- LOGIC: PRUNE HABIT (A Função que Faltava) ---

/**
 * Remove todo o histórico de um hábito específico dos arquivos compactados.
 * Operação pesada: Descomprime -> Filtra -> Recomprime.
 */
async function pruneHabitFromArchives(payload: { habitId: string, archives: Record<string, string | Uint8Array> }) {
    const { habitId, archives } = payload;
    const newArchives: Record<string, string | Uint8Array> = {};

    // Itera sobre cada ano arquivado (ex: "2024", "2025")
    for (const [year, rawData] of Object.entries(archives)) {
        try {
            let yearData: Record<string, any>;
            
            // 1. Inflar (Decompress) - Suporta Binário e String Legado
            if (rawData instanceof Uint8Array) {
                const jsonStr = await decompressFromBuffer(rawData);
                yearData = JSON.parse(jsonStr);
            } else if (typeof rawData === 'string') {
                if (rawData.startsWith('GZIP:')) {
                    const jsonStr = await decompressString(rawData.substring(5));
                    yearData = JSON.parse(jsonStr);
                } else {
                    yearData = JSON.parse(rawData);
                }
            } else {
                continue; // Pula dados inválidos
            }

            let yearModified = false;

            // 2. Limpar (Prune)
            // Itera sobre todos os dias do ano
            for (const dateISO in yearData) {
                const dayRecord = yearData[dateISO];
                // Se o hábito existe neste dia, deleta
                if (dayRecord && dayRecord[habitId]) {
                    delete dayRecord[habitId];
                    yearModified = true;
                    
                    // Se o dia ficou vazio, remove o dia inteiro
                    if (Object.keys(dayRecord).length === 0) {
                        delete yearData[dateISO];
                    }
                }
            }

            // 3. Deflar (Compress)
            if (yearModified) {
                // Se o ano ficou vazio, marca para remoção (string vazia)
                if (Object.keys(yearData).length === 0) {
                    newArchives[year] = "";
                } else {
                    // Recomprime como Uint8Array (Padrão Moderno)
                    const newJsonStr = JSON.stringify(yearData);
                    const newBuffer = await compressToBuffer(newJsonStr);
                    newArchives[year] = newBuffer;
                }
            } else {
                // Se não tocou, mantém o dado original (Zero Allocation)
                newArchives[year] = rawData;
            }

        } catch (e) {
            console.error(`[Worker] Failed to prune archive for year ${year}`, e);
            // Em caso de erro (dado corrompido), mantém o original para não perder tudo
            newArchives[year] = rawData;
        }
    }

    return newArchives;
}