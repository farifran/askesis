/**
 * @file services/notificationCard.test.ts
 * @description Cartão pré-renderizado que o Service Worker lê para personalizar o lembrete.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { state, HABIT_STATE } from '../state';
import { HabitService } from './HabitService';
import { getTodayUTCIso } from '../utils';
import { setLanguage } from '../i18n';
import { buildNotificationCard, setNotificationQuote } from './notificationCard';
import { createTestHabit, clearTestState } from '../tests/test-utils';

const TODAY = getTodayUTCIso();

// `author` é chave de i18n, resolvida na montagem do cartão.
const QUOTE = { text: 'Nenhum vento é favorável a quem não sabe aonde vai.', authorKey: 'musoniusRufus' };

describe('buildNotificationCard', () => {
    beforeAll(async () => {
        // O cartão é pré-renderizado: sem dicionário carregado, `t()` devolveria
        // a própria chave e o teste não veria o texto que chega ao usuário.
        await setLanguage('en');
        await setLanguage('pt');
    });

    beforeEach(() => {
        clearTestState();
        setNotificationQuote(null);
    });

    it('retorna null quando não há hábitos ativos hoje', () => {
        // Sem nada agendado, o texto genérico do push é mais honesto.
        expect(buildNotificationCard()).toBeNull();
    });

    it('lista os hábitos pendentes pelo nome', () => {
        createTestHabit({ name: 'Meditar', time: 'Morning', goalType: 'check' });
        createTestHabit({ name: 'Ler', time: 'Morning', goalType: 'check' });

        const card = buildNotificationCard()!;

        expect(card.date).toBe(TODAY);
        expect(card.lang).toBe('pt');
        expect(card.title).toBe('Hábitos pendentes');
        expect(card.body).toContain('Meditar');
        expect(card.body).toContain('Ler');
    });

    it('resume com "+N" quando há mais nomes do que cabem', () => {
        ['A', 'B', 'C', 'D', 'E'].forEach(name =>
            createTestHabit({ name, time: 'Morning', goalType: 'check' })
        );

        const card = buildNotificationCard()!;

        // 3 nomes visíveis + contagem dos 2 restantes.
        expect(card.body).toContain('+2');
        expect(card.body).not.toContain('E');
    });

    it('não conta como pendente o hábito já concluído', () => {
        const feito = createTestHabit({ name: 'Feito', time: 'Morning', goalType: 'check' });
        createTestHabit({ name: 'Pendente', time: 'Morning', goalType: 'check' });
        HabitService.setStatus(feito, TODAY, 'Morning', HABIT_STATE.DONE);

        const card = buildNotificationCard()!;

        expect(card.body).toContain('Pendente');
        expect(card.body).not.toContain('Feito');
    });

    it('mostra a frase estoica quando o dia está completo', () => {
        const id = createTestHabit({ name: 'Meditar', time: 'Morning', goalType: 'check' });
        HabitService.setStatus(id, TODAY, 'Morning', HABIT_STATE.DONE);
        setNotificationQuote(QUOTE);

        const card = buildNotificationCard()!;

        expect(card.title).toBe('Tudo em dia');
        expect(card.body).toContain(QUOTE.text);
        // Autor resolvido pelo i18n, não a chave crua.
        expect(card.body).toContain('Musônio Rufo');
        expect(card.body).not.toContain('musoniusRufus');
    });

    it('usa o idioma ativo no título e no autor', () => {
        const id = createTestHabit({ name: 'Meditar', time: 'Morning', goalType: 'check' });
        HabitService.setStatus(id, TODAY, 'Morning', HABIT_STATE.DONE);
        setNotificationQuote(QUOTE);
        state.activeLanguageCode = 'en';

        const card = buildNotificationCard()!;

        expect(card.lang).toBe('en');
        expect(card.title).toBe('All done');
        expect(card.body).toContain(QUOTE.text);
    });

    it('retorna null no dia completo sem frase publicada', () => {
        // Frases carregam sob demanda: antes do chunk chegar não há o que dizer,
        // e o texto genérico do push é melhor que um corpo vazio.
        const id = createTestHabit({ name: 'Meditar', time: 'Morning', goalType: 'check' });
        HabitService.setStatus(id, TODAY, 'Morning', HABIT_STATE.DONE);

        expect(buildNotificationCard()).toBeNull();
    });

    it('nunca lança: falha ao montar vira null', () => {
        createTestHabit({ name: 'Meditar', time: 'Morning', goalType: 'check' });
        // Corrompe o estado de um jeito que quebra o cálculo do resumo.
        (state as unknown as { habits: unknown }).habits = null;

        expect(() => buildNotificationCard()).not.toThrow();
        expect(buildNotificationCard()).toBeNull();
    });
});
