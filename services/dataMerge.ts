/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/dataMerge.ts
 * @description Algoritmo de Reconciliação de Estado (Smart Merge / CRDT-lite).
 * Necessário para Importação Manual e Migrações na Thread Principal.
 */

import { AppState, HabitDailyInfo } from '../state';
import { compressToBuffer } from '../utils';

/**
 * Helper de fusão granular dia-a-dia.
 * Itera sobre os dados locais e aplica lógica de "Winner Takes All" baseada em peso.
 * Retorna true se houver alterações no mergedDay.
 */
function mergeDayRecord(localDay: Record<string, HabitDailyInfo>, mergedDay: Record<string, HabitDailyInfo>): boolean {
    let isDirty = false;
    for (const habitId in localDay) {
        if (!mergedDay[habitId]) {
            mergedDay[habitId] = localDay[habitId];
            isDirty = true;
            continue;
        }

        const localHabitData = localDay[habitId];
        const mergedHabitData = mergedDay[habitId];

        if (localHabitData.dailySchedule !== undefined) {
            const localSchStr = JSON.stringify(localHabitData.dailySchedule);
            const mergedSchStr = JSON.stringify(mergedHabitData.dailySchedule);
            if (localSchStr !== mergedSchStr) {
                mergedHabitData.dailySchedule = localHabitData.dailySchedule;
                isDirty = true;
            }
        }

        const localInstances = localHabitData.instances || {};
        const mergedInstances = mergedHabitData.instances || {};

        for (const time in localInstances) {
            const localInst = localInstances[time as any];
            const mergedInst = mergedInstances[time as any];

            if (!localInst) continue;

            if (!mergedInst) {
                mergedInstances[time as any] = localInst;
                isDirty = true;
            } else {
                if (mergedInst.goalOverride === undefined && localInst.goalOverride !== undefined) {
                    mergedInst.goalOverride = localInst.goalOverride;
                    isDirty = true;
                }
                
                const lNoteLen = localInst.note ? localInst.note.length : 0;
                const mNoteLen = mergedInst.note ? mergedInst.note.length : 0;
                
                if (lNoteLen > mNoteLen) {
                    if (mergedInst.note !== localInst.note) {
                        mergedInst.note = localInst.note;
                        isDirty = true;
                    }
                }
            }
        }
    }
    return isDirty;
}

async function hydrateArchive(content: string | Uint8Array): Promise<Record<string, Record<string, HabitDailyInfo>>> {
    // Na Main Thread não temos as funções de descompressão síncronas aqui facilmente sem importar utils pesados,
    // mas para a finalidade de merge de estado principal, geralmente lidamos com objetos já hidratados ou ignoramos arquivos profundos
    // se não formos o worker. 
    // Simplificação: Retorna vazio se for binário na main thread, pois a main thread raramente faz merge profundo de arquivos históricos.
    // Se necessário, o cloud.ts (Worker) é quem faz isso.
    return {}; 
}

/**
 * Funde o estado local com um estado recebido (Cloud ou Arquivo).
 * Estratégia: União de Conjuntos + Preservação de Dados Mais Ricos.
 */
export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    // Deep Clone do incoming para usar como base
    const merged: AppState = structuredClone(incoming);
    
    // 1. Habits: União por ID
    const incomingIds = new Set(incoming.habits.map(h => h.id));
    local.habits.forEach(h => {
        if (!incomingIds.has(h.id)) {
            (merged.habits as any).push(h);
        }
    });

    // 2. Daily Data: Merge granular
    for (const date in local.dailyData) {
        if (!merged.dailyData[date]) {
            (merged.dailyData as any)[date] = local.dailyData[date];
        } else {
            mergeDayRecord(local.dailyData[date], merged.dailyData[date]);
        }
    }

    // 3. Archives (Simplificado para Main Thread)
    // A thread principal geralmente não precisa fazer merge complexo de arquivos zipados,
    // apenas garantir que arquivos ausentes sejam copiados.
    if (local.archives) {
        (merged as any).archives = merged.archives || {};
        for (const year in local.archives) {
            if (!merged.archives[year]) {
                (merged.archives as any)[year] = local.archives[year];
            }
        }
    }
    
    // 4. Metadados e Preferências
    merged.lastModified = Date.now();
    // @ts-ignore
    merged.version = Math.max(local.version || 0, incoming.version || 0);
    
    // Merge de Listas (Sets)
    const mergeList = (a: readonly any[] | undefined, b: readonly any[] | undefined) => 
        Array.from(new Set([...(a||[]), ...(b||[])]));

    // @ts-ignore
    merged.notificationsShown = mergeList(incoming.notificationsShown, local.notificationsShown);
    // @ts-ignore
    merged.pending21DayHabitIds = mergeList(incoming.pending21DayHabitIds, local.pending21DayHabitIds);
    // @ts-ignore
    merged.pendingConsolidationHabitIds = mergeList(incoming.pendingConsolidationHabitIds, local.pendingConsolidationHabitIds);

    return merged;
}