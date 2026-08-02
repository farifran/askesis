/**
 * @file services/aiPrompt.test.ts
 * @description Invariantes do prompt de análise estoica.
 *
 * O prompt é um CONTRATO entre três partes: os templates dos locales, o montador
 * no worker e o consumo do resultado pelo quoteEngine. Erros aqui são silenciosos
 * — a IA responde, o JSON parseia, e o efeito simplesmente não acontece.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_THEMES } from '../data/aiThemes';
import { QUOTE_ANALYSIS_SCHEMA } from './analysis';

const LOCALES = ['pt', 'en', 'es'] as const;

function loadLocale(lang: string): Record<string, unknown> {
    return JSON.parse(readFileSync(`locales/${lang}.json`, 'utf8'));
}

/** Tags canônicas declaradas na união StoicTag de data/quotes.ts. */
function loadStoicTags(): Set<string> {
    const src = readFileSync('data/quotes.ts', 'utf8');
    const union = src.match(/export type StoicTag =([\s\S]*?);/);
    if (!union) throw new Error('União StoicTag não encontrada em data/quotes.ts');
    return new Set([...union[1].matchAll(/'([a-zA-Z_]+)'/g)].map(m => m[1]));
}

describe('Prompt de análise estoica', () => {
    describe('vocabulário de temas', () => {
        // REGRESSÃO: a lista vivia nos locales e foi traduzida em pt/es, enquanto
        // as tags das citações são inglesas. Os temas devolvidos pela IA nunca
        // casavam com quote.metadata.tags e o AI_MATCH boost ficava morto — no
        // idioma padrão do app. Agora é constante tipada, validada na compilação.
        it('contém apenas tags que existem em StoicTag', () => {
            const tags = loadStoicTags();
            expect(AI_THEMES.length).toBeGreaterThan(0);
            const invalid = AI_THEMES.filter(theme => !tags.has(theme));
            expect(invalid, `temas sem tag correspondente: ${invalid.join(', ')}`).toEqual([]);
        });

        it('saiu dos arquivos de locale (não é texto de interface)', () => {
            for (const lang of LOCALES) {
                expect(loadLocale(lang), `locale ${lang}`).not.toHaveProperty('aiThemeList');
            }
        });

        it('o schema restringe os temas ao mesmo vocabulário do prompt', () => {
            // Enum no responseSchema: tema fora da lista deixa de ser improvável
            // e passa a ser impossível — o modelo é restringido na decodificação.
            const themesSchema = QUOTE_ANALYSIS_SCHEMA.properties.relevant_themes;
            expect(themesSchema.items.enum).toEqual([...AI_THEMES]);
        });
    });

    describe('templates', () => {
        it('todos os idiomas declaram os placeholders que o montador substitui', () => {
            for (const lang of LOCALES) {
                const prompt = String(loadLocale(lang).aiPromptQuote);
                expect(prompt, `locale ${lang}`).toContain('{notes}');
                expect(prompt, `locale ${lang}`).toContain('{theme_list}');
            }
        });

        it('todos os idiomas pedem os campos que o app realmente consome', () => {
            // analysis.ts lê json.analysis.determined_level e json.relevant_themes.
            for (const lang of LOCALES) {
                const prompt = String(loadLocale(lang).aiPromptQuote);
                expect(prompt, `locale ${lang}`).toContain('determined_level');
                expect(prompt, `locale ${lang}`).toContain('relevant_themes');
            }
        });

        it('documenta todos os blocos que o montador injeta', () => {
            // REGRESSÃO: [DATA_CONTEXT] era anexado a todo prompt sem que nenhum
            // template o explicasse — o modelo recebia dados que as instruções
            // nunca mandavam usar, ao contrário de [HABIT_MODES].
            for (const lang of LOCALES) {
                const prompt = String(loadLocale(lang).aiPromptQuote);
                expect(prompt, `locale ${lang}`).toContain('[HABIT_MODES]');
                expect(prompt, `locale ${lang}`).toContain('[DATA_CONTEXT]');
                expect(prompt, `locale ${lang}`).toContain('first_entry=true');
            }
        });

        it('numera os passos sequencialmente, sem saltos nem repetições', () => {
            for (const lang of LOCALES) {
                const prompt = String(loadLocale(lang).aiPromptQuote);
                const steps = [...prompt.matchAll(/^(\d+)\.\s{2}\*\*/gm)].map(m => Number(m[1]));
                expect(steps.length, `locale ${lang}`).toBeGreaterThan(1);
                expect(steps, `locale ${lang}`).toEqual(steps.map((_, i) => i + 1));
            }
        });

        it('manda copiar os identificadores de tema sem traduzir', () => {
            // O prompt é escrito em pt/es mas a lista de temas é inglesa: sem
            // instrução explícita, o modelo traduz e o boost volta a morrer.
            const markers = { pt: 'sem traduzir', en: 'without translating', es: 'sin traducir' };
            for (const lang of LOCALES) {
                const prompt = String(loadLocale(lang).aiPromptQuote);
                expect(prompt, `locale ${lang}`).toContain(markers[lang]);
            }
        });

        it('define o nível por rubrica direta, não por média aritmética', () => {
            // A média de 5 critérios 1-3, arredondada, prende 82,7% dos casos no
            // nível 2 — a adaptação de registro deixava de diferenciar.
            const markers = { pt: 'NÃO uma média aritmética', en: 'NOT an arithmetic average', es: 'NO un promedio aritmético' };
            for (const lang of LOCALES) {
                const prompt = String(loadLocale(lang).aiPromptQuote);
                expect(prompt, `locale ${lang}`).toContain(markers[lang]);
                expect(prompt, `locale ${lang}`).not.toContain('average_score');
            }
        });

        it('cobre entrada sem sinal reflexivo suficiente', () => {
            for (const lang of LOCALES) {
                const prompt = String(loadLocale(lang).aiPromptQuote);
                expect(prompt, `locale ${lang}`).toContain('relevant_themes: []');
            }
        });

        it('não vaza palavras de outro idioma no template português', () => {
            const pt = String(loadLocale('pt').aiPromptQuote);
            for (const leak of ['palabras', 'Granularidad ', 'puntuación', 'siguiente']) {
                expect(pt.includes(leak), `PT contém termo em espanhol: ${leak}`).toBe(false);
            }
        });
    });
});

describe('Montagem do prompt (sync.worker)', () => {
    it('preserva padrões de $ vindos das notas do usuário', async () => {
        // REGRESSÃO: String.replace(str, str) interpreta `$&`, `$\``, `$'` e `$$`
        // no texto de substituição. Uma nota contendo esses padrões era corrompida
        // — trechos do template vazavam para dentro do texto enviado à IA.
        const { buildAiQuoteAnalysisPrompt } = await import('./sync.worker');

        const notes = "Gastei $& hoje, refleti sobre $`isso e $$ economias";
        const result = buildAiQuoteAnalysisPrompt({
            notes,
            themeList: 'action, courage',
            translations: {
                aiPromptQuote: 'Notas:\n{notes}\n---\nTemas: {theme_list}',
                aiSystemInstructionQuote: 'sys'
            }
        }) as { prompt: string };

        expect(result.prompt).toContain(notes);
        expect(result.prompt).not.toContain('{notes}');
        expect(result.prompt).toContain('Temas: action, courage');
    });
});
