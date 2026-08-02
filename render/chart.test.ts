/**
 * @file render/chart.test.ts
 * @description Regra de pontuação diária do gráfico de progresso composto.
 */

import { describe, expect, it } from 'vitest';
import { dailyPerformanceFactor, isDayInProgress } from './chart';
import { CHART_PLUS_BONUS_MULTIPLIER } from '../constants';

describe('isDayInProgress', () => {
    it('só considera em andamento o dia de hoje com pendências', () => {
        expect(isDayInProgress(true, 2)).toBe(true);
        expect(isDayInProgress(true, 0)).toBe(false);  // tudo decidido: dia fechou
        expect(isDayInProgress(false, 2)).toBe(false); // dia passado
    });
});

describe('dailyPerformanceFactor', () => {
    describe('dia em andamento (hoje, com pendências)', () => {
        // REGRESSÃO: antes o dia de hoje ficava congelado no valor da véspera até
        // zerar as pendências — o gráfico só se movia ao marcar TODOS os hábitos.
        it('sobe a cada hábito marcado', () => {
            expect(dailyPerformanceFactor(0, 4, true, false)).toBe(0);
            expect(dailyPerformanceFactor(1, 4, true, false)).toBe(0.25);
            expect(dailyPerformanceFactor(2, 4, true, false)).toBe(0.5);
            expect(dailyPerformanceFactor(3, 4, true, false)).toBe(0.75);
        });

        it('metade concluída já move a linha (não fica na base)', () => {
            // Caso relatado: 1 de 2 hábitos marcados exibia 0,0%.
            expect(dailyPerformanceFactor(1, 2, true, false)).toBeGreaterThan(0);
        });

        it('nunca pune um dia que ainda pode ser cumprido', () => {
            for (let done = 0; done <= 4; done++) {
                expect(dailyPerformanceFactor(done, 4, true, false)).toBeGreaterThanOrEqual(0);
            }
        });

        it('é monotônico: mais hábitos nunca reduzem a pontuação', () => {
            let previous = -Infinity;
            for (let done = 0; done <= 5; done++) {
                const factor = dailyPerformanceFactor(done, 5, true, false);
                expect(factor).toBeGreaterThan(previous);
                previous = factor;
            }
        });
    });

    describe('dia fechado', () => {
        it('trata metade concluída como neutro e pune abaixo disso', () => {
            expect(dailyPerformanceFactor(0, 4, false, false)).toBe(-1);
            expect(dailyPerformanceFactor(2, 4, false, false)).toBe(0);
            expect(dailyPerformanceFactor(4, 4, false, false)).toBe(1);
        });

        it('dia completo pontua igual em andamento ou fechado', () => {
            // Sem descontinuidade na virada quando o dia foi 100% cumprido.
            expect(dailyPerformanceFactor(4, 4, true, false)).toBe(dailyPerformanceFactor(4, 4, false, false));
        });
    });

    it('bônus de superação tem precedência sobre a proporção', () => {
        expect(dailyPerformanceFactor(1, 4, true, true)).toBe(CHART_PLUS_BONUS_MULTIPLIER);
        expect(dailyPerformanceFactor(4, 4, false, true)).toBe(CHART_PLUS_BONUS_MULTIPLIER);
    });

    it('dia sem hábitos agendados é neutro', () => {
        expect(dailyPerformanceFactor(0, 0, false, false)).toBe(0);
        expect(dailyPerformanceFactor(0, 0, true, false)).toBe(0);
    });
});
