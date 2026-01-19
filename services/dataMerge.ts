
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/dataMerge.ts
 * @description Algoritmo de Reconciliação de Estado (Smart Merge / CRDT-lite).
 * Versão Main Thread (sincronizada logicamente com o Worker).
 */

import { AppState, HabitDailyInfo } from '../state';

function mergeDayRecord(localDay: Record<string, HabitDailyInfo>, mergedDay: Record<string, HabitDailyInfo>): boolean {
    let isDirty = false;
    for (const habitId in localDay) {
        // Se o merged (vencedor) não tem dados para este hábito neste dia, adotamos o local (perdedor)
        if (!mergedDay[habitId]) {
            mergedDay[habitId] = localDay[habitId];
            isDirty = true;
            continue;
        }

        const localHabitData = localDay[habitId];
        const mergedHabitData = mergedDay[habitId];

        const localInstances = localHabitData.instances || {};
        const mergedInstances = mergedHabitData.instances || {};

        for (const time in localInstances) {
            const localInst = localInstances[time as any];
            const mergedInst = mergedInstances[time as any];

            if (!localInst) continue;

            if (!mergedInst) {
                // Vencedor não tinha registro para este horário -> Adiciona do perdedor
                mergedInstances[time as any] = localInst;
                isDirty = true;
            } else {
                // WEIGHTED MERGE LOGIC (Main Thread)
                
                // 1. Goal Override
                // Se vencedor não tem override, mas perdedor tem -> mantemos o do perdedor
                if (mergedInst.goalOverride === undefined && localInst.goalOverride !== undefined) {
                    mergedInst.goalOverride = localInst.goalOverride;
                    isDirty = true;
                }
                
                // 2. Notes (Heavier wins)
                const lNoteLen = localInst.note ? localInst.note.length : 0;
                const mNoteLen = mergedInst.note ? mergedInst.note.length : 0;
                
                // Se o vencedor tem nota vazia e o perdedor tem nota -> Perdedor ganha
                // Se ambos têm, e a do perdedor é maior -> Perdedor ganha (assumindo mais detalhe)
                if ((!mergedInst.note && localInst.note) || (localInst.note && lNoteLen > mNoteLen)) {
                    mergedInst.note = localInst.note;
                    isDirty = true;
                }
            }
        }
        
        // Preserve Schedules changes if missing in winner
        if (!mergedHabitData.dailySchedule && localHabitData.dailySchedule) {
             mergedHabitData.dailySchedule = localHabitData.dailySchedule;
             isDirty = true;
        }
    }
    return isDirty;
}

export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    // 1. Newest Wins Strategy (Hybrid)
    const localTs = local.lastModified || 0;
    const incomingTs = incoming.lastModified || 0;
    
    // Define quem é a base ("Vencedor") e quem será fundido ("Perdedor")
    let winner = localTs > incomingTs ? local : incoming;
    let loser = localTs > incomingTs ? incoming : local;
    
    // CLONE: Garante que não mutamos o estado original durante o merge
    const merged: AppState = structuredClone(winner);
    
    // 2. Habits: Union by ID (Don't lose offline creations)
    const mergedIds = new Set(merged.habits.map(h => h.id));
    loser.habits.forEach(h => {
        if (!mergedIds.has(h.id)) {
            // Hábito existia no estado antigo/offline mas não no novo -> Preserva
            // (Assumindo que não foi deletado explicitamente, mas criado recentemente)
            (merged.habits as any).push(h);
        }
    });

    // 3. Daily Data: Weighted Merge (Inject loser data into winner if beneficial)
    for (const date in loser.dailyData) {
        if (!merged.dailyData[date]) {
            // Data inteira faltando no vencedor -> Copia do perdedor
            (merged.dailyData as any)[date] = loser.dailyData[date];
        } else {
            // Data existe -> Merge granular
            mergeDayRecord(loser.dailyData[date], merged.dailyData[date]);
        }
    }

    // 4. Archives (Union Keys)
    if (loser.archives) {
        (merged as any).archives = merged.archives || {};
        for (const year in loser.archives) {
            if (!merged.archives[year]) {
                (merged.archives as any)[year] = loser.archives[year];
            }
        }
    }
    
    // 5. Monthly Logs (Bitmasks)
    // Mapas de bits são difíceis de fundir sem lógica de vetor.
    // Mantemos a estratégia "Vencedor Leva Tudo" por chave de mês, 
    // mas se o vencedor não tiver o mês, pegamos do perdedor.
    if (loser.monthlyLogs && loser.monthlyLogs.size > 0) {
        if (!merged.monthlyLogs) merged.monthlyLogs = new Map();
        for (const [key, val] of loser.monthlyLogs.entries()) {
            if (!merged.monthlyLogs.has(key)) {
                merged.monthlyLogs.set(key, val);
            }
        }
    }

    // TIME INTEGRITY FIX: High-Water Mark Algorithm
    // O novo timestamp deve ser estritamente maior ou igual a qualquer timestamp visto anteriormente.
    // Isso garante que este novo estado fundido seja reconhecido como a "Verdade" na próxima sincronização.
    const now = Date.now();
    merged.lastModified = Math.max(localTs, incomingTs, now);
    
    // Se por acaso os timestamps forem iguais, incrementa +1 para garantir mudança
    if (merged.lastModified === Math.max(localTs, incomingTs)) {
        merged.lastModified += 1;
    }

    // Versioning
    // @ts-ignore
    merged.version = Math.max(local.version || 0, incoming.version || 0);
    
    // Merge Arrays (Union)
    const mergeList = (a: readonly any[] | undefined, b: readonly any[] | undefined) => 
        Array.from(new Set([...(a||[]), ...(b||[])]));

    // @ts-ignore
    merged.notificationsShown = mergeList(merged.notificationsShown, loser.notificationsShown);
    // @ts-ignore
    merged.pending21DayHabitIds = mergeList(merged.pending21DayHabitIds, loser.pending21DayHabitIds);
    // @ts-ignore
    merged.pendingConsolidationHabitIds = mergeList(merged.pendingConsolidationHabitIds, loser.pendingConsolidationHabitIds);

    return merged;
}
