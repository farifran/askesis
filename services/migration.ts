
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [NOTA COMPARATIVA]: Este módulo é executado raramente, mas é crítico. A implementação demonstra engenharia sênior ao usar Maps para eficiência e uma arquitetura baseada em array de 'MIGRATIONS' que facilita a adição de futuras alterações de esquema de banco de dados local sem refatoração pesada.

import { AppState, Habit, HabitSchedule } from '../state';

/**
 * Migrates the state from a version older than 6 to version 6.
 * The key change in v6 was the introduction of `scheduleHistory`.
 * This function converts the old flat habit structure into the new one.
 * @param oldState The application state from a version < 6.
 * @returns An AppState object conforming to the v6 structure.
 */
function migrateToV6(oldState: any): AppState {
    const oldHabits = oldState.habits as any[];
    // OTIMIZAÇÃO DE PERFORMANCE: Cria um mapa para lookups rápidos de hábitos por ID,
    // o que é muito mais eficiente do que usar Array.find() repetidamente em um loop.
    const habitsMap = new Map(oldHabits.map(h => [h.id, h]));

    // 1. Identifica as versões mais recentes de cada hábito (folhas na árvore de versões).
    const previousVersionIds = new Set(oldHabits.map(h => h.previousVersionId).filter(Boolean));
    const latestHabits = oldHabits.filter(h => !previousVersionIds.has(h.id));
    const newHabits: Habit[] = [];

    for (const latestHabit of latestHabits) {
        // 2. Traça a linhagem de cada hábito, do mais antigo ao mais recente.
        const lineage: any[] = [];
        let currentHabitInLineage: any | undefined = latestHabit;
        while (currentHabitInLineage) {
            lineage.unshift(currentHabitInLineage);
            currentHabitInLineage = habitsMap.get(currentHabitInLineage.previousVersionId);
        }
        
        const firstHabit = lineage[0];
        // 3. Cria o novo hábito unificado, usando o ID mais recente.
        const newHabit: Habit = {
            id: latestHabit.id,
            icon: firstHabit.icon,
            color: firstHabit.color,
            goal: firstHabit.goal,
            createdOn: firstHabit.createdOn,
            graduatedOn: latestHabit.graduatedOn,
            scheduleHistory: [],
        };

        // 4. Constrói o `scheduleHistory` a partir da linhagem.
        for (const oldVersion of lineage) {
            const schedule: HabitSchedule = {
                startDate: oldVersion.createdOn,
                endDate: oldVersion.endedOn,
                name: oldVersion.name,
                subtitle: oldVersion.subtitle,
                nameKey: oldVersion.nameKey,
                subtitleKey: oldVersion.subtitleKey,
                times: oldVersion.times,
                frequency: oldVersion.frequency,
                scheduleAnchor: oldVersion.scheduleAnchor || oldVersion.createdOn,
            };
            newHabit.scheduleHistory.push(schedule);

            // 5. Remapeia os dados diários dos IDs antigos para o novo ID unificado.
            if (oldVersion.id !== newHabit.id) {
                 Object.keys(oldState.dailyData).forEach(dateStr => {
                    const dailyDataForDate = oldState.dailyData[dateStr];
                    if (dailyDataForDate[oldVersion.id]) {
                        // CORREÇÃO DE INTEGRIDADE DE DADOS: Em vez de sobrescrever, mescla os dados.
                        // Isso previne a perda de dados se múltiplas versões de um hábito foram
                        // concluídas no mesmo dia (ex: um hábito de manhã e outro à tarde).
                        const sourceInfo = dailyDataForDate[oldVersion.id];
                        // Garante que o objeto de destino exista.
                        dailyDataForDate[newHabit.id] = dailyDataForDate[newHabit.id] || { instances: {} };
                        const targetInfo = dailyDataForDate[newHabit.id];

                        // Mescla as instâncias, com as do `sourceInfo` tendo precedência, mas na prática
                        // não deveria haver sobreposição de horários (times) entre versões no mesmo dia.
                        targetInfo.instances = { ...targetInfo.instances, ...sourceInfo.instances };
                        
                        // Mescla outras propriedades, se necessário (ex: dailySchedule).
                        if (sourceInfo.dailySchedule && !targetInfo.dailySchedule) {
                            targetInfo.dailySchedule = sourceInfo.dailySchedule;
                        }

                        delete dailyDataForDate[oldVersion.id];
                    }
                });
            }
        }
        newHabits.push(newHabit);
    }

    return {
        ...oldState,
        habits: newHabits,
        version: 6, // Marca como migrado para v6
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
