# MLS Trace Event Schema Parity Test

## Problem

The TraceEvent union is the single source of truth for the MLS receive-pipeline diagnostic harness (epic-mls-live-delivery-race). The S3 classifier reads structured trace events to distinguish F1/F2/F3 failure classes — if a variant field type drifts silently, the classifier misclassifies or ignores events.

Source: BACKLOG.json finding `mls-trace-event-schema-parity-test` promoted 2026-06-01.

*Success signal: tsc --noEmit passes and vitest src/marmot/mls-trace.test.ts exits zero — divergence in variant names or field types between the two TraceEvent unions is a compile-time failure.*

## Solution

Add a vitest unit test in `src/marmot/mls-trace.test.ts` that enforces parity between the two TraceEvent union definitions using TypeScript's structural type system. The test lives in `src/marmot/` so it runs in the vitest CI shard alongside other unit tests without requiring the e2e build context. The test is schema-only: it validates type shape, not runtime behavior.

## Scope

### In Scope

- Write `src/marmot/mls-trace.test.ts` with TypeScript structural-typing assertions covering all 20 TraceEvent variants.
- Verify the test passes (`vitest src/marmot/mls-trace.test.ts`) and that `tsc --noEmit` is clean.

### Out of Scope

- Runtime behavior tests for the trace recorder.
- Changes to `src/marmot/mls-trace.ts` or `e2e/fixtures/mls-trace-classify.ts`.
- E2E coverage.

## Design Decisions

1. **Type-system as assertion mechanism** — TypeScript's strict union assignment check (`fixtureVar: FixtureTraceEvent = sourceVar`) fails at compile time if any field type differs between the two unions. No custom assertion library needed.
2. **All 20 variants covered** — Each variant is represented by one representative event construction. The union exhaustiveness is guaranteed by TypeScript.
3. **Placed in `src/marmot/` not `e2e/`** — Runs in the vitest CI shard without requiring the e2e build context.

## Technical Approach

### `src/marmot/mls-trace.test.ts` (new file)

Import both TraceEvent types:
```ts
import type { TraceEvent as SourceTraceEvent } from "./mls-trace";
import type { TraceEvent as FixtureTraceEvent } from "e2e/fixtures/mls-trace-classify";
```

Assert parity for every variant by constructing one representative event from the source type and assigning it to the fixture type variable. Any drift in field names or field types causes a compile error.

Example pattern:
```ts
const reqStart: FixtureTraceEvent = { kind: "req-start", t: 0, relay: "", filter: {}, reqId: "" };
// If source's filter is Filter and fixture's is unknown → ok
// If source's filter type and fixture's diverge → TS error
```

## Stories

- **S1 — Schema parity regression test** — Add mls-trace.test.ts. Covers AC-STRUCT-1.

## Acceptance Criteria

See [`acceptance-criteria.md`](./acceptance-criteria.md).

## Relationship to Other Epics

- **epic-mls-live-delivery-race** — This epic depends on the TraceEvent union being stable across the source/fixture boundary; this test is a regression guard for that dependency.

## Non-Goals

- No changes to the trace recorder's runtime behavior.
- No changes to the e2e harness or any Playwright tests.