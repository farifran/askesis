
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
import { decompressString, decompressFromBuffer, compressToBuffer } from '../utils';

// CONSTANTS
const GZIP_PREFIX = 'GZIP:';

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
            // Compara arrays de agendamento para evitar dirty flag falso (JSON stringify é rápido para arrays pequenos)
            const localSchStr = JSON.stringify(localHabitData.dailySchedule);
            const mergedSchStr = JSON.stringify(mergedHabitData.dailySchedule);
            
            if (localSchStr !== mergedSchStr) {
                mergedHabitData.dailySchedule = localHabitData.dailySchedule;
                isDirty = true;
            }
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
                isDirty = true;
            } else {
                // CONFLITO SEMÂNTICO: Note & Goal Override Merge
                // Status agora é gerenciado pelo monthlyLogs (Bitmask), então focamos nos metadados.
                
                // Goal Override: Local prevalece se merged for undefined (Union)
                if (mergedInst.goalOverride === undefined && localInst.goalOverride !== undefined) {
                    mergedInst.goalOverride = localInst.goalOverride;
                    isDirty = true;
                }

                // Note Merge: "Maior Texto Vence".
                const lNoteLen = localInst.note?.length ?? 0;
                const mNoteLen = mergedInst.note?.length ?? 0;

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

async function hydrateArchive(content: string | Uint8Array): Promise<Record<string, any>> {
    try {
        // Hybrid Reader
        if (content instanceof Uint8Array) {
            const json = await decompressFromBuffer(content);
            return JSON.parse(json);
        }
        
        if (typeof content === 'string') {
            if (content.startsWith(GZIP_PREFIX)) {
                const json = await decompressString(content.substring(GZIP_PREFIX.length));
                return JSON.parse(json);
            }
            return JSON.parse(content);
        }
        
        return {};
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
    // @fix: Cast to `any` to allow mutation of the cloned state object.
    const merged: any = structuredClone(incoming);

    // 1. Fusão de Definições de Hábitos
    const incomingIds = new Set();
    for (let i = 0; i < incoming.habits.length; i++) incomingIds.add(incoming.habits[i].id);
    
    for (let i = 0; i < local.habits.length; i++) {
        if (!incomingIds.has(local.habits[i].id)) {
            merged.habits.push(local.habits[i]);
        }
    }

    // 2. Mesclar Daily Data (Hot Storage - Metadados)
    for (const date in local.dailyData) {
        if (!merged.dailyData[date]) {
            merged.dailyData[date] = local.dailyData[date];
        } else {
            mergeDayRecord(local.dailyData[date], merged.dailyData[date]);
        }
    }

    // 3. Mesclar Logs Binários (Monthly Logs)
    // Robustez: Garante que estamos lidando com Maps, mesmo se a entrada vier como objeto
    if (local.monthlyLogs) {
        // Inicializa se não existir
        if (!merged.monthlyLogs) {
            merged.monthlyLogs = new Map();
        } else if (!(merged.monthlyLogs instanceof Map)) {
            // Recovery: Se merged.monthlyLogs veio como objeto (serialização incorreta), converte para Map
            try {
                merged.monthlyLogs = new Map(Object.entries(merged.monthlyLogs));
            } catch {
                merged.monthlyLogs = new Map();
            }
        }
        
        // Iteração Defensiva: local.monthlyLogs pode ser Map ou Objeto
        const localIterator = (local.monthlyLogs instanceof Map) 
            ? local.monthlyLogs.entries() 
            : Object.entries(local.monthlyLogs);

        for (const [key, val] of localIterator) {
            // Estratégia: Server Wins para conflitos (já está no merged/incoming), 
            // Local Wins para dados novos (Union).
            if (!merged.monthlyLogs.has(key)) {
                merged.monthlyLogs.set(key, val);
            }
        }
    }

    // 4. Fusão de Arquivos (Cold Storage)
    if (local.archives) {
        merged.archives = merged.archives || {};
        for (const year in local.archives) {
            if (!merged.archives[year]) {
                // Se o servidor não tem esse ano, pegamos o local.
                merged.archives[year] = local.archives[year];
            } else {
                try {
                    // Deep Merge necessário: Hidrata ambos para comparar
                    const [localYearData, incomingYearData] = await Promise.all([
                        hydrateArchive(local.archives[year]),
                        hydrateArchive(merged.archives[year])
                    ]);
                    
                    let isDirty = false;
                    for (const date in localYearData) {
                        if (!incomingYearData[date]) {
                            incomingYearData[date] = localYearData[date];
                            isDirty = true;
                        } else {
                            // Se mergeDayRecord retornar true, significa que houve mudança real nos dados
                            if (mergeDayRecord(localYearData[date], incomingYearData[date])) {
                                isDirty = true;
                            }
                        }
                    }
                    
                    // BINARY OPTIMIZATION: "Dirty Check"
                    // Só recomprime e substitui se houve alteração real.
                    // Caso contrário, mantém o buffer original do 'incoming' (Zero Allocation).
                    if (isDirty) {
                        const compressed = await compressToBuffer(JSON.stringify(incomingYearData));
                        merged.archives[year] = compressed;
                    }
                } catch (e) {
                    console.error(`Deep merge failed for ${year}`, e);
                }
            }
        }
    }

    // 5. Metadados
    merged.lastModified = Date.now();
    merged.version = Math.max(local.version, incoming.version);
    
    merged.notificationsShown = Array.from(new Set([...incoming.notificationsShown, ...local.notificationsShown]));
    merged.pending21DayHabitIds = Array.from(new Set([...incoming.pending21DayHabitIds, ...local.pending21DayHabitIds]));
    merged.pendingConsolidationHabitIds = Array.from(new Set([...incoming.pendingConsolidationHabitIds, ...local.pendingConsolidationHabitIds]));

    return merged;
}
