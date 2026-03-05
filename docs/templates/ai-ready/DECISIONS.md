# Decisions Log

Record architectural and process decisions in chronological order.

## Entry template

- ID: DEC-YYYYMMDD-XX
- Status: proposed | accepted | deprecated
- Context:
- Decision:
- Alternatives considered:
- Consequences:
- Rollback plan:
- Links (PR/issues/docs):

## Example

- ID: DEC-20260305-01
- Status: accepted
- Context: Type system noise from mixed app and test scopes.
- Decision: Split TypeScript config into app and test projects.
- Alternatives considered: single tsconfig with broad `types`.
- Consequences: clearer editor diagnostics, explicit test typing pipeline.
- Rollback plan: merge configs back if tooling cannot support project references.
- Links (PR/issues/docs): [link]
