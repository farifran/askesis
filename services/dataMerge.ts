/**
 * @license
 * SPDX-License-Identifier: MIT
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
import { normalizeHabitMode, normalizeTimesByMode, normalizeFrequencyByMode } from './habitActions';

export type DeduplicationDecision = 'deduplicate' | 'keep_separate';
export interface DedupCandidate {
    identity: string;
    winnerHabit: Habit;
    loserHabit: Habit;
}

export interface MergeOptions {
    /**
     * Opcional: permite pedir confirmação do usuário antes de deduplicar hábitos com IDs diferentes.
     * Se retornar 'keep_separate', o hábito do loser NÃO será remapeado/mesclado e será mantido separado.
     */
    onDedupCandidate?: (candidate: DedupCandidate) => DeduplicationDecision | Promise<DeduplicationDecision>;
}

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

function isUnsafeObjectKey(key: string): boolean {
    return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

function mergeDayRecord(source: Record<string, HabitDailyInfo>, target: Record<string, HabitDailyInfo>) {
    for (const habitId of Object.keys(source)) {
        if (isUnsafeObjectKey(habitId)) continue;

        const sourceHabit = source[habitId];
        const targetHabit = target[habitId];

        if (!targetHabit) {
            target[habitId] = structuredClone(sourceHabit);
            continue;
        }

        const sourceInstances: HabitInstanceMap = sourceHabit.instances ?? {};
        const targetInstances: HabitInstanceMap = targetHabit.instances ?? {};

        for (const time of Object.keys(sourceInstances)) {
            if (!isHabitInstanceKey(time)) continue;

            const srcInst = sourceInstances[time];
            const tgtInst = targetInstances[time];
            if (!srcInst) continue;

            if (!tgtInst) {
                targetInstances[time] = { ...srcInst };
            } else {
                if ((srcInst.note?.length || 0) > (tgtInst.note?.length || 0)) {
                    tgtInst.note = srcInst.note;
                }
                if (srcInst.goalOverride !== undefined) {
                    tgtInst.goalOverride = srcInst.goalOverride;
                }
            }
        }

        targetHabit.instances = targetInstances;
        if (sourceHabit.dailySchedule) {
            targetHabit.dailySchedule = sourceHabit.dailySchedule;
        }
    }
}

function sanitizeDailyData(appState: AppState): void {
    const sourceDailyData = appState.dailyData ?? {};
    const sanitizedDailyData: Record<string, Record<string, HabitDailyInfo>> = {};

    for (const date of Object.keys(sourceDailyData)) {
        if (isUnsafeObjectKey(date)) continue;

        const dayRecord = sourceDailyData[date];
        if (!dayRecord || typeof dayRecord !== 'object') continue;

        const sanitizedDayRecord: Record<string, HabitDailyInfo> = {};
        for (const habitId of Object.keys(dayRecord)) {
            if (isUnsafeObjectKey(habitId)) continue;
            sanitizedDayRecord[habitId] = dayRecord[habitId];
        }

        sanitizedDailyData[date] = sanitizedDayRecord;
    }

    (appState as any).dailyData = sanitizedDailyData;
}

/**
 * Obtém uma identidade normalizada para o hábito (Nome ou Chave de Tradução).
 */
function getHabitIdentity(h: Habit): string | null {
    if (!h.scheduleHistory || h.scheduleHistory.length === 0) {
        const deletedRaw = (h.deletedName || '').trim().toLowerCase();
        return deletedRaw.length > 0 ? deletedRaw : null;
    }
    // Pega o agendamento mais recente
    const lastSchedule = h.scheduleHistory.reduce((prev, curr) => 
        (curr.startDate > prev.startDate ? curr : prev), h.scheduleHistory[0]);
    
    // Identidade é baseada no Nome explícito OU na Chave de Tradução
    const raw = lastSchedule.name || lastSchedule.nameKey || '';
    
    // Normalização: Minúsculo, sem espaços extras nas pontas
    const normalized = raw.trim().toLowerCase();
    
    return normalized.length > 0 ? normalized : null;
}

function getLatestSchedule(h: Habit): HabitSchedule | null {
    if (!h.scheduleHistory || h.scheduleHistory.length === 0) return null;
    // scheduleHistory não garante ordenação; escolhe por startDate
    return h.scheduleHistory.reduce((prev, curr) => (curr.startDate > prev.startDate ? curr : prev), h.scheduleHistory[0]);
}

function schedulesEquivalent(a: HabitSchedule | null, b: HabitSchedule | null): boolean {
    if (!a || !b) return false;
    if ((a.name || '') !== (b.name || '')) return false;
    if ((a.nameKey || '') !== (b.nameKey || '')) return false;
    if ((a.mode || '') !== (b.mode || '')) return false;

    const aTimes = a.times || [];
    const bTimes = b.times || [];
    if (aTimes.length !== bTimes.length) return false;
    for (let i = 0; i < aTimes.length; i++) {
        if (aTimes[i] !== bTimes[i]) return false;
    }

    // Frequency e Goal são objetos; compara por JSON (com chaves estáveis, já que são literais simples)
    if (JSON.stringify(a.frequency) !== JSON.stringify(b.frequency)) return false;
    if (JSON.stringify(a.goal) !== JSON.stringify(b.goal)) return false;

    return true;
}

function shouldConfirmIdentityDedup(identity: string, winnerHabit: Habit, loserHabit: Habit): boolean {
    // Regra conservadora: nomes curtos/genéricos são propensos a colisões.
    if (identity.length < 5) return true;

    // Se os históricos diferem em “forma”, confirmar.
    const wLen = winnerHabit.scheduleHistory?.length || 0;
    const lLen = loserHabit.scheduleHistory?.length || 0;
    if (wLen !== lLen) return true;

    // Se o schedule mais recente diverge, confirmar.
    const wLast = getLatestSchedule(winnerHabit);
    const lLast = getLatestSchedule(loserHabit);
    if (!schedulesEquivalent(wLast, lLast)) return true;

    return false;
}

export async function mergeStates(local: AppState, incoming: AppState, options?: MergeOptions): Promise<AppState> {
    [local, incoming].forEach(hydrateLogs);
    [local, incoming].forEach(sanitizeDailyData);

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
    const blockedIdentities = new Set<string>(); // Identities que NÃO podem ser deduplicadas nesta execução

    // Popula mapa inicial com hábitos do vencedor
    merged.habits.forEach(h => {
        mergedHabitsMap.set(h.id, h);
        const identity = getHabitIdentity(h);
        if (identity) {
            winnerIdentityMap.set(identity, h.id);
        }
    });
    
    for (const loserHabit of loser.habits) {
        let winnerHabit = mergedHabitsMap.get(loserHabit.id);

        // --- SMART DEDUPLICATION ---
        if (!winnerHabit) {
            const identity = getHabitIdentity(loserHabit);
            if (identity) {
                if (blockedIdentities.has(identity)) {
                    // Identidade marcada como ambígua: nunca deduplicar automaticamente neste merge.
                    winnerHabit = undefined;
                } else {
                    const matchedId = winnerIdentityMap.get(identity);
                    if (matchedId) {
                        winnerHabit = mergedHabitsMap.get(matchedId);
                        if (winnerHabit) {
                            const needsConfirm = shouldConfirmIdentityDedup(identity, winnerHabit, loserHabit);
                            if (needsConfirm) {
                                if (options?.onDedupCandidate) {
                                    try {
                                        const decision = await options.onDedupCandidate({ identity, winnerHabit, loserHabit });
                                        if (decision === 'keep_separate') {
                                            blockedIdentities.add(identity);
                                            winnerHabit = undefined;
                                        }
                                    } catch (e) {
                                        // Fail-safe: se a UI/callback falhar, não deduplicar.
                                        blockedIdentities.add(identity);
                                        winnerHabit = undefined;
                                        logger.warn('[Merge] Dedup confirmation callback failed; keeping habits separate.', e);
                                    }
                                } else {
                                    // Sem UI/callback: nunca deduplicar candidato considerado arriscado.
                                    blockedIdentities.add(identity);
                                    winnerHabit = undefined;
                                    logger.warn(`[Merge] Dedup candidate "${identity}" requires confirmation; keeping habits separate.`);
                                }
                            }

                            if (winnerHabit) {
                                // DUPLICATA ENCONTRADA: Mapeia o ID antigo para o vencedor
                                idRemap.set(loserHabit.id, winnerHabit.id);
                                logger.info(`[Merge] Deduplicated habit "${identity}" (${loserHabit.id} -> ${winnerHabit.id})`);
                            }
                        }
                    }
                }
            }
        }

        if (!winnerHabit) {
            mergedHabitsMap.set(loserHabit.id, structuredClone(loserHabit));
        } else {
            // Merge de hábito existente (mesmo ID ou deduplicado)
            winnerHabit.scheduleHistory = mergeHabitHistories(winnerHabit.scheduleHistory, loserHabit.scheduleHistory);

            const isDeduplicatedByIdentity = winnerHabit.id !== loserHabit.id;

            // Regra de negócio: em deduplicação por identidade, estado ativo vence tombstone.
            if (isDeduplicatedByIdentity && winnerHabit.deletedOn && !loserHabit.deletedOn) {
                winnerHabit.deletedOn = undefined;
                winnerHabit.deletedName = undefined;
            }
            
            if (loserHabit.deletedOn) {
                // Em merge de IDs diferentes (deduplicação), não propagar tombstone de um duplicado
                // para um hábito ativo já selecionado como vencedor.
                if (!isDeduplicatedByIdentity || winnerHabit.deletedOn) {
                    if (!winnerHabit.deletedOn || loserHabit.deletedOn > winnerHabit.deletedOn) {
                        winnerHabit.deletedOn = loserHabit.deletedOn;
                    }
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
    }

    (merged as any).habits = Array.from(mergedHabitsMap.values());

    // Sanitize merged mode/times to ensure consistency and no duplicate TimeOfDay entries.
    for (const habit of merged.habits) {
        for (let i = 0; i < habit.scheduleHistory.length; i++) {
            const schedule = habit.scheduleHistory[i];
            const normalizedMode = normalizeHabitMode(schedule.mode);
            const normalizedTimes = normalizeTimesByMode(normalizedMode, schedule.times);
            const normalizedFrequency = normalizeFrequencyByMode(normalizedMode, schedule.frequency as any);
            const hadModeChange = schedule.mode !== normalizedMode;
            const hadTimesChange =
                normalizedTimes.length !== schedule.times.length
                || normalizedTimes.some((time, idx) => time !== schedule.times[idx]);
            const hadFrequencyChange = JSON.stringify(normalizedFrequency) !== JSON.stringify(schedule.frequency);

            if (hadModeChange) {
                (habit.scheduleHistory[i] as any).mode = normalizedMode;
            }

            if (hadTimesChange) {
                logger.warn(`[Merge] Habit "${schedule.name}": normalized times for mode=${normalizedMode}`);
                (habit.scheduleHistory[i] as any).times = normalizedTimes;
            }

            if (hadFrequencyChange) {
                logger.warn(`[Merge] Habit "${schedule.name}": normalized frequency for mode=${normalizedMode}`);
                (habit.scheduleHistory[i] as any).frequency = normalizedFrequency;
            }
        }
    }

    // MERGE DAILY DATA COM REMAP
    for (const date of Object.keys(loser.dailyData ?? {})) {
        if (isUnsafeObjectKey(date)) continue;

        const remappedDailyData: Record<string, HabitDailyInfo> = Object.create(null);
        const sourceDayData = loser.dailyData[date];
        if (!sourceDayData) continue;

        for (const habitId of Object.keys(sourceDayData)) {
            if (isUnsafeObjectKey(habitId)) continue;
            const targetId = idRemap.get(habitId) || habitId;
            if (isUnsafeObjectKey(targetId)) continue;
            remappedDailyData[targetId] = sourceDayData[habitId];
        }

        if (!merged.dailyData[date]) {
            (merged.dailyData as any)[date] = structuredClone(remappedDailyData);
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
