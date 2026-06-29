# Architectural Proposal: Event-Sourced Receive Engine

**Codebase root:** `/Users/mrother/Projects/941design/notestr/notestr-web`
**Grounded in:** spec.md and exploration.json confirmed against source.

---

## 1. Paradigm

**Recommended:** Functional core + imperative shell, with a CQRS-style read/write split at the engine boundary.

The codebase already exhibits a partial version of this pattern. `applyEvent` and `replayEvents` in `src/store/task-reducer.ts:5-105` are a textbook functional core: pure, no React, no I/O, deterministic over any input sequence. The imperative shell is the `useDeviceSync` React hook (`src/marmot/device-sync.ts:487`), which wraps that core in a `useEffect` closure holding all the side-effectful state: the `ingestLock` mutex, `pendingRetry` map, `syncedEventIds` cache, live buffer, and epoch tracker (device-sync.ts:642-667). The problem is that the shell is a React hook, so all engine state resets on unmount and every correctness invariant is contingent on mount timing.

The target architecture has three shells nested around a stable functional core:

**Inner core (pure, no I/O):** `src/domain/` — task reducer, projector, domain event normalization. Zero framework imports. Accepts `AcceptedDomainEvent[]`, returns `TaskState`. Already 95% exists in task-reducer.ts; needs only the idempotency key layer added.

**Middle shell (imperative, no React):** `src/engine/` — per-group receive state machine. Owns ingest sequencing, catch-up, buffering, deferred parking, retry. May perform I/O via the `PersistenceAdapter` port. Must not import React or Next.js. This is what `useDeviceSync` becomes once its React coupling is removed.

**Outer shell (React adapter):** `src/integration/` — hooks and providers that subscribe to engine output events and push projected state into React. Calls engine methods; does not implement ingest logic.

The CQRS split: writes (relay event → engine accept → raw log append → accepted domain event) and reads (accepted domain event log → projector → `TaskState`) are separated at the `AcceptedDomainEvent` boundary. The projector never touches the transport path; the engine never touches React state.

This is the correct paradigm because: (a) the functional core is already proven and tested; (b) the receive state machine logic already exists, it just needs to be lifted out of a React hook lifecycle; (c) hexagonal/ports-and-adapters would add interface indirection for every direction of I/O but the system has only two I/O surfaces (marmot-ts and IDB), making the overhead disproportionate to the gain here.

---

## 2. Module Map

### `src/engine/receive-engine.ts` — NEW

**Purpose:** Per-group receive state machine. The central new artifact.

**Absorbs from device-sync.ts:**
- `syncGroup` (device-sync.ts:895-1010): subscribe-first cutover, `liveBuffer`, `cutoverComplete` flag, step 1/2/3 sequencing — moves here verbatim minus React guard (`mountedRef.current` checks become engine lifecycle checks)
- `ingestLock` (device-sync.ts:651): per-group mutex, becomes a field on the engine instance
- `getPendingRetryQueue` + deferred parking (device-sync.ts:668-751): moves here
- `attachRetryOnEpochAdvance` (device-sync.ts:819-870): becomes an internal engine subscription on the marmot `stateChanged` event
- `ingestGroupEventsRaw` (device-sync.ts:677-761): renamed `ingestFacts`, now emits `EngineOutputEvent` instead of side-effecting listeners

**Data it owns exclusively:** per-group engine lifecycle state (`uninitialized` / `joining` / `recovering` / `catching_up` / `buffering_live` / `live` / `degraded` / `retrying_deferred` / `stopped`); per-group `lastEpoch` (currently device-sync.ts:657); per-group `retryAttempts` budget (currently device-sync.ts:666).

**Does NOT own:** persistence calls (delegated to `PersistenceAdapter`), React state, marmot-ts group handle (injected at construction).

### `src/engine/engine-types.ts` — NEW

**Purpose:** All cross-module type definitions: `EngineLifecycleState`, `EngineHealth`, `EngineOutputEvent` union, `RawProtocolFact`, `AcceptedDomainEvent`, `EngineCheckpoint`, `PersistenceAdapter` interface.

**Absorbs:** the `TraceEvent` vocabulary from `src/marmot/mls-trace.ts` is the direct precursor; `mls-trace.ts` stays as the diagnostic build-time implementation, but the engine output event union formalizes what was previously implicit trace vocabulary.

### `src/engine/ingest-policy.ts` — NEW (thin wrapper)

**Purpose:** Encapsulates dedupe and retry-budget policy independently of engine lifecycle.

**Absorbs:**
- `createPendingRetryQueue` from `src/marmot/ingest-queue.ts:84-149` — either moves here or is re-exported; the pure module contract is preserved
- `selectAndIncrementRetries` from device-sync.ts (the drain-on-ingest Solution B policy, currently tested in device-sync.test.ts)

### `src/domain/domain-events.ts` — NEW

**Purpose:** Defines `AcceptedDomainEvent<T>` with stable idempotency key and the task-specific alias.

**Does not absorb existing code** — fills the gap identified in exploration.json ("ordering_identity.gap"): `rumor.id` is the canonical correlator (device-sync.ts:81-85, GAP-1 comment) but is not on `TaskEvent`. This module creates the wrapper type that carries it.

### `src/domain/task-projector.ts` — NEW (thin wrapper)

**Purpose:** Exposes `buildProjection(log: AcceptedDomainEvent<TaskEvent>[]): TaskState` as the engine's projection API.

**Absorbs:**
- `applyEvent` and `replayEvents` from `src/store/task-reducer.ts:5-105` — either moves or re-exports. The reducer is already the right shape; the projector adds the `AcceptedDomainEvent` unwrap layer and deduplication on `event.id` before folding into `applyEvent`.

### `src/persistence/raw-event-log-store.ts` — NEW (replaces persistence.ts)

**Purpose:** Idempotent raw-fact log over IDB.

**Replaces:**
- `appendEvent` from `src/store/persistence.ts:29-36` — the naive read-modify-write with no idempotency check. The replacement adds a lookup-before-insert on `fact.id` (or a Set-keyed secondary index) to absorb duplicate delivery without log inflation. The inflation problem is currently masked by reducer idempotence (exploration.json "persistence_reality.log_inflation") but is not type-enforced.
- `loadEvents`, `saveEvents` from persistence.ts:17-27 — replaced by `loadFacts` / `loadAcceptedEvents`.

**Uses:** the same `createKVStore` / IDB infrastructure from `src/marmot/storage.ts:100-133`, preserving per-pubkey namespacing.

### `src/persistence/checkpoint-store.ts` — NEW

**Purpose:** Durable engine checkpoint keyed by `groupId`. Owns the IDB store `"engine-checkpoints"`.

### `src/persistence/deferred-store.ts` — NEW

**Purpose:** Durable deferred-queue metadata. The in-memory `PendingRetryQueue` (ingest-queue.ts) survives only until the engine is torn down. This store persists the `nostrEventId` list of deferred events across restarts, enabling recovery to resume retry without re-fetching the full historical log. Owns IDB store `"deferred-events"`.

### `src/integration/marmot-adapter.ts` — NEW

**Purpose:** Typed bridge between the marmot-ts API surface and the engine. Owns all code that touches `MarmotGroup` or `MarmotClient` outside the engine receive path.

**Absorbs from device-sync.ts:**
- The outbox bridge: `enqueueExpectedPublish`, `removeExpectedPublishByRumorId`, `consumeExpectedPublishForKind445`, `beginDispatchPublishWindow`, `endDispatchPublishWindow` (device-sync.ts:86-290) — this is an integration concern, not an engine concern. Moves here intact.
- `attachAppMsgListener` (device-sync.ts:874-892) — becomes the adapter's subscription registration, now passing received data to the engine rather than calling `appendEvent` directly.
- `fetchAndApplyTaskBootstrap` (device-sync.ts:1349-...) — wraps the kind-30078 path and converts its synthetic `task.created` outputs into `RawProtocolFact` records tagged `receiptSource: "bootstrap-kind-30078"` before handing them to the engine.

**Also absorbs from device-sync.ts:** `client.tsx`-level `attachStateListener` calls that currently wire `group.on("stateChanged")` → React setState (exploration.json "framework_coupling_to_remove" item 5) — these become engine lifecycle callbacks instead.

### `src/integration/react-engine-hooks.ts` — NEW

**Purpose:** React adapter layer. Subscribes to `EngineOutputEvent` stream and pushes projected state into React.

**Absorbs and removes:**
- `TaskStoreProvider`'s second `applicationMessage` listener (task-store.tsx:178-255) — deleted; this is the core F3-class race class the epic eliminates.
- `useDeviceSync` hook body (device-sync.ts:487-...) — the hook signature is preserved for external callers, but its body becomes a thin wrapper that creates an engine instance and wires its output events to React state.
- `ensureMonotonicTimestamp` in dispatch (task-store.tsx) — moves to the publish path in this layer, never into the projector.

### `src/marmot/device-sync.ts` — MODIFIED, eventually slimmed

**Immediate fate:** stub remains; internals migrate story-by-story per the phase plan. Should not have new correctness logic added during the migration.

### `src/store/task-store.tsx` — MODIFIED

**Immediate fate:** second `applicationMessage` listener (lines 178-255) removed once `react-engine-hooks.ts` delivers projected state. `dispatch` path stays but `ensureMonotonicTimestamp` moves to the outbox layer. `stateRef` sync-on-remote-receive pattern (lines 230-237) removed.

### `src/store/persistence.ts` — DEPRECATED

Replaced by `src/persistence/raw-event-log-store.ts`. Kept alive only for the migration shadow period; removed in Phase 8.

---

## 3. Seam Contracts

### 3a. `RawProtocolFact` — Open Question 1, a blocker

```typescript
interface RawProtocolFact {
  id: string;               // idempotency key: nostrEvent.id (globally unique relay event id)
  groupId: string;          // group.idStr — MLS hex group ID
  nostrEventId: string;     // same as id; explicit field for query clarity
  nostrEvent: NostrEvent;   // full relay envelope (kind, pubkey, sig, tags, content, created_at)
  receivedAt: number;       // client-side receipt ms (Date.now() at ingest call time)
  receiptSource:
    | "historical"           // from client.network.request one-shot fetch
    | "live"                 // from client.network.subscription stream
    | "bootstrap-kind-30078";// from fetchAndApplyTaskBootstrap NIP-44 side-channel
  epochAtReceipt: string;   // group.state.groupContext.epoch.toString() at ingest entry
}
```

**Invariants:**
- `id` is stable across duplicate deliveries of the same relay event (relay event ids are content-addressed).
- `receiptSource` is the mechanism that integrates kind-30078 without a second receive path: bootstrap facts enter the same store with a distinct source tag, and the engine treats them as a distinct ingest phase (after historical catch-up, before live cutover). This answers the "MATERIAL" flag in exploration.json.
- `nostrEvent.content` is the encrypted MLS ciphertext; raw-fact storage does not attempt decryption. Reinterpretation requires the persisted MLS `group-state` IDB entry at the corresponding epoch.

**Blocker:** the `epochAtReceipt` field requires that the persisted MLS `SerializedClientState` (currently in the `group-state` IDB store) is keyed in a way that allows retrieval of the state corresponding to a past epoch. Today the store holds only the current state. An epoch-keyed snapshot strategy must be decided before Phase 7 (persist recovery metadata) can land.

### 3b. `AcceptedDomainEvent` — idempotency gap, required before Phase 4

```typescript
interface AcceptedDomainEvent<T = TaskEvent> {
  id: string;          // STABLE IDEMPOTENCY KEY: rumor.id from the marmot-ts
                       // applicationMessage callback (the unsigned Nostr event id).
                       // This is the correlator documented in GAP-1 at
                       // device-sync.ts:81-85. It is NOT a field on TaskEvent today.
  factId: string;      // RawProtocolFact.id that produced this domain event
  groupId: string;
  acceptedAt: number;  // engine client-ms at acceptance
  epoch: string;       // MLS epoch string at acceptance
  payload: T;          // the normalized TaskEvent (unchanged type)
}
```

**Idempotency key derivation:** `rumor.id` is available inside the `applicationMessage` callback at the point where marmot-ts emits decrypted application data. Both existing listeners already capture it: device-sync.ts:879 and task-store.tsx:199-203. The engine's ingest path calls `deserializeApplicationData` once, extracts `rumor.id` as `AcceptedDomainEvent.id`, and passes `rumor.content` parsed as `TaskEvent` into `payload`. No change to the wire format.

**Consequence for persistence:** `appendAcceptedEvent` in `PersistenceAdapter` must do a set-membership check on `event.id` before inserting. The projector then deduplicates on `event.id` when folding `AcceptedDomainEvent[]` through `applyEvent`. This closes the log-inflation path currently masked by reducer idempotence.

### 3c. `EngineCheckpoint` — Open Question 3, a blocker

```typescript
interface EngineCheckpoint {
  groupId: string;
  savedAt: number;                  // client ms
  engineState: EngineLifecycleState;// enum value at checkpoint time
  lastEpoch: string;                // MLS epoch string
  lastProcessedFactId: string;      // last RawProtocolFact.id successfully through ingest
  lastAcceptedDomainEventId: string;// last AcceptedDomainEvent.id produced
  deferredNostrEventIds: string[];  // events in PendingRetryQueue at checkpoint time
}
```

**Invariants:**
- On restart, the engine loads `EngineCheckpoint` + `DeferredStore` to reconstruct `PendingRetryQueue` without a full relay re-fetch.
- `lastProcessedFactId` is used to determine which facts in the raw log are already processed (skip them during recovery replay), equivalent to the `syncedEventIds` seen-set (device-sync.ts:683) that today lives only in memory.
- **Blocker:** the checkpoint's relationship to persisted MLS state must be resolved — specifically whether `lastEpoch` is sufficient to identify the correct `SerializedClientState` for reinterpretation, or whether epoch-keyed MLS state snapshots are required. If epoch-keyed snapshots are not available, deterministic reinterpretation (P2) is limited to the current MLS state only.

### 3d. Engine output event union

```typescript
type EngineOutputEvent =
  | { type: "envelope_received";      factId: string; groupId: string }
  | { type: "envelope_deferred";      factId: string; groupId: string;
      reason: "unreadable" | "epoch_mismatch" | "parse_error" }
  | { type: "domain_event_accepted";  event: AcceptedDomainEvent }
  | { type: "domain_event_rejected";  factId: string; groupId: string; reason: string }
  | { type: "projection_invalidated"; groupId: string }
  | { type: "group_state_changed";    groupId: string; newEpoch: string; prevEpoch: string }
  | { type: "engine_state_changed";   groupId: string;
      state: EngineLifecycleState; health: "nominal" | "degraded" }
  | { type: "deferred_retry_started"; groupId: string; count: number }
  | { type: "recovered";              groupId: string }
```

**Consumers:** `src/integration/react-engine-hooks.ts` subscribes to this stream. On `domain_event_accepted`, it appends to a local accepted-events list and calls `buildProjection`. On `engine_state_changed`, it exposes engine health to UI without making UI a correctness owner.

### 3e. `PersistenceAdapter` port

```typescript
interface PersistenceAdapter {
  // Raw fact log
  appendFact(fact: RawProtocolFact): Promise<void>;            // idempotent on fact.id
  loadFacts(groupId: string): Promise<RawProtocolFact[]>;

  // Accepted domain event log (derived; optional cache layer)
  appendAcceptedEvent(event: AcceptedDomainEvent): Promise<void>; // idempotent on event.id
  loadAcceptedEvents(groupId: string): Promise<AcceptedDomainEvent[]>;

  // Checkpoints
  saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void>;
  loadCheckpoint(groupId: string): Promise<EngineCheckpoint | null>;

  // Deferred queue durability
  saveDeferredIds(groupId: string, ids: string[]): Promise<void>;
  loadDeferredIds(groupId: string): Promise<string[]>;
}
```

**Implementation:** the three persistence modules implement this interface using `createKVStore` (storage.ts:100-133), preserving per-pubkey IDB namespacing and the `clearAppState` fixture contract.

---

## 4. Boundary Rules

**Rule 1 — Engine has no framework imports.** `src/engine/*` must not import from `react`, `next`, `next/navigation`, or any file under `src/integration/`. Enforceable with a CI import-graph lint rule.

**Rule 2 — Domain is pure.** `src/domain/*` must not import from `src/engine/`, `src/persistence/`, `src/integration/`, or the DOM. The projector accepts data and returns data; performs no I/O. `task-reducer.ts:5-105` is already compliant.

**Rule 3 — Persistence is an outbound port, not a peer.** `src/persistence/*` may import from `src/domain/` for types. It must not import from `src/engine/` or `src/integration/`. The engine calls persistence via `PersistenceAdapter`; persistence never calls the engine.

**Rule 4 — Integration owns all React coupling.** `src/integration/*` may import from all other layers. It is the only layer permitted to call `useState`/`useEffect`/`useRef` or dispatch DOM events. The DOM event bus couplings currently in device-sync.ts:1055 and task-store.tsx:371 must remain in or move to `src/integration/`.

**Rule 5 — kind-30078 is a receipt source, not a second receive path.** `fetchAndApplyTaskBootstrap` (device-sync.ts:1349) is called by `src/integration/marmot-adapter.ts` during the group-joining phase; its output is injected into the engine as `RawProtocolFact` with `receiptSource: "bootstrap-kind-30078"`. From the engine layer downward, there is exactly one receive path.

**Rule 6 — `ensureMonotonicTimestamp` stays on the publish path.** ADR-001's sender-side monotonic bump migrates to the outbox/publish layer in `src/integration/`. It must never enter the projector or the domain reducer, because the projector must be reproducible from persisted inputs without current-clock access.

**Rule 7 — No correctness logic added to task-store.tsx or device-sync.ts during migration.** Both files are scheduled for replacement. New receive correctness features attach to `src/engine/receive-engine.ts`. New publish correctness features attach to the outbox path in `src/integration/`.

---

## 5. Assumptions

**Assumption A — Shadow-mode parallel run is feasible without MLS state corruption (Phase 3).** Per-pubkey IDB namespacing (storage.ts:100-133) makes the new engine's distinct keys namespacing-safe. The risk is the shared `group-state` IDB entry holding `SerializedClientState` managed by marmot-ts. Both paths use the same group handle, so MLS mutations are already serialized through `ingestLock`. If marmot-ts writes `group-state` outside ingest, diff-checking will produce false divergences.

**Assumption B — marmot-ts will not internalize catch-up during this epic.** The cutover logic is consumer-managed because marmot-ts has no catch-up API. If the fork acquires a catch-up primitive, the engine boundary must be revisited. Controlled risk (project-owned fork).

**Assumption C — Own-echo suppression behavior in marmot-ts is stable.** marmot-ts silently drops self-sent kind-445 at ingest. The engine never receives `domain_event_accepted` for own messages; the outbox bridge is the only reconciliation path. If the fork changes own-echo behavior, own events would be double-applied without a guard. Should be documented as a fork invariant.

**Assumption D — The single-writer LWW convergence constraint is not relaxed by this epic.** The LWW reducer is convergent only under single-writer-per-field. The engine does not change the reducer or ordering contract. Genuine concurrent multi-writer edits are out of scope without a separate consensus mechanism.

**Assumption E — Persisting raw kind-445 envelopes plus current MLS state is sufficient for semantically strong recovery.** marmot-ts owns all mutations to `SerializedClientState` and only the current state is persisted. Deterministic reinterpretation of a past-epoch event requires the MLS state at that epoch. Until epoch-keyed snapshots exist, "restart recovery" means recovery from the current epoch forward, not full replay from genesis. Deferred to Open Question 3; primary blocker for Phase 7.

**Assumption F — kind-30078 bootstrap always runs after the engine is initialized for the group.** Bootstrap must be an explicit engine phase (`joining`) so bootstrap-sourced facts are sequenced before historical catch-up. If bootstrap runs after `live`, bootstrap tasks could arrive out-of-order relative to accepted events, violating FWW for `task.created`.

---

**Blockers before implementation begins:**

1. Resolve the `RawProtocolFact` shape (3a) — whether epoch-keyed MLS state snapshots are required. Gates Phase 2 and Phase 7.
2. Resolve the `EngineCheckpoint` relationship to persisted MLS state (3c). Same gate.
3. Decide the `AcceptedDomainEvent.id` derivation as a formal spec amendment — `rumor.id` is the de facto answer but must be written as a type contract before Phase 4 stories can be independently implementable.
