# AI-Ready Project Starter Pack

This folder contains generic templates that can be reused in any software project.

## Goal

Provide a machine-friendly and human-readable development map that reduces ambiguity, rework, and unsafe changes.

## Files

- `ai-map.yaml`: Structured project map for AI agents.
- `INVARIANTS.md`: Non-negotiable rules.
- `RUNBOOK.md`: Incident diagnosis and recovery steps.
- `DECISIONS.md`: Architecture decision log.
- `CONTRIBUTING.md`: Contribution workflow and PR checks.
- `.env.example`: Environment variable contract and safe defaults.
- `QUALITY_GATES.md`: Required checks before merge/release.

## Suggested adoption order

1. Copy `ai-map.yaml` and fill commands, modules, and priorities.
2. Define critical invariants in `INVARIANTS.md`.
3. Add top 5 incident playbooks to `RUNBOOK.md`.
4. Record at least 3 key decisions in `DECISIONS.md`.
5. Enforce checks in `QUALITY_GATES.md`.
6. Align `CONTRIBUTING.md` and `.env.example` with the real project.

## Maintenance rule

Update these files whenever architecture, workflows, or critical safeguards change.
