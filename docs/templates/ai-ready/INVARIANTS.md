# Invariants

These are non-negotiable rules. If any is violated, release must stop.

## Security

- No secrets committed to source control.
- All external input must be validated before use.
- Privileged actions require explicit authorization checks.
- High-risk rendering paths must use safe/sanitized APIs.

## Data Consistency

- Every write path must be idempotent or explicitly guarded.
- Conflicts must have deterministic resolution rules.
- Deletions and updates must preserve referential integrity.
- Time handling must be explicit (timezone/UTC policy documented).

## Reliability

- Critical operations must have timeout and retry strategy.
- Error handling must avoid silent failures.
- Recovery behavior must be defined for partial failure.

## Performance

- Define budgets for startup, hot paths, and heavy operations.
- No unbounded work on user-interaction critical paths.
- Expensive work must be batched, deferred, or offloaded.

## Accessibility

- Interactive elements must be keyboard reachable and operable.
- Focus order and escape paths must be deterministic.
- Essential controls must have semantic labels.

## Change Management

- Any invariant change requires a decision entry in `DECISIONS.md`.
