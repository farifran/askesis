
import { state, HABIT_STATE, PERIOD_OFFSET, TimeOfDay, getHabitDailyInfoForDate, Habit } from '../state';
import { getHabitPropertiesForDate } from './selectors';

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
     * Leitura Híbrida:
     * 1. Tenta ler do novo sistema (BigInt).
     * 2. Se for 0, verifica se existe dado no sistema legado (dailyData) para não perder histórico.
     * 
     * @param habitId ID do hábito
     * @param dateISO Data em formato ISO
     * @param time Período do dia
     * @param habitObj Otimização: Objeto Habit já carregado para evitar O(N) lookup no fallback.
     */
    static getStatus(habitId: string, dateISO: string, time: TimeOfDay, habitObj?: Habit): number {
        const key = this.getLogKey(habitId, dateISO);
        const log = state.monthlyLogs?.get(key);
        
        // 1- Leitura do Bitmask (Prioridade O(1))
        if (log !== undefined) {
            const day = parseInt(dateISO.substring(8, 10), 10);
            // Endereçamento: (Dia-1)*6 + Offset
            const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
            const val = Number((log >> bitPos) & 0b11n);
            if (val !== HABIT_STATE.NULL) return val;
        }
    
        // 2- Fallback Inteligente (Lê JSON Legado + Calcula Superação)
        // Isso é necessário apenas durante a fase de transição ou para dados muito antigos arquivados em JSON.
        try {
            const dayData = getHabitDailyInfoForDate(dateISO);
            const legacyInstance = dayData[habitId]?.instances[time];
            
            if (!legacyInstance) return HABIT_STATE.NULL;
            
            // TYPE CASTING SAFE: Propriedade 'status' removida da interface, acesso via 'any' para dados legados.
            const legacyStatus = (legacyInstance as any).status;

            if (legacyStatus === 'completed') {
                // VERIFICAÇÃO DE ARETE (Superação)
                // Se houver um valor numérico (goalOverride) e ele for maior que a meta definida...
                if (legacyInstance.goalOverride !== undefined) {
                     // Otimização: Usa o objeto passado ou busca no array (O(N))
                     const habit = habitObj || state.habits.find(h => h.id === habitId);
                     if (habit) {
                         const props = getHabitPropertiesForDate(habit, dateISO);
                         // Se a meta for numérica e o realizado for maior que o total
                         if (props?.goal?.total && legacyInstance.goalOverride > props.goal.total) {
                             return HABIT_STATE.DONE_PLUS;
                         }
                     }
                }
                return HABIT_STATE.DONE;
            }
            
            if (legacyStatus === 'snoozed') return HABIT_STATE.DEFERRED;
            
            return HABIT_STATE.NULL;
        } catch (e) {
            return HABIT_STATE.NULL;
        }
    }

    /**
     * Escrita no Novo Formato
     * Realiza operações bitwise atômicas no BigInt.
     */
    static setStatus(habitId: string, dateISO: string, time: TimeOfDay, status: number) {
        if (!state.monthlyLogs) state.monthlyLogs = new Map();
        
        const key = this.getLogKey(habitId, dateISO);
        let log = state.monthlyLogs.get(key) || 0n;
        
        const day = parseInt(dateISO.substring(8, 10), 10);
        const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);

        // Limpa bits antigos (AND com inverso da máscara) e seta novos (OR)
        log &= ~(0b11n << bitPos);
        log |= (BigInt(status) << bitPos);

        state.monthlyLogs.set(key, log);
        
        // Marcar UI como suja para re-render
        state.uiDirtyState.calendarVisuals = true;
    }

    /**
     * [ZERO-COST PERSISTENCE] Compacta logs para binário (ArrayBuffer).
     * Transforma Map<string, bigint> em Map<string, ArrayBuffer>.
     * 
     * CORREÇÃO CRÍTICA: Um BigInt de mês pode ter até 186 bits. 
     * ArrayBuffer(8) (64 bits) causa perda de dados.
     * Alocamos 24 bytes (192 bits) para cobrir o mês inteiro.
     */
    static packBinaryLogs(): Map<string, ArrayBuffer> {
        const packed = new Map<string, ArrayBuffer>();
        if (state.monthlyLogs && state.monthlyLogs instanceof Map) {
            state.monthlyLogs.forEach((val, key) => {
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
