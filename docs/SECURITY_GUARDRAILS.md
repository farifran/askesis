# Security Guardrails

Este documento define as regras mínimas de higiene/segurança para contribuição no Askesis.

## Objetivo

Evitar regressões de segurança e reduzir superfície de risco sem bloquear evolução do produto.

## Regras obrigatórias

1. Não usar `ui.aiResponse.innerHTML = ...`.
2. Não usar `ui.confirmModalText.innerHTML = ...` sem sanitização.
3. Não usar `ui.syncWarningText.innerHTML = ...`.
4. Arquivos removidos por higiene não devem retornar:
   - `AUDIT_SMART_MERGE.md`
   - `SMART_MERGE_SOLUTIONS.ts`

## Caminhos permitidos

- Para conteúdo textual: usar `setTextContent` de `render/dom.ts`.
- Para HTML controlado: sanitizar e aplicar com `replaceChildren(DocumentFragment)`.

## Verificações automáticas

- `npm run guardrail:security-html`
- `npm run guardrail:dead-files`
- `npm run lint`

Nota: o `lint` do projeto é nativo (TypeScript + checks de higiene), sem dependência obrigatória de plugins ESLint externos.
No momento, o type-check (`tsc`) roda em modo informativo no lint nativo; as regras de guardrail/higiene continuam bloqueantes.

## Política de revisão

Em PRs que toquem UI/render/listeners:

- Validar se novos pontos de renderização seguem os helpers seguros.
- Justificar explicitamente qualquer exceção de HTML dinâmico.
- Preferir mudanças pequenas e testáveis por módulo.
