# Quality Gates

These checks define merge and release readiness.

## Merge gates (required)

- Lint: pass
- Typecheck: pass
- Unit/integration tests: pass
- Critical scenario tests: pass for risky changes
- Security guardrails: pass

## Release gates (required)

- Build artifact generated successfully
- Smoke test in staging
- No unresolved high severity issues
- Rollback plan verified

## Risk-based escalation

- High-risk change requires:
  - Design note or decision entry
  - Two reviewers
  - Explicit rollback checklist

## Evidence format for PR

- Commands executed
- Key output summary
- Test scope affected
- Any skipped checks and justification

## Failure policy

- If any required gate fails: do not merge.
- If gate is flaky: label as flaky, isolate, and fix before release.
