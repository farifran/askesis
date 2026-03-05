# AI Project Blueprint: Habit App (Askesis-like)

## Purpose

This document is a single source of truth for bootstrapping a habit-tracking app with strong foundations from day one.
It is written for both humans and coding agents.

## Product Scope

### Core goal

Build a local-first habit tracker with:

- daily check-ins by time of day
- strong privacy defaults
- optional cloud sync
- optional AI reflection layer

### Non-goals (initial versions)

- social feed
- public profiles
- ad-driven growth loops
- deep gamification loops that compromise focus

## Architecture Principles

1. Local-first by default
2. Offline-first UX
3. Deterministic state transitions
4. Typed boundaries between modules
5. Security by default, not by patch
6. Small modules with strict ownership
7. Performance budgets enforced in CI
8. Accessibility as baseline requirement
9. Event-driven decoupling (no framework state management)
10. Progressive enhancement (features degrade, never crash)
11. Zero-trust internal payloads (validate at every boundary)

## Required Module Boundaries

Use this top-level structure from day one.

```text
src/
  app/
    boot/
    routing/
    lifecycle/
  domain/
    habits/
      model/
      services/
      policies/
    sync/
      model/
      services/
      conflict/
    analysis/
      model/
      services/
  ui/
    calendar/
    habits/
    modals/
    shared/
  infra/
    storage/
    network/
    crypto/
    workers/
    telemetry/
  contracts/
    api/
    events/
    worker/
  tests/
    unit/
    integration/
    scenario/
```

### Hard boundary rules

- `ui/*` cannot import `infra/*` directly.
- `domain/*` cannot depend on DOM APIs.
- `infra/*` cannot contain business decisions.
- All cross-boundary payloads must be declared in `contracts/*`.
- `ui/*` communicates state changes via custom events, not direct calls.
- Workers only receive/send message shapes declared in `contracts/worker/`.

## Naming Conventions

Establish these from day one to avoid inconsistency:

- **Files**: `camelCase.ts` for modules, `kebab-case/` for directories
- **Types/Interfaces**: `PascalCase` (`Habit`, `AppState`, `WorkerRequestV1`)
- **Functions**: `camelCase` (`getStatus`, `renderApp`, `mergeStates`)
- **Constants**: `UPPER_SNAKE_CASE` (`HABIT_STATE`, `NETWORK_DEBOUNCE_MS`)
- **Private/internal functions**: `_prefixed` (`_handleVisibilityChange`, `_buildListItem`)
- **Test descriptions**: `describe/it` with emoji prefixes for visual scanning (`🧪`, `🔐`, `🎲`)
- **Event names**: `kebab-case` strings (`habits-changed`, `day-changed`, `request-analysis`)
- **CSS variables**: `--kebab-case` (`--color-primary`, `--spacing-md`)

## File Size and Responsibility Limits

Enforce in CI:

- max 400 lines for most files
- max 700 lines for generated/config exceptions only
- one primary responsibility per module
- if a file has more than one reason to change, split it

## State Management Model

### State strategy

- Single source of truth for app state
- Immutable transitions for domain updates
- Side effects handled by orchestrators, not reducers
- Derived values through selectors only

### State partitions

- `coreState`: habits, schedules, metadata
- `uiState`: modal visibility, focus state, transient flags
- `syncState`: queue, retry metadata, conflict markers
- `analysisState`: AI request state, last summaries

## Event-Driven Architecture

### Custom Event Hub

Use native DOM `CustomEvent` dispatch for inter-module communication.
No framework (Redux, MobX, signals) needed.

### Rules

- All app-level events declared in a central `events.ts` file
- Each event has: name, payload type, producer, consumers
- Events are fire-and-forget (producers do not await consumers)
- Side effects triggered by listeners, never by event dispatchers
- Event names are string constants, not magic strings

### Event catalog structure

```typescript
// events.ts
export const EVENTS = {
  HABITS_CHANGED: 'habits-changed',
  DAY_CHANGED: 'day-changed',
  RENDER_APP: 'render-app',
  SYNC_REQUESTED: 'sync-requested',
  CARD_STATUS_CHANGED: 'card-status-changed',
} as const;

export function emit(name: string, detail?: unknown): void {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}
```

### Listener wiring

- Register listeners in a central `listeners.ts` bootstrapper
- Heavy listeners (drag, swipe) deferred via `scheduler.postTask()` or `setTimeout()`
- Listeners must not throw (wrap in try-catch, log, continue)

## Boot and Lifecycle Sequence

Define a deterministic startup order from day one.

### Required boot sequence

1. **Integrity check** — detect boot loops (sessionStorage counter, max 3 retries)
2. **Load local state** — IndexedDB hydration, render immediately with local data
3. **Cloud sync** — if sync key exists, fetch remote state with timeout
4. **Merge** — reconcile local and remote with conflict resolution
5. **UI unlock** — remove loading indicators, enable interactions
6. **Deferred tasks** — archival checks, analytics, lazy feature loading
7. **Push setup** — notification opt-in only after first user interaction

### Lifecycle events

- **Visibility change** — refresh UI on app resume, detect day transitions
- **Online/offline** — toggle network indicator, flush sync queue on reconnect
- **Midnight boundary** — detect day change and refresh calendar/status

## Contracts First (Critical)

Define and version these contracts before implementing features.

### 1) Worker contracts

- `WorkerRequestV1`
- `WorkerResponseV1`
- strict discriminated unions
- required `version` field

### 2) API contracts

- request/response schema per endpoint
- explicit error shapes
- explicit retryability metadata

### 3) Event contracts

- app-level events typed in one central file
- each event has producer, consumers, and side-effects documented

## Validation and Serialization

### Rule

Never trust runtime payloads, even if they come from internal layers.

### Required

- validate all boundary payloads (API, worker, storage hydration)
- sanitize unsafe strings before rendering
- reject unknown enum values
- preserve forward compatibility for schema versioning

## Keyboard and Input Normalization

Cross-browser keyboard handling is a known source of bugs.
Normalize from day one.

### Required normalizations

- `' '` / `'Spacebar'` → `'Space'` (use `event.code` as fallback)
- `'Esc'` → `'Escape'`
- `'Left'` / `'Right'` / `'Up'` / `'Down'` → `'ArrowLeft'` / `'ArrowRight'` / `'ArrowUp'` / `'ArrowDown'`

### Implementation pattern

```typescript
// utils.ts
export function normalizeKey(e: KeyboardEvent): string {
  const key = e.key;
  if (key === ' ' || key === 'Spacebar' || e.code === 'Space') return 'Space';
  if (key === 'Esc') return 'Escape';
  const arrowMap: Record<string, string> = {
    Left: 'ArrowLeft', Right: 'ArrowRight',
    Up: 'ArrowUp', Down: 'ArrowDown',
  };
  return arrowMap[key] ?? key;
}

export function isActivationKey(e: KeyboardEvent): boolean {
  const k = normalizeKey(e);
  return k === 'Enter' || k === 'Space';
}
```

### Keyboard rules

- Never compare `e.key` directly in feature code
- Always use normalization helpers from a shared utility
- All interactive controls must respond to both Enter and Space
- Modal escape must use normalized Escape check

## Safe DOM by Default

### Global policy

- default render path is DOM-safe API usage
- no raw `innerHTML` in feature code
- if rich HTML is unavoidable, sanitize first and isolate sink

### Allowed rendering patterns

- `textContent`
- `createElement + append`
- `replaceChildren(DocumentFragment)`

### Guardrails

- block PR if forbidden sinks are introduced
- keep an allowlist of audited sinks

### HTML sanitization (when rich content is unavoidable)

```typescript
// Strip dangerous tags: script, iframe, object, embed, link, meta, style
// Strip dangerous attributes: on*, javascript: URLs
// Return DocumentFragment via template + sanitize pipeline
function sanitizeHtmlToFragment(html: string): DocumentFragment { ... }
```

## Sync and Conflict Strategy

### Must-have characteristics

- idempotent operations
- deterministic conflict resolution
- explicit tombstone semantics
- per-record logical timestamps or equivalent ordering strategy

### Conflict policy baseline

1. Match by canonical id
2. Dedup by normalized identity with conservative heuristics
3. LWW only where safe and explicit
4. Keep merge audit metadata for debugging

### Queue and retry

- exponential backoff with jitter
- max retry policy
- dead-letter style quarantine for repeated failures

## Error Handling and Resilience Patterns

### Strategy hierarchy

1. **Try-catch + fallback** — network fails → offline mode, crypto fails → sync key fallback
2. **Graceful degradation** — missing API (`scheduler.postTask`) → `setTimeout()` polyfill
3. **Retry with backoff** — exponential backoff with jitter for API calls
4. **Circuit breaker** — cooldown after quota exhaustion (e.g., 90s after AI daily limit)
5. **User feedback** — modal confirmations for destructive actions, status messages for async errors

### Error handling rules

- Never let errors propagate silently — catch, log, and degrade
- Never show raw stack traces to end users
- Abort long-running operations with `AbortController` + timeout
- All event listeners wrapped in try-catch (a failing listener must not break others)

## Network Resilience

### Online/offline detection

- Listen for `online`/`offline` events on `window`
- Toggle visual indicator (CSS class) on app container
- Flush pending sync queue on reconnect

### Sync resilience

- Hash-based change detection (only upload if state differs from last sync)
- Debounced sync triggers (avoid flooding on rapid changes)
- 409 conflict → fetch remote, merge locally, retry
- Dead-letter quarantine for repeatedly failing operations

### Visibility-aware refresh

- On `visibilitychange` return: refresh UI, detect day boundary, check sync
- Prevent redundant API calls during background state

## Security Baseline (Blockers)

- no secrets in repository
- strict input validation for all external inputs
- key derivation and encryption in worker path for heavy crypto
- no stack traces leaked to end users
- rate limiting and abuse controls in public endpoints
- CSP and secure headers for deployed app

## Accessibility Baseline (Blockers)

- all interactive controls keyboard operable
- focus trap and escape behavior in modal flows
- semantic labels on controls
- announced status messages for important async actions
- scenario tests for keyboard-only flow

## Performance Baseline (Blockers)

Define budgets and fail CI when exceeded.

| Metric | Budget | Measurement |
| --- | --- | --- |
| Cold start (to interactive) | < 2s on 3G | Lighthouse / synthetic test |
| Render update (calendar batch) | < 16ms per frame | Performance.mark in test |
| Sync/merge (1000 habits) | < 500ms | Integration test assertion |
| Memory ceiling (1h session) | < 50MB heap | Scenario test with GC check |
| Bundle size (main) | < 150KB gzip | CI build output check |

### Performance tactics

- Batch DOM updates (e.g., calendar renders in batches of 15-30 items)
- Avoid unbounded work on input handlers (debounce at 100-500ms)
- Offload CPU-bound operations to Web Workers (crypto, merge, analysis)
- Debounce high-frequency sync triggers (e.g., 2s after last change)
- Use `requestIdleCallback` for non-urgent cleanup (orphaned data pruning)
- Use `scheduler.postTask()` with fallback for deferred heavy listeners
- Use `IntersectionObserver` for lazy rendering (charts, off-screen content)

### Memory management

- Lazy initialization for DOM caches and worker instances
- Cache size limits with eviction (e.g., hash cache max 2000 entries)
- Explicit event listener cleanup on component teardown
- `AbortController` cleanup for canceled async operations
- Prune stale cache entries on day boundary transitions

## Testing Strategy (from MVP)

### Test pyramid

1. Unit tests for domain logic
2. Integration tests for storage, sync, and contracts
3. Scenario tests for journeys, accessibility, and resilience

### Required test suites

- `domain/habits` invariants
- merge/conflict determinism suite (including fuzzer + oracle pattern)
- migration compatibility suite (fixtures per schema version)
- keyboard and focus regression suite
- security sink regression suite
- network resilience suite (offline, timeout, 409 conflict)
- disaster recovery suite (corrupted storage, missing fields)

### Test infrastructure (build from day one)

```typescript
// test-utils.ts — centralized helpers
createTestHabit(overrides?)     // Minimal valid Habit
clearTestState()                // Full state + cache reset
toggleTestHabitStatus(id, date) // Status cycling helper
populateTestPeriod(habits, days)// Bulk data generation
```

### Test environment

- Browser-like DOM via happy-dom (fast, no real browser)
- Global mocks: `fetch` serves locale files from disk (no network)
- Test timeout: 30s for scenario tests, default for unit
- Slow test threshold alert: > 1s

### Coverage policy

- Line: ≥ 80%, Branch: ≥ 70% for core modules
- Scenario suites are mandatory for release
- Critical paths (merge, crypto, persistence) require ≥ 90% branch coverage

## TypeScript Project Separation

Use isolated tsconfigs from day one.

- `tsconfig.base.json`: shared compiler options (strict, ES2020+, moduleResolution node)
- `tsconfig.app.json`: app runtime/editor scope (`types: []`, excludes test files)
- `tsconfig.test.json`: test-only globals/types (`types: ["vitest", "node"]`)
- optional `tsconfig.tools.json`: scripts/build tooling scope

### Why this matters

- Prevents test globals (`describe`, `it`) from polluting app code
- Editor shows errors relevant to the current context only
- CI runs `tsc --noEmit` per project for precise type checking

## Build System Requirements

### Entry points

- Main app bundle (ESM, minified in production)
- Web Worker bundle (separate entry, no DOM deps)
- Static assets (HTML, manifest, service worker, locales, icons)

### Build tool expectations

- Fast bundler (esbuild, Vite, or equivalent)
- Environment variable injection via `define` (no runtime env access in browser)
- Source maps in development only
- Tree shaking for production builds
- Watch mode for development with hot reload

### Service Worker strategy

- Precache app shell + locales + icons
- Navigation: network-first with cache fallback (3s timeout)
- Assets: stale-while-revalidate (scripts, styles, images)
- API routes: always network-only (never cache API responses)
- Push notification worker: lazy-loaded only after user opt-in

## Internationalization (i18n)

### Architecture from day one

- Centralized translation loader with timeout and fallback chain
- Dual-layer cache: object references (WeakMap) + string keys (Map)
- Lazy loading: fetch locale JSON on demand, not at build time
- Fallback chain: user language → closest variant → default language

### Required capabilities

- Pluralization via `Intl.PluralRules` (cached per locale)
- String interpolation: `{paramName}` syntax with regex replacement
- Date/number formatting via `Intl.DateTimeFormat` / `Intl.NumberFormat` (cached)
- Zero-allocation hot path for frequently accessed strings (lookup tables)

### i18n rules

- No hardcoded user-facing strings in source code
- All translations keyed by stable identifiers
- New features must include translations for all supported languages

## State Migration and Versioning

### Schema evolution strategy

- Maintain an `APP_VERSION` constant (integer, bumped on schema changes)
- Write forward-compatible migration functions: `migrateV1toV2(state)`, etc.
- Run migrations sequentially on load: detect stored version → apply chain
- Never delete fields in storage — mark deprecated, keep reading old shapes

### Migration rules

- Every schema change requires an ADR
- Migration functions must be unit tested with fixtures from each version
- Rollback strategy documented for each migration
- Storage format must support unknown fields (forward compatibility)

## CI Quality Gates (Required)

Every PR must pass:

- lint (ESLint + custom rules for dangerous patterns)
- typecheck (app + test, separate `tsc --noEmit` runs)
- unit and integration tests
- critical scenario tests
- security guardrails (HTML sink detection + dead-file detection via scripts)
- file-size guardrail (default 400 lines with explicit temporary exceptions)
- bundle/performance budget checks
- dead code detection (guardrail script blocks unused exports)

## Observability and Diagnostics

### Baseline telemetry

- error count by module
- sync failures by reason
- retry/quarantine counters
- key UX timings (startup, first interaction, modal open)

### Logging policy

- structured logs with event codes
- no PII in logs
- correlation id for sync flows

## ADR Discipline

Create ADRs for any high-impact decision.

Minimum ADR fields:

- context
- decision
- alternatives
- consequences
- rollback strategy

Trigger ADR when changing:

- data model
- sync/merge algorithm
- security posture
- architecture boundary

## Delivery Plan (Phase-by-Phase)

### Phase 0: Foundation

- module skeleton with boundary rules enforced
- contracts and schemas (worker, API, events)
- tsconfig separation (app, test, tools)
- CI gates and guardrails (lint, typecheck, security scripts)
- baseline telemetry stubs
- event hub (`events.ts`) and listener bootstrapper (`listeners.ts`)
- keyboard normalization utility
- test infrastructure (test-utils, vitest config, global mocks)
- i18n loader with fallback chain

### Phase 1: Local Core

- habit CRUD with typed domain model
- schedule model (frequency, time-of-day, start/end dates)
- daily check-ins with state transitions
- IndexedDB persistence with debounced saves
- migration framework (version tracking + migration chain)
- unit tests for core domain invariants

### Phase 2: UX Core

- calendar strip and grouping by time-of-day
- modal system with focus trapping and escape handling
- keyboard-only navigation for all interactive controls
- accessibility scenario tests (screen reader, keyboard-only)
- PWA setup (manifest, service worker, offline shell)
- error handling and user feedback patterns

### Phase 3: Sync

- encrypted sync queue (AES-256-GCM in worker)
- worker contracts with versioned message shapes
- merge/conflict engine with deterministic resolution
- hash-based change detection (skip unchanged uploads)
- network resilience (online/offline, 409 handling, retry)
- integration and resilience tests

### Phase 4: AI Layer (optional)

- strict prompt input policy (size limit, sanitization)
- rate limiting + circuit breaker (daily quota + cooldown)
- safe fallback when offline or quota-limited
- no leakage of private data beyond approved scope
- cache layer for repeated prompts (hash key, TTL)

### Phase 5: Hardening

- performance tuning against defined budgets
- memory leak hunting (scenario tests with GC checks)
- error budget and SLO checks
- security review and threat model update
- dead code elimination and bundle optimization

## Agent Execution Rules

Coding agents should follow this order:

1. Read this blueprint fully.
2. Read `contracts/*` and invariants before coding.
3. Prefer smallest safe change.
4. Add or update tests with each behavior change.
5. Do not bypass guardrails for speed.
6. If boundary is unclear, create ADR before implementation.

## Definition of Done

A change is done only if:

- behavior is implemented
- contracts are updated
- tests are added/updated
- docs are updated when architecture/operations change
- CI gates pass without exceptions

## Bootstrap Checklist

- [ ] Module boundaries created
- [ ] Contracts versioned
- [ ] tsconfig split configured
- [ ] Guardrails configured
- [ ] CI quality gates active
- [ ] Telemetry baseline implemented
- [ ] ADR log seeded with baseline decisions
- [ ] Runbook seeded with top 5 incidents
- [ ] Security and accessibility blockers encoded in tests

## What This Prevents

- monolithic files with mixed responsibilities
- unsafe DOM regressions
- silent sync/worker contract breakage
- noisy editor context from mixed TS scopes
- repeated architecture debates without recorded decisions
- late discovery of accessibility and performance regressions
- cross-browser keyboard bugs from raw `e.key` comparisons
- i18n retrofit costs from hardcoded strings
- memory leaks from missing cache eviction and listener cleanup
- silent failures from missing error handling patterns
- migration disasters from unversioned state schemas
- fragile tests from missing centralized test helpers
- network edge-case crashes from missing resilience patterns
- build confusion from undocumented entry points and env vars

