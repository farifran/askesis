import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../state';
import { HabitService } from './HabitService';

beforeEach(() => {
  // Reset minimal state
  state.habits = [] as any;
  state.dailyData = {} as any;
  state.monthlyLogs = new Map();
  state.archives = {} as any;
  state.syncLogs = [] as any;
  HabitService.resetCache();
});

describe('exportData complete backup', () => {
  it('preserves tombstones, archives and every log without exporting sync diagnostics', async () => {
    // Arrange: two habits, one deleted
    state.habits = [
      { id: 'keep', createdOn: '2024-01-01', scheduleHistory: [] } as any,
      { id: 'deleted', createdOn: '2024-01-02', deletedOn: '2024-02-01', scheduleHistory: [] } as any
    ];
    // Monthly logs include both habits
    state.monthlyLogs = new Map([['keep_2024-01', 1n], ['deleted_2024-01', 1n]]);
    state.archives = { '2023': 'archived-data' };
    HabitService.resetCache();

    let capturedBlob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: any) => { capturedBlob = blob; return 'blob://fake'; });

    const mod = await import('./habitActions');
    // Act
    (mod as any).exportData();
    await new Promise(r => setTimeout(r, 0));

    // Assert
    expect(capturedBlob).toBeInstanceOf(Blob);
    // O compilador não vê o mock rodar, então continua achando que é `null`.
    const text = await (capturedBlob as unknown as Blob).text();
    const payload = JSON.parse(text);

    // Tombstones keep deletions from reappearing after restore.
    expect(Array.isArray(payload.habits)).toBe(true);
    expect(payload.habits.find((h: any) => h.id === 'deleted').deletedOn).toBe('2024-02-01');

    // Cold history is part of the backup; diagnostic logs are not.
    expect(payload.archives).toEqual({ '2023': 'archived-data' });
    expect(payload.syncLogs).toBeUndefined();

    // All history travels with the backup.
    expect(Array.isArray(payload.monthlyLogsSerialized)).toBe(true);
    expect(payload.monthlyLogsSerialized.some((e: any) => e[0] === 'keep_2024-01')).toBe(true);
    expect(payload.monthlyLogsSerialized.some((e: any) => e[0] === 'deleted_2024-01')).toBe(true);
  });
});
