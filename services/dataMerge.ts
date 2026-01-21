
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

import { AppState, Habit, HabitDailyInfo, TimeOfDay } from '../state';
import { decompressString, compressString, parseUTCIsoDate } from '../utils';

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
 * Combina dois estados de forma inteligente preservando o progresso e respeitando deleções.
 * 
 * Lógica de Estrutura (Hábitos):
 * 1. Identifica qual estado é mais recente (Autoridade).
 * 2. Usa a lista de hábitos da Autoridade como base.
 * 3. Incorpora hábitos do estado antigo APENAS se eles foram criados DEPOIS da data de modificação da Autoridade (Offline Creations).
 *    Isso evita que hábitos deletados na Autoridade "ressuscitem" vindo do estado antigo.
 */
export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    const localIsNewer = local.lastModified > incoming.lastModified;
    const newerState = localIsNewer ? local : incoming;
    const olderState = localIsNewer ? incoming : local;

    // 1. Base da Fusão é o estado mais recente (Clone profundo para segurança)
    const merged: AppState = structuredClone(newerState);

    // 2. Fusão Inteligente de Definições de Hábitos
    // Objetivo: Detectar hábitos criados offline no dispositivo "velho" que precisam ser salvos,
    // enquanto ignoramos hábitos que existem no "velho" mas foram deletados no "novo".
    
    const newerIds = new Set(newerState.habits.map(h => h.id));
    
    for (const oldHabit of olderState.habits) {
        // Se o hábito já existe no novo, ignoramos (a versão do 'newerState' prevalece pois é mais recente)
        if (newerIds.has(oldHabit.id)) continue;

        // Se o hábito NÃO existe no novo, temos um dilema:
        // A) Ele foi criado no 'olderState' recentemente (enquanto offline)? -> DEVEMOS MANTER.
        // B) Ele existia em ambos, mas foi deletado no 'newerState'? -> DEVEMOS DESCARTAR.
        
        // Critério: Se a data de criação do hábito é POSTERIOR ao lastModified do 'newerState',
        // assumimos que é uma criação nova offline que o 'newerState' desconhece.
        const createdTime = parseUTCIsoDate(oldHabit.createdOn).getTime();
        
        // Margem de segurança de 1 minuto para evitar race conditions de relógio
        // Se o hábito foi criado DEPOIS que o estado vencedor foi salvo, ele é novo.
        if (createdTime > (newerState.lastModified - 60000)) {
            merged.habits.push(oldHabit);
        } else {
            // Caso contrário, assumimos que o 'newerState' deliberadamente não tem esse hábito (foi deletado)
            // LOG: console.log(`Dropping zombie habit: ${oldHabit.name || oldHabit.id}`);
        }
    }

    // 3. Mesclar Daily Data (Hot Storage)
    // Aqui fundimos o progresso. Se fiz check no "velho", queremos que conte.
    for (const date in olderState.dailyData) {
        if (!merged.dailyData[date]) {
            merged.dailyData[date] = olderState.dailyData[date];
        } else {
            mergeDayRecord(olderState.dailyData[date], merged.dailyData[date]);
        }
    }

    // 4. Fusão de Arquivos (Cold Storage)
    if (olderState.archives) {
        merged.archives = merged.archives || {};
        for (const year in olderState.archives) {
            if (!merged.archives[year]) {
                merged.archives[year] = olderState.archives[year];
            } else {
                try {
                    const [olderYearData, mergedYearData] = await Promise.all([
                        hydrateArchive(olderState.archives[year]),
                        hydrateArchive(merged.archives[year])
                    ]);
                    
                    for (const date in olderYearData) {
                        if (!mergedYearData[date]) {
                            mergedYearData[date] = olderYearData[date];
                        } else {
                            mergeDayRecord(olderYearData[date], mergedYearData[date]);
                        }
                    }
                    
                    const compressed = await compressString(JSON.stringify(mergedYearData));
                    merged.archives[year] = `${GZIP_PREFIX}${compressed}`;
                } catch (e) {
                    console.error(`Deep merge failed for ${year}`, e);
                }
            }
        }
    }

    // 5. Metadados e Limpeza Final
    // Garante que o timestamp seja sempre incremental para o próximo sync
    merged.lastModified = Date.now();
    merged.version = Math.max(local.version, incoming.version);
    
    // Mescla notificações vistas para não repetir alertas
    merged.notificationsShown = Array.from(new Set([...incoming.notificationsShown, ...local.notificationsShown]));
    
    // Limpa DailyData de hábitos que não existem mais na lista final (Garbage Collection)
    const validIds = new Set(merged.habits.map(h => h.id));
    for (const date in merged.dailyData) {
        for (const habitId in merged.dailyData[date]) {
            if (!validIds.has(habitId)) {
                delete merged.dailyData[date][habitId];
            }
        }
    }

    return merged;
}
