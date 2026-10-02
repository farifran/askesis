import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAppState, buildTestHabit, clearTestState } from './test-utils';
import { mergeStates } from '../services/dataMerge/merge';
import { state, APP_VERSION } from '../state';
import { loadState } from '../services/persistence';
import { compressArchive, decompressArchive } from '../services/compression';
import { getTodayUTCIso } from '../utils';

beforeEach(() => clearTestState());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('integridade após correções da auditoria', () => {
    it('não ressuscita dias desmarcados, preservando conclusões independentes', async () => {
        const old = makeAppState({ lastModified: 300, quests: [{ id: 'custom:q', startedOn: '2026-10-01', days: ['2026-10-01', '2026-10-02'] }] });
        const recent = makeAppState({ lastModified: 200, quests: [{ id: 'custom:q', startedOn: '2026-10-01', days: [], dayEdits: { '2026-10-01': { at: 200, done: false } } }] });
        for (const [a, b] of [[recent, old], [old, recent]]) {
            expect((await mergeStates(a, b)).quests[0].days).toEqual(['2026-10-02']);
        }
    });
    it('não abandona novamente uma tentativa retomada', async () => {
        const old = makeAppState({ lastModified: 100, quests: [{ id: 'custom:q', startedOn: '2026-09-01', days: [], abandonedOn: '2026-09-02' }] });
        const recent = makeAppState({ lastModified: 200, quests: [{ id: 'custom:q', startedOn: '2026-09-01', attemptFrom: '2026-10-01', days: [], lifecycleAt: 200 }] });
        expect((await mergeStates(recent, old)).quests[0].abandonedOn).toBeUndefined();
    });
    it('mantém exclusão e edição mais curta de notas mesmo após mudança alheia no outro aparelho', async () => {
        const habit = buildTestHabit({ name: 'Anotar', time: 'Morning' }, 'h');
        const old = makeAppState({ lastModified: 500, habits: [habit],
            dailyData: { '2026-10-01': { h: { instances: { Morning: { note: 'nota antiga extensa', noteModifiedAt: 10 } } } } },
            quests: [{ id: 'q', startedOn: '2026-10-01', days: [], notes: { '2026-10-01': 'antiga' }, noteEdits: { '2026-10-01': 10 } }] });
        const recent = makeAppState({ lastModified: 200, habits: [habit],
            dailyData: { '2026-10-01': { h: { instances: { Morning: { note: 'nova', noteModifiedAt: 20 } } } } },
            quests: [{ id: 'q', startedOn: '2026-10-01', days: [], notes: {}, noteEdits: { '2026-10-01': 20 } }] });
        const merged = await mergeStates(recent, old);
        expect(merged.dailyData['2026-10-01'].h.instances.Morning?.note).toBe('nova');
        expect(merged.quests[0].notes?.['2026-10-01']).toBeUndefined();
    });
    it('preserva anos exclusivos e reúne entradas do mesmo ano em gzip e JSON legado', async () => {
        const first = { '2024-01-01': { h1: { instances: { Morning: { note: 'x'.repeat(2000) } } } } };
        const second = { '2024-02-01': { h2: { instances: {} } } };
        const old = makeAppState({ lastModified: 100, archives: { '2024': await compressArchive(JSON.stringify(first)), '2023': '{}' } });
        const recent = makeAppState({ lastModified: 200, archives: { '2024': JSON.stringify(second), '2025': '{}' } });
        const merged = await mergeStates(recent, old);
        expect(Object.keys(merged.archives).sort()).toEqual(['2023', '2024', '2025']);
        expect(JSON.parse(await decompressArchive(merged.archives['2024'] as string))).toEqual({ ...first, ...second });
    });
    it('aborta merge de arquivo ilegível sem sobrescrever as fontes', async () => {
        const old = makeAppState({ archives: { '2024': 'gz1:corrupt' } });
        const recent = makeAppState({ archives: { '2024': '{}' } });
        await expect(mergeStates(recent, old)).rejects.toThrow();
        expect(old.archives['2024']).toBe('gz1:corrupt');
        expect(recent.archives['2024']).toBe('{}');
    });
    it('hidrata contexto e quotas persistidos após reiniciar', async () => {
        const quoteState = { currentId: 'saved-quote', displayedAt: 123, lockedContext: 'x' };
        await loadState(makeAppState({ version: APP_VERSION, aiDailyCount: 3, aiQuotaDate: getTodayUTCIso(), lastAIContextHash: 'saved-hash', quoteState }));
        expect(state.aiDailyCount).toBe(3);
        expect(state.lastAIContextHash).toBe('saved-hash');
        expect(state.quoteState).toEqual(quoteState);
    });
    it('impede união entre gerações diferentes da conta', async () => {
        const device = makeAppState({ lastModified: 900, habits: [buildTestHabit({ name: 'Antigo', time: 'Morning' })] });
        const remote = makeAppState({ lastModified: 200, accountGeneration: 'new-generation' });
        await expect(mergeStates(device, remote)).rejects.toThrow('different account generations');
    });
    it('preserva textos 0x e envelopes tipados no roundtrip do worker', async () => {
        await import('../services/sync.worker');
        const reply = vi.fn(); vi.stubGlobal('postMessage', reply);
        const payload = { note: '0x123', name: '0xZZ', count: 291n, logs: new Map([['h_2024-01', 1n]]) };
        await self.onmessage!({ data: { id: 'enc', type: 'encrypt', payload, key: 'test-only-key' } } as MessageEvent);
        const encrypted = reply.mock.calls[0][0].result;
        await self.onmessage!({ data: { id: 'dec', type: 'decrypt', payload: encrypted, key: 'test-only-key' } } as MessageEvent);
        expect(reply.mock.calls[1][0].result).toEqual(payload);
    });
});
