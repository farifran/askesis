# Auditoria de dependências — 2 de outubro de 2026

Após atualizar o lockfile e instalar as ferramentas exigidas pelo ESLint, `npm audit`
reportou **zero vulnerabilidades**, tanto em produção quanto incluindo desenvolvimento.
O resultado é uma consulta datada ao registry, não uma garantia de ausência de falhas.

Versões instaladas relevantes:

| Pacote | Versão |
|---|---|
| @google/genai | 1.52.0 |
| @upstash/redis | 1.39.0 |
| dompurify | 3.4.16 |
| vitest / @vitest/ui / @vitest/coverage-v8 | 4.1.11 |
| vite direto | 6.4.3 |
| esbuild direto | 0.28.2 |
| eslint | 10.11.0 |
| @typescript-eslint/parser / eslint-plugin | 8.71.0 |

`package-lock.json` fixa a árvore completa. O relatório bruto anterior permanece em
[system-audit-dependencies-2026-10-02.json](code-review/system-audit-dependencies-2026-10-02.json)
como evidência histórica; ele não descreve a árvore atual.

`npm run lint` executa ESLint. TypeScript tem seu próprio comando (`npm run typecheck`).
O guardrail de auditoria falha se o registry estiver indisponível, se a execução
falhar ou se o JSON estiver incompleto. HIGH/CRITICAL de produção bloqueiam CI;
os demais níveis continuam visíveis no relatório. O job noturno também bloqueia
HIGH/CRITICAL e publica o relatório mesmo em falha.

Verificação: `npm run guardrail:audit`, `npm run typecheck`, `npm run lint`,
`npm test` e `npm run build`. O inventário de testes é gerado por
`npm run test:inventory`, que executa a suíte completa.
