/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { AppState, APP_VERSION, Habit, HabitSchedule } from './state';

/**
 * Migrates the state from a version older than 6 to version 6.
 * The key change in v6 was the introduction of `scheduleHistory`.
 * This function converts the old flat habit structure into the new one.
 * @param oldState The application state from a version < 6.
 * @returns An AppState object conforming to the v6 structure.
 */
function migrateToV6(oldState: any): AppState {
    console.log(`Migrating data from v${oldState.version || 0} to v6`);
    const oldHabits = oldState.habits as any[];
    // Find the latest versions of habits, ignoring the ones that were versioned off
    const previousVersionIds = new Set(oldHabits.map(h => h.previousVersionId).filter(Boolean));
    const latestHabits = oldHabits.filter(h => !previousVersionIds.has(h.id));
    const newHabits: Habit[] = [];

    for (const latestHabit of latestHabits) {
        const lineage: any[] = [];
        let currentHabitInLineage: any | undefined = latestHabit;
        // Trace back the history of the habit through `previousVersionId`
        while (currentHabitInLineage) {
            lineage.unshift(currentHabitInLineage);
            currentHabitInLineage = oldHabits.find(h => h.id === currentHabitInLineage.previousVersionId);
        }
        
        const firstHabit = lineage[0];
        const newHabit: Habit = {
            id: latestHabit.id,
            icon: firstHabit.icon,
            color: firstHabit.color,
            goal: firstHabit.goal,
            createdOn: firstHabit.createdOn,
            graduatedOn: latestHabit.graduatedOn,
            scheduleHistory: [],
        };

        // Build the schedule history from the lineage
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

            // Remap dailyData from old IDs to the new unified ID
            if (oldVersion.id !== newHabit.id) {
                 Object.keys(oldState.dailyData).forEach(dateStr => {
                    if (oldState.dailyData[dateStr][oldVersion.id]) {
                        oldState.dailyData[dateStr][newHabit.id] = oldState.dailyData[dateStr][oldVersion.id];
                        delete oldState.dailyData[dateStr][oldVersion.id];
                    }
                });
            }
        }
        newHabits.push(newHabit);
    }

    return {
        ...oldState,
        habits: newHabits,
        version: 6, // Mark as migrated to v6
    };
}


/**
 * Applies all necessary migrations to bring a loaded state object to the current app version.
 * @param loadedState The state object loaded from storage, which might be an old version.
 * @returns The state object, migrated to the current version.
 */
export function migrateState(loadedState: any): AppState {
    let migratedState = loadedState;
    const loadedVersion = migratedState.version || 0;

    if (loadedVersion < 6) {
        migratedState = migrateToV6(migratedState);
    }

    // Future migration steps would be chained here.
    // e.g., if (migratedState.version < 7) { migratedState = migrateToV7(migratedState); }

    migratedState.version = APP_VERSION;
    return migratedState as AppState;
}
