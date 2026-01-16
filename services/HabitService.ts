
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { state, HABIT_STATE, PERIOD_OFFSET, TimeOfDay } from '../state';

// CONSTANTS for Bitmask Storage
// 31 days * 3 periods * 2 bits = 186 bits.
// We need 24 bytes (192 bits) to store this safely.
const BUFFER_SIZE = 24; 
const CHUNK_SIZE = 64n;
const MASK_64 = 0xFFFFFFFFFFFFFFFFn;

export class HabitService {

    private static getLogKey(habitId: string, dateISO: string): string {
        return `${habitId}_${dateISO.substring(0, 7)}`; // ID_YYYY-MM
    }

    /**
     * Leitura Otimizada (Bitmask Only)
     */
    static getStatus(habitId: string, dateISO: string, time: TimeOfDay): number {
        const key = this.getLogKey(habitId, dateISO);
        const log = state.monthlyLogs?.get(key);
        
        if (log !== undefined) {
            const day = parseInt(dateISO.substring(8, 10), 10);
            const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
            return Number((log >> bitPos) & 3n);
        }
        return 0;
    }

    /**
     * [CRÍTICO] Escrita Otimizada (Bitmask Only)
     * Esta é a função que estava faltando para persistir o clique.
     */
    static setStatus(habitId: string, dateISO: string, time: TimeOfDay, newState: number) {
        // Garante a existência do mapa
        if (!state.monthlyLogs) state.monthlyLogs = new Map();

        const key = this.getLogKey(habitId, dateISO);
        const day = parseInt(dateISO.substring(8, 10), 10);
        
        // 1. Endereçamento (Onde está o bit?)
        const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
        
        // 2. Máscara de Limpeza (Zera os 2 bits atuais)
        // ~(11 << pos) cria ...11100111...
        const clearMask = ~(3n << bitPos);
        
        // 3. Recupera valor atual (ou 0)
        let currentLog = state.monthlyLogs.get(key) || 0n;
        
        // 4. Operação Atômica: (Atual AND Limpeza) OR (Novo << Posição)
        const newLog = (currentLog & clearMask) | (BigInt(newState) << bitPos);
        
        // 5. Salva no Mapa em Memória
        state.monthlyLogs.set(key, newLog);
        
        // 6. Marca Flag de Sujeira para a Persistência salvar no disco
        state.uiDirtyState.chartData = true; 
    }

    /**
     * [ZERO-COST PERSISTENCE] Compacta logs para binário (ArrayBuffer).
     * Transforma Map<string, bigint> em Map<string, ArrayBuffer>.
     * 
     * CORREÇÃO CRÍTICA: Um BigInt de mês pode ter até 186 bits. 
     * ArrayBuffer(8) (64 bits) causa perda de dados.
     * Alocamos 24 bytes (192 bits) para cobrir o mês inteiro.
     * 
     * @param sourceLogs Opcional. Fonte dos logs. Se não fornecido, usa o state global.
     */
    static packBinaryLogs(sourceLogs?: Map<string, bigint>): Map<string, ArrayBuffer> {
        const packed = new Map<string, ArrayBuffer>();
        const target = sourceLogs || state.monthlyLogs;

        if (target && target instanceof Map) {
            target.forEach((val, key) => {
                const buffer = new ArrayBuffer(BUFFER_SIZE);
                const view = new DataView(buffer);
                
                // Grava 3 blocos de 64 bits (Big Endian para consistência)
                // Bloco 0: bits 0-63 (Low) -> Byte Offset 16
                view.setBigUint64(16, val & MASK_64, false); 
                // Bloco 1: bits 64-127 (Mid) -> Byte Offset 8
                view.setBigUint64(8, (val >> CHUNK_SIZE) & MASK_64, false);
                // Bloco 2: bits 128-191 (High) -> Byte Offset 0
                view.setBigUint64(0, (val >> (CHUNK_SIZE * 2n)) & MASK_64, false);
                
                packed.set(key, buffer);
            });
        }
        return packed;
    }

    /**
     * [ZERO-COST] Restaura logs a partir de binário.
     * Reconstrói o BigInt a partir dos 24 bytes.
     */
    static unpackBinaryLogs(packed: Map<string, ArrayBuffer>) {
        if (!packed || !(packed instanceof Map)) return;
        
        const targetMap = state.monthlyLogs || new Map();
        
        packed.forEach((buffer, key) => {
            // Validação de integridade
            if (buffer.byteLength === BUFFER_SIZE) {
                const view = new DataView(buffer);
                
                const part2 = view.getBigUint64(0, false); // High bits
                const part1 = view.getBigUint64(8, false); // Mid bits
                const part0 = view.getBigUint64(16, false); // Low bits
                
                // Reconstrói: (High << 128) | (Mid << 64) | Low
                const val = (part2 << (CHUNK_SIZE * 2n)) | (part1 << CHUNK_SIZE) | part0;
                
                targetMap.set(key, val);
            } else if (buffer.byteLength === 8) {
                // LEGACY RECOVERY: Se encontrarmos buffers antigos de 8 bytes (durante desenvolvimento)
                const view = new DataView(buffer);
                const val = view.getBigUint64(0, false);
                targetMap.set(key, val);
            }
        });
        
        state.monthlyLogs = targetMap;
    }

    /**
     * Serialização para API (JSON Safe)
     */
    static serializeLogsForCloud(): [string, string][] {
        if (!state.monthlyLogs) return [];
        return Array.from(state.monthlyLogs.entries()).map(([key, val]) => {
            return [key, val.toString(16)] as [string, string];
        });
    }

    /**
     * Deserialização da API
     */
    static deserializeLogsFromCloud(serialized: [string, string][]) {
        if (!Array.isArray(serialized)) return;
        const map = new Map<string, bigint>();
        serialized.forEach(([key, hexVal]) => {
            try {
                const hexClean = hexVal.startsWith("0x") ? hexVal : "0x" + hexVal;
                map.set(key, BigInt(hexClean));
            } catch (e) {
                console.warn(`Skipping invalid hex log: ${key}`);
            }
        });
        state.monthlyLogs = map;
    }
}
