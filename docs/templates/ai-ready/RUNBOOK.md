# Runbook

Use this runbook during incidents and high-severity regressions.

## Incident template

- Symptom:
- Scope affected:
- First seen:
- Suspected cause:
- Immediate mitigation:
- Permanent fix:
- Follow-up actions:

## Playbook 1: Build or startup fails

- Check dependency install status and lockfile integrity.
- Run `lint`, `typecheck`, and `test` separately to isolate failure layer.
- If recent config changes exist, revert only config delta and re-test.

## Playbook 2: Runtime errors in production

- Identify failing module and last known good release.
- Enable safe fallback path if available.
- Roll back to previous stable release if error rate crosses threshold.
- Capture minimal reproduction and add regression test.

## Playbook 3: Data inconsistency or merge conflict

- Freeze risky write paths if possible.
- Export affected records and preserve forensic snapshot.
- Apply deterministic reconciliation policy documented in invariants.
- Verify integrity with targeted checks before reopening writes.

## Playbook 4: External dependency outage

- Switch to degraded mode and queue pending operations.
- Increase timeout/retry only within safe limits.
- Track dropped/retried operations for later replay.

## Playbook 5: Security regression

- Stop rollout immediately.
- Disable vulnerable path/feature flag.
- Rotate exposed credentials if needed.
- Patch, test, and document root cause.
