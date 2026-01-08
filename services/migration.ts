
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file services/migration.ts
 * @description Motor de Migração de Schema de Dados (Database Migration Engine).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo é executado de forma síncrona durante a inicialização (`loadState`).
 * Embora bloqueie a thread principal, sua execução é rara (apenas após atualizações do app).
 * 
 * ARQUITETURA (Sequential Versioning):
 * - **Responsabilidade Única:** Transformar estruturas de dados obsoletas (JSON persistido) 
 *   no formato exigido pela versão atual do código (`AppState`).
 * - **Graph-Based Reconstruction:** A migração V6 utiliza teoria dos grafos para reconstruir 
 *   a história de hábitos que foram fragmentados em versões anteriores.
 * - **Imutabilidade Funcional:** Cada função de migração recebe um estado e retorna um *novo* estado,
 *   sem mutações laterais arriscadas.
 * 
 * DEPENDÊNCIAS CRÍTICAS:
 * - Definições de tipo em `state.ts`. Alterações lá exigem novas migrações aqui.
 */

import { AppState, Habit, HabitSchedule } from '../state';

// --- GRAPH HELPERS (Pure Logic) ---

/**
 * Constrói um grafo não direcionado (Lista de Adjacência) conectando versões de hábitos.
 */
function buildAdjacencyGraph(habits: any[]): Map<string, string[]> {
    const habitsMap = new Map(habits.map(h => [h.id, h]));
    const adj = new Map<string, string[]>();

    // Helper interno para conexão bidirecional
    const addEdge = (u: string, v: string) => {
        if (!adj.has(u)) adj.set(u, []);
        if (!adj.has(v)) adj.set(v, []);
        adj.get(u)!.push(v);
        adj.get(v)!.push(u);
    };

    for (const habit of habits) {
        // Garante que todo nó exista no grafo, mesmo isolado
        if (!adj.has(habit.id)) {
            adj.set(habit.id, []);
        }
        // Conecta Versão Atual -> Versão Anterior
        if (habit.previousVersionId && habitsMap.has(habit.previousVersionId)) {
            addEdge(habit.id, habit.previousVersionId);
        }
    }
    return adj;
}

/**
 * Realiza uma busca em largura (BFS) para encontrar todos os componentes conectados a um nó.
 * Retorna uma lista de IDs que pertencem à mesma linhagem de hábito.
 */
function findConnectedComponent(startNodeId: string, adj: Map<string, string[]>, visited: Set<string>): string[] {
    const componentIds: string[] = [];
    const queue: string[] = [startNodeId];
    visited.add(startNodeId);

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        componentIds.push(currentId);

        const neighbors = adj.get(currentId) || [];
        for (const neighborId of neighbors) {
            if (!visited.has(neighborId)) {
                visited.add(neighborId);
                queue.push(neighborId);
            }
        }
    }
    return componentIds;
}

// --- MIGRATION LOGIC ---

/**
 * Migrates the state from a version older than 6 to version 6.
 * The key change in v6 was the introduction of `scheduleHistory`.
 */
function migrateToV6(oldState: any): AppState {
    if (!oldState || typeof oldState !== 'object') {
        return { version: 6, habits: [], dailyData: {}, archives: {}, lastModified: Date.now(), notificationsShown: [], pending21DayHabitIds: [], pendingConsolidationHabitIds: [] } as AppState;
    }

    // TYPE SAFETY [2025-06-01]: Explicit legacy interface definition.
    // Prevents 'any' usage and documents the expected shape of V5 habits.
    interface LegacyHabit {
        id: string;
        previousVersionId?: string;
        createdOn: string;
        endedOn?: string;
        graduatedOn?: string;
        icon: string;
        color: string;
        goal: any;
        name?: string;
        subtitle?: string;
        nameKey?: string;
        subtitleKey?: string;
        times: any;
        frequency: any;
        scheduleAnchor?: string;
    }

    const oldHabits = (Array.isArray(oldState.habits) ? oldState.habits : []) as LegacyHabit[];
    
    if (oldHabits.length === 0) {
        return { ...oldState, habits: [], version: 6 };
    }

    // 1. Graph Construction
    const adj = buildAdjacencyGraph(oldHabits);
    const habitsMap = new Map<string, LegacyHabit>(oldHabits.map((h) => [h.id, h]));

    // 2. Component Analysis & Consolidation
    const newHabits: Habit[] = [];
    const dailyDataRemap = new Map<string, string>();
    const visited = new Set<string>();

    for (const habit of oldHabits) {
        if (visited.has(habit.id)) continue;

        // BFS para encontrar todas as versões deste hábito
        const componentIds = findConnectedComponent(habit.id, adj, visited);
        if (componentIds.length === 0) continue;

        // Recupera objetos completos e ordena cronologicamente
        const sortedHabits = componentIds
            .map(id => habitsMap.get(id))
            .filter((h): h is LegacyHabit => !!h) // Type Guard
            .sort((a, b) => a.createdOn.localeCompare(b.createdOn));
        
        const firstHabit = sortedHabits[0];
        const lastHabit = sortedHabits[sortedHabits.length - 1];

        // 3. Create Unified Habit (Identity Preservation)
        const newHabit: Habit = {
            id: lastHabit.id,
            icon: lastHabit.icon,
            color: lastHabit.color,
            goal: lastHabit.goal,
            createdOn: firstHabit.createdOn,
            graduatedOn: lastHabit.graduatedOn,
            scheduleHistory: [],
        };
        
        // 4. Build Linear History
        for (let i = 0; i < sortedHabits.length; i++) {
            const oldVersion = sortedHabits[i];
            
            // Map old ID -> New ID for daily data migration
            if (oldVersion.id !== newHabit.id) {
                dailyDataRemap.set(oldVersion.id, newHabit.id);
            }
            
            const nextVersion = sortedHabits[i + 1];
            const endDate = nextVersion ? nextVersion.createdOn : oldVersion.endedOn;

            const schedule: HabitSchedule = {
                startDate: oldVersion.createdOn,
                endDate: endDate,
                name: oldVersion.name,
                subtitle: oldVersion.subtitle,
                nameKey: oldVersion.nameKey,
                subtitleKey: oldVersion.subtitleKey,
                times: oldVersion.times,
                frequency: oldVersion.frequency,
                scheduleAnchor: oldVersion.scheduleAnchor || oldVersion.createdOn,
            };
            newHabit.scheduleHistory.push(schedule);
        }
        
        newHabits.push(newHabit);
    }
    
    // 5. Remap Daily Data
    const newDailyData = oldState.dailyData || {};
    for (const dateStr in newDailyData) {
        const dailyEntry = newDailyData[dateStr];
        if (!dailyEntry) continue;

        for (const [oldId, newId] of dailyDataRemap.entries()) {
            if (dailyEntry[oldId]) {
                const sourceInfo = dailyEntry[oldId];
                
                // Initialize target if needed (Monomorphic)
                dailyEntry[newId] = dailyEntry[newId] || { instances: {}, dailySchedule: undefined };
                const targetInfo = dailyEntry[newId];

                // Merge instances
                targetInfo.instances = { ...targetInfo.instances, ...sourceInfo.instances };
                
                if (sourceInfo.dailySchedule && !targetInfo.dailySchedule) {
                    targetInfo.dailySchedule = sourceInfo.dailySchedule;
                }

                delete dailyEntry[oldId];
            }
        }
    }

    return {
        ...oldState,
        habits: newHabits,
        dailyData: newDailyData,
        version: 6,
    };
}

const MIGRATIONS = [
    { targetVersion: 6, migrate: migrateToV6 },
];

export function migrateState(loadedState: any, targetVersion: number): AppState {
    if (!loadedState) {
        console.warn("migrateState received null state. Returning default.");
        return { version: targetVersion, habits: [], dailyData: {}, archives: {}, lastModified: Date.now(), notificationsShown: [], pending21DayHabitIds: [], pendingConsolidationHabitIds: [] } as AppState;
    }

    let migratedState = loadedState;
    const initialVersion = migratedState.version || 0;

    if (initialVersion < targetVersion) {
        console.log(`Starting migration from v${initialVersion} to v${targetVersion}...`);
        
        for (const migration of MIGRATIONS) {
            if (migratedState.version < migration.targetVersion && migration.targetVersion <= targetVersion) {
                console.log(`Applying migration to v${migration.targetVersion}...`);
                try {
                    migratedState = migration.migrate(migratedState);
                } catch (e) {
                    console.error(`Migration v${migration.targetVersion} failed:`, e);
                    migratedState.version = migration.targetVersion; 
                }
            }
        }
    }

    migratedState.version = targetVersion;
    return migratedState as AppState;
}
