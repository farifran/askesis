import { state, HABIT_STATE, PERIOD_OFFSET, TimeOfDay, getHabitDailyInfoForDate } from '../state';

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
        
        if (log !== undefined) {
            // Leitura Bitwise Otimizada
            const day = parseInt(dateISO.substring(8, 10), 10);
            const bitPos = BigInt(((day - 1) * 6) + PERIOD_OFFSET[time]);
            return Number((log >> bitPos) & 0b11n);
        }

        // Fallback para Legado (Compatibilidade)
        const legacyDay = getHabitDailyInfoForDate(dateISO)[habitId];
        const status = legacyDay?.instances[time]?.status;
        
        if (status === 'completed') return HABIT_STATE.DONE;
        if (status === 'snoozed') return HABIT_STATE.DEFERRED;
        // Pending ou undefined vira NULL
        return HABIT_STATE.NULL;
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
