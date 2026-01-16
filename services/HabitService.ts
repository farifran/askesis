
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
     * Leitura Otimizada (Bitmask Only):
     * Acessa diretamente o mapa de BigInts para verificar o status.
     * Complexidade: O(1).
     * 
     * @param habitId ID do hábito
     * @param dateISO Data em formato ISO
     * @param time Período do dia
     */
    static getStatus(habitId: string, dateISO: string, time: TimeOfDay): number {
        const key = this.getLogKey(habitId, dateISO);
        const log = state.monthlyLogs?.get(key);
        
        if (log !== undefined) {
            const day = parseInt(dateISO.substring(8, 10), 10);
            // Endereçamento: (Dia-1)*6 + Offset
            const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
            // Extrai 2 bits e converte para número
            return Number((log >> bitPos) & 0b11n);
        }
    
        return HABIT_STATE.NULL;
    }

    /**
     * [WRITE OPERATION] - A peça que faltava.
     * Atualiza o Bitmask com o novo estado e marca o sistema para salvamento.
     */
    static setStatus(habitId: string, dateISO: string, time: TimeOfDay, newState: number) {
        if (!state.monthlyLogs) state.monthlyLogs = new Map();

        const key = this.getLogKey(habitId, dateISO);
        const day = parseInt(dateISO.substring(8, 10), 10);
        
        // 1. Posição dos bits (0-186)
        const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
        
        // 2. Máscara de limpeza (11 invertido na posição correta)
        // Ex: ...1111001111... zera apenas os 2 bits alvo
        const clearMask = ~(3n << bitPos);
        
        // 3. Valor atual (ou 0 se não existir)
        let currentLog = state.monthlyLogs.get(key) || 0n;
        
        // 4. Operação Bitwise: Limpa o buraco E insere o novo valor
        // (Valor & Limpeza) | (Novo << Posição)
        const newLog = (currentLog & clearMask) | (BigInt(newState) << bitPos);
        
        // 5. Atualiza Mapa e Flags
        state.monthlyLogs.set(key, newLog);
        
        // Flag para persistência saber que precisa salvar o Binário
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
     * [CLOUD SERIALIZATION] Exporta logs para JSON (Hex Strings).
     * Necessário para envio via API REST/JSON.
     */
    static serializeLogsForCloud(): [string, string][] {
        if (!state.monthlyLogs) return [];
        return Array.from(state.monthlyLogs.entries()).map(([key, val]) => {
            return [key, val.toString(16)] as [string, string];
        });
    }

    /**
     * [CLOUD DESERIALIZATION] Importa logs do JSON (Hex Strings).
     */
    static deserializeLogsFromCloud(serialized: [string, string][]) {
        if (!Array.isArray(serialized)) return;
        const map = new Map<string, bigint>();
        serialized.forEach(([key, hexVal]) => {
            try {
                // "0x" prefixo opcional, BigInt lida com isso se estiver limpo,
                // mas garantimos o formato hex explícito
                const hexClean = hexVal.startsWith("0x") ? hexVal : "0x" + hexVal;
                map.set(key, BigInt(hexClean));
            } catch (e) {
                console.warn(`Skipping invalid hex log: ${key}`);
            }
        });
        state.monthlyLogs = map;
    }
}
