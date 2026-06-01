# MLS Trace Event Schema Parity Test — Acceptance Criteria

## Terminology

- **Source TraceEvent** — the TraceEvent union defined in `src/marmot/mls-trace.ts` (imported as `SourceTraceEvent`).
- **Fixture TraceEvent** — the TraceEvent union duplicated in `e2e/fixtures/mls-trace-classify.ts` (imported as `FixtureTraceEvent`).
- **Parity assertion** — TypeScript structural type assignment of the form `const v: FixtureTraceEvent = { ...source-typed-values }`.

## Known TAGs

- **STRUCT** — structural assertions about files, schemas, types.
- **DEP** — dependency or integration assertions.

## Schema Parity (S1)

**AC-STRUCT-1** — `src/marmot/mls-trace.test.ts` MUST exist and MUST contain at least one TypeScript statement that assigns a value typed as `SourceTraceEvent` to a variable typed as `FixtureTraceEvent`, such that any divergence in variant names, variant count, or field types between the two unions produces a TypeScript compile error.

**AC-STRUCT-2** — The parity assertion in `src/marmot/mls-trace.test.ts` MUST cover all 20 TraceEvent variants present in `src/marmot/mls-trace.ts` (`req-start`, `req-event`, `req-eose`, `req-close`, `sub-start`, `sub-event`, `sub-close`, `ingest-call`, `ingest-result`, `queue-enqueue`, `queue-remove`, `queue-drain`, `epoch-change`, `publish-task`, `task-store-load-start`, `task-store-load-complete`, `task-store-recv`, `task-store-accepted`, `task-store-rejected`, `task-store-error`).

**AC-DEP-1** — `vitest src/marmot/mls-trace.test.ts` MUST exit zero.

**AC-DEP-2** — `npx tsc --noEmit` MUST exit zero and MUST NOT report errors in `src/marmot/mls-trace.test.ts`.

## Cross-Cutting Invariants

None.

## Manual Validation

None required — all assertions are compile-time or unit-test runnable.