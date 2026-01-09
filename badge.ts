import { getHabitDailyInfoForDate } from './state';
import { getTodayUTCIso, parseUTCIsoDate, getActiveHabitsForDate } from './utils';

// MELHORIA DE TIPAGEM [2024-12-24]: Estende a interface global do Navigator para incluir
// a API de Badging, fornecendo segurança de tipos e autocompletar, e eliminando a
// necessidade de coerções de tipo (as any).
declare global {
    interface Navigator {
        setAppBadge?(count: number): Promise<void>;
        clearAppBadge?(): Promise<void>;
    }
}

/**
 * Calcula o número de instâncias de hábitos pendentes para o dia atual.
 * @returns O número total de hábitos pendentes para hoje.
 */
function calculateTodayPendingCount(): number {
    const todayISO = getTodayUTCIso();
    const todayObj = parseUTCIsoDate(todayISO);
    const dailyInfo = getHabitDailyInfoForDate(todayISO);
    
    let pendingCount = 0;
    
    // Usa a função auxiliar para obter hábitos ativos e seus agendamentos de uma só vez.
    const activeHabitsToday = getActiveHabitsForDate(todayObj);

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
export async function updateAppBadge() {
    // A API de Emblema é suportada no objeto navigator.
    // MELHORIA DE TIPAGEM [2024-12-24]: A verificação de 'setAppBadge' e a chamada subsequente agora são
    // totalmente seguras em termos de tipo, graças à declaração global.
    if (navigator.setAppBadge && navigator.clearAppBadge) {
        try {
            const count = calculateTodayPendingCount();
            if (count > 0) {
                await navigator.setAppBadge(count);
            } else {
                await navigator.clearAppBadge();
            }
        } catch (error) {
            console.error('Failed to set app badge:', error);
        }
    }
}