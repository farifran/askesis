/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file services/habitActions.ts
 * @description Barrel re-export — mantém compatibilidade com todos os consumidores existentes.
 */

export { deduplicateTimeOfDay, normalizeHabitMode, normalizeTimesByMode, normalizeFrequencyByMode } from './habitActions/normalization';
export { saveHabitFromModal } from './habitActions/crudCore';
export { toggleHabitStatus, markAllHabitsForDate, setGoalOverride, handleSaveNote } from './habitActions/statusTracking';
export { handleHabitDrop, requestHabitEndingFromModal, requestHabitTimeRemoval } from './habitActions/scheduleManagement';
export { requestHabitPermanentDeletion, graduateHabit, performArchivalCheck, resetDeviceData, resetAccountData } from './habitActions/deletion';
export { performAIAnalysis } from './habitActions/aiAnalysis';
export { importData, exportData } from './habitActions/io';
export { reorderHabit, handleDayTransition, consumeAndFormatCelebrations } from './habitActions/ui';
