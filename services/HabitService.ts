
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { state, PERIOD_OFFSET, TimeOfDay } from '../state';

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
     * Esta função grava o clique na memória.
     */
    static setStatus(habitId: string, dateISO: string, time: TimeOfDay, newState: number) {
        // 1. Inicialização Lazy do Mapa (Segurança)
        if (!state.monthlyLogs) state.monthlyLogs = new Map();

        const key = this.getLogKey(habitId, dateISO);
        const day = parseInt(dateISO.substring(8, 10), 10);
        
        // 2. Matemática Bitwise
        const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
        const clearMask = ~(3n << bitPos); // Cria buraco (00) na posição
        
        // 3. Leitura e Modificação
        let currentLog = state.monthlyLogs.get(key) || 0n;
        const newLog = (currentLog & clearMask) | (BigInt(newState) << bitPos);
        
        // 4. Gravação
        state.monthlyLogs.set(key, newLog);
        
        // 5. Flag de Sujeira (Avisa Persistence e Charts que algo mudou)
        state.uiDirtyState.chartData = true;

        // DEBUG: Confirmação visual no console (Remova após confirmar que funciona)
        // console.log(`[Bitmask] Write Success: ${key} -> ${newLog} (Status: ${newState})`);
    }

    /**
     * Serialização para JSON (Exportação/Cloud)
     * Converte Map<BigInt> para Array de Strings Hexadecimais
     */
    static serializeLogsForCloud(): [string, string][] {
        if (!state.monthlyLogs) return [];
        return Array.from(state.monthlyLogs.entries()).map(([key, val]) => {
            return [key, "0x" + val.toString(16)] as [string, string];
        });
    }

    /**
     * Deserialização (Importação/Cloud)
     * Converte Hex Strings de volta para Map<BigInt>
     */
    static deserializeLogsFromCloud(serialized: [string, string][]) {
        if (!Array.isArray(serialized)) return;
        const map = new Map<string, bigint>();
        serialized.forEach(([key, hexVal]) => {
            try {
                // Suporta formato "0x..." e "..." puro
                const hexClean = hexVal.startsWith("0x") ? hexVal : "0x" + hexVal;
                map.set(key, BigInt(hexClean));
            } catch (e) {
                console.warn(`[HabitService] Skipping invalid hex log: ${key}`, e);
            }
        });
        state.monthlyLogs = map;
    }
    
    /**
     * Suporte Legado (Migração de ArrayBuffer antigo se houver)
     */
    static unpackBinaryLogs(binaryMap: Map<string, ArrayBuffer>) {
        if (!state.monthlyLogs) state.monthlyLogs = new Map();
        binaryMap.forEach((buffer, key) => {
            // Conversão simples de buffer antigo para BigInt (assumindo 64 bits ou similar)
            // Implementação simplificada para migração
            try {
                const view = new DataView(buffer);
                // Se o buffer for pequeno, tentamos ler. Se não, descartamos (segurança).
                if (buffer.byteLength >= 8) {
                    state.monthlyLogs!.set(key, view.getBigUint64(0, true)); // Little Endian
                }
            } catch (e) {
                console.warn("Falha na migração binária legada", e);
            }
        });
    }
}
