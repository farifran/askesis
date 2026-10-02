/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file services/dataMerge/merge.ts
 * @description Algoritmo principal de merge CRDT-lite: mergeStates, mergeHabitHistories, mergeDayRecord.
 */

import type { AppState, HabitDailyInfo, Habit, HabitSchedule, QuestRecord } from '../../state';
import { logger } from '../../utils';
import { compressArchive, decompressArchive } from '../compression';
import { HabitService } from '../HabitService';
import { normalizeSchedule } from '../habitActions/normalization';
import type { MergeOptions } from './types';
import { isUnsafeObjectKey, isHabitInstanceKey } from './validation';
import { hydrateLogs, sanitizeDailyData } from './hydration';
import { getHabitIdentity, getLatestSchedule, schedulesEquivalent } from './identity';
import { evaluateIdentityDedupStrategy, findFuzzyIdentityMatchId } from './dedupStrategy';

type HabitInstanceMap = NonNullable<HabitDailyInfo['instances']>;

export function mergeHabitHistories(winnerHistory: HabitSchedule[], loserHistory: HabitSchedule[]): HabitSchedule[] {
    const historyMap = new Map<string, HabitSchedule>();
    loserHistory.forEach(s => historyMap.set(s.startDate, { ...s }));
    winnerHistory.forEach(s => historyMap.set(s.startDate, { ...s }));
    // Use stable string comparison to avoid locale-dependent ordering
    return Array.from(historyMap.values()).sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
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
                if ((srcInst.noteModifiedAt ?? 0) > (tgtInst.noteModifiedAt ?? 0)
                    || (!tgtInst.noteModifiedAt && tgtInst.note === undefined && srcInst.note !== undefined)) {
                    tgtInst.note = srcInst.note;
                    tgtInst.noteModifiedAt = srcInst.noteModifiedAt;
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

/** Data mais antiga entre as duas, ignorando as ausentes. */
function earliestDate(a?: string, b?: string): string | undefined {
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
}

/** Merge por campo: ausência antiga não desfaz edições ou lápides recentes. */
function mergeQuests(winnerQuests: QuestRecord[] = [], loserQuests: QuestRecord[] = []): QuestRecord[] {
    const byId = new Map(winnerQuests.map(q => [q.id, structuredClone(q)]));
    for (const loser of loserQuests) {
        const winner = byId.get(loser.id);
        if (!winner) { byId.set(loser.id, structuredClone(loser)); continue; }
        const dayEdits = { ...loser.dayEdits, ...winner.dayEdits };
        for (const [day, edit] of Object.entries(loser.dayEdits ?? {})) {
            const current = dayEdits[day];
            // Em empate a desmarcação vence, de forma independente da ordem.
            if (edit.at > current.at || (edit.at === current.at && !edit.done)) dayEdits[day] = { ...edit };
        }
        const days = new Set([...winner.days, ...loser.days]);
        for (const [day, edit] of Object.entries(dayEdits)) {
            if (edit.done) days.add(day); else days.delete(day);
        }
        const notes = { ...loser.notes, ...winner.notes };
        const noteEdits = { ...loser.noteEdits, ...winner.noteEdits };
        for (const day of new Set([...Object.keys(winner.noteEdits ?? {}), ...Object.keys(loser.noteEdits ?? {})])) {
            const a = winner.noteEdits?.[day] ?? 0;
            const b = loser.noteEdits?.[day] ?? 0;
            const source = b > a ? loser : winner;
            noteEdits[day] = Math.max(a, b);
            if (source.notes?.[day]) notes[day] = source.notes[day]; else delete notes[day];
        }
        // Uma tentativa retomada não herda conclusão/abandono da anterior.
        const winnerAttempt = winner.attemptFrom ?? winner.startedOn;
        const loserAttempt = loser.attemptFrom ?? loser.startedOn;
        const lifecycle = (loser.lifecycleAt ?? 0) > (winner.lifecycleAt ?? 0) ? loser : winner;
        const attempt = winnerAttempt > loserAttempt ? winner : loserAttempt > winnerAttempt ? loser : lifecycle;
        const sameAttempt = winnerAttempt === loserAttempt;
        const hasLifecycle = !!(winner.lifecycleAt || loser.lifecycleAt);
        const completedOn = sameAttempt && !hasLifecycle
            ? earliestDate(winner.completedOn, loser.completedOn) : attempt.completedOn;
        byId.set(winner.id, {
            ...winner,
            days: [...days].sort(), dayEdits, notes, noteEdits,
            startedOn: earliestDate(winner.startedOn, loser.startedOn)!,
            attemptFrom: attempt.attemptFrom,
            lifecycleAt: Math.max(winner.lifecycleAt ?? 0, loser.lifecycleAt ?? 0) || undefined,
            completedOn,
            abandonedOn: completedOn ? undefined : sameAttempt && !hasLifecycle
                ? earliestDate(winner.abandonedOn, loser.abandonedOn) : attempt.abandonedOn,
            customTitle: winner.customTitle ?? loser.customTitle,
            customTarget: winner.customTarget ?? loser.customTarget
        });
    }
    return [...byId.values()];
}

async function readArchive(value: string | Uint8Array): Promise<Record<string, Record<string, HabitDailyInfo>>> {
    const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
    const parsed = JSON.parse(await decompressArchive(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid archive');
    return parsed;
}

async function mergeArchives(winner: AppState, loser: AppState, idRemap: Map<string, string>) {
    const archives = { ...winner.archives };
    for (const [year, value] of Object.entries(loser.archives ?? {})) {
        if (isUnsafeObjectKey(year)) continue;
        if (!archives[year] && idRemap.size === 0) { archives[year] = value; continue; }
        if (archives[year] === value && idRemap.size === 0) continue;
        // Erro aborta o merge: nenhuma das cópias pode ser substituída por {}.
        const source = await readArchive(value);
        const target = archives[year] ? await readArchive(archives[year]) : {};
        for (const [day, data] of Object.entries(source)) {
            if (isUnsafeObjectKey(day)) continue;
            const remapped: Record<string, HabitDailyInfo> = Object.create(null);
            for (const [id, info] of Object.entries(data)) {
                const mapped = idRemap.get(id) ?? id;
                if (!isUnsafeObjectKey(mapped)) remapped[mapped] = info;
            }
            target[day] ??= {};
            mergeDayRecord(remapped, target[day]);
        }
        archives[year] = await compressArchive(JSON.stringify(target));
    }
    return archives;
}

export async function mergeStates(local: AppState, incoming: AppState, options?: MergeOptions): Promise<AppState> {
    if ((local.accountGeneration ?? 'legacy') !== (incoming.accountGeneration ?? 'legacy')) {
        throw new Error('Cannot merge different account generations');
    }
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
    const winnerIdentityMap = new Map<string, string>();
    const idRemap = new Map<string, string>();
    const blockedIdentities = new Set<string>();
    const confirmedIdentities = new Set<string>();

    // Contexto de dados históricos para validação de dedup
    const mergedDailyData = structuredClone(winner.dailyData || {});
    for (const date in loser.dailyData || {}) {
        if (!mergedDailyData[date]) {
            mergedDailyData[date] = {};
        }
        Object.assign(mergedDailyData[date], loser.dailyData[date]);
    }

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
                    winnerHabit = undefined;
                } else {
                    const matchedId = winnerIdentityMap.get(identity) || findFuzzyIdentityMatchId(identity, winnerIdentityMap);
                    if (matchedId) {
                        winnerHabit = mergedHabitsMap.get(matchedId);
                        if (winnerHabit) {
                            if (!confirmedIdentities.has(identity)) {
                                const strategy = evaluateIdentityDedupStrategy(identity, winnerHabit, loserHabit, mergedDailyData);
                                if (strategy === 'auto_keep_separate') {
                                    blockedIdentities.add(identity);
                                    winnerHabit = undefined;
                                    logger.warn(`[Merge] Dedup candidate "${identity}" auto-blocked as ambiguous.`);
                                } else if (strategy === 'ask_confirmation') {
                                    if (options?.onDedupCandidate) {
                                        try {
                                            const decision = await options.onDedupCandidate({ identity, winnerHabit, loserHabit });
                                            if (decision === 'keep_separate') {
                                                blockedIdentities.add(identity);
                                                winnerHabit = undefined;
                                            } else {
                                                confirmedIdentities.add(identity);
                                            }
                                        } catch (e) {
                                            blockedIdentities.add(identity);
                                            winnerHabit = undefined;
                                            logger.warn('[Merge] Dedup confirmation callback failed; keeping habits separate.', e);
                                        }
                                    } else {
                                        blockedIdentities.add(identity);
                                        winnerHabit = undefined;
                                        logger.warn(`[Merge] Dedup candidate "${identity}" requires confirmation; keeping habits separate.`);
                                    }
                                } else {
                                    confirmedIdentities.add(identity);
                                }
                            }

                            if (winnerHabit) {
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
            winnerHabit.scheduleHistory = mergeHabitHistories(winnerHabit.scheduleHistory, loserHabit.scheduleHistory);

            const isDeduplicatedByIdentity = winnerHabit.id !== loserHabit.id;

            if (isDeduplicatedByIdentity && winnerHabit.deletedOn && !loserHabit.deletedOn) {
                winnerHabit.deletedOn = undefined;
                winnerHabit.deletedName = undefined;
            }

            if (schedulesEquivalent(getLatestSchedule(winnerHabit), getLatestSchedule(loserHabit))) {
                const winnerCreated = winnerHabit.createdOn || '9999-12-31';
                const loserCreated = loserHabit.createdOn || '9999-12-31';
                if (loserCreated < winnerCreated) {
                    const tempHistory = winnerHabit.scheduleHistory;
                    winnerHabit.scheduleHistory = mergeHabitHistories(loserHabit.scheduleHistory, tempHistory);
                }
            }

            if (loserHabit.deletedOn) {
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

    // Sanitize merged mode/times to ensure consistency
    for (const habit of merged.habits) {
        for (let i = 0; i < habit.scheduleHistory.length; i++) {
            const schedule = habit.scheduleHistory[i];
            normalizeSchedule(schedule);
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

            const remappedId = idRemap.get(habitId);
            const targetId = remappedId || habitId;
            const newKey = `${targetId}_${suffix}`;

            const existingVal = remappedLoserLogs.get(newKey);
            if (existingVal === undefined) {
                remappedLoserLogs.set(newKey, value);
            } else if (remappedId) {
                // Colisão de dedup: os logs do hábito canônico têm precedência
                // sobre os do hábito absorvido.
                remappedLoserLogs.set(newKey, HabitService.mergeLogValues(existingVal, value));
            } else {
                // Este `value` é o do próprio hábito canônico; ele é o vencedor.
                remappedLoserLogs.set(newKey, HabitService.mergeLogValues(value, existingVal));
            }
        }
    }

    merged.monthlyLogs = HabitService.mergeLogs(winner.monthlyLogs, remappedLoserLogs);

    // Objetivos não passam pelo remap de identidade: o id vem do catálogo (ou é
    // um UUID), então não há o problema de dedup que os hábitos têm.
    (merged as { quests: QuestRecord[] }).quests = mergeQuests(winner.quests, loser.quests);

    Object.assign(merged, { archives: await mergeArchives(winner, loser, idRemap) });

    merged.lastModified = Math.max(localTs, incomingTs, Date.now()) + 1;

    return merged;
}
