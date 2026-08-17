/**
 * @file listeners/resetData.test.ts
 * @description Testes do fluxo de "Apagar dados" nas Configurações Gerais.
 *
 * O botão pergunta o escopo antes de apagar: dados da conta (zera a conta
 * inteira e mantém a sincronização) ou dados do aparelho (limpa e desvincula).
 * Os dois alcances são irreversíveis e não se parecem, então o que se testa aqui
 * é justamente que nenhum deles sai de um toque só e que cada botão dispara o
 * reset que promete.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const _btn = () => ({ addEventListener: vi.fn() });
const _cls = () => ({ classList: { contains: vi.fn(() => false), toggle: vi.fn() } });

const mockShowConfirmationModal = vi.fn();
vi.mock('../render', () => ({
    updateNotificationUI: vi.fn(),
    openModal: vi.fn(),
    closeModal: vi.fn(),
    setupManageModal: vi.fn(),
    renderExploreHabits: vi.fn(),
    showConfirmationModal: (...args: any[]) => mockShowConfirmationModal(...args),
    renderLanguageFilter: vi.fn(),
    openEditModal: vi.fn(),
}));

vi.mock('../render/dom', () => ({ setTextContent: vi.fn() }));
vi.mock('../render/rotary', () => ({ setupReelRotary: vi.fn() }));

vi.mock('../utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils')>();
    return {
        ...actual,
        triggerHaptic: vi.fn(),
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    };
});

vi.mock('../i18n', () => ({
    t: (key: string) => key,
    setLanguage: vi.fn(),
    getAiLanguageName: vi.fn(),
}));

vi.mock('../services/push', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/push')>();
    return {
        ...actual,
        ensureOneSignalReady: vi.fn(),
        setLocalPushOptIn: vi.fn(),
        getLocalPushOptIn: vi.fn(() => null),
    };
});

vi.mock('../services/api', () => ({ hasLocalSyncKey: vi.fn(() => true) }));

vi.mock('../services/habitActions', () => ({
    saveHabitFromModal: vi.fn(),
    requestHabitEndingFromModal: vi.fn(),
    requestHabitPermanentDeletion: vi.fn(),
    resetDeviceData: vi.fn(async () => {}),
    resetAccountData: vi.fn(async () => {}),
    handleSaveNote: vi.fn(),
    graduateHabit: vi.fn(),
    exportData: vi.fn(),
    importData: vi.fn(),
}));

vi.mock('../state', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../state')>();
    return { ...actual, LANGUAGES: [{ code: 'pt', nameKey: 'langPt' }] };
});

vi.mock('./modals/aiHandlers', () => ({
    handleAiEvalClick: vi.fn(),
    handleAiOptionsClick: vi.fn(),
}));

vi.mock('./modals/fullCalendarHandlers', () => ({
    handleFullCalendarPrevClick: vi.fn(),
    handleFullCalendarNextClick: vi.fn(),
    handleFullCalendarGridClick: vi.fn(),
    handleFullCalendarGridKeydown: vi.fn(),
}));

vi.mock('./modals/formHandlers', () => ({
    handleHabitNameInput: vi.fn(),
    handleIconPickerClick: vi.fn(),
    handleIconGridClick: vi.fn(),
    handleColorGridClick: vi.fn(),
    handleChangeColorClick: vi.fn(),
    handleTimeContainerClick: vi.fn(),
    handleFrequencyChange: vi.fn(),
    handleFrequencyClick: vi.fn(),
}));

vi.mock('../data/predefinedHabits', () => ({ PREDEFINED_HABITS: [] }));

const resetAppBtn = _btn();
vi.mock('../render/ui', () => ({
    ui: {
        notificationToggle: { checked: false, disabled: false, ..._btn() },
        notificationToggleLabel: { classList: { toggle: vi.fn(), contains: vi.fn(() => false) } },
        notificationStatusDesc: { textContent: '' },
        manageHabitsBtn: _btn(),
        fabAddHabit: _btn(),
        habitList: _btn(),
        manageModal: { ..._btn(), ..._cls() },
        get resetAppBtn() { return resetAppBtn; },
        languageViewport: {},
        languageReel: {},
        languagePrevBtn: _btn(),
        languageNextBtn: _btn(),
        exploreHabitList: _btn(),
        createCustomHabitBtn: _btn(),
        aiEvalBtn: _btn(),
        aiOptionsModal: _btn(),
        confirmModalConfirmBtn: _btn(),
        confirmModalEditBtn: _btn(),
        saveNoteBtn: _btn(),
        fullCalendarPrevBtn: _btn(),
        fullCalendarNextBtn: _btn(),
        fullCalendarGrid: _btn(),
        editHabitSaveBtn: _btn(),
        editHabitForm: { elements: { namedItem: vi.fn(() => ({ maxLength: 0, addEventListener: vi.fn() })) } },
        habitIconPickerBtn: _btn(),
        iconPickerGrid: _btn(),
        colorPickerGrid: _btn(),
        changeColorFromPickerBtn: _btn(),
        habitTimeContainer: _btn(),
        frequencyOptionsContainer: _btn(),
        exploreModal: _cls(),
        confirmModal: _cls(),
    },
}));

import { hasLocalSyncKey } from '../services/api';
import { resetAccountData, resetDeviceData } from '../services/habitActions';

type ModalCall = [string, () => void, Record<string, any> | undefined];

/** Dispara o clique em "Apagar dados" e devolve o modal aberto. */
async function clickResetButton(): Promise<ModalCall> {
    const { setupModalListeners } = await import('./modals');
    setupModalListeners();

    const handler = resetAppBtn.addEventListener.mock.calls
        .find(([event]) => event === 'click')?.[1] as () => void;
    expect(handler).toBeTypeOf('function');

    handler();
    return mockShowConfirmationModal.mock.calls.at(-1) as ModalCall;
}

/** O encadeamento entre modais passa por microtask; deixa a fila drenar. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('🧹 Apagar dados (escopo conta x aparelho)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(hasLocalSyncKey).mockReturnValue(true);
    });

    it('pergunta o escopo antes de apagar qualquer coisa', async () => {
        const [text, , opts] = await clickResetButton();

        expect(text).toBe('resetScopeQuestion');
        expect(opts?.confirmText).toBe('resetScopeAccount');
        expect(opts?.editText).toBe('resetScopeDevice');
        expect(resetAccountData).not.toHaveBeenCalled();
        expect(resetDeviceData).not.toHaveBeenCalled();
    });

    it('escolher "dados da conta" ainda exige a confirmação destrutiva', async () => {
        const [, confirmAccount] = await clickResetButton();
        confirmAccount();
        await flush();

        const [text, applyReset] = mockShowConfirmationModal.mock.calls.at(-1) as ModalCall;
        expect(text).toBe('confirmResetAccount');
        expect(resetAccountData).not.toHaveBeenCalled();

        applyReset();
        expect(resetAccountData).toHaveBeenCalledTimes(1);
        expect(resetDeviceData).not.toHaveBeenCalled();
    });

    it('escolher "dados deste aparelho" leva ao reset local', async () => {
        const [, , opts] = await clickResetButton();
        opts?.onEdit();
        await flush();

        const [text, applyReset] = mockShowConfirmationModal.mock.calls.at(-1) as ModalCall;
        expect(text).toBe('confirmResetDevice');

        applyReset();
        expect(resetDeviceData).toHaveBeenCalledTimes(1);
        expect(resetAccountData).not.toHaveBeenCalled();
    });

    it('sem chave de sync vai direto à confirmação do aparelho', async () => {
        // Não existe conta a reiniciar: perguntar o escopo seria oferecer a mesma
        // coisa duas vezes.
        vi.mocked(hasLocalSyncKey).mockReturnValue(false);

        const [text, applyReset] = await clickResetButton();
        expect(text).toBe('confirmResetDevice');

        applyReset();
        expect(resetDeviceData).toHaveBeenCalledTimes(1);
    });

    it('avisa quando o purge falha, em vez de apagar em silêncio', async () => {
        vi.mocked(resetAccountData).mockRejectedValueOnce(new Error('KV down'));

        const [, confirmAccount] = await clickResetButton();
        confirmAccount();
        await flush();

        const [, applyReset] = mockShowConfirmationModal.mock.calls.at(-1) as ModalCall;
        applyReset();
        await flush();

        const [errorText, , errorOpts] = mockShowConfirmationModal.mock.calls.at(-1) as ModalCall;
        expect(errorText).toBe('resetAccountError');
        expect(errorOpts?.hideCancel).toBe(true);
    });
});
