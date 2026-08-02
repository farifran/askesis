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
    describe('aiThemeList é vocabulário de máquina, não texto de interface', () => {
        // REGRESSÃO: as listas de PT e ES estavam traduzidas ("resiliencia",
        // "coragem"), mas as tags das citações são inglesas. Os temas devolvidos
        // pela IA nunca casavam com quote.metadata.tags, então o AI_MATCH boost
        // ficava morto — justamente no idioma padrão do app.
        it('é idêntica em todos os idiomas', () => {
            const canonical = loadLocale('en').aiThemeList;
            expect(typeof canonical).toBe('string');
            for (const lang of LOCALES) {
                expect(loadLocale(lang).aiThemeList, `locale ${lang}`).toBe(canonical);
            }
        });

        it('contém apenas tags que existem em StoicTag', () => {
            const tags = loadStoicTags();
            const themes = String(loadLocale('en').aiThemeList)
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);

            expect(themes.length).toBeGreaterThan(0);
            const invalid = themes.filter(theme => !tags.has(theme));
            expect(invalid, `temas sem tag correspondente: ${invalid.join(', ')}`).toEqual([]);
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
