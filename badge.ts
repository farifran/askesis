/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, getHabitDailyInfoForDate, shouldHabitAppearOnDate, getEffectiveScheduleForHabitOnDate } from './state';
import { getTodayUTCIso, parseUTCIsoDate } from './utils';

/**
 * Calcula o número de instâncias de hábitos pendentes para o dia atual.
 * @returns O número total de hábitos pendentes para hoje.
 */
function calculateTodayPendingCount(): number {
    const todayISO = getTodayUTCIso();
    const todayObj = parseUTCIsoDate(todayISO);
    const dailyInfo = getHabitDailyInfoForDate(todayISO);
    
    let pendingCount = 0;
    
    // Filtra por hábitos ativos, não graduados e agendados para hoje
    const activeHabitsToday = state.habits.filter(h => 
        !h.graduatedOn && shouldHabitAppearOnDate(h, todayObj)
    );

    activeHabitsToday.forEach(habit => {
        // Obtém o agendamento específico para hoje (pode ser uma substituição diária)
        const scheduleForToday = getEffectiveScheduleForHabitOnDate(habit, todayISO);
        const instances = dailyInfo[habit.id]?.instances || {};
        
        scheduleForToday.forEach(time => {
            const status = instances[time]?.status ?? 'pending';
            if (status === 'pending') {
                pendingCount++;
            }
        });
    });
    
    return pendingCount;
}

/**
 * Atualiza o emblema do ícone do aplicativo com o número atual de hábitos pendentes para hoje.
 * Se a contagem for zero, o emblema é limpo.
 * Esta função verifica o suporte do navegador antes de tentar definir o emblema.
 */
export async function updateAppBadge() {
    // A API de Emblema é suportada no objeto navigator.
    if ('setAppBadge' in navigator && 'clearAppBadge' in navigator) {
        try {
            const count = calculateTodayPendingCount();
            if (count > 0) {
                // A API faz parte do padrão, mas o TS pode não tê-la.
                // Usar 'as any' é uma forma segura de chamá-la.
                await (navigator as any).setAppBadge(count);
            } else {
                await (navigator as any).clearAppBadge();
            }
        } catch (error) {
            console.error('Failed to set app badge:', error);
        }
    }
}
