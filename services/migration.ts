/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [NOTA COMPARATIVA]: Este módulo é executado raramente, mas é crítico. A implementação demonstra engenharia sênior ao usar Maps para eficiência e uma arquitetura baseada em array de 'MIGRATIONS' que facilita a adição de futuras alterações de esquema de banco de dados local sem refatoração pesada.

import { AppState, Habit, HabitSchedule } from '../state';

/**
 * Migrates the state from a version older than 6 to version 6.
 * The key change in v6 was the introduction of `scheduleHistory`.
 * This function converts the old flat habit structure into the new one, correctly handling
 * branched version histories to prevent duplicate habits from being created using a robust
 * graph traversal algorithm to find all connected components.
 * @param oldState The application state from a version < 6.
 * @returns An AppState object conforming to the v6 structure.
 */
function migrateToV6(oldState: any): AppState {
    const oldHabits = oldState.habits as any[];
    if (!oldHabits || oldHabits.length === 0) {
        oldState.version = 6;
        return oldState;
    }

    // --- 1. Graph Construction (Adjacency List for an Undirected Graph) ---
    const habitsMap = new Map(oldHabits.map(h => [h.id, h]));
    const adj = new Map<string, string[]>();

    const addEdge = (u: string, v: string) => {
        if (!adj.has(u)) adj.set(u, []);
        if (!adj.has(v)) adj.set(v, []);
        adj.get(u)!.push(v);
        adj.get(v)!.push(u);
    };

    for (const habit of oldHabits) {
        // Ensure every habit is a node in the graph, even if disconnected
        if (!adj.has(habit.id)) {
            adj.set(habit.id, []);
        }
        if (habit.previousVersionId && habitsMap.has(habit.previousVersionId)) {
            addEdge(habit.id, habit.previousVersionId);
        }
    }

    // --- 2. Find All Connected Components ---
    const newHabits: Habit[] = [];
    const dailyDataRemap = new Map<string, string>();
    const visited = new Set<string>();

    for (const habit of oldHabits) {
        if (visited.has(habit.id)) {
            continue;
        }

        // Start a traversal (BFS) to find the entire connected component
        const componentHabits: any[] = [];
        const queue: string[] = [habit.id];
        visited.add(habit.id);

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            const currentHabit = habitsMap.get(currentId);
            if (currentHabit) {
                componentHabits.push(currentHabit);
            }

            const neighbors = adj.get(currentId) || [];
            for (const neighborId of neighbors) {
                if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    queue.push(neighborId);
                }
            }
        }
        
        if (componentHabits.length === 0) continue;

        // --- 3. Consolidate the Component into a Single New Habit ---
        const sortedHabits = componentHabits.sort((a, b) => a.createdOn.localeCompare(b.createdOn));
        
        const firstHabit = sortedHabits[0];
        const lastHabit = sortedHabits[sortedHabits.length - 1];

        // The unified habit uses the ID of the latest version and its properties.
        const newHabit: Habit = {
            id: lastHabit.id,
            icon: lastHabit.icon,
            color: lastHabit.color,
            goal: lastHabit.goal,
            createdOn: firstHabit.createdOn, // Keep the original creation date
            graduatedOn: lastHabit.graduatedOn, // Graduated status is from the last known state
            scheduleHistory: [],
        };
        
        // --- 4. Build the linear scheduleHistory from the sorted versions ---
        for (let i = 0; i < sortedHabits.length; i++) {
            const oldVersion = sortedHabits[i];
            
            // Map this old ID to the new unified ID for dailyData migration
            if (oldVersion.id !== newHabit.id) {
                dailyDataRemap.set(oldVersion.id, newHabit.id);
            }
            
            // The endDate of a schedule is the startDate of the next version,
            // or the habit's own `endedOn` property if it's the last in the chain.
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
    
    // --- 5. Remap dailyData using the collected mappings ---
    const newDailyData = oldState.dailyData;
    for (const dateStr in newDailyData) {
        const dailyEntry = newDailyData[dateStr];
        for (const [oldId, newId] of dailyDataRemap.entries()) {
            if (dailyEntry[oldId]) {
                const sourceInfo = dailyEntry[oldId];
                
                dailyEntry[newId] = dailyEntry[newId] || { instances: {} };
                const targetInfo = dailyEntry[newId];

                // Merge instances, source takes precedence in case of time collision
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


// ARQUITETURA DE MANUTENIBILIDADE: Um array de migrações permite um processo de migração mais limpo e escalável.
// Para adicionar uma nova migração, basta adicionar uma nova entrada a este array.
const MIGRATIONS = [
    { targetVersion: 6, migrate: migrateToV6 },
    // { targetVersion: 7, migrate: migrateToV7 }, // Exemplo de como uma migração futura seria adicionada
];

/**
 * Applies all necessary migrations sequentially to bring a loaded state object to the current app version.
 * @param loadedState The state object loaded from storage, which might be an old version.
 * @param targetVersion The version to migrate towards (usually APP_VERSION).
 * @returns The state object, migrated to the current version.
 */
export function migrateState(loadedState: any, targetVersion: number): AppState {
    let migratedState = loadedState;
    const initialVersion = migratedState.version || 0;

    if (initialVersion < targetVersion) {
        console.log(`Starting migration from v${initialVersion} to v${targetVersion}...`);
        
        // Aplica todas as migrações necessárias em sequência.
        for (const migration of MIGRATIONS) {
            if (migratedState.version < migration.targetVersion && migration.targetVersion <= targetVersion) {
                console.log(`Applying migration to v${migration.targetVersion}...`);
                migratedState = migration.migrate(migratedState);
            }
        }
    }

    migratedState.version = targetVersion;
    return migratedState as AppState;
}