
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { getHabitDailyInfoForDate, getActiveHabitsForDate } from './state';
import { getTodayUTCIso } from './utils';

// [2025-01-15] TYPE SAFETY: Definição de interface local para a Badging API.
// Evita o uso repetido de 'as any' e fornece autocompletar/verificação se o TS for atualizado.
interface NavigatorWithBadging extends Navigator {
    setAppBadge(contents?: number): Promise<void>;
    clearAppBadge(): Promise<void>;
}

/**
 * Calcula o número de instâncias de hábitos pendentes para o dia atual.
 * @returns O número total de hábitos pendentes para hoje.
 */
function calculateTodayPendingCount(): number {
    const todayISO = getTodayUTCIso();
    // PERFORMANCE [2025-02-23]: Passamos a string ISO diretamente.
    // getActiveHabitsForDate lida eficientemente com strings, evitando parsing desnecessário aqui.
    // USE LAZY ACCESSOR: Ensure compatibility with archive/lazy-loading architecture.
    const dailyInfo = getHabitDailyInfoForDate(todayISO);
    
    let pendingCount = 0;
    
    const activeHabitsToday = getActiveHabitsForDate(todayISO);

    activeHabitsToday.forEach(({ habit, schedule }) => {
        const instances = dailyInfo[habit.id]?.instances || {};
        
        schedule.forEach(time => {
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
export async function updateAppBadge(): Promise<void> {
    // A API de Emblema é suportada no objeto navigator.
    if ('setAppBadge' in navigator && 'clearAppBadge' in navigator) {
        try {
            const count = calculateTodayPendingCount();
            const nav = navigator as NavigatorWithBadging;

            if (count > 0) {
                await nav.setAppBadge(count);
            } else {
                await nav.clearAppBadge();
            }
        } catch (error) {
            // Falha silenciosa ou log discreto é aceitável para funcionalidades de UI progressivas
            console.error('Failed to set app badge:', error);
        }
    }
}
