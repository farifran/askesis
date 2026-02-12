
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file services/dataMerge.ts
 * @description Algoritmo de Reconciliação de Estado (Smart Merge / CRDT-lite).
 * 
 * UPDATE [2025-06-25]: Adicionada Deduplicação Inteligente por Nome.
 * Se IDs forem diferentes mas nomes iguais, funde os dados e remapeia os IDs
 * para evitar duplicação visual.
 */

import { AppState, HabitDailyInfo, Habit, HabitSchedule } from '../state';
import { logger } from '../utils';
import { HabitService } from './HabitService';

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

/**
 * Hidrata monthlyLogs garantindo que BigInts e Maps sejam reconstruídos corretamente.
 */
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

/**
 * Mescla o histórico de agendamentos de um hábito usando Last-Write-Wins (LWW) por entrada.
 * O vencedor (determinado pelo lastModified global) tem prioridade sobre as definições de agendamento.
 * Isso garante que se um usuário alterou um endDate ou meta, a versão mais recente prevaleça.
 */
function mergeHabitHistories(winnerHistory: HabitSchedule[], loserHistory: HabitSchedule[]): HabitSchedule[] {
    const historyMap = new Map<string, HabitSchedule>();
    
    // 1. Carrega o histórico do perdedor como base
    loserHistory.forEach(s => historyMap.set(s.startDate, { ...s }));
    
    // 2. O vencedor sobrescreve entradas com a mesma data de início (LWW absoluto)
    // Se o vencedor definiu um endDate, isso será preservado.
    winnerHistory.forEach(s => historyMap.set(s.startDate, { ...s }));
    
    return Array.from(historyMap.values()).sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/**
 * Mescla registros diários (Notas e Overrides).
 */
function mergeDayRecord(source: Record<string, HabitDailyInfo>, target: Record<string, HabitDailyInfo>) {
    for (const habitId in source) {
        if (!target[habitId]) {
            target[habitId] = source[habitId];
            continue;
        }

        const sourceInstances = source[habitId].instances || {};
        const targetInstances = target[habitId].instances || {};

        for (const time in sourceInstances) {
            const srcInst = sourceInstances[time as any];
            const tgtInst = targetInstances[time as any];
            if (!srcInst) continue;
            if (!tgtInst) {
                targetInstances[time as any] = srcInst;
            } else {
                if ((srcInst.note?.length || 0) > (tgtInst.note?.length || 0)) {
                    tgtInst.note = srcInst.note;
                }
                if (srcInst.goalOverride !== undefined) {
                    tgtInst.goalOverride = srcInst.goalOverride;
                }
            }
        }
        if (source[habitId].dailySchedule) target[habitId].dailySchedule = source[habitId].dailySchedule;
    }
}

export async function mergeStates(local: AppState, incoming: AppState): Promise<AppState> {
    [local, incoming].forEach(hydrateLogs);

    const localTs = local.lastModified || 0;
    const incomingTs = incoming.lastModified || 0;
    
    // LÓGICA DE VENCEDOR: Maior timestamp vence (LWW).
    // Proteção: Se um lado está vazio e o outro não, o populado vence para evitar wipe acidental.
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
    
    // MAPA DE NOMES PARA DEDUPLICAÇÃO
    // Normaliza nomes (trim + lowercase) para encontrar duplicatas semânticas
    const winnerNameMap = new Map<string, string>(); // NomeNormalizado -> ID
    const idRemap = new Map<string, string>(); // OldID -> NewID

    // Popula mapa inicial com hábitos do vencedor
    merged.habits.forEach(h => {
        mergedHabitsMap.set(h.id, h);
        const lastSchedule = h.scheduleHistory[h.scheduleHistory.length - 1];
        if (lastSchedule && lastSchedule.name) {
            const normalizedName = lastSchedule.name.trim().toLowerCase();
            if (normalizedName) {
                winnerNameMap.set(normalizedName, h.id);
            }
        }
    });
    
    loser.habits.forEach(loserHabit => {
        let winnerHabit = mergedHabitsMap.get(loserHabit.id);
        
        // --- SMART DEDUPLICATION ---
        // Se não achou pelo ID, tenta achar pelo NOME
        if (!winnerHabit) {
            const lastSchedule = loserHabit.scheduleHistory[loserHabit.scheduleHistory.length - 1];
            if (lastSchedule && lastSchedule.name) {
                const normalizedName = lastSchedule.name.trim().toLowerCase();
                const matchedId = winnerNameMap.get(normalizedName);
                if (matchedId) {
                    winnerHabit = mergedHabitsMap.get(matchedId);
                    if (winnerHabit) {
                        // Encontrou duplicata! Mapeia o ID antigo para o novo (vencedor)
                        idRemap.set(loserHabit.id, winnerHabit.id);
                        logger.info(`[Merge] Deduplicated habit "${lastSchedule.name}" (${loserHabit.id} -> ${winnerHabit.id})`);
                    }
                }
            }
        }

        if (!winnerHabit) {
            // Se não achou nem por ID nem por Nome, adiciona como novo
            mergedHabitsMap.set(loserHabit.id, loserHabit);
        } else {
            // Se achou (por ID ou Nome), faz o merge
            
            // Mescla histórico com prioridade para o vencedor
            winnerHabit.scheduleHistory = mergeHabitHistories(winnerHabit.scheduleHistory, loserHabit.scheduleHistory);
            
            // Tombstone de deleção: data mais tardia vence (ação mais recente)
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

            // Graduação: data mais antiga vence (primeira vez que o usuário conquistou)
            if (loserHabit.graduatedOn) {
                if (!winnerHabit.graduatedOn || loserHabit.graduatedOn < winnerHabit.graduatedOn) {
                    winnerHabit.graduatedOn = loserHabit.graduatedOn;
                }
            }
        }
    });

    (merged as any).habits = Array.from(mergedHabitsMap.values());

    // MERGE DAILY DATA COM REMAP
    for (const date in loser.dailyData) {
        // Precisamos criar um objeto temporário onde as chaves (habitIDs) já estão remapeadas
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
    // 1. Remapeia os logs do perdedor para os IDs do vencedor, se necessário
    const remappedLoserLogs = new Map<string, bigint>();
    if (loser.monthlyLogs) {
        for (const [key, value] of loser.monthlyLogs.entries()) {
            // Chave formato: ID_YYYY-MM
            // Vamos separar ID do sufixo
            const parts = key.split('_');
            // O ID é tudo antes do último underscore (para suportar IDs com underscore, embora UUID não tenha)
            // Mas o formato padrão é UUID_YYYY-MM, UUID não tem underscore.
            // Safe split:
            const suffix = parts.pop(); // YYYY-MM
            const habitId = parts.join('_');
            
            const targetId = idRemap.get(habitId) || habitId;
            const newKey = `${targetId}_${suffix}`;
            
            // Se houver colisão de remapeamento (vários perdedores -> um vencedor), 
            // precisamos fazer merge bit a bit aqui mesmo antes do merge final.
            const existingVal = remappedLoserLogs.get(newKey);
            if (existingVal !== undefined) {
                // Fusão simples OR para bitmask durante remapeamento
                // (Para CRDT completo, usamos a função HabitService.mergeLogs depois)
                remappedLoserLogs.set(newKey, existingVal | value);
            } else {
                remappedLoserLogs.set(newKey, value);
            }
        }
    }

    // 2. Faz o merge final com os logs do vencedor
    merged.monthlyLogs = HabitService.mergeLogs(winner.monthlyLogs, remappedLoserLogs);
    
    // O timestamp final deve ser incrementado para garantir propagação
    merged.lastModified = Math.max(localTs, incomingTs, Date.now()) + 1;

    return merged;
}
