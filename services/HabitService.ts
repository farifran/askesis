
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
            try {
                const view = new DataView(buffer);
                if (buffer.byteLength >= 8) {
                    state.monthlyLogs!.set(key, view.getBigUint64(0, true)); // Little Endian
                }
            } catch (e) {
                console.warn("Falha na migração binária legada", e);
            }
        });
    }

    /**
     * INTELLIGENT MERGE (CRDT-Lite para Bitmasks)
     * Funde dois mapas de logs.
     * Regra Padrão: Timestamp Authority (definido no caller) + Soft Merge (não apaga dados se um lado for zero).
     */
    static mergeLogs(winnerMap: Map<string, bigint> | undefined, loserMap: Map<string, bigint> | undefined): Map<string, bigint> {
        const result = new Map<string, bigint>(winnerMap || []);
        if (!loserMap) return result;

        for (const [key, loserVal] of loserMap.entries()) {
            const winnerVal = result.get(key);
            // Se o vencedor não tem dados ou tem dados vazios (0), aceita os dados do perdedor
            if (winnerVal === undefined || (winnerVal === 0n && loserVal !== 0n)) {
                result.set(key, loserVal);
            }
        }
        return result;
    }

    /**
     * FORCE DAY SYNC (Prioridade Absoluta para Data Específica)
     * Transplanta os bits de um dia específico da 'sourceMap' (Cloud) para 'targetMap' (Local/Merged).
     * Isso garante que "Hoje" esteja exatamente igual à nuvem, ignorando timestamps locais.
     */
    static overwriteDayBits(targetMap: Map<string, bigint>, sourceMap: Map<string, bigint> | undefined, dateISO: string) {
        if (!sourceMap) return;
        
        // Itera sobre todos os hábitos na fonte (Nuvem) que têm registro para este mês
        const monthSuffix = dateISO.substring(0, 7); // YYYY-MM
        const day = parseInt(dateISO.substring(8, 10), 10);
        
        // Calcula a máscara do dia (todos os 3 períodos: Manhã, Tarde, Noite)
        // Cada período usa 2 bits. Total 6 bits por dia.
        // Posição inicial: (dia - 1) * 6
        const startBit = BigInt((day - 1) * 6);
        const dayMask = (3n << startBit) | (3n << (startBit + 2n)) | (3n << (startBit + 4n));
        const clearMask = ~dayMask;

        for (const [key, sourceVal] of sourceMap.entries()) {
            if (key.endsWith(monthSuffix)) {
                // Extrai os bits do dia da nuvem
                const sourceDayBits = sourceVal & dayMask;
                
                // Pega o valor atual local (ou 0 se não existir)
                const currentLocalVal = targetMap.get(key) || 0n;
                
                // Limpa os bits do dia no local e injeta os bits da nuvem
                const newVal = (currentLocalVal & clearMask) | sourceDayBits;
                
                targetMap.set(key, newVal);
            }
        }
    }
}
