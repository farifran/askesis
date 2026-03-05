# Hygiene Baseline (2026-02-27)

## Estado atual

- Guardrail de sinks sensíveis já existe e está ativo.
- Guardrail de dead files foi adicionado.
- Stack mínima de lint foi adicionada para TS/TSX.

## Riscos ainda existentes (prioridade)

1. Uso amplo de `innerHTML` fora dos três sinks críticos (principalmente em `render/*`).
2. Módulos grandes com múltiplas responsabilidades (principalmente `listeners/modals.ts` e `render/modals.ts`).
3. Uso de `any` em fluxos de worker/sync.

## Meta de curto prazo

- Reduzir ao menos 30% de atribuições `innerHTML` em `render/*` com utilitários seguros.
- Consolidar a modularização de `services/habitActions/*` e reduzir os próximos alvos (`listeners/modals.ts`, `render/modals.ts`).
- Tratar os principais `any` nos pipelines de sync/worker.

## Definição de pronto (higiene)

- CI bloqueia regressão dos guardrails.
- Lint ativo no pipeline.
- Política documentada para novos PRs.
