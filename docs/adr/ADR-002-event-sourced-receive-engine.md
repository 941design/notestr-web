# ADR-002: Event-Sourced Receive Engine and Deterministic Projection Architecture — Architecture Decision

**Status**: Accepted — five product-behavior risks resolved 2026-06-29 (see Decisions Resolved)
**Date**: 2026-06-29
**Epic**: specs/epic-event-sourced-receive-engine/

---

## Context

This epic replaces the current listener-driven receive path with a library-like, event-sourced receive engine that owns ingest correctness, recovery, and deterministic projection. The problem is not the absence of building blocks — `ingestLock`, `PendingRetryQueue`, retry-on-epoch, and a pure task reducer already exist — but that they are scattered across three files with no single typed owner or explicit state machine lifecycle.

**Codebase constraints from exploration.json that shaped the decision:**

1. **Two uncoordinated applicationMessage listeners** (`device-sync.ts:874-892` for persistence, `task-store.tsx:181-255` for React state): both fire for every incoming message, each calls `deserializeApplicationData` independently, with no sequencing guarantee. The persistence listener survives unmount; the React listener is lost on unmount.

2. **Non-idempotent appendEvent** (`persistence.ts:29-36`): naive read-modify-write with no idempotency key. Duplicate deliveries inflate the log silently; reducer idempotence masks the result but does not prevent log growth. Not type-enforced.

3. **kind-30078 bootstrap side-channel** (`device-sync.ts:1324-1586`): `fetchAndApplyTaskBootstrap` decrypts via NIP-44 (not `group.ingest`), produces synthetic `task.created` events, and runs a separate CRDT merge gate at `device-sync.ts:1433-1452` that duplicates the `applyEvent` tie-break from `task-reducer.ts:18-32`. Canonical truth includes this side-channel; the architecture must account for it.

4. **marmot-ts owns MLS state mutation with no snapshot-at-epoch or catch-up API**: `group.ingest()` destructively consumes ratchet keys; once consumed, a second pass yields `skipped` with no `applicationMessage`. Historical vs live is entirely consumer-managed. There is no past-epoch retrieval API; only the current `SerializedClientState` is persisted.

5. **ADR-001 three-level ordering** (`docs/adr/ADR-001`): `updatedAt` (seconds) primary → `updatedBy` (pubkey lower-wins) → `updatedByDevice` (MLS clientId lower-wins). Sender-side monotonic bump already in place in `task-store.tsx:dispatch`. The projector must not touch the clock.

6. **Single-writer LWW constraint** (`multi-client.property.test.ts`): convergence holds only under one writer per field. Genuine concurrent multi-writer edits are out of scope without a separate consensus mechanism.

7. **ingestLock closure-private** (`device-sync.ts:651` inside `useEffect:506`): a new engine instance carries its own lock; two lock instances do not serialize against each other. This made the originally proposed shadow parallel-ingest structurally impossible.

---

## Decision

### Paradigm

**Functional core + imperative shell, three nested shells.** CQRS label dropped — it added no testable constraint beyond "one owner of ingest" and imported write/read-model vocabulary not present in this codebase.

- **Inner core (pure, no I/O):** `src/domain/` — task reducer, projector, domain event types, shared CRDT tie-break. `task-reducer.ts:5-105` is already compliant and fully reusable.
- **Middle shell (imperative, no React):** `src/engine/` — per-group receive state machine with explicit `start()`/`stop()`/`reset()` lifecycle. This is **new construction**, not lift-and-shift; the behavior is understood from `device-sync.ts:643-817` but the closure variables must be reconstituted as a class.
- **Outer shell (React adapter):** `src/integration/` — hooks and providers that subscribe to engine output and push projected state into React.

Hexagonal/ports-and-adapters rejected with corrected reasoning: the marmot-ts ratchet **is** the domain model. A hexagonal MLS-ingest port would be a single-implementor interface reproducing all marmot concepts. `marmot-adapter.ts` already serves the adapter role; boundary rules keep marmot coupling contained.

### Module Map

**`src/engine/receive-engine.ts`** — NEW imperative class. Absorbs `ingestGroupEventsRaw`/`ingestLock`/`syncedEventIds` (`device-sync.ts:677-817`), `syncGroup` cutover (`895-1010`), deferred parking (`668-751`), `attachRetryOnEpochAdvance` (`819-870`). Explicitly owns lifecycle states: `uninitialized` / `joining` / `recovering` / `catching_up` / `buffering_live` / `live` / `degraded` (orthogonal health dimension) / `retrying_deferred` / `stopped`.

**`src/engine/engine-types.ts`** — NEW. All cross-module type definitions. **IDB key schema is specified here** (Rule 9): `notestr:raw-facts:${groupId}`, `notestr:accepted-events:${groupId}`, `notestr:engine-checkpoints:${groupId}`, `notestr:deferred-ids:${groupId}`. Legacy `notestr:events:${groupId}` kept read-only until Phase 8.

**`src/engine/ingest-policy.ts`** — NEW thin wrapper. Absorbs `createPendingRetryQueue` (`ingest-queue.ts:84-149`) and `selectAndIncrementRetries` policy.

**`src/domain/domain-events.ts`** — NEW. `AcceptedDomainEvent<T>` with `sourceKind` discriminator and dual idempotency-key derivation (MLS path: `rumor.id`; bootstrap path: `"bootstrap:${groupId}:${task.id}"`).

**`src/domain/task-projector.ts`** — NEW thin wrapper. **Incremental projection**: `applyEvent(currentProjection, event.payload)` per `domain_event_accepted`. Full `buildProjection` only on restart or explicit `projection_invalidated`. `projection_invalidated` is NOT emitted on ratchet-advance `stateChanged` (performance invariant).

**`src/domain/task-crdt.ts`** — NEW. Shared `taskWinsOver(candidate, existing)` tie-break helper called by both `applyEvent` (`task-reducer.ts:18-32`) and the bootstrap merge gate (`device-sync.ts:1433-1452`). Eliminates the duplicate-projection drift risk identified in Round 1.

**`src/persistence/raw-event-log-store.ts`** — NEW. Idempotent raw-fact log over IDB. Replaces `appendEvent` (`persistence.ts:29-36`); adds lookup-before-insert on `fact.id`. Uses `createKVStore` (`storage.ts:100-133`).

**`src/persistence/checkpoint-store.ts`** — NEW. Durable engine checkpoint keyed by `groupId`. IDB key: `notestr:engine-checkpoints:${groupId}`.

**`src/persistence/deferred-store.ts`** — NEW. Durable deferred-queue metadata. Persists `nostrEventId` list across restarts. IDB key: `notestr:deferred-ids:${groupId}`.

**`src/integration/marmot-adapter.ts`** — NEW. Typed bridge to marmot-ts. Owns outbox bridge (`device-sync.ts:93-141`), bootstrap wrapping, and subscription registration. Engine holds at `joining` until bootstrap resolves before transitioning to `catching_up`.

**`src/integration/react-engine-hooks.ts`** — NEW. Subscribes to `EngineOutputEvent` stream. Incremental `applyEvent` per `domain_event_accepted`; not full rebuild on `stateChanged`. Exposes engine health to UI without making UI a correctness owner.

**`src/marmot/device-sync.ts`** — MODIFIED, eventually slimmed. No new correctness logic during migration (Rule 7).

**`src/store/task-store.tsx`** — MODIFIED. Second `applicationMessage` listener removed once `react-engine-hooks.ts` delivers projected state.

**`src/store/persistence.ts`** — DEPRECATED. Removed in Phase 8.

### Seam Contracts

**`RawProtocolFact`:**

```typescript
interface RawProtocolFact {
  id: string;               // nostrEvent.id — content-addressed; idempotency key
  groupId: string;          // group.idStr (MLS hex group ID)
  nostrEventId: string;     // same as id; explicit for query clarity
  nostrEvent: NostrEvent;   // full relay envelope
  receivedAt: number;       // client-side ms at ingest call (Date.now())
  receiptSource:
    | "historical"           // one-shot fetch via client.network.request
    | "live"                 // live subscription via client.network.subscription
    | "bootstrap-kind-30078";// NIP-44 side-channel from fetchAndApplyTaskBootstrap
  epochAtReceipt: string;   // DIAGNOSTIC ONLY — not a retrieval key for past MLS state
}
```

**`AcceptedDomainEvent`:**

```typescript
interface AcceptedDomainEvent<T = TaskEvent> {
  id: string;           // MLS path: rumor.id; bootstrap: "bootstrap:${groupId}:${task.id}"
  factId: string | null;// null for bootstrap-sourced (no RawProtocolFact backing it)
  sourceKind: "mls-rumor" | "bootstrap-kind-30078";
  groupId: string;
  acceptedAt: number;   // client ms at acceptance
  epoch: string;        // MLS epoch string at acceptance
  payload: T;           // normalized TaskEvent (unchanged wire type)
}
```

**`EngineCheckpoint`** (split markers — not conflated):

```typescript
interface EngineCheckpoint {
  groupId: string;
  savedAt: number;
  engineState: EngineLifecycleState;
  lastEpoch: string;
  lastIngestedFactId: string;       // all events through group.ingest (= syncedEventIds)
  lastAcceptedDomainEventId: string;// only those yielding applicationMessage
  deferredNostrEventIds: string[];  // PendingRetryQueue at checkpoint time
}
```

**`EngineOutputEvent`** (epoch/ratchet split):

```typescript
type EngineOutputEvent =
  | { type: "envelope_received";      factId: string; groupId: string }
  | { type: "envelope_deferred";      factId: string; groupId: string;
      reason: "unreadable" | "epoch_mismatch" | "parse_error" }
  | { type: "domain_event_accepted";  event: AcceptedDomainEvent }
  | { type: "domain_event_rejected";  factId: string; groupId: string; reason: string }
  | { type: "projection_invalidated"; groupId: string }
  | { type: "group_epoch_advanced";   groupId: string; newEpoch: string; prevEpoch: string }
  | { type: "group_ratchet_advanced"; groupId: string }
  | { type: "engine_state_changed";   groupId: string;
      state: EngineLifecycleState; health: "nominal" | "degraded" }
  | { type: "deferred_retry_started"; groupId: string; count: number }
  | { type: "recovered";              groupId: string }
```

`group_epoch_advanced` triggers deferred-retry (matches `device-sync.ts:825`). `group_ratchet_advanced` does not.

**`OutboxEntry`** (Phase 6 pre-condition, Rule 8):

`createdAt` is set once before first send, immutable across retries → stable `rumorId`. Required for Invariant 2 under retry (see `task-store.tsx:336-339`: retried send with new `created_at` → new event hash → two `applicationMessage` firings with different ids and same payload).

**`PersistenceAdapter` port:**

```typescript
interface PersistenceAdapter {
  appendFact(fact: RawProtocolFact): Promise<void>;              // idempotent on fact.id
  loadFacts(groupId: string): Promise<RawProtocolFact[]>;
  appendAcceptedEvent(event: AcceptedDomainEvent): Promise<void>;// idempotent on event.id
  loadAcceptedEvents(groupId: string): Promise<AcceptedDomainEvent[]>;
  saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void>;
  loadCheckpoint(groupId: string): Promise<EngineCheckpoint | null>;
  saveDeferredIds(groupId: string, ids: string[]): Promise<void>;
  loadDeferredIds(groupId: string): Promise<string[]>;
}
```

Implementation: `createKVStore` (`storage.ts:100-133`), per-pubkey IDB namespacing preserved.

### Boundary Rules

1. **Engine has no framework imports.** `src/engine/*` must not import `react`, `next`, `next/navigation`, or any file under `src/integration/`. Enforceable with CI import-graph lint rule.
2. **Domain is pure.** `src/domain/*` must not import `src/engine/`, `src/persistence/`, `src/integration/`, or the DOM. Zero framework imports.
3. **Persistence is an outbound port.** `src/persistence/*` may import `src/domain/` for types. Must not import `src/engine/` or `src/integration/`. Persistence never calls the engine.
4. **Integration owns all React coupling.** `src/integration/*` is the only layer permitted to call `useState`/`useEffect`/`useRef` or dispatch DOM events. DOM event bus couplings at `device-sync.ts:1055` and `task-store.tsx:371` must remain in or move to `src/integration/`.
5. **One engine owns all ingest decisions.** Bootstrap is the `joining` phase under engine authority; its output enters the same accepted-event log. `marmot-adapter.ts` calls `fetchAndApplyTaskBootstrap`; output is injected into the engine as `RawProtocolFact` with `receiptSource: "bootstrap-kind-30078"`.
6. **`ensureMonotonicTimestamp` stays on the publish path.** Must never enter the projector or domain reducer; projector must be reproducible from persisted inputs without current-clock access.
7. **No correctness logic added to `task-store.tsx` or `device-sync.ts` during migration.** Both files are scheduled for replacement.
8. **Outbox entries are immutable after creation.** `createdAt` must not be updated on retry; changing it changes the `rumorId`, breaking Invariant 2.
9. **IDB key schema is defined in `src/engine/engine-types.ts`.** All persistence implementations use these keys exclusively; no agent introduces a new IDB key without amending `engine-types.ts`.
10. **Adapter instance lifetime outlasts engine instance lifetime.** `marmot-adapter.ts` is torn down after `receive-engine.ts`. No enforcement mechanism is currently specified; see Accepted Risks.

### Migration Strategy (Strangler)

Phases 1–9 per spec.md. **Phase 3 redesigned** (Round 1 BC-1): the engine observes the same `applicationMessage` callbacks from the single shared `group.ingest()` chain and produces its own accepted-event log; verification compares projection outputs (`engine.buildProjection()` vs legacy `stateRef.current`). No second `group.ingest()` call. The engine's joining gate, live-cutover buffering, and deferred retry are inactive in Phase 3 (listener-only mode) — see Accepted Risks.

---

## Rationale

**Why this over alternatives:**

The functional core + imperative shell paradigm was chosen because the inner core (`task-reducer.ts`) is already proven, pure, and tested; the middle shell behavior (state machine) already exists in closure variables in `device-sync.ts:643-817` and needs to be reconstituted as an explicit class, not invented from scratch; and the outer shell (React adapter) is a natural extraction of what `TaskStoreProvider` and `useDeviceSync` already do.

**What was challenged in Round 1 and how it was resolved:**

- **CQRS decoration (R1-paradigm-1):** Dropped. The write/read split was never unified in this codebase; one ingest owner is basic layering, not a CQRS pattern.
- **Shadow-mode parallel-ingest impossible (R1-BC-1):** Accepted. `ingestLock` is closure-private (`device-sync.ts:651`); `group.ingest()` destructively consumes ratchet keys (`device-sync.ts:700`); second pass yields `skipped`/no-callback. Phase 3 redesigned as projection-output comparison.
- **Bootstrap idempotency key unspecified (R1-BC-2):** Resolved. Key = `"bootstrap:${groupId}:${task.id}"`, deterministic across re-runs, `sourceKind`-tagged, `groupId`-prefixed to prevent cross-group collision.
- **Epoch-keyed snapshot blocker (R1-BC-3):** Accepted. No snapshot-at-epoch API in marmot-ts. Invariant 3 formally weakened to same-epoch replay only. `epochAtReceipt` made diagnostic-only.
- **Missing quizzl/shophop docs (R1-BC-4):** Accepted. Files confirmed absent (`exploration.json` notable_flags). Cross-project justification removed; architecture stands on first-principles grounded in this codebase.
- **Duplicate projection — bootstrap merge gate (R1-BC-5):** Resolved. Bootstrap merge gate at `device-sync.ts:1433-1447` duplicated the `applyEvent` tie-break. Unified via shared `task-crdt.ts`.

**Five Round-2 blocking concerns were not resolved; they are accepted as known risks** (see Accepted Risks).

---

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Hexagonal / ports-and-adapters | The marmot-ts ratchet is the domain model; a hexagonal MLS-ingest port would be a single-implementor interface reproducing all marmot concepts with no substitutability gain. `marmot-adapter.ts` already serves the adapter role; boundary rules achieve containment. |
| Keep current listener-driven architecture | The two-listener race class (F3) is unfixable without a single ingest owner. `appendEvent` idempotency gap is type-unenforced. React lifecycle coupling makes recovery non-equivalent by design (P4 unachievable). |
| Full event-sourcing with epoch-keyed MLS snapshots now | No snapshot-at-epoch API exists in marmot-ts; requires an undesigned fork extension. marmot-ts is the source of truth for MLS state; this layer cannot substitute for it. Deferred to Evolution Trigger ET-7. |
| Shadow-mode parallel-ingest verification (original Phase 3) | Structurally impossible: `ingestLock` is closure-private; `group.ingest()` destructively consumes ratchet keys; concurrent calls race on marmot internal state; sequential calls yield `skipped`/no-callback. The comparison would produce only false divergences. |

---

## Consequences

### Positive

- Single explicit owner of ingest correctness across historical catch-up, live cutover, dedupe, deferred handling, retry, and restart recovery.
- Deterministic projection rebuildable from persisted inputs without listener timing dependence.
- Framework-agnostic middle shell: engine lifecycle is not tied to React mount/unmount.
- Incremental projection (`applyEvent` per event) matches the existing performance contract of `task-store.tsx:219`; no regression from full-rebuild on every `stateChanged`.
- IDB key schema locked in `engine-types.ts`: prevents divergence across independently-implemented story increments.
- Bootstrap merge gate unified with `applyEvent` via `task-crdt.ts`: eliminates dual-projection drift.

### Negative / Trade-offs

- **Middle shell is new construction.** `receive-engine.ts` is not a lift-and-shift; explicit `start()`/`stop()`/`reset()` lifecycle and a formal state machine must be built. Story estimation must not treat this as migration work.
- **Invariant 3 weakened.** Cross-epoch deferred events are irrecoverable on restart until the marmot fork acquires a snapshot-at-epoch API. Normal condition (any epoch-advancing commit while unreadable events are parked) produces this loss. Documented irrecoverable loss, not equivalent recovery.
- **Phase 3 validates projection only.** The novel middle shell (joining-gate, live-cutover buffering, deferred-retry) gets no shadow validation during Phase 3. Bugs in the state machine produce no signal until Phase 5 activates it.
- **Outbox / Phase 6 durability pre-condition.** Invariant 2 under retry requires `OutboxEntry.createdAt` immutability. This must land before Phase 6 stories; adding it after retries are implemented is a seam-level change.

### Accepted Risks

1. **Phase 3 false confidence:** The shadow comparison tests projection-layer accuracy only (engine state machine inactive in listener-only mode). The joining-gate, live-cutover, and deferred-retry behaviors — the novel parts — produce no signal in Phase 3. Passing Phase 3 is a false negative for state-machine correctness. Mitigation requires either redesigning Phase 3 to exercise the state machine, or mandating FSM unit tests before Phase 5 stories are dispatched. **Requires human decision before Phase 5.**

2. **spec.md:663 / Invariant 3 mismatch:** `spec.md:663` states the full unqualified Invariant 3. The proposal weakens it to same-epoch only. Stories written from `spec.md` will implement cross-epoch recovery that cannot be satisfied without a marmot fork extension. The weakening lives only in this proposal. **Requires human decision: either amend spec.md with the same-epoch carve-out (changing what the epic delivers), or design the epoch-keyed snapshot fork extension before Phase 2.**

3. **Bootstrap idempotency collision on re-join:** Key `"bootstrap:${groupId}:${task.id}"` collides across re-joins. Once `appendAcceptedEvent` idempotency lands, re-join bootstrap is permanently silenced for already-logged tasks; the engine falls back to relay kind-445 to reach updated state. If aged-off, the task is permanently stale at its prior state. No accepted-log reset policy on re-join is specified. **Requires human decision before Phase 2.**

4. **Engine<->adapter ingest seam unresolved:** `receive-engine.ts` absorbs code calling `group.ingest()` and `client.network.subscription()` directly (`device-sync.ts:700, 942`) while `marmot-adapter.ts` claims to contain all marmot coupling (ET-1). Both cannot simultaneously be true. The typed contract (who calls `group.ingest()`, who drives the subscription, what the engine receives — raw `NostrEvent[]`, `IngestResult` stream, or other) is unspecified. **Requires human decision before either module's stories are written.**

5. **Joining-gate relay-I/O dependency with no timeout:** The new `joining` gate blocks catch-up on a relay-I/O operation (bootstrap fetch, `device-sync.ts:1364`) with no timeout. Today, relay unavailability degrades gracefully (bootstrap fails non-fatally, catch-up proceeds via `device-sync.ts:602`). Under the new gate, a stalled bootstrap fetch blocks the group entirely at `joining` — no live, no catch-up, no projection. **Requires human decision: specify timeout semantics and failure-path transition (`joining → degraded` or `joining → catching_up` after timeout) before joining-phase story is implementable.**

---

## Decisions Resolved (2026-06-29)

The five risks above that required a human decision were adjudicated by the product owner on 2026-06-29. spec.md was amended to match; the architecture doc moved these from "Open Questions" to binding "Implementation Constraints." The decisions:

1. **Phase 3 scope → projection-only, with an FSM-unit-test entry gate to Phase 5.** Phase 3 is accepted as validating the projection layer only; it is not relied on for state-machine correctness. `receive-engine.ts` FSM unit tests are required before Phase 5 stories dispatch.

2. **Invariant 3 → narrowed to same-epoch replay.** Recovery equivalence is guaranteed from the current encryption epoch forward only. Events undecryptable across an epoch advance are recovered by relay re-sync, not local replay. The per-epoch key-snapshot fork extension (which would restore full cross-epoch recovery) was **rejected as out of scope** for this epic; it remains available as evolution trigger ET-7. spec.md amended at P4, Invariant 3, and Out of Scope.

3. **Re-join → reset the local accepted-event log.** On a new MLS Welcome (including the `forget-device` per-leaf rejoin), the engine clears the per-group accepted-event log and `bootstrap-completed` flag before replaying the fresh bootstrap snapshot, so the bootstrap idempotency key cannot strand a re-joining device on stale data. spec.md amended (Ordering and Identity). Engineering follow-up: re-join-vs-restart detection and reset sequencing, settled before Phase 2 `appendAcceptedEvent` idempotency lands.

4. **Joining-gate → timeout, then degrade forward.** The `joining` gate gets an explicit timeout; on timeout or bootstrap failure the engine moves forward into `catching_up`/`live` in `degraded` health rather than blocking the group, preserving today's graceful relay-down behavior. spec.md amended (Desired Engine State Machine). Engineering follow-up: timeout value and `joining → degraded` transition wiring.

5. **spec.md hygiene → broken links removed.** The dead links to `docs/quizzl-report.md` and `docs/shophop-report.md` were removed and the distilled lessons reframed to stand on their own.

**Still open (engineering-internal, no product-behavior implication):** the engine↔adapter ingest seam (Accepted Risk 4), the formal FSM transition table, the recovery-sequencing protocol, and the Rule-10 teardown-order enforcement. These are owned by the integration architect and resolved before the phases noted in the architecture doc — they do not require a product decision.

---

## Evolution Triggers

- **ET-1:** marmot ingest API shape change → only `marmot-adapter.ts` must change. (Trigger is conditional on resolution of Accepted Risk 4 — if engine calls `group.ingest()` directly, scope is larger.)
- **ET-2:** marmot acquires catch-up API → `syncGroup` cutover becomes delegation; engine-internal state-machine restructure required.
- **ET-3:** kind-30078 deprecation → `joining` phase + `marmot-adapter.ts` bootstrap wrapping must be revised.
- **ET-4:** multi-writer concurrency defeating LWW → conflict detection at `domain_event_accepted`; projector extended; seam contract changes; `task-crdt.ts` tie-break insufficient.
- **ET-5:** cross-group projections (global board, cross-group search) → new event-routing layer above per-group engine; no fanout/aggregator in the four module groups.
- **ET-6:** re-join after state reset (`forget-device` per-leaf flow) → accepted-log reset policy + `bootstrap-completed` IDB flag fate must be designed. Currently unmodeled; the `joining` gate is designed for first-join only.
- **ET-7:** marmot fork acquires snapshot-at-epoch API → Invariant 3 can be fully restored; `epochAtReceipt` becomes a retrieval key; Phase 7 gains full cross-epoch recovery.

---

## Debate Summary

- **Round 1 blocking concerns:** 5; resolved by revision: 5 (with noted residuals in seam contracts and assumptions)
  - BC-1: Shadow-mode impossible → Phase 3 redesigned as projection-output comparison
  - BC-2: Bootstrap idempotency key → derived as `"bootstrap:${groupId}:${task.id}"`; `sourceKind` tag added
  - BC-3: Epoch-keyed snapshot → Invariant 3 weakened to same-epoch; `epochAtReceipt` diagnostic-only
  - BC-4: Missing quizzl/shophop docs → cross-project justification removed; architecture regrounded
  - BC-5: Bootstrap merge gate = second projection → unified via `task-crdt.ts`

- **Round 2 residual/new blocking concerns:** 5; accepted as known risks pending human decision: 5
  - R2-1: Phase 3 validates projection only, not state machine — false confidence
  - R2-2: Invariant 3 weakening lives in proposal but not in spec.md:663 — spec/impl mismatch on day one
  - R2-3: Bootstrap idempotency key collides on re-join, silencing re-join bootstrap permanently
  - R2-4: Engine<->adapter ingest seam unspecified; ET-1 claim contradicted by absorbing group.ingest()
  - R2-5: Joining-gate turns graceful relay-down degradation into total group blockage — no timeout
