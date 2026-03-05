# Contributing

## Branch and commit

- Create short-lived branches from main.
- Use clear commit messages with intent and scope.

## Development flow

1. Sync latest main.
2. Implement smallest safe change.
3. Run required checks locally.
4. Open PR with risk notes and test evidence.

## PR requirements

- Problem statement and expected behavior.
- Files changed and rationale.
- Risk assessment (security/data/performance).
- Test evidence (commands + outcomes).
- Rollback note for high-risk changes.

## Mandatory checks before merge

- Lint passes.
- Typecheck passes.
- Affected tests pass.
- Critical scenario tests pass for risky changes.
- Invariants are not violated.

## Review guidelines

- Prefer small, atomic PRs.
- No unrelated refactors in bug-fix PRs.
- Document any new operational behavior in `RUNBOOK.md`.
