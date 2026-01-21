
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/dataMerge.ts
 * @description Algoritmo de Reconciliação de Estado (Smart Merge / CRDT-lite).
 */

import { AppState, HabitDailyInfo } from '../state';
import { HabitService } from './HabitService';
import { getTodayUTCIso } from '../utils';

/**
 * Mescla registros diários.
 * @param source O registro "dominante" (normalmente Cloud para hoje, ou Vencedor por Timestamp).
 * @param target O registro a ser atualizado.
 * @param preserveNotes Se true, tenta manter notas do target se source estiver vazio.
 */
function mergeDayRecord(source: Record<string, HabitDailyInfo>, target: Record<string, HabitDailyInfo>, preserveNotes = true) {
    for (const habitId in source) {
        if (!target[habitId]) {
            target[habitId] = source[habitId];
            continue;
        }

        const sourceHabitData = source[habitId];
        const targetHabitData = target[habitId]; // Objeto que será modificado (Merged)

        const sourceInstances = sourceHabitData.instances || {};
        const targetInstances = targetHabitData.instances || {};

        // Para HOJE (prioridade Cloud), começamos com a estrutura da Cloud.
        // Se for mesclagem histórica normal, a lógica de 'weights' abaixo resolve.
        
        for (const time in sourceInstances) {
            const srcInst = sourceInstances[time as any];
            const tgtInst = targetInstances[time as any];

            if (!srcInst) continue;

            if (!tgtInst) {
                targetInstances[time as any] = srcInst;
            } else {
                // WEIGHTED MERGE: Notes
                // Se a fonte (Cloud) não tem nota, mas o alvo (Local) tem, mantemos a Local.
                // Se ambas têm, e a Local é maior, mantemos a Local (assumindo edição recente não syncada).
                if (preserveNotes) {
                    const sNoteLen = srcInst.note ? srcInst.note.length : 0;
                    const tNoteLen = tgtInst.note ? tgtInst.note.length : 0;
                    
                    if ((!srcInst.note && tgtInst.note) || (tgtInst.note && tNoteLen > sNoteLen)) {
                        srcInst.note = tgtInst.note; // Injeta nota local no objeto fonte
                    }
                }
                // O objeto final é baseado no source (Cloud), com a nota enriquecida.
                targetInstances[time as any] = srcInst;
            }
        }
        
        // Se o source (Cloud) tem agendamento específico, ele ganha.
        if (sourceHabitData.dailySchedule) {
             targetHabitData.dailySchedule = sourceHabitData.dailySchedule;
        }
    }
}

export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    const localTs = local.lastModified || 0;
    const incomingTs = incoming.lastModified || 0;
    const todayISO = getTodayUTCIso();
    
    // 1. Define Base (Vencedor) por Timestamp
    // incoming = Nuvem
    let winner = localTs > incomingTs ? local : incoming;
    let loser = localTs > incomingTs ? incoming : local;
    
    const merged: AppState = structuredClone(winner);
    
    // 2. Habits Union (Prevent Duplicates by ID)
    const mergedIds = new Set(merged.habits.map(h => h.id));
    loser.habits.forEach(h => {
        if (!mergedIds.has(h.id)) {
            (merged.habits as any).push(h);
        }
    });

    // 3. Daily Data Merge (Rich Data)
    for (const date in loser.dailyData) {
        if (!merged.dailyData[date]) {
            (merged.dailyData as any)[date] = loser.dailyData[date];
        } else {
            // Para dias passados, usamos a lógica padrão de merge baseada no Vencedor
            if (date !== todayISO) {
                mergeDayRecord(loser.dailyData[date], (merged.dailyData as any)[date]);
            }
        }
    }

    // --- PRIORIDADE ABSOLUTA PARA HOJE (Cloud Wins) ---
    // Independentemente de quem é o 'winner' por timestamp, para HOJE,
    // queremos que a estrutura da Nuvem (incoming) seja a base, 
    // mas preservando notas locais se elas forem mais detalhadas.
    if (incoming.dailyData[todayISO]) {
        if (!merged.dailyData[todayISO]) {
            (merged.dailyData as any)[todayISO] = {};
        }
        // Aqui invertemos a lógica: 'source' é incoming (Cloud), 'target' é o merged (que pode ter dados locais).
        // TYPE FIX: Cast explícito para 'any' ou 'Record' mutável para satisfazer o compilador TS,
        // já que merged.dailyData é tipado como Readonly no AppState.
        mergeDayRecord(incoming.dailyData[todayISO], (merged.dailyData as any)[todayISO], true);
    }

    // 4. Archives Union
    if (loser.archives) {
        (merged as any).archives = merged.archives || {};
        for (const year in loser.archives) {
            if (!merged.archives[year]) {
                (merged.archives as any)[year] = loser.archives[year];
            }
        }
    }
    
    // 5. Monthly Logs (Bitmasks) - SMART MERGE
    merged.monthlyLogs = HabitService.mergeLogs(winner.monthlyLogs, loser.monthlyLogs);
    
    // --- FORCE TODAY BITMASK FROM CLOUD ---
    // Sobrescreve especificamente os bits de hoje com o que está na nuvem.
    if (incoming.monthlyLogs) {
        HabitService.overwriteDayBits(merged.monthlyLogs, incoming.monthlyLogs, todayISO);
    }

    // 6. Time Integrity (Monotonic Clock)
    const now = Date.now();
    merged.lastModified = Math.max(localTs, incomingTs, now);
    
    if (merged.lastModified === Math.max(localTs, incomingTs)) {
        merged.lastModified += 1;
    }

    // @ts-ignore
    merged.version = Math.max(local.version || 0, incoming.version || 0);
    
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
