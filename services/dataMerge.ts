
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
                // WEIGHTED MERGE: Notes & Overrides
                if (mergedInst.goalOverride === undefined && localInst.goalOverride !== undefined) {
                    mergedInst.goalOverride = localInst.goalOverride;
                    isDirty = true;
                }
                
                const lNoteLen = localInst.note ? localInst.note.length : 0;
                const mNoteLen = mergedInst.note ? mergedInst.note.length : 0;
                
                if ((!mergedInst.note && localInst.note) || (localInst.note && lNoteLen > mNoteLen)) {
                    mergedInst.note = localInst.note;
                    isDirty = true;
                }
            }
        }
        
        if (!mergedHabitData.dailySchedule && localHabitData.dailySchedule) {
             mergedHabitData.dailySchedule = localHabitData.dailySchedule;
             isDirty = true;
        }
    }
    return isDirty;
}

export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    const localTs = local.lastModified || 0;
    const incomingTs = incoming.lastModified || 0;
    
    // 1. Define Base (Vencedor) por Timestamp
    let winner = localTs > incomingTs ? local : incoming;
    let loser = localTs > incomingTs ? incoming : local;
    
    const merged: AppState = structuredClone(winner);
    
    // 2. Habits Union (Prevent Duplicates by ID)
    const mergedIds = new Set(merged.habits.map(h => h.id));
    loser.habits.forEach(h => {
        if (!mergedIds.has(h.id)) {
            // Hábito novo vindo do estado 'perdedor' (ex: criado no tablet)
            (merged.habits as any).push(h);
        }
    });

    // 3. Daily Data Merge (Rich Data)
    for (const date in loser.dailyData) {
        if (!merged.dailyData[date]) {
            (merged.dailyData as any)[date] = loser.dailyData[date];
        } else {
            mergeDayRecord(loser.dailyData[date], merged.dailyData[date]);
        }
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
    // Usa o HabitService para fundir inteligentemente os mapas
    merged.monthlyLogs = HabitService.mergeLogs(winner.monthlyLogs, loser.monthlyLogs);

    // 6. Time Integrity (Monotonic Clock)
    const now = Date.now();
    merged.lastModified = Math.max(localTs, incomingTs, now);
    
    if (merged.lastModified === Math.max(localTs, incomingTs)) {
        merged.lastModified += 1;
    }

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
