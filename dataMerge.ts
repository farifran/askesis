
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppState, HabitDailyInfo, HabitStatus, TimeOfDay } from './state';

/**
 * SMART MERGE ALGORITHM:
 * Combina dois estados (Local e Remoto/Backup) de forma inteligente, preservando o máximo de dados possível.
 * - Hábitos: União baseada em ID.
 * - Dados Diários: Fusão granular baseada em peso de status (Completed > Snoozed > Pending).
 * - Archives: Fusão de dados históricos (Cold Storage).
 * - Arrays: União de conjuntos.
 */
export function mergeStates(local: AppState, incoming: AppState): AppState {
    // 1. Base: O estado que chega (incoming) é a base, clonamos para evitar mutação.
    const merged: AppState = JSON.parse(JSON.stringify(incoming));

    // 2. Fusão de Definições de Hábitos (Estratégia de União)
    // Se o usuário criou um hábito novo localmente que não está no incoming, adicionamos ao merge.
    const incomingHabitIds = new Set(incoming.habits.map(h => h.id));
    local.habits.forEach(localHabit => {
        if (!incomingHabitIds.has(localHabit.id)) {
            merged.habits.push(localHabit);
        }
    });

    // 3. Fusão de Dados Diários (Estratégia de Peso de Status)
    // Pesos: Completed (3) > Snoozed (2) > Pending (1)
    const getStatusWeight = (status: HabitStatus | undefined): number => {
        if (status === 'completed') return 3;
        if (status === 'snoozed') return 2;
        return 1; // Pending ou undefined
    };

    const mergeDayRecord = (localDay: Record<string, HabitDailyInfo>, mergedDay: Record<string, HabitDailyInfo>) => {
        for (const habitId in localDay) {
            // Se o hábito não tem dados neste dia no incoming, copiamos do local.
            if (!mergedDay[habitId]) {
                mergedDay[habitId] = localDay[habitId];
                continue;
            }

            // CONFLITO GRANULAR: O mesmo hábito, no mesmo dia, existe em ambos.
            const localHabitData = localDay[habitId];
            const mergedHabitData = mergedDay[habitId];

            // A. Mesclar Override de Agendamento (Daily Schedule)
            if (localHabitData.dailySchedule !== undefined) {
                mergedHabitData.dailySchedule = localHabitData.dailySchedule;
            }

            // B. Mesclar Instâncias (Períodos do dia)
            const localInstances = localHabitData.instances;
            const mergedInstances = mergedHabitData.instances;

            for (const timeKey in localInstances) {
                const time = timeKey as TimeOfDay;
                const localInst = localInstances[time];
                const mergedInst = mergedInstances[time];

                if (!localInst) continue;

                if (!mergedInst) {
                    // Existe local mas não no incoming -> Adiciona
                    mergedInstances[time] = localInst;
                } else {
                    // COLISÃO DE INSTÂNCIA:
                    const localWeight = getStatusWeight(localInst.status);
                    const mergedWeight = getStatusWeight(mergedInst.status);

                    if (localWeight > mergedWeight) {
                        // Local é "mais completo/significativo", sobrescreve incoming.
                        mergedInstances[time] = localInst;
                    } else if (localWeight === mergedWeight) {
                        // Pesos iguais: Preservar a nota mais longa ou meta numérica
                        if (localInst.note && (!mergedInst.note || localInst.note.length > mergedInst.note.length)) {
                            mergedInst.note = localInst.note;
                        }
                        if (localInst.goalOverride !== undefined) {
                            mergedInst.goalOverride = localInst.goalOverride;
                        }
                    }
                }
            }
        }
    };

    // Mesclar Daily Data (Hot Storage)
    for (const date in local.dailyData) {
        if (!merged.dailyData[date]) {
            merged.dailyData[date] = local.dailyData[date];
        } else {
            mergeDayRecord(local.dailyData[date], merged.dailyData[date]);
        }
    }

    // 4. Fusão de Arquivos (Cold Storage)
    if (local.archives) {
        merged.archives = merged.archives || {};
        for (const year in local.archives) {
            if (!merged.archives[year]) {
                // Se só existe no local, copia direto
                merged.archives[year] = local.archives[year];
            } else {
                // Conflito de Arquivos: Ambos têm dados para este ano.
                try {
                    const localYearData = JSON.parse(local.archives[year]);
                    const incomingYearData = JSON.parse(merged.archives[year]);
                    
                    // Mescla dia a dia dentro do ano arquivado
                    for (const date in localYearData) {
                        if (!incomingYearData[date]) {
                            incomingYearData[date] = localYearData[date];
                        } else {
                            mergeDayRecord(localYearData[date], incomingYearData[date]);
                        }
                    }
                    
                    // Recompacta
                    merged.archives[year] = JSON.stringify(incomingYearData);
                } catch (e) {
                    console.error(`Failed to merge archives for year ${year}`, e);
                    // Em caso de erro, mantém a versão do incoming por segurança
                }
            }
        }
    }

    // 5. Fusão de Metadados e Arrays Auxiliares
    merged.lastModified = Date.now(); // O merge cria um novo momento no tempo
    merged.version = Math.max(local.version, incoming.version);
    
    const allNotifications = new Set([...incoming.notificationsShown, ...local.notificationsShown]);
    merged.notificationsShown = Array.from(allNotifications);

    const all21Days = new Set([...incoming.pending21DayHabitIds, ...local.pending21DayHabitIds]);
    merged.pending21DayHabitIds = Array.from(all21Days);

    const all66Days = new Set([...incoming.pendingConsolidationHabitIds, ...local.pendingConsolidationHabitIds]);
    merged.pendingConsolidationHabitIds = Array.from(all66Days);

    return merged;
}
