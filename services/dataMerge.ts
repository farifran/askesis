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

type IdentityDedupStrategy = 'auto_deduplicate' | 'ask_confirmation' | 'auto_keep_separate';

const GENERIC_HABIT_IDENTITIES = new Set([
    'habit',
    'habito',
    'novo habito',
    'new habit',
    'nuevo habito',
    'teste',
    'test'
]);

/**
 * Calcula distância de Levenshtein entre duas strings.
 * Usado para fuzzy matching de nomes de hábitos (singular/plural, typos).
 */
function levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substituição
                    matrix[i][j - 1] + 1,     // inserção
                    matrix[i - 1][j] + 1      // deleção
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

/**
 * Verifica se dois nomes são similares o suficiente para serem considerados o mesmo hábito.
 * @param threshold máximo de edições aceitas (default: 2)
 */
function areNamesFuzzySimilar(name1: string, name2: string, threshold = 2): boolean {
    const n1 = normalizeIdentityText(name1);
    const n2 = normalizeIdentityText(name2);
    
    if (n1 === n2) return true;
    if (n1.length < 5 || n2.length < 5) return false; // muito curto = arriscado
    
    const distance = levenshteinDistance(n1, n2);
    return distance > 0 && distance <= threshold;
}

/**
 * Extrai datas onde o hábito tem registros em dailyData.
 */
function getHabitDataDates(habitId: string, dailyData: Record<string, Record<string, HabitDailyInfo>>): Set<string> {
    const dates = new Set<string>();
    for (const date in dailyData) {
        if (dailyData[date]?.[habitId]) {
            dates.add(date);
        }
    }
    return dates;
}

/**
 * Verifica se dois conjuntos de datas têm interseção (uso simultâneo).
 */
function hasDateOverlap(dates1: Set<string>, dates2: Set<string>): boolean {
    for (const date of dates1) {
        if (dates2.has(date)) return true;
    }
    return false;
}

function parseUtcDate(date: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function getDateRange(dates: Set<string>): { min: Date; max: Date } | null {
    let min: Date | null = null;
    let max: Date | null = null;

    for (const value of dates) {
        const parsed = parseUtcDate(value);
        if (!parsed) continue;
        if (!min || parsed < min) min = parsed;
        if (!max || parsed > max) max = parsed;
    }

    if (!min || !max) return null;
    return { min, max };
}

function dayGapBetweenRanges(
    rangeA: { min: Date; max: Date },
    rangeB: { min: Date; max: Date }
): number {
    const msPerDay = 24 * 60 * 60 * 1000;

    if (rangeA.max < rangeB.min) {
        return Math.floor((rangeB.min.getTime() - rangeA.max.getTime()) / msPerDay);
    }

    if (rangeB.max < rangeA.min) {
        return Math.floor((rangeA.min.getTime() - rangeB.max.getTime()) / msPerDay);
    }

    return 0;
}

/**
 * Verifica se períodos de agenda dos hábitos se sobrepõem temporalmente.
 * Retorna true se há overlap OU se não pode determinar com certeza (para evitar bloqueio agressivo).
 */
function hasScheduleOverlap(habit1: Habit, habit2: Habit): boolean {
    // Se ambos estão ativos, consideram-se sobrepostos (uso simultâneo possível)
    if (!habit1.deletedOn && !habit2.deletedOn) return true;
    
    // Se ambos deletados, verificar períodos reais
    if (habit1.deletedOn && habit2.deletedOn) {
        const h1Start = habit1.createdOn || '0000-01-01';
        const h1End = habit1.deletedOn;
        const h2Start = habit2.createdOn || '0000-01-01';
        const h2End = habit2.deletedOn;
        return h1Start <= h2End && h2Start <= h1End;
    }
    
    // Um deletado, um ativo: verificar se o deletado foi antes do ativo iniciar
    const deleted = habit1.deletedOn ? habit1 : habit2;
    const active = habit1.deletedOn ? habit2 : habit1;
    
    if (!deleted.deletedOn || !active.createdOn) return true; // incerteza = overlap
    
    // Se o deletado terminou ANTES do ativo começar, não há overlap (hábitos sequenciais)
    if (deleted.deletedOn < active.createdOn) return false;
    
    return true; // qualquer outro caso = possível overlap
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

function normalizeIdentityText(raw: string): string {
    return raw
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/**
 * Obtém uma identidade normalizada para o hábito (Nome ou Chave de Tradução).
 */
function getHabitIdentity(h: Habit): string | null {
    if (!h.scheduleHistory || h.scheduleHistory.length === 0) {
        const deletedRaw = normalizeIdentityText(h.deletedName || '');
        return deletedRaw.length > 0 ? deletedRaw : null;
    }
    // Pega o agendamento mais recente
    const lastSchedule = h.scheduleHistory.reduce((prev, curr) => 
        (curr.startDate > prev.startDate ? curr : prev), h.scheduleHistory[0]);
    
    // Identidade é baseada no Nome explícito OU na Chave de Tradução
    const raw = lastSchedule.name || lastSchedule.nameKey || '';
    
    // Normalização: Minúsculo, sem espaços extras nas pontas
    const normalized = normalizeIdentityText(raw);
    
    return normalized.length > 0 ? normalized : null;
}

function getLatestSchedule(h: Habit): HabitSchedule | null {
    if (!h.scheduleHistory || h.scheduleHistory.length === 0) return null;
    // scheduleHistory não garante ordenação; escolhe por startDate
    return h.scheduleHistory.reduce((prev, curr) => (curr.startDate > prev.startDate ? curr : prev), h.scheduleHistory[0]);
}

function schedulesEquivalent(a: HabitSchedule | null, b: HabitSchedule | null): boolean {
    if (!a || !b) return false;
    if (normalizeIdentityText(a.name || '') !== normalizeIdentityText(b.name || '')) return false;
    if (normalizeIdentityText(a.nameKey || '') !== normalizeIdentityText(b.nameKey || '')) return false;
    if ((a.mode || '') !== (b.mode || '')) return false;

    const aTimes = Array.from(new Set(a.times || [])).sort();
    const bTimes = Array.from(new Set(b.times || [])).sort();
    if (aTimes.length !== bTimes.length) return false;
    for (let i = 0; i < aTimes.length; i++) {
        if (aTimes[i] !== bTimes[i]) return false;
    }

    // Frequency e Goal são objetos; compara por JSON (com chaves estáveis, já que são literais simples)
    if (JSON.stringify(a.frequency) !== JSON.stringify(b.frequency)) return false;
    if (JSON.stringify(a.goal) !== JSON.stringify(b.goal)) return false;

    return true;
}

function evaluateIdentityDedupStrategy(
    identity: string, 
    winnerHabit: Habit, 
    loserHabit: Habit,
    dailyDataContext?: Record<string, Record<string, HabitDailyInfo>>
): IdentityDedupStrategy {
    // Nomes muito curtos/genericos são propensos a colisão: separar sem intervenção.
    if (identity.length < 5 || GENERIC_HABIT_IDENTITIES.has(identity)) {
        return 'auto_keep_separate';
    }

    // Verificar se hábitos têm históricos claramente separados no tempo.
    // Evita bloquear dedup quando a diferença é pequena (ex.: dias consecutivos no mesmo hábito).
    if (dailyDataContext) {
        const winnerDates = getHabitDataDates(winnerHabit.id, dailyDataContext);
        const loserDates = getHabitDataDates(loserHabit.id, dailyDataContext);
        
        // Se ambos têm histórico mas sem overlap, só bloqueia automaticamente quando há separação temporal significativa.
        if (winnerDates.size > 0 && loserDates.size > 0 && !hasDateOverlap(winnerDates, loserDates)) {
            const winnerRange = getDateRange(winnerDates);
            const loserRange = getDateRange(loserDates);

            if (winnerRange && loserRange) {
                const gapDays = dayGapBetweenRanges(winnerRange, loserRange);
                if (gapDays >= 30) {
                    return 'auto_keep_separate';
                }
            }
        }
    }

    // Verificar se períodos de agenda não se sobrepõem (ex: "Corrida" 2024 deletado, novo "Corrida" 2025).
    if (!hasScheduleOverlap(winnerHabit, loserHabit)) {
        return 'auto_keep_separate';
    }

    const wLast = getLatestSchedule(winnerHabit);
    const lLast = getLatestSchedule(loserHabit);
    const wName = wLast?.name || wLast?.nameKey || '';
    const lName = lLast?.name || lLast?.nameKey || '';

    // Alta confiança: mesmo schedule lógico mais recente.
    if (schedulesEquivalent(wLast, lLast)) {
        return 'auto_deduplicate';
    }

    // Alta confiança: nomes são fuzzy-similares (ex: "Exercício" vs "Exercícios") e schedules compatíveis.
    if (areNamesFuzzySimilar(wName, lName, 2)) {
        // Verificar se pelo menos mode e frequency são compatíveis
        if (wLast?.mode === lLast?.mode && JSON.stringify(wLast?.frequency) === JSON.stringify(lLast?.frequency)) {
            return 'auto_deduplicate';
        }
    }

    // Alta confiança: ativo vs deletado com mesma identidade normalizada.
    const winnerActive = !winnerHabit.deletedOn;
    const loserActive = !loserHabit.deletedOn;
    if (winnerActive !== loserActive) {
        const activeHabit = winnerActive ? winnerHabit : loserHabit;
        const activeIdentity = getHabitIdentity(activeHabit);
        if (activeIdentity === identity && areNamesFuzzySimilar(wName, lName, 1)) {
            return 'auto_deduplicate';
        }
    }

    return 'ask_confirmation';
}

function findFuzzyIdentityMatchId(
    loserIdentity: string,
    winnerIdentityMap: Map<string, string>
): string | undefined {
    if (loserIdentity.length < 5 || GENERIC_HABIT_IDENTITIES.has(loserIdentity)) {
        return undefined;
    }

    const fuzzyMatches: string[] = [];
    for (const [winnerIdentity, winnerId] of winnerIdentityMap.entries()) {
        if (winnerIdentity.length < 5 || GENERIC_HABIT_IDENTITIES.has(winnerIdentity)) {
            continue;
        }

        if (areNamesFuzzySimilar(loserIdentity, winnerIdentity, 1)) {
            fuzzyMatches.push(winnerId);
        }
    }

    return fuzzyMatches.length === 1 ? fuzzyMatches[0] : undefined;
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
    const confirmedIdentities = new Set<string>(); // Identities já confirmadas/deduplicadas nesta execução
    
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
                    // Identidade marcada como ambígua: nunca deduplicar automaticamente neste merge.
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
                                } else {
                                    confirmedIdentities.add(identity);
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
            
            // Desempate: se schedules equivalentes, preferir o hábito mais antigo (createdOn) como âncora estável.
            if (schedulesEquivalent(getLatestSchedule(winnerHabit), getLatestSchedule(loserHabit))) {
                const winnerCreated = winnerHabit.createdOn || '9999-12-31';
                const loserCreated = loserHabit.createdOn || '9999-12-31';
                if (loserCreated < winnerCreated) {
                    // Loser é mais antigo: inverter lógica de merge para preservar estabilidade.
                    const tempHistory = winnerHabit.scheduleHistory;
                    winnerHabit.scheduleHistory = mergeHabitHistories(loserHabit.scheduleHistory, tempHistory);
                }
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

/**
 * Prepara informações para modal de confirmação de dedup com contexto detalhado.
 * Retorna null se a consolidação foi auto-decidida (não precisa modal).
 */
export interface DedupModalContext {
    identity: string;
    winnerName: string;
    loserName: string;
    winnerCreatedOn: string;
    loserCreatedOn: string;
    winnerScheduleCount: number;
    loserScheduleCount: number;
    winnerIsActive: boolean;
    loserIsActive: boolean;
    confidenceLevel: 'high' | 'medium' | 'low';
    recommendationText: string;
}

export function buildDedupModalContext(
    identity: string,
    winnerHabit: Habit,
    loserHabit: Habit
): DedupModalContext {
    const winnerLast = getLatestSchedule(winnerHabit);
    const loserLast = getLatestSchedule(loserHabit);
    const winnerName = (winnerLast?.name || winnerLast?.nameKey || identity || '').trim();
    const loserName = (loserLast?.name || loserLast?.nameKey || identity || '').trim();
    const winnerIsActive = !winnerHabit.deletedOn;
    const loserIsActive = !loserHabit.deletedOn;
    const winnerScheduleCount = winnerHabit.scheduleHistory?.length || 0;
    const loserScheduleCount = loserHabit.scheduleHistory?.length || 0;

    // Determinar nivel de confiança
    let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
    let recommendationText = 'Decida manualmente se agrupar o histórico com certeza total.';

    if (schedulesEquivalent(winnerLast, loserLast)) {
        confidenceLevel = 'high';
        recommendationText = '✓ Recomendamos consolidar (agendas idênticas).';
    } else if (winnerIsActive !== loserIsActive) {
        confidenceLevel = 'medium';
        recommendationText = '⚠️ Um está ativo, outro deletado - Recomendamos consolidar.';
    } else if (winnerName === loserName && winnerScheduleCount === loserScheduleCount) {
        confidenceLevel = 'medium';
        recommendationText = '⚠️ Nomes idênticos e histórico similar - Recomendamos consolidar.';
    }

    return {
        identity,
        winnerName,
        loserName,
        winnerCreatedOn: winnerHabit.createdOn || '(desconhecido)',
        loserCreatedOn: loserHabit.createdOn || '(desconhecido)',
        winnerScheduleCount,
        loserScheduleCount,
        winnerIsActive,
        loserIsActive,
        confidenceLevel,
        recommendationText
    };
}
