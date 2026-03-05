# Contributing

Thank you for contributing to Askesis.
This guide defines the minimum standards for safe changes.

## Scope

- Keep PRs small and focused on one intent.
- Avoid unrelated refactors in bug-fix PRs.
- Prefer the smallest safe change.
- Update tests and docs when behavior changes.

## Branch and commit

- Branch from `main`.
- Use short-lived branches.
- Commit messages should be clear and action-oriented.
- Recommended format: `<type>(<scope>): <summary>`.

Examples:

- `fix(sync): handle 409 merge retry`
- `test(services): add migration fixture for v11`
- `docs(architecture): document worker contract change`

## Architecture rules

- Keep domain logic out of DOM-heavy modules.
- Do not bypass typed boundaries between modules.
- Do not introduce unsafe HTML sinks.
- Preserve keyboard accessibility behavior.

## Security and safety rules

- Never commit secrets.
- Do not add raw `innerHTML` assignments in feature code.
- Use existing sanitization and safe DOM helpers.
- Keep server input validation strict.

## Local validation before PR

Run these checks locally:

```bash
npm run typecheck
npm run guardrail:all
npm run guardrail:file-size
npm run lint
npm test
```

For risky changes (sync, persistence, security, accessibility, performance), also run:

```bash
npm run test:scenario
npm run test:coverage
```

## PR requirements

Every PR must include:

- Problem statement and expected behavior.
- What changed and why.
- Risk assessment (security/data/performance/accessibility).
- Test evidence (commands executed + concise results).
- Rollback strategy for high-risk changes.

## High-risk changes

Changes touching the items below require extra care:

- Data model or migration logic.
- Sync and conflict resolution.
- Encryption, auth, or HTTP security behavior.
- Accessibility-critical flows (modal, keyboard, focus).
- Build or service worker behavior.

For these, include:

- Design note (or ADR/decision entry when applicable).
- At least one scenario test update.
- Explicit rollback plan in the PR.

## Definition of done

A change is done only when:

- Code is implemented and reviewed.
- Relevant tests are added/updated and pass.
- Required gates pass.
- Operational/doc updates are included when needed.
- No known blocker remains open for merge.
