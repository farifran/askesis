
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
 * Embora não acesse o DOM, operações de merge em estados grandes (especialmente Archives) 
 * podem bloquear a thread.
 * 
 * ARQUITETURA (Conflict-free Replicated Data Type - Lite):
 * - **Responsabilidade Única:** Unificar duas árvores de estado (`local` e `incoming/remote`) em uma 
 *   única "Fonte da Verdade", garantindo consistência eventual sem perda de dados significativa.
 * - **Estratégia Semântica:** Diferente de um merge simples por timestamp ("Last Write Wins"), 
 *   este algoritmo usa pesos semânticos. Um hábito "Concluído" localmente sempre sobrescreve 
 *   um "Pendente" na nuvem, independentemente do timestamp, preservando o progresso do usuário.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - Estrutura do `AppState` em `state.ts`.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Structured Clone:** Uso de API nativa moderna para clonagem profunda performática.
 * 2. **Sets para Deduplicação:** Complexidade O(1) para verificar existência de IDs.
 * 3. **Status Weighting:** Lógica de negócios codificada para resolução de conflitos em nível de campo.
 */

import { AppState, HabitDailyInfo, HabitStatus, TimeOfDay } from '../state';

// PERFORMANCE: Lookup Table para pesos de status (Smi Values).
// Acesso O(1) é mais rápido que switch/if-else repetido.
// Pending = 1, Snoozed = 2, Completed = 3. Undefined = 1.
const STATUS_WEIGHTS: Record<string, number> = {
    'completed': 3,
    'snoozed': 2,
    'pending': 1
};

const DEFAULT_WEIGHT = 1;

/**
 * SMART MERGE ALGORITHM:
 * Combina dois estados (Local e Remoto/Backup) de forma inteligente, preservando o máximo de dados possível.
 * - Hábitos: União baseada em ID.
 * - Dados Diários: Fusão granular baseada em peso de status (Completed > Snoozed > Pending).
 * - Archives: Fusão de dados históricos (Cold Storage).
 * - Arrays: União de conjuntos.
 */
export function mergeStates(local: AppState, incoming: AppState): AppState {
    // PERFORMANCE / MODERNIZATION [2025-03-08]: Use structuredClone for better performance and modern standard compliance.
    // Deep Clone é necessário para garantir imutabilidade dos inputs. 'structuredClone' é mais rápido que JSON.parse/stringify.
    // [OPTIMIZATION]: We mutate 'merged' in-place.
    const merged: AppState = structuredClone(incoming);

    // 2. Fusão de Definições de Hábitos (Estratégia de União)
    // Se o usuário criou um hábito novo localmente que não está no incoming, adicionamos ao merge.
    // PERFORMANCE: Set lookup O(1) dentro do loop O(N).
    const incomingHabitIds = new Set(incoming.habits.map(h => h.id));
    const localHabits = local.habits;
    const localHabitsLen = localHabits.length;

    // Raw Loop
    for (let i = 0; i < localHabitsLen; i = (i + 1) | 0) {
        const localHabit = localHabits[i];
        if (!incomingHabitIds.has(localHabit.id)) {
            merged.habits.push(localHabit);
        }
    }

    /**
     * Helper de fusão granular dia-a-dia.
     * Itera sobre os dados locais e aplica lógica de "Winner Takes All" baseada em peso.
     * INLINED OPTIMIZATION: Função movida para escopo local para evitar closures custosas se fosse externa.
     */
    const mergeDayRecord = (localDay: Record<string, HabitDailyInfo>, mergedDay: Record<string, HabitDailyInfo>) => {
        // PERFORMANCE: Loop 'for...in' é otimizado em V8 para objetos de dicionário.
        for (const habitId in localDay) {
            // Se o hábito não tem dados neste dia no incoming, copiamos do local (União).
            if (!mergedDay[habitId]) {
                mergedDay[habitId] = localDay[habitId];
                continue;
            }

            // CONFLITO GRANULAR: O mesmo hábito, no mesmo dia, existe em ambos.
            const localHabitData = localDay[habitId];
            const mergedHabitData = mergedDay[habitId];

            // A. Mesclar Override de Agendamento (Daily Schedule)
            // Se localmente houve uma alteração de agendamento, preservamos.
            if (localHabitData.dailySchedule !== undefined) {
                mergedHabitData.dailySchedule = localHabitData.dailySchedule;
            }

            // B. Mesclar Instâncias (Períodos do dia)
            const localInstances = localHabitData.instances;
            const mergedInstances = mergedHabitData.instances;

            for (const timeKey in localInstances) {
                const time = timeKey as TimeOfDay;
                const localInst = localInstances[time];
                const mergedInst = mergedInstances[time];

                if (!localInst) continue;

                if (!mergedInst) {
                    // Existe local mas não no incoming -> Adiciona
                    mergedInstances[time] = localInst;
                } else {
                    // CONFLITO SEMÂNTICO [2025-03-21]: Decoupled Merge Strategy.
                    // Em vez de substituir o objeto inteiro baseado no peso do status, 
                    // mesclamos propriedade por propriedade para preservar dados ricos (Notas).

                    // 1. Status Merge (Baseado em Peso)
                    // Lookup O(1) via Tabela
                    const localWeight = STATUS_WEIGHTS[localInst.status] || DEFAULT_WEIGHT;
                    const mergedWeight = STATUS_WEIGHTS[mergedInst.status] || DEFAULT_WEIGHT;

                    if (localWeight > mergedWeight) {
                        // Local ganha o status.
                        mergedInst.status = localInst.status;
                        
                        // Se o local ganhou o status, preferimos o goalOverride dele (se existir).
                        if (localInst.goalOverride !== undefined) {
                            mergedInst.goalOverride = localInst.goalOverride;
                        }
                    } else {
                        // Incoming ganha o status (ou empate).
                        // Se o Incoming não tem goalOverride mas o Local tem, preservamos o Local (preenchimento de lacunas).
                        if (mergedInst.goalOverride === undefined && localInst.goalOverride !== undefined) {
                            mergedInst.goalOverride = localInst.goalOverride;
                        }
                    }

                    // 2. Note Merge (Independente do Status)
                    // Estratégia: "Maior Texto Vence".
                    const localNoteLen = localInst.note ? localInst.note.length : 0;
                    const mergedNoteLen = mergedInst.note ? mergedInst.note.length : 0;

                    if (localNoteLen > mergedNoteLen) {
                        mergedInst.note = localInst.note;
                    }
                }
            }
        }
    };

    // Mesclar Daily Data (Hot Storage)
    for (const date in local.dailyData) {
        if (!merged.dailyData[date]) {
            merged.dailyData[date] = local.dailyData[date];
        } else {
            mergeDayRecord(local.dailyData[date], merged.dailyData[date]);
        }
    }

    // 4. Fusão de Arquivos (Cold Storage)
    if (local.archives) {
        merged.archives = merged.archives || {};
        for (const year in local.archives) {
            if (!merged.archives[year]) {
                // Se só existe no local, copia direto (rápido)
                merged.archives[year] = local.archives[year];
            } else {
                const localContent = local.archives[year];
                const incomingContent = merged.archives[year];

                // GZIP CHECK [2025-04-06]: "Incoming Wins" for compressed archives to avoid Sync decompress.
                if (localContent.startsWith('GZIP:') || incomingContent.startsWith('GZIP:')) {
                    continue; 
                }

                // Legacy JSON: Se ambos forem texto plano, tentamos mesclar.
                try {
                    const localYearData = JSON.parse(localContent);
                    const incomingYearData = JSON.parse(incomingContent);
                    
                    // Mescla dia a dia dentro do ano arquivado
                    for (const date in localYearData) {
                        if (!incomingYearData[date]) {
                            incomingYearData[date] = localYearData[date];
                        } else {
                            mergeDayRecord(localYearData[date], incomingYearData[date]);
                        }
                    }
                    
                    // Recompacta (neste caso, mantém JSON pois era legado)
                    merged.archives[year] = JSON.stringify(incomingYearData);
                } catch (e) {
                    console.error(`Failed to merge archives for year ${year}`, e);
                }
            }
        }
    }

    // 5. Fusão de Metadados e Arrays Auxiliares
    merged.lastModified = Date.now(); // O merge cria um novo momento no tempo
    merged.version = local.version > incoming.version ? local.version : incoming.version;
    
    // PERFORMANCE: União de Sets para deduplicação rápida.
    // Usamos Spread Syntax que é otimizado em V8 modernos para iteráveis.
    const allNotifications = new Set([...incoming.notificationsShown, ...local.notificationsShown]);
    merged.notificationsShown = Array.from(allNotifications);

    const all21Days = new Set([...incoming.pending21DayHabitIds, ...local.pending21DayHabitIds]);
    merged.pending21DayHabitIds = Array.from(all21Days);

    const all66Days = new Set([...incoming.pendingConsolidationHabitIds, ...local.pendingConsolidationHabitIds]);
    merged.pendingConsolidationHabitIds = Array.from(all66Days);

    return merged;
}
