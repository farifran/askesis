import { state, HABIT_STATE, PERIOD_OFFSET, TimeOfDay, getHabitDailyInfoForDate } from '../state';
import { getHabitPropertiesForDate } from './selectors';

export class HabitService {

    private static getLogKey(habitId: string, dateISO: string): string {
        return `${habitId}_${dateISO.substring(0, 7)}`; // ID_YYYY-MM
    }

    /**
     * Leitura Híbrida:
     * 1. Tenta ler do novo sistema (BigInt).
     * 2. Se for 0, verifica se existe dado no sistema legado (dailyData) para não perder histórico.
     */
    static getStatus(habitId: string, dateISO: string, time: TimeOfDay): number {
        const key = this.getLogKey(habitId, dateISO);
        const log = state.monthlyLogs.get(key);
        
        // 1- Leitura do Bitmask (Prioridade)
        if (log !== undefined) {
            const day = parseInt(dateISO.substring(8, 10), 10);
            const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
            const val = Number((log >> bitPos) & 0b11n);
            if (val !== HABIT_STATE.NULL) return val;
        }
    
        // 2- Fallback Inteligente (Lê JSON Legado + Calcula Superação)
        try {
            const dayData = getHabitDailyInfoForDate(dateISO);
            const legacyInstance = dayData[habitId]?.instances[time];
            
            if (!legacyInstance) return HABIT_STATE.NULL;
            
            if (legacyInstance.status === 'completed') {
                // VERIFICAÇÃO DE ARETE (Superação)
                // Se houver um valor numérico (goalOverride) e ele for maior que a meta definida...
                if (legacyInstance.goalOverride !== undefined) {
                     // Recupera a meta original daquela data
                     const habit = state.habits.find(h => h.id === habitId);
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
            
            if (legacyInstance.status === 'snoozed') return HABIT_STATE.DEFERRED;
            
            return HABIT_STATE.NULL;
        } catch (e) {
            return HABIT_STATE.NULL;
        }
    }

    /**
     * Escrita no Novo Formato
     */
    static setStatus(habitId: string, dateISO: string, time: TimeOfDay, status: number) {
        const key = this.getLogKey(habitId, dateISO);
        let log = state.monthlyLogs.get(key) || 0n;
        
        const day = parseInt(dateISO.substring(8, 10), 10);
        const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);

        // Limpa bits antigos e seta novos
        log &= ~(0b11n << bitPos);
        log |= (BigInt(status) << bitPos);

        state.monthlyLogs.set(key, log);
        
        // Marcar UI como suja para re-render
        state.uiDirtyState.calendarVisuals = true;
    }
}