# Event-Sourced Receive Engine and Deterministic Projection Architecture

## Summary

This epic defines a large-scale refactor of the application's distributed-state architecture. The goal is to replace the current listener-driven receive path with a **library-like, event-sourced receive engine** that owns ingest correctness, recovery, and deterministic projection.

The target architecture is designed for systems built on relay-delivered events with eventual consistency, duplicate delivery, reordering, delayed decryptability, reconnect replay, and recovery-after-restart as normal operating conditions.

This is not a narrow fix for the current MLS live-delivery flake. It is an architectural response to the broader problem that the application's distributed-state invariants are currently split across the MLS receive layer, UI-side listeners, persistence helpers, and React lifecycle timing.

The resulting system should be suitable for extraction into a reusable library for other projects with similar constraints.

## Why This Epic Exists

The current application works, but the architecture shows clear signs of under-modeled distributed-state behavior:

- Receive correctness is split primarily between `src/marmot/device-sync.ts`, `src/store/task-store.tsx`, and persistence helpers.
- The UI can observe protocol timing directly through `applicationMessage` listeners.
- Recovery after restart is not guaranteed to be semantically equivalent to uninterrupted operation.
- Important distributed invariants are encoded as side effects, timing assumptions, and local conventions rather than one explicit state machine.
- Recent flaky live-delivery behavior exposed these seams, but the issue is broader than one race condition.

The architecture should instead assume:

- relay events may be duplicated
- relay events may arrive late
- relay events may be replayed after reconnect
- decryption/readability may lag behind receipt
- state must converge without manual reload
- projection must be deterministic
- restart recovery must be a first-class behavior

These are not edge cases. They are the normal shape of this system.

## Problem Statement

Today, the application has no single typed owner for the full path:

`relay event -> transport receipt -> MLS ingest -> domain normalization -> persistence -> projection -> UI-visible state`

Instead, the current path is split like this:

- `src/marmot/device-sync.ts` owns catch-up, live ingest orchestration, unreadable parking, retry-on-epoch, and one `applicationMessage` listener used for persistence.
- `src/store/task-store.tsx` owns a second `applicationMessage` listener used for React state updates.
- `src/store/persistence.ts` is the durability helper behind reload recovery, but its `appendEvent()` path is a naive read-modify-write helper with no idempotency primitive.
- `src/marmot/network.ts` is a transport seam, not the ownership problem itself. It matters because its request/subscription behavior shapes the receive engine, but it is not where group-level correctness currently lives.

This architecture has three core weaknesses:

### 1. The state machine is only partially explicit

The codebase already has useful building blocks:

- a per-group `ingestLock`
- a deferred queue in `src/marmot/ingest-queue.ts`
- retry-on-epoch behavior in `device-sync.ts`
- a pure task reducer with replay support

The problem is not the total absence of state-machine building blocks. The problem is that they are not gathered under one explicit receive owner with one typed lifecycle model. Lifecycle phases such as catching up, buffering, live-ready, degraded, retrying unreadable events, and recovering after restart are still expressed indirectly across refs, listeners, queues, and effect timing.

### 2. Projection correctness depends on listener timing

The UI currently participates directly in the protocol receive path. This creates race conditions where application visibility depends on whether a listener was attached, whether a persistence write settled first, or whether a React effect ran before a message was emitted.

### 3. Recovery is architectural, not incidental, but is not modeled as such

The application relies on replay and persistence to recover distributed state, but the persistence model is not structured around one explicit durable record plus one deterministic projector. This makes correctness harder to reason about and complicates extraction into a reusable core.

## Architectural Direction

The target architecture is:

- **event-sourced**
- **eventually consistent**
- **deterministic in projection**
- **library-like at the core**
- **framework-agnostic below the app adapter layer**

At the center is a **per-group receive engine** that owns distributed-state ingest behavior for a group from transport receipt to durable domain-event acceptance.

The UI should consume **projected application state**, not raw MLS timing.

## Design Principles

### P1 — One owner of ingest correctness

Exactly one subsystem should own:

- historical catch-up
- live subscription cutover
- dedupe
- ordering policy
- unreadable/deferred handling
- retry policy
- restart recovery behavior

No React component, store, or feature-level listener should bypass that owner for correctness-critical state transitions.

### P2 — Canonical durable truth is raw protocol facts plus persisted MLS state

The canonical durable truth cannot be raw kind-445 events alone. Interpretation of those events depends on persisted MLS/client/group state.

The canonical durable record should therefore be:

- the raw received protocol/event stream relevant to group and application state
- the persisted MLS/client/group state required to interpret that stream
- the engine metadata required to replay interpretation coherently

Accepted domain events, projections, and materialized stores are **derived artifacts**. They are not the primary durable truth.

This preserves:

- replayability
- reproducibility
- reinterpretation under newer engine logic
- auditability
- cleaner separation between received facts and computed meaning

The system should still ensure that application state is driven by interpreted domain events rather than raw callback timing, but the durable source of truth should remain the raw input stream plus persisted MLS state plus engine metadata.

### P3 — Domain events, not transport timing, drive state

Transport envelopes and MLS `applicationMessage` callbacks are input signals. They are not application state.

The system should normalize accepted protocol payloads into domain events and use those domain events as the replayable basis for projection.

### P4 — Recovery must be equivalent by design, within the current encryption epoch

If the app is restarted mid-flight, recovery should converge to the same projected state as uninterrupted execution, subject only to accepted eventual-consistency semantics **and to the availability of decryption state**.

**Decision (ADR-002, 2026-06-29):** The encryption library (the marmot-ts fork) persists only the *current* group key state, not a per-epoch history. An event that arrived under an earlier epoch and was still undecrypted when the group's epoch advanced cannot be re-read after a restart — its decryption key is gone. Recovery equivalence is therefore guaranteed **from the current epoch forward only**. A device that was holding an undecryptable event across an epoch change and then restarted re-acquires that event's content by re-syncing from the relay, not from the local raw log. Full cross-epoch recovery would require a per-epoch key-snapshot API that does not exist in the fork and is explicitly out of scope for this epic (see Out of Scope and Invariant 3).

### P5 — Duplicate delivery and replay are normal

At-least-once delivery behavior must be accepted and absorbed through stable identity, dedupe, idempotent projection, and deterministic replay.

### P6 — Framework code must be outside the core

The receive state machine, event log, and projector model should not depend on React, Next.js, or browser component lifecycle.

### P7 — Decryptability lag is a first-class state

Unreadable or not-yet-decryptable events are not exceptional failures. They are part of normal engine behavior and should be modeled explicitly.

### P8 — Publish and receive are one consistency story

The architecture must model not only "what we received" but also "what we emitted locally and have not yet reconciled against durable receive truth."

Optimistic local publish, outbox state, own-echo reconciliation, and delivery failure handling are part of the same state machine boundary.

## Lessons From Related Projects

Two related projects (Quizzl and Shophop) were reviewed as architectural references during early design. Their review reports are **not checked into this repo** — the patterns distilled below stand on their own and the architecture does not depend on those source documents. (The prior links to `docs/quizzl-report.md` and `docs/shophop-report.md` were removed because those files do not exist here.)

The main lessons are:

### Quizzl

Useful pattern:

- explicit ingest/epoch-resolution owner (`EpochResolver`)
- future-epoch buffering
- replay/rollback discipline

Weakness to avoid:

- domain ingest, persistence, and projection spread across React contexts and version-bump refresh patterns

### Shophop

Useful pattern:

- pure domain reducer
- replayable local action history
- explicit offline outbox

Weakness to avoid:

- receive correctness split across hooks, stores, and transport callbacks
- no strong single owner of end-to-end ingest semantics

### Synthesis

The target architecture for this project should combine:

- Quizzl's ingest-state discipline
- Shophop's deterministic reducer/projection approach
- a stricter separation between receive engine, persistent event log, projection, and UI adapter

## Current Shortcomings in This Project

This section describes the shortcomings the new architecture is intended to replace.

### A. Receive logic is scattered between protocol-side and UI-side listeners

The concrete split today is:

- `src/marmot/device-sync.ts`
- `src/store/task-store.tsx`
- `src/store/persistence.ts`

`device-sync.ts` attaches one `applicationMessage` listener for persistence-side behavior. `task-store.tsx` attaches a second `applicationMessage` listener for UI state. These two listeners participate in the same user-visible state transition, but there is no single typed owner of that transition.

### B. UI state can depend on protocol timing

`TaskStoreProvider` updates React state directly from `applicationMessage`. This means UI visibility can depend on:

- listener attachment timing
- mount order
- async persistence race ordering
- effect timing

That is too low-level a dependency for application correctness.

### C. Multiple state roles are blurred together

The current system does not clearly separate:

- transport envelopes
- MLS-accepted payloads
- normalized domain events
- projected task state
- volatile UI state

This makes both reasoning and refactoring harder.

### D. Persistence primitives are not safe enough for the intended consistency model

`src/store/persistence.ts` is intentionally small, but the current `appendEvent()` contract is not strong enough for a duplicated/replayed receive path. It is a read-modify-write helper with no idempotency key and no append-level dedupe semantics.

That means persistence itself is not aligned with the architecture's stated assumptions about duplicate delivery and replay.

### E. Recovery is partially durable and partially in-memory

Some necessary receive behavior is represented only in memory or in callback sequencing, which means restart recovery is not as principled as it should be.

### F. The architecture is app-bound rather than library-like

Core distributed-state behavior is entangled with React providers and app-specific side effects. That prevents extraction and makes the design harder to reuse across similar projects.

## Target Architecture

The target architecture has four layers.

### 1. Receive Engine

Per-group engine responsible for:

- transport event intake
- historical catch-up
- live buffering and cutover
- dedupe
- unreadable/deferred event parking
- retry triggers
- replay sequencing
- acceptance/rejection/defer decisions
- receive-state persistence checkpoints

The engine emits exactly these ten typed `EngineOutputEvent` variants (amended
2026-07-12, Stage-2 cold review — P3-12; see `architecture.md` "Seam Contracts
› EngineOutputEvent" for the authoritative field-level definition):

- `envelope_received`
- `envelope_deferred`
- `domain_event_accepted`
- `domain_event_rejected`
- `projection_invalidated`
- `group_epoch_advanced`
- `group_ratchet_advanced`
- `engine_state_changed` — carries `{ state, health }`; `degraded` is a
  **health dimension** on this event, not a separate event of its own
- `deferred_retry_started`
- `recovered`

This layer is framework-agnostic.

### 2. Canonical Record Store

Durable storage for:

- raw received protocol envelopes relevant to group/application state
- persisted MLS/client/group state required to interpret those envelopes
- idempotency keys / dedupe records
- engine checkpoints
- deferred/unreadable queue metadata
- retry bookkeeping
- recovery markers

This layer is the **canonical durable fact store** for receive behavior.

It should not be a byte-for-byte mirror of every incidental transport detail. It should persist the raw facts necessary for:

- deterministic re-interpretation
- replay
- diagnosis
- recovery
- migration to newer interpretation logic

This layer persists enough information to make restart recovery meaningful and explicit.

### 3. Interpretation and Projection Layer

This layer interprets raw persisted envelopes into accepted domain events and then reduces those domain events into application-visible projections.

The interpretation stage should be explicit and replayable.

Pure deterministic reducers that build application-visible state from accepted domain events.

For this application, the initial primary projection is the task-state projection for each group.

Projection properties:

- deterministic
- replayable
- idempotent
- rebuildable from persisted inputs

### 4. Publish / Outbox and Reconciliation Layer

This layer owns the local-to-remote side of consistency:

- optimistic local publish intent
- outbox durability
- send attempt bookkeeping
- reconciliation of locally-sent actions against durable receive truth
- own-echo / self-observation semantics

The current `task-store.tsx:dispatch` path mixes optimistic apply, persistence, and send. In the target architecture, those concerns should be owned by one explicit publish/reconciliation subsystem rather than being implicit inside a UI store.

### 5. App Adapter Layer

Framework integration:

- React hooks
- selectors
- subscriptions to projection updates
- UI lifecycle and rendering concerns

This layer should consume projections and engine status, not raw MLS `applicationMessage` timing.

## Core Concepts

### Transport Envelope

The raw relay-delivered event and any immediately associated receipt metadata.

This is one component of the canonical durable record.

### Raw Protocol Fact

A persisted received envelope plus the receipt/engine metadata needed to replay and reinterpret it later.

This is the canonical durable record.

Examples:

- a received kind-445 event
- associated group id / relay scope / receipt timestamp
- linkage to the persisted MLS/client/group state needed for interpretation
- minimal engine metadata needed to replay the same ingest decision space

### Accepted Domain Event

A normalized application event that has:

- been successfully ingested through the receive engine
- passed readability/decryptability constraints
- been mapped into application semantics
- been assigned a stable identity

This is a **derived fact**, not the primary durable source of truth.

Example:

- `task.created`
- `task.status_changed`
- `task.assigned`
- `task.deleted`

### Deferred Event

A received event that is not yet acceptable for projection because it is unreadable, blocked on missing state, or otherwise pending future recovery conditions.

### Projection

A deterministic materialized state derived from accepted domain events.

### Engine Checkpoint

Durable metadata that allows the receive engine to resume coherently after restart.

### Publish Intent / Outbox Entry

A durable record of a locally-authored domain action that has been accepted locally for eventual send but has not yet been fully reconciled against durable receive truth.

## Desired Engine State Machine

The engine should expose explicit lifecycle states. Exact names may change during implementation, but the model should include at least these concepts:

- `uninitialized`
- `joining`
- `recovering`
- `catching_up`
- `buffering_live`
- `live`
- `degraded`
- `retrying_deferred`
- `stopped`

`degraded` should be modeled as an orthogonal health/status dimension, not as a normal linear lifecycle peer of `catching_up` or `live`. A group can be `live+degraded` or `buffering_live+degraded`. The implementation may encode this as a tagged status rather than a flat enum.

These are engine states, not UI states.

Transitions should be explicit and observable.

The catch-up to live cutover protocol must be explicit. The engine should define, per group:

- when live subscription opens relative to historical fetch
- whether live events buffer during historical catch-up
- whether buffered live events are speculatively interpreted or held
- the precise condition under which the group becomes `live`

Examples:

- `recovering -> catching_up`
- `catching_up -> buffering_live`
- `buffering_live -> live`
- `live -> retrying_deferred`
- `catching_up + degraded`
- `live + degraded`

The point is not the exact enum. The point is to stop encoding operational phases indirectly in callbacks and refs.

**Decision (ADR-002, 2026-06-29) — the joining gate must not block the group on relay I/O.** The `joining` phase waits for the join-time bootstrap/catch-up to resolve before the group goes `live`. That wait depends on relay I/O and must therefore have an explicit timeout and a failure-path transition. On timeout (or bootstrap failure), the engine must transition forward into `catching_up`/`live` in a `degraded` state rather than remaining in `joining` indefinitely. This preserves today's behavior: when the relay is slow or unavailable the user keeps working locally and sync catches up later — the group is never frozen. The timeout value and the `joining -> degraded` failure transition must be specified before the joining-phase story is implementable.

## Consistency Contract

The target consistency model is **eventual consistency with deterministic interpretation and projection**.

That means:

- valid events may appear in the UI later than when they were first received
- duplicate delivery must not change final projected state
- replay after reconnect must converge to the same projection as uninterrupted operation
- temporary unreadability must not require manual reload for recovery
- the final projected state must depend on accepted domain events and deterministic reduction, not on listener timing

This architecture does **not** promise strong real-time consistency.

## Persistence Model

The refactor should explicitly separate persisted concerns.

### Persisted

- raw protocol/event log
- persisted MLS/client/group state needed for interpretation
- projection snapshots or checkpoints where justified
- receive-engine checkpoints
- deferred/unreadable metadata
- retry/outbox metadata

### Optional Persisted

- accepted domain-event indexes or caches
- compact snapshots for fast replay
- additional diagnostic envelope metadata

### Not Source Of Truth

- volatile UI state
- React component-local state
- listener attachment status
- render-time derivations
- interpreted/materialized state that can be rebuilt from the canonical record

## Publish / Outbox Model

The engine boundary must include local publish semantics.

Requirements:

- optimistic local authoring must be represented explicitly as publish intent
- outbox durability must survive restart
- send attempts and failures must be observable
- own-echo/self-observation semantics must be defined explicitly
- reconciliation between local optimistic state and durable receive truth must be deterministic

The architecture should avoid a model where UI code "optimistically applies and hopes the receive side catches up later" without one typed reconciliation path.

## Ordering and Identity

The system must treat ordering and identity as first-class design concerns.

Requirements:

- every accepted domain event must have a stable idempotency key
- dedupe must not depend on React/store timing
- when timestamps are used, they must not be the sole correctness boundary
- if total ordering is needed within a scope, the tie-break strategy must be explicit

The design should not rely solely on second-resolution `created_at` values to define correctness.

### Re-join must reset the local accepted-event log

**Decision (ADR-002, 2026-06-29):** Idempotency by stable event id is correct for *live* duplicate delivery, but it must not silence the join-time bootstrap snapshot on a re-join. When a device re-joins a group (a new MLS Welcome — for example after "forget device" and rejoin), the engine must treat its local accepted-event log and the `bootstrap-completed` marker as **stale and reset them**, so the fresh bootstrap snapshot is applied rather than skipped as "already seen."

Requirement: re-join clears the per-group accepted-event log (and bootstrap marker) before the joining phase replays the new snapshot. Without this reset, a re-joining device whose in-between history has been pruned from the relay would be permanently stranded on an outdated projection with no error surfaced. The reset policy and its interaction with the `bootstrap-completed` marker must be defined before the persistence adapter's append-with-idempotency contract is finalized (Phase 2).

## Projection Model

Task state should become a deterministic projection over interpreted accepted domain events derived from the raw persisted log.

This implies:

- no direct UI correctness dependency on `group.on("applicationMessage")`
- no primary correctness dependency on timing of `appendEvent()`
- replaying accepted task events should reconstruct the task state
- projection invalidation and rebuild rules should be explicit

The projector should be pure or as close to pure as practical.

## Library Character

The core of this architecture should be designed so that extraction remains possible, but extraction is not itself the primary deliverable of this epic.

The reusable core should own:

- receive engine
- state machine
- raw event log contracts
- event normalization contracts
- projection interfaces
- persistence adapter interfaces

The app-specific shell should own:

- task-specific domain schema
- UI selectors
- React integration
- visual degraded/recovery states

This separation is an architectural quality goal. It should not force abstractions that materially slow delivery for hypothetical consumers that do not yet exist.

## Proposed Package / Module Boundaries

Illustrative only; final naming can change.

```text
src/engine/
  receive-engine.ts
  engine-types.ts
  engine-state.ts
  engine-checkpoint.ts
  ingest-policy.ts

src/domain/
  domain-events.ts
  task-projector.ts
  task-projection-types.ts

src/persistence/
  raw-event-log-store.ts
  interpreted-event-index.ts
  checkpoint-store.ts
  deferred-store.ts

src/integration/
  marmot-adapter.ts
  react-engine-hooks.ts
```

The architectural requirement is separation of roles, not these exact paths.

## Migration Strategy

This refactor is large and should be staged.

### Phase 1 — Establish engine boundaries and invariants

- introduce engine interfaces and types
- isolate current receive behavior behind a new engine-facing abstraction
- stop adding new correctness logic directly to UI stores/providers
- codify invariants as tests before major behavioral movement

### Phase 2 — Define the canonical record and strangler boundary

- define the exact canonical record shape: raw envelopes + persisted MLS state references + engine metadata
- define replay and reinterpretation contracts
- define engine metadata/checkpoint persistence alongside the canonical record
- put the new engine behind a feature flag or strangler boundary

### Phase 3 — Introduce parallel-run and diff-checking

**Scope (amended 2026-07-12, per ADR-002):** Phase 3 is **projection-layer validation only, in listener-observation mode**. The originally proposed shadow/parallel-ingest design was rejected as structurally impossible (`group.ingest()` destructively consumes ratchet keys; `ingestLock` is closure-private — see ADR-002 Alternatives Considered and architecture.md Constraint 6). Do not re-derive it.

- observe the legacy listeners' outputs and feed the same accepted events through the new projection path
- compare new projection outputs against the legacy path
- add structured diff-checking before cutover
- Phase 3 passing does NOT indicate state-machine correctness; FSM unit tests are a Phase 5 entry gate (architecture.md Constraint 6)

### Phase 4 — Move task projection behind the engine

- create accepted-domain-event model for task operations
- create deterministic task projector
- route UI reads through projected state rather than raw live listener updates

### Phase 5 — Move receive logic into the engine

- historical catch-up
- live cutover
- dedupe
- deferred handling
- retry policy

### Phase 6 — Introduce publish/outbox ownership

- move optimistic local publish and reconciliation behind the engine boundary
- define durable outbox and own-echo semantics
- stop treating publish as a UI-store side effect

### Phase 7 — Persist recovery metadata explicitly

- engine checkpoints
- deferred state
- projection rebuild inputs

### Phase 8 — Remove old listener-driven correctness paths

- retire duplicated persistence/listener logic
- remove UI correctness dependency on `applicationMessage`
- simplify `TaskStoreProvider`

### Phase 9 — Harden boundaries and remove shadow-mode scaffolding

- remove app-framework coupling from the core where practical
- remove legacy/new dual-write paths
- document extraction seams

## Relationship to Current MLS Live-Delivery Work

This epic is related to, but broader than:

- [specs/epic-mls-live-delivery-race/spec.md](/Users/mrother/Projects/941design/notestr/notestr-web/specs/epic-mls-live-delivery-race/spec.md:1)

That epic addresses immediate F1/F2 delivery-path flaws and adds diagnostic clarity.

This epic addresses the architectural cause behind why such issues are difficult to reason about in the first place: the absence of a single explicit receive/projection engine.

The live-delivery race work may land first as a tactical stabilization. This epic is the strategic redesign.

## In Scope

- designing and implementing a per-group receive engine
- introducing a replayable raw-event log and deterministic interpretation layer
- introducing deterministic projection for task state
- separating engine/persistence/projection/app layers
- making recovery and degraded states explicit
- reducing or removing UI dependence on raw protocol callback timing
- moving optimistic local publish, outbox durability, and own-echo reconciliation behind the engine boundary (P8, Phase 6, Invariant 6)
- preserving future extractability where it does not distort near-term architecture

## Out of Scope

- replacing MLS or Marmot protocol primitives
- changing relay infrastructure as a substitute for architectural correctness
- solving every future application domain upfront beyond the abstractions needed for extension
- guaranteeing strict real-time consistency
- rewriting unrelated product areas that do not participate in this state path
- per-epoch decryption-key snapshots (cross-epoch recovery of events that were undecryptable across an epoch advance) — see P4 and Invariant 3
- concurrent multi-tab operation: the engine assumes a single active tab per group. Two tabs running engine instances against the same per-group IDB stores are not coordinated (no Web Locks / leader election). Revisit as an evolution trigger if multi-tab becomes a supported scenario.

## Correctness Invariants

The engine should be validated against explicit invariants, not only qualitative architectural goals.

Target invariants:

1. `projection(replay(X))` is deterministic for a fixed canonical record `X`.
2. `projection(replay(X))` is unchanged by duplicate delivery of already-accounted-for inputs.
3. `projection(recover(prefix(X)) + replay(suffix(X))) == projection(replay(X))` **for inputs decryptable under the current encryption epoch**. Inputs that were undecryptable across an epoch advance are recovered by relay re-sync, not by local replay, and are excluded from this equality (see P4). Full cross-epoch replay equality is out of scope for this epic; it requires a per-epoch key-snapshot API that does not exist in the marmot-ts fork.
4. For any accepted task-event log `L`, rebuilding projection from persisted inputs yields the same state as the in-memory projection.
5. Deferred/unreadable events that become readable after later valid state transitions converge without manual reload.
6. Optimistic local publish reconciles to the same durable projected state whether or not own-echo is observed before restart.

These should be expressed in tests using the same vocabulary as the repo's existing reducer/property-test culture.

## Success Criteria

This epic is successful when:

- the application's distributed-state flow is owned by one explicit receive engine per group
- task state is derived from deterministic projection over interpreted domain events from the raw log
- restart recovery converges without depending on raw UI listener timing
- the core engine is framework-agnostic
- new distributed-state features can attach to the same engine/projection model instead of inventing their own receive paths
- the resulting architecture is clear enough that future race-condition analysis can start from the engine state machine instead of reverse-engineering behavior from multiple layers
- the above correctness invariants are enforced in automated tests

## Open Design Questions

All five questions are **RESOLVED** (design phase completed 2026-06-29; markers added 2026-07-12):

1. ~~What exact raw-envelope shape should be persisted as the canonical fact record?~~ **RESOLVED** — `RawProtocolFact` seam contract (architecture.md "Seam Contracts": full field table, `id`-vs-`seq` invariants).
2. ~~Should projections use periodic snapshots for replay performance, or begin with log-only rebuild?~~ **RESOLVED — log-only rebuild.** `EngineCheckpoint` carries no projection snapshot; Recovery Sequencing R1 always does `buildProjection(replayOrder(acceptedLog))`. Snapshots may be revisited later as a performance optimization; they are not part of this epic.
3. ~~What exact receive metadata is necessary for restart recovery?~~ **RESOLVED** — `EngineCheckpoint` seam + Recovery Sequencing R1–R4 (architecture.md).
4. ~~Which interpreted artifacts are persisted vs rebuilt?~~ **RESOLVED** — `AcceptedDomainEvent` is the only persisted interpreted artifact (`PersistenceAdapter.appendAcceptedEvent`); projections are always rebuildable and never source of truth.
5. ~~How should degraded states surface into the UI?~~ **RESOLVED** — `engine_state_changed{state, health}` output event consumed by `react-engine-hooks.ts`; visual treatment is app-shell concern (Library Character section).

## Recommendation

Proceed with this refactor as a first-class architecture epic.

The immediate live-delivery stabilization work should still land, but it should be treated as tactical containment. The long-term fix is to redesign the state pipeline so that eventually consistent distributed behavior is modeled explicitly and owned by a reusable core, rather than emerging from coordination between transport code, UI effects, and ad hoc persistence.

## Amendments

- **2026-06-29 (ADR-002):** Five product-behavior decisions resolved and back-ported (P4/Invariant-3 narrowing, re-join reset, joining-gate timeout, EngineCheckpoint `lastIngestedSeq`, engine↔adapter seam).
- **2026-07-12 (spec validation, pre-implementation):** Phase 3 reworded from "shadow mode" to listener-observation-only (the shadow design was rejected by ADR-002; wording predated the debate). Open Design Questions 1–5 all marked RESOLVED with pointers (Q2 → log-only rebuild; Q4 → accepted-events are the only persisted interpreted artifact). In Scope gains the publish/outbox bullet (was implied by P8/Phase 6/Invariant 6 but absent from the list). Out of Scope gains the single-active-tab assumption. Failure-mode defaults added to architecture.md Implementation Constraints §11–§13 (persistence I/O failure → degraded+retry; corrupt checkpoint → treated as absent; parse_error → permanent reject, never parked).
- **2026-07-12 (Stage-2 cold review batch A–G):** persistence carve-out permitting `src/persistence/*` to import `engine-types.ts` only (A); `EngineCheckpoint.bootstrapCompleted` added and FSM L1/L2 restart routing keyed on it, plus `PersistenceAdapter.clearGroupState` realizing `reset()` (B); `AcceptedDomainEvent.factId` made non-nullable — bootstrap events now link to their kind-30078 `RawProtocolFact` (C); `EngineCheckpoint.deferredNostrEventIds` removed, `deferred-store` is the sole deferred-queue source of truth (D); `lastEpoch`/`lastAcceptedDomainEventId` made nullable to legally represent a checkpoint saved during `joining` (E); the boundary-scanner test tightened to cover `.tsx`, no-space `from"..."` imports, all of `src/` for AC-BOUND-3, and `src/marmot`/`src/persistence` for AC-BOUND-1 (F); this output-event list corrected to the real ten-variant vocabulary (G).
- **2026-07-12 (S3 Stage-2 cold review batch):** `task-projector.ts` gained property coverage for `replayOrder` (phase-partitioning, within-phase stability, non-mutation, fresh-array return) and purity oracles (input non-mutation, result-vs-independent-fold equality, `EMPTY_PROJECTION` non-pollution); AC-INV-2's projector half re-scoped to "re-applying an already-applied event is a no-op" — unique-id logs are a persistence-layer precondition (S4's `appendAcceptedEvent` idempotency), not something the projector dedups, correcting a prior phrasing that implied projector-side id-dedup; `applyEvent` now preserves referential identity on no-op paths (returns the same `TaskProjection` reference rather than a fresh copy), a pure optimization S8's React layer will rely on for change detection.
