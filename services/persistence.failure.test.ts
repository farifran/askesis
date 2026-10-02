import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { makeAppState } from '../tests/test-utils';

vi.mock('../render', () => ({ clearHabitDomCache: vi.fn(), resetGradeBaseline: vi.fn() }));
let fail = false;
let writes: unknown[] = [];
beforeEach(() => {
    vi.resetModules();
    fail = false;
    writes = [];
    vi.stubGlobal('indexedDB', { open() {
        const request: any = {};
        queueMicrotask(() => request.onsuccess?.({ target: { result: {
            transaction() {
                const tx: any = { error: new Error('QuotaExceededError'), objectStore: () => ({
                    put: (data: unknown) => writes.push(structuredClone(data)), delete() {}, clear() {}
                }) };
                queueMicrotask(() => fail ? tx.onabort?.() : tx.oncomplete?.());
                return tx;
            }
        } } }));
        return request;
    } });
});
afterEach(() => vi.unstubAllGlobals());

it('propaga falha de gravação remota e informa falha local, recuperando no próximo save', async () => {
    const { persistStateLocally, saveState, registerSyncHandler } = await import('./persistence');
    const { APP_EVENTS } = await import('../events');
    const notice = vi.fn();
    document.addEventListener(APP_EVENTS.persistenceChanged, notice);
    const sync = vi.fn(); registerSyncHandler(sync);
    try {
        fail = true;
        await expect(persistStateLocally(makeAppState())).rejects.toThrow('QuotaExceededError');
        expect(await saveState(true)).toBe(false);
        expect(sync).toHaveBeenCalled();
        expect(notice.mock.calls[0][0].detail.saved).toBe(false);
        fail = false;
        expect(await saveState(true)).toBe(true);
        expect(notice.mock.calls.at(-1)![0].detail.saved).toBe(true);
    } finally { document.removeEventListener(APP_EVENTS.persistenceChanged, notice); }
});

it('serializa snapshots concorrentes sem guardar referências mutáveis', async () => {
    const { saveState } = await import('./persistence');
    const { state } = await import('../state');
    state.lastModified = 1;
    const first = saveState(true, true);
    state.lastModified = 2;
    const second = saveState(true, true);
    await Promise.all([first, second]);
    const cores = writes.filter((x: any) => typeof x.lastModified === 'number') as Array<{lastModified: number}>;
    expect(cores.map(x => x.lastModified)).toEqual([1, 2]);
});
