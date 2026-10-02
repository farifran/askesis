import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../render', () => ({
    closeModal: vi.fn(),
    showConfirmationModal: vi.fn(),
    renderAINotificationState: vi.fn(),
    clearHabitDomCache: vi.fn(),
    updateDayVisuals: vi.fn(),
    openModal: vi.fn()
}));

vi.mock('../render/ui', () => ({
    ui: { manageModal: document.createElement('div') }
}));

vi.mock('../i18n', () => ({
    t: (key: string) => key,
    getTimeOfDayName: (time: string) => time,
    formatDate: () => 'date',
    formatList: (items: string[]) => items.join(', '),
    getAiLanguageName: () => 'pt'
}));

vi.mock('./persistence', () => ({
    loadState: vi.fn(async () => null),
    saveState: vi.fn(async () => {}),
    persistStateLocally: vi.fn(async () => {}),
    clearLocalPersistence: vi.fn(async () => {})
}));

vi.mock('./cloud', () => ({
    runWorkerTask: vi.fn(async () => ({})),
    addSyncLog: vi.fn(),
    syncStateWithCloud: vi.fn()
}));

vi.mock('./api', () => ({
    apiFetch: vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
    clearKey: vi.fn()
}));

describe('import/export round-trip', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('rehidrata monthlyLogsSerialized antes do loadState', async () => {
        const { importData } = await import('./habitActions');
        const { loadState } = await import('./persistence');

        const originalCreate = document.createElement.bind(document);
        let fileInput: HTMLInputElement | null = null;
        vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
            const el = originalCreate(tag);
            if (tag === 'input') fileInput = el as HTMLInputElement;
            return el;
        });

        importData();

        const { state } = await import('../state');
        state.accountGeneration = 'current-generation';
        const payload = {
            version: 10,
            accountGeneration: 'backup-generation',
            archives: { '2023': '{}' },
            habits: [{ id: 'h1', createdOn: '2024-01-01', scheduleHistory: [] }],
            monthlyLogsSerialized: [['h1_2024-01', '0x1']]
        };

        const file = new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
        // `input.files` só aceita um FileList real; definimos a propriedade
        // diretamente porque não há como construir um FileList em ambiente de teste.
        Object.defineProperty(fileInput, 'files', {
            value: Object.assign([file], { item: (i: number) => [file][i] ?? null }),
            configurable: true
        });

        await (fileInput as unknown as HTMLInputElement)?.onchange?.({ target: fileInput } as any);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(loadState).toHaveBeenCalled();
        const arg = (loadState as any).mock.calls[0][0];
        expect(arg.monthlyLogs).toEqual(new Map([['h1_2024-01', 1n]]));
        expect(arg.archives).toEqual(payload.archives);
        expect(arg.accountGeneration).toBe('current-generation');
    });
    it('não aplica nem envia importação cuja gravação falhou', async () => {
        const { importData } = await import('./habitActions');
        const { loadState, persistStateLocally } = await import('./persistence');
        const { syncStateWithCloud } = await import('./cloud');
        const { showConfirmationModal } = await import('../render');
        const originalCreate = document.createElement.bind(document);
        let input!: HTMLInputElement;
        vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
            const el = originalCreate(tag);
            if (tag === 'input') input = el as HTMLInputElement;
            return el;
        });
        importData();
        const file = new File([JSON.stringify({ version: 13, habits: [], archives: {} })], 'backup.json');
        Object.defineProperty(input, 'files', { value: [file] });
        vi.mocked(persistStateLocally).mockRejectedValueOnce(new Error('Disk full'));
        await input.onchange?.({ target: input } as any);
        expect(loadState).not.toHaveBeenCalled();
        expect(syncStateWithCloud).not.toHaveBeenCalled();
        expect(showConfirmationModal).toHaveBeenCalledWith('importError', expect.any(Function), expect.any(Object));
    });

});
