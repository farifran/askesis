/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/dataMerge.ts
 * @description Algoritmo de Reconciliação de Estado (Smart Merge / CRDT-lite).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo executa lógica computacional pura (síncrona). 
 */

import { AppState, HabitDailyInfo, TimeOfDay } from '../state';
import { decompressString, compressString } from '../utils';

// PERFORMANCE: Lookup Table para pesos de status (Smi Values).
const STATUS_WEIGHTS: Record<string, number> = {
    'completed': 3,
    'snoozed': 2,
    'pending': 1
};

// CONSTANTS
const GZIP_PREFIX = 'GZIP:';

/**
 * Helper de fusão granular dia-a-dia.
 * Itera sobre os dados locais e aplica lógica de "Winner Takes All" baseada em peso.
 */
function mergeDayRecord(localDay: Record<string, HabitDailyInfo>, mergedDay: Record<string, HabitDailyInfo>) {
    for (const habitId in localDay) {
        if (!mergedDay[habitId]) {
            mergedDay[habitId] = localDay[habitId];
            continue;
        }

        const localHabitData = localDay[habitId];
        const mergedHabitData = mergedDay[habitId];

        if (localHabitData.dailySchedule !== undefined) {
            mergedHabitData.dailySchedule = localHabitData.dailySchedule;
        }

        const localInstances = localHabitData.instances;
        const mergedInstances = mergedHabitData.instances;

        for (const timeKey in localInstances) {
            const time = timeKey as TimeOfDay;
            const localInst = localInstances[time];
            const mergedInst = mergedInstances[time];

            if (!localInst) continue;

            if (!mergedInst) {
                mergedInstances[time] = localInst;
            } else {
                // CONFLITO SEMÂNTICO: Decoupled Merge Strategy.
                const lWeight = STATUS_WEIGHTS[localInst.status] ?? 1;
                const mWeight = STATUS_WEIGHTS[mergedInst.status] ?? 1;

                if (lWeight > mWeight) {
                    mergedInst.status = localInst.status;
                    if (localInst.goalOverride !== undefined) {
                        mergedInst.goalOverride = localInst.goalOverride;
                    }
                } else if (mergedInst.goalOverride === undefined && localInst.goalOverride !== undefined) {
                    mergedInst.goalOverride = localInst.goalOverride;
                }

                // Note Merge: "Maior Texto Vence".
                const lNoteLen = localInst.note?.length ?? 0;
                const mNoteLen = mergedInst.note?.length ?? 0;

                if (lNoteLen > mNoteLen) {
                    mergedInst.note = localInst.note;
                }
            }
        }
    }
}

async function hydrateArchive(content: string): Promise<Record<string, any>> {
    try {
        if (content.startsWith(GZIP_PREFIX)) {
            const json = await decompressString(content.substring(GZIP_PREFIX.length));
            return JSON.parse(json);
        }
        return JSON.parse(content);
    } catch (e) {
        console.error("Merge: Hydration failed", e);
        return {};
    }
}

/**
 * SMART MERGE ALGORITHM:
 * Combina dois estados de forma inteligente preservando o progresso.
 */
export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    const merged: AppState = structuredClone(incoming);

    // 1. Fusão de Definições de Hábitos
    const incomingIds = new Set();
    for (let i = 0; i < incoming.habits.length; i++) incomingIds.add(incoming.habits[i].id);
    
    for (let i = 0; i < local.habits.length; i++) {
        if (!incomingIds.has(local.habits[i].id)) {
            merged.habits.push(local.habits[i]);
        }
    }

    // 2. Mesclar Daily Data (Hot Storage)
    for (const date in local.dailyData) {
        if (!merged.dailyData[date]) {
            merged.dailyData[date] = local.dailyData[date];
        } else {
            mergeDayRecord(local.dailyData[date], merged.dailyData[date]);
        }
    }

    // 3. Fusão de Arquivos (Cold Storage)
    if (local.archives) {
        merged.archives = merged.archives || {};
        for (const year in local.archives) {
            if (!merged.archives[year]) {
                merged.archives[year] = local.archives[year];
            } else {
                try {
                    const [localYearData, incomingYearData] = await Promise.all([
                        hydrateArchive(local.archives[year]),
                        hydrateArchive(merged.archives[year])
                    ]);
                    
                    for (const date in localYearData) {
                        if (!incomingYearData[date]) {
                            incomingYearData[date] = localYearData[date];
                        } else {
                            mergeDayRecord(localYearData[date], incomingYearData[date]);
                        }
                    }
                    
                    const compressed = await compressString(JSON.stringify(incomingYearData));
                    merged.archives[year] = `${GZIP_PREFIX}${compressed}`;
                } catch (e) {
                    console.error(`Deep merge failed for ${year}`, e);
                }
            }
        }
    }

    // 4. Metadados
    merged.lastModified = Date.now();
    merged.version = Math.max(local.version, incoming.version);
    
    merged.notificationsShown = Array.from(new Set([...incoming.notificationsShown, ...local.notificationsShown]));
    merged.pending21DayHabitIds = Array.from(new Set([...incoming.pending21DayHabitIds, ...local.pending21DayHabitIds]));
    merged.pendingConsolidationHabitIds = Array.from(new Set([...incoming.pendingConsolidationHabitIds, ...local.pendingConsolidationHabitIds]));

    return merged;
}