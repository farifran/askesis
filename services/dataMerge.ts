/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/dataMerge.ts
 * @description Algoritmo de Reconciliação de Estado (Smart Merge / CRDT-lite).
 * 
 * UPDATE [2025-06-25]: Adicionada Deduplicação Inteligente Robusta.
 * Suporta normalização de texto e fallback para nameKey.
 */

import { AppState, HabitDailyInfo, Habit, HabitSchedule } from '../state';
import { logger } from '../utils';
import { HabitService } from './HabitService';
import { deduplicateTimeOfDay } from './habitActions';

function isValidBigIntString(value: string): boolean {
    if (!value) return false;
    const normalized = value.startsWith('0x') ? value.slice(2) : value;
    if (!/^[0-9a-f]+$/i.test(normalized)) return false;
    if (normalized.length > 64) return false;
    return true;
}

function safeBigIntFromUnknown(value: any): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
        return BigInt(value);
    }
    if (typeof value === 'string') {
        if (!isValidBigIntString(value)) return null;
        const hexClean = value.startsWith('0x') ? value : '0x' + value;
        return BigInt(hexClean);
    }
    if (value && typeof value === 'object' && 'val' in value) {
        return safeBigIntFromUnknown((value as any).val);
    }
    return null;
}

function hydrateLogs(appState: AppState) {
    if (appState.monthlyLogs && !(appState.monthlyLogs instanceof Map)) {
        const entries = Array.isArray(appState.monthlyLogs) 
            ? appState.monthlyLogs 
            : Object.entries(appState.monthlyLogs);
            
        const map = new Map<string, bigint>();
        entries.forEach((item: any) => {
            const [key, val] = item as [string, any];
            try {
                const hydrated = safeBigIntFromUnknown(val);
                if (hydrated !== null) map.set(key, hydrated);
                else logger.warn(`[Merge] Invalid bigint value for ${key}`);
            } catch(e) {
                logger.warn(`[Merge] Failed to hydrate bitmask for ${key}`, e);
            }
        });
        (appState as any).monthlyLogs = map;
    }
}

function mergeHabitHistories(winnerHistory: HabitSchedule[], loserHistory: HabitSchedule[]): HabitSchedule[] {
    const historyMap = new Map<string, HabitSchedule>();
    loserHistory.forEach(s => historyMap.set(s.startDate, { ...s }));
    winnerHistory.forEach(s => historyMap.set(s.startDate, { ...s }));
    return Array.from(historyMap.values()).sort((a, b) => a.startDate.localeCompare(b.startDate));
}

type HabitInstanceMap = NonNullable<HabitDailyInfo['instances']>;
type HabitInstanceKey = keyof HabitInstanceMap;

function isHabitInstanceKey(value: string): value is HabitInstanceKey {
    return value === 'Morning' || value === 'Afternoon' || value === 'Evening';
}

function mergeDayRecord(source: Record<string, HabitDailyInfo>, target: Record<string, HabitDailyInfo>) {
    for (const habitId in source) {
        if (!target[habitId]) {
            target[habitId] = source[habitId];
            continue;
        }

        const sourceInstances: HabitInstanceMap = source[habitId].instances ?? {};
        const targetInstances: HabitInstanceMap = target[habitId].instances ?? {};

        for (const time of Object.keys(sourceInstances)) {
            if (!isHabitInstanceKey(time)) continue;

            const srcInst = sourceInstances[time];
            const tgtInst = targetInstances[time];

            if (!srcInst) continue;

            if (!tgtInst) {
                targetInstances[time] = srcInst;
            } else {
                if ((srcInst.note?.length || 0) > (tgtInst.note?.length || 0)) {
                    tgtInst.note = srcInst.note;
                }
                if (srcInst.goalOverride !== undefined) {
                    tgtInst.goalOverride = srcInst.goalOverride;
                }
            }
        }

        target[habitId].instances = targetInstances;

        if (source[habitId].dailySchedule) {
            target[habitId].dailySchedule = source[habitId].dailySchedule;
        }
    }
}

/**
 * Obtém uma identidade normalizada para o hábito (Nome ou Chave de Tradução).
 */
function getHabitIdentity(h: Habit): string | null {
    if (!h.scheduleHistory || h.scheduleHistory.length === 0) return null;
    // Pega o agendamento mais recente
    const lastSchedule = h.scheduleHistory.reduce((prev, curr) => 
        (curr.startDate > prev.startDate ? curr : prev), h.scheduleHistory[0]);
    
    // Identidade é baseada no Nome explícito OU na Chave de Tradução
    const raw = lastSchedule.name || lastSchedule.nameKey || '';
    
    // Normalização: Minúsculo, sem espaços extras nas pontas
    const normalized = raw.trim().toLowerCase();
    
    return normalized.length > 0 ? normalized : null;
}

export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    [local, incoming].forEach(hydrateLogs);

    const localTs = local.lastModified || 0;
    const incomingTs = incoming.lastModified || 0;
    
    let winner: AppState;
    let loser: AppState;

    if (local.habits.length === 0 && incoming.habits.length > 0) {
        winner = incoming;
        loser = local;
    } else if (incoming.habits.length === 0 && local.habits.length > 0) {
        winner = local;
        loser = incoming;
    } else {
        winner = localTs >= incomingTs ? local : incoming;
        loser = localTs >= incomingTs ? incoming : local;
    }
    
    const merged: AppState = structuredClone(winner);
    const mergedHabitsMap = new Map<string, Habit>();
    
    // MAPA DE IDENTIDADE PARA DEDUPLICAÇÃO
    const winnerIdentityMap = new Map<string, string>(); // IdentityString -> ID
    const idRemap = new Map<string, string>(); // OldID -> NewID

    // Popula mapa inicial com hábitos do vencedor
    merged.habits.forEach(h => {
        mergedHabitsMap.set(h.id, h);
        const identity = getHabitIdentity(h);
        if (identity) {
            winnerIdentityMap.set(identity, h.id);
        }
    });
    
    loser.habits.forEach(loserHabit => {
        let winnerHabit = mergedHabitsMap.get(loserHabit.id);
        
        // --- SMART DEDUPLICATION ---
        if (!winnerHabit) {
            const identity = getHabitIdentity(loserHabit);
            if (identity) {
                const matchedId = winnerIdentityMap.get(identity);
                if (matchedId) {
                    winnerHabit = mergedHabitsMap.get(matchedId);
                    if (winnerHabit) {
                        // DUPLICATA ENCONTRADA: Mapeia o ID antigo para o vencedor
                        idRemap.set(loserHabit.id, winnerHabit.id);
                        logger.info(`[Merge] Deduplicated habit "${identity}" (${loserHabit.id} -> ${winnerHabit.id})`);
                    }
                }
            }
        }

        if (!winnerHabit) {
            // Novo hábito genuíno
            mergedHabitsMap.set(loserHabit.id, loserHabit);
        } else {
            // Merge de hábito existente (mesmo ID ou deduplicado)
            winnerHabit.scheduleHistory = mergeHabitHistories(winnerHabit.scheduleHistory, loserHabit.scheduleHistory);
            
            if (loserHabit.deletedOn) {
                if (!winnerHabit.deletedOn || loserHabit.deletedOn > winnerHabit.deletedOn) {
                    winnerHabit.deletedOn = loserHabit.deletedOn;
                }
            }

            if (winnerHabit.deletedOn) {
                if (!winnerHabit.deletedName && loserHabit.deletedName) {
                    winnerHabit.deletedName = loserHabit.deletedName;
                }
            } else if (winnerHabit.deletedName) {
                winnerHabit.deletedName = undefined;
            }

            if (loserHabit.graduatedOn) {
                if (!winnerHabit.graduatedOn || loserHabit.graduatedOn < winnerHabit.graduatedOn) {
                    winnerHabit.graduatedOn = loserHabit.graduatedOn;
                }
            }
        }
    });

    (merged as any).habits = Array.from(mergedHabitsMap.values());

    // Sanitize merged times to ensure no duplicate TimeOfDay entries.
    for (const habit of merged.habits) {
        for (let i = 0; i < habit.scheduleHistory.length; i++) {
            const schedule = habit.scheduleHistory[i];
            const originalLength = schedule.times.length;
            const deduped = deduplicateTimeOfDay(schedule.times);
            if (deduped.length < originalLength) {
                logger.warn(`[Merge] Habit "${schedule.name}": removed ${originalLength - deduped.length} duplicate times`);
                (habit.scheduleHistory[i] as any).times = deduped;
            }
        }
    }

    // MERGE DAILY DATA COM REMAP
    for (const date in loser.dailyData) {
        const remappedDailyData: Record<string, HabitDailyInfo> = {};
        const sourceDayData = loser.dailyData[date];
        
        for (const habitId in sourceDayData) {
            const targetId = idRemap.get(habitId) || habitId;
            remappedDailyData[targetId] = sourceDayData[habitId];
        }

        if (!merged.dailyData[date]) {
            (merged.dailyData as any)[date] = remappedDailyData;
        } else {
            mergeDayRecord(remappedDailyData, (merged.dailyData as any)[date]);
        }
    }

    // MERGE BITMASKS (LOGS) COM REMAP
    const remappedLoserLogs = new Map<string, bigint>();
    if (loser.monthlyLogs) {
        for (const [key, value] of loser.monthlyLogs.entries()) {
            const parts = key.split('_');
            const suffix = parts.pop(); // YYYY-MM
            const habitId = parts.join('_');
            
            const targetId = idRemap.get(habitId) || habitId;
            const newKey = `${targetId}_${suffix}`;
            
            const existingVal = remappedLoserLogs.get(newKey);
            if (existingVal !== undefined) {
                remappedLoserLogs.set(newKey, existingVal | value);
            } else {
                remappedLoserLogs.set(newKey, value);
            }
        }
    }

    merged.monthlyLogs = HabitService.mergeLogs(winner.monthlyLogs, remappedLoserLogs);
    
    merged.lastModified = Math.max(localTs, incomingTs, Date.now()) + 1;

    return merged;
}
