import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { state, bumpStateGeneration } from '../state';
import { clearTestState } from '../tests/test-utils';
import { getTodayUTCIso, addDays, parseUTCIsoDate, toUTCIsoDateString } from '../utils';
import { activateQuest, getActiveQuests } from '../services/progression';
import { renderQuestCatalog } from './progression';

beforeAll(() => {
    for (const id of [
        'quest-picker-modal', 'quest-picker-title', 'quest-catalog-list', 'quest-catalog-note',
        'create-custom-quest-btn', 'quest-custom-form', 'quest-custom-title-label',
        'quest-custom-title', 'quest-custom-target-label', 'quest-custom-confirm'
    ]) {
        const node = document.createElement(id === 'quest-custom-title' ? 'input' : id.endsWith('btn') || id.endsWith('confirm') ? 'button' : 'div');
        node.id = id;
        document.body.append(node);
    }
});

beforeEach(clearTestState);

describe('retomada de objetivos personalizados pelo catálogo', () => {
    it('mostra o expirado na lista e troca ativar por abandonar após retomada', () => {
        const past = toUTCIsoDateString(addDays(parseUTCIsoDate(getTodayUTCIso()), -10));
        state.quests = [{ id: 'custom:reading', customTitle: 'Ler', customTarget: 10, startedOn: past, days: [past] }];
        bumpStateGeneration();
        expect(getActiveQuests()).toEqual([]);
        renderQuestCatalog();
        const button = document.querySelector<HTMLButtonElement>('[data-quest-id="custom:reading"]')!;
        expect(button.dataset.questAction).toBe('activate');
        expect(button.disabled).toBe(false);
        expect(activateQuest(button.dataset.questId!).ok).toBe(true);
        renderQuestCatalog();
        expect(document.querySelector<HTMLElement>('[data-quest-id="custom:reading"]')!.dataset.questAction).toBe('abandon');
    });

    it('mantém o expirado visível mas impede retomada com os três slots ocupados', () => {
        const today = getTodayUTCIso();
        state.quests = [
            { id: 'custom:old', customTitle: 'Antigo', customTarget: 10, startedOn: '2020-01-01', days: [] },
            ...[1, 2, 3].map(n => ({ id: `custom:${n}`, customTitle: `Ativo ${n}`, customTarget: 10, startedOn: today, days: [] }))
        ];
        bumpStateGeneration();
        renderQuestCatalog();
        expect(document.querySelector<HTMLButtonElement>('[data-quest-id="custom:old"]')!.disabled).toBe(true);
    });
});
