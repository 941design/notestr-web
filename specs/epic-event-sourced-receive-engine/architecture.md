# Epic Architecture: event-sourced-receive-engine

**ADR**: docs/adr/ADR-002-event-sourced-receive-engine.md
**Status**: current
**Last updated**: 2026-07-14 (S13 "boundary-hardening-and-cutover-complete" — added "Extraction Seams" section; prior Stage-2 cold review amendments from 2026-07-12 are marked inline "(amended 2026-07-12, Stage-2 cold review)")

---

## Paradigm

Functional core + imperative shell, three nested shells: pure domain inner core (`src/domain/`), imperative-no-React middle shell (`src/engine/`), React adapter outer shell (`src/integration/`).

---

## Module Map

| Module | Purpose | Location | Owned Data |
|---|---|---|---|
| receive-engine | Per-group receive state machine; explicit `start()`/`stop()`/`reset()` lifecycle; new construction | `src/engine/receive-engine.ts` | Lifecycle state, `lastEpoch`, retry budget, `PendingRetryQueue` (in-memory) |
| engine-types | All cross-module type definitions; IDB key schema authority | `src/engine/engine-types.ts` | Type definitions only |
| ingest-policy | Dedupe and retry-budget policy; wraps `PendingRetryQueue` | `src/engine/ingest-policy.ts` | None (stateless helpers) |
| domain-events | `AcceptedDomainEvent<T>` with `sourceKind` discriminator and dual idempotency-key derivation | `src/domain/domain-events.ts` | Type definitions only |
| task-projector | Deterministic incremental projection: `applyEvent` per `domain_event_accepted`; full rebuild on restart/`projection_invalidated` only | `src/domain/task-projector.ts` | None (pure function) |
| task-crdt | Shared `taskWinsOver(candidate, existing)` tie-break helper; called by both `applyEvent` and bootstrap merge gate | `src/domain/task-crdt.ts` | None (pure function) |
| raw-event-log-store | Idempotent raw-fact log; replaces `persistence.ts:appendEvent`; lookup-before-insert on `fact.id` | `src/persistence/raw-event-log-store.ts` | IDB `notestr:raw-facts:${groupId}` |
| checkpoint-store | Durable engine checkpoint keyed by `groupId` | `src/persistence/checkpoint-store.ts` | IDB `notestr:engine-checkpoints:${groupId}` |
| deferred-store | Durable deferred-queue id list across restarts | `src/persistence/deferred-store.ts` | IDB `notestr:deferred-ids:${groupId}` |
| marmot-adapter | Typed bridge to marmot-ts; owns outbox bridge and bootstrap wrapping; engine holds at `joining` until bootstrap resolves | `src/integration/marmot-adapter.ts` | Outbox bridge Maps (moved from `device-sync.ts:93-141`) |
| react-engine-hooks | Subscribes to `EngineOutputEvent`; incremental `applyEvent`; exposes engine health to UI | `src/integration/react-engine-hooks.ts` | React state only |
| device-sync | MODIFIED — stub during migration; no new correctness logic | `src/marmot/device-sync.ts` | Shrinking: internals migrate story-by-story |
| task-store | MODIFIED — second `applicationMessage` listener removed when engine takes over | `src/store/task-store.tsx` | Shrinking |
| persistence | DEPRECATED — removed Phase 8 | `src/store/persistence.ts` | Legacy `notestr:events:${groupId}` (read-only during migration) |
| task-events | ADDED BY S2 (2026-07-12, S1 review Finding 2 / Decider gate) — the TaskEvent wire type + `createTask` factory, relocated from `src/store`: **the pure inner core owns the domain wire type.** `createTask`'s `crypto.randomUUID()`/`Date.now()` are the ONLY sanctioned nondeterministic calls in `src/domain/` (allowlisted in the boundary scanner); projector/CRDT code must stay pure | `src/domain/task-events.ts` | Wire type + createTask factory |
| task-events-shim | FROZEN (2026-07-12) — pure re-export shim (`export * from "../domain/task-events"`) kept so 15 legacy importers work unchanged; do NOT add declarations here (structural test enforces) | `src/store/task-events.ts` | None (re-export only) |

---

## Seam Contracts

### RawProtocolFact

| Field | Type | Optional |
|---|---|---|
| id | string | no — `nostrEvent.id`; content-addressed; idempotency/dedupe key |
| seq | number | no — monotonic per-group receipt sequence assigned on append; the ORDERING and recovery-watermark key (ids are content hashes, NOT ordered) |
| groupId | string | no — `group.idStr` (MLS hex group ID) |
| nostrEventId | string | no — same as `id`; explicit for query clarity |
| nostrEvent | NostrEvent | no — full relay envelope |
| receivedAt | number | no — client-side ms at ingest call (`Date.now()`) |
| receiptSource | `"historical" \| "live" \| "bootstrap-kind-30078"` | no |
| epochAtReceipt | string | no — DIAGNOSTIC ONLY |

**Invariants:**
- `id` is stable across duplicate deliveries of the same relay event (content-addressed) and is the dedupe key. `id` is NOT ordered — never compare ids to determine sequence.
- `seq` is assigned monotonically on append to the per-group raw-log and is the sole ordering/recovery-watermark key. Duplicate deliveries (same `id`) do not get a new `seq` (idempotent append by `id`).
- `epochAtReceipt` MUST NOT be used as a retrieval key for past `SerializedClientState`. No snapshot-at-epoch API exists in marmot-ts. This field is diagnostic metadata only.
- Bootstrap-sourced facts enter the same store as MLS-sourced facts; `receiptSource` discriminates origin.
- `nostrEvent.content` is encrypted MLS ciphertext; raw-fact storage does not attempt decryption.
- **Producer/store split (amended 2026-07-12, Codex review):** `seq` is assigned by the raw log ON APPEND, so producers (`marmot-adapter.ts`, and `IngestSignal` variants carrying a pre-persistence fact) construct a seq-less `RawProtocolFactInput` (`RawProtocolFact` minus `seq`). `PersistenceAdapter.appendFact` accepts the `RawProtocolFactInput` and returns the store-assigned, sequenced `RawProtocolFact` (see `PersistenceAdapter` below).

**Produced by:** `src/integration/marmot-adapter.ts`
**Consumed by:** `src/engine/receive-engine.ts` (ingest), `src/persistence/raw-event-log-store.ts` (durability)
**IDB key:** `notestr:raw-facts:${groupId}` (defined in `src/engine/engine-types.ts`)

---

### AcceptedDomainEvent

| Field | Type | Optional |
|---|---|---|
| id | string | no — MLS path: `rumor.id`; bootstrap: `"bootstrap:${groupId}:${task.id}"` |
| factId | string | no — the backing `RawProtocolFact.id` (amended 2026-07-12, Stage-2 cold review — P2-7). MLS path: the kind-445 envelope's fact. Bootstrap path: the kind-30078 snapshot event's fact — the snapshot IS persisted as a `RawProtocolFact` (`receiptSource: "bootstrap-kind-30078"`), and every synthetic per-task bootstrap event links to it; many accepted events may share one `factId`. |
| sourceKind | `"mls-rumor" \| "bootstrap-kind-30078"` | no |
| groupId | string | no |
| acceptedAt | number | no — client ms at acceptance |
| epoch | string | no — MLS epoch string at acceptance |
| payload | TaskEvent | no — normalized task event; unchanged wire type |

**Invariants:**
- `id` is the primary deduplication key. `appendAcceptedEvent` is idempotent on `id`.
- MLS path: `id = rumor.id` from the `applicationMessage` callback; available at `device-sync.ts:879` and `task-store.tsx:199-203`.
- Bootstrap path: `id = "bootstrap:${groupId}:${task.id}"`. Deterministic across re-runs. `groupId` prefix prevents cross-group `task.id` collision.
- DECIDED (ADR-002, 2026-06-29): re-join clears the per-group accepted-event log and `bootstrap-completed` marker before replaying the fresh snapshot, so the bootstrap `id` collision cannot silence the new snapshot. See Implementation Constraint §1(b). The remaining engineering task is detecting re-join vs plain restart and sequencing the reset.
- Replay sort order over a mixed-`sourceKind` log is phase order (bootstrap events before MLS events), NOT `acceptedAt` clock order. Client clock skew could reorder bootstrap after live if sorted by `acceptedAt`.

**Produced by:** `src/engine/receive-engine.ts`
**Consumed by:** `src/domain/task-projector.ts`, `src/persistence/raw-event-log-store.ts`
**IDB key:** `notestr:accepted-events:${groupId}` (defined in `src/engine/engine-types.ts`)

---

### EngineCheckpoint

| Field | Type | Optional |
|---|---|---|
| groupId | string | no |
| savedAt | number | no — client ms |
| engineState | EngineLifecycleState | no — enum value at checkpoint time |
| lastEpoch | `string \| null` | no — MLS epoch string; `null` until the first epoch is observed (amended 2026-07-12, Stage-2 cold review — P3-11). A checkpoint saved during `joining` legally carries `null`. |
| lastIngestedSeq | number | no — `seq` of the last `RawProtocolFact` that COMPLETED `group.ingest` (processed, skipped, or deferred). Recovery re-ingests only facts with `seq > lastIngestedSeq`. |
| lastAcceptedDomainEventId | `string \| null` | no — last `AcceptedDomainEvent.id` produced; `null` until the first accepted event is produced (amended 2026-07-12, Stage-2 cold review — P3-11). A checkpoint saved during `joining` legally carries `null`. |
| bootstrapCompleted | boolean | no — **added 2026-07-12, Stage-2 cold review — P1-2.** True once the join-time kind-30078 bootstrap has been fully applied for this group. MONOTONIC once true until `reset()` clears the checkpoint; every `saveCheckpoint` must carry it forward. Restart routing keys on this flag — see `fsm.md` L1/L2. |

**Invariants:**
- `lastIngestedSeq` and `lastAcceptedDomainEventId` are DISTINCT markers. An unreadable/deferred event advances `lastIngestedSeq` but NOT `lastAcceptedDomainEventId`. Conflating them is a known anti-pattern from the original proposal.
- Recovery sequencing is SPECIFIED in the "Recovery Sequencing" section (resolves Open Questions §7). A fact's recovery disposition is decided by store membership + the `seq` watermark, never by comparing content-hash ids.
- On restart, the engine re-ingests only raw-log facts with `seq > lastIngestedSeq`; facts at or below the watermark already have their outcome in the accepted-log or deferred-store.
- **Single deferred truth (amended 2026-07-12, Stage-2 cold review — P2-6):** the deferred queue has exactly ONE durable source of truth: `deferred-store` (R2a prune, then R2 rebuild). The checkpoint carries no deferred ids (removed `deferredNostrEventIds` — a stale checkpoint copy could bypass the R2a accepted-wins prune).
- **Bootstrap-completed lives in the checkpoint (amended 2026-07-12, Stage-2 cold review — P1-2):** the `bootstrap-completed` flag referenced by "Re-join and Reset" below is the `bootstrapCompleted` field on this checkpoint — clearing the checkpoint (via `reset()` / `PersistenceAdapter.clearGroupState`) clears it too. This still satisfies Decision 3 (re-join clears the accepted-log AND the bootstrap-completed marker) because a full `clearGroupState` clears the checkpoint that carries it.

**Produced by:** `src/engine/receive-engine.ts` (on phase transition and periodic save)
**Consumed by:** `src/engine/receive-engine.ts` (on restart, to reconstruct `PendingRetryQueue`)
**IDB key:** `notestr:engine-checkpoints:${groupId}` (defined in `src/engine/engine-types.ts`)

---

### EngineOutputEvent

| Field | Type | Optional |
|---|---|---|
| type | discriminated union (see below) | no |
| (variant fields) | per-variant | varies |

**Variants:**
- `envelope_received` — `{ factId, groupId }`
- `envelope_deferred` — `{ factId, groupId, reason: "unreadable" | "epoch_mismatch" }` *(parse failures are NOT deferrable — see invariant below)*
- `domain_event_accepted` — `{ event: AcceptedDomainEvent }`
- `domain_event_rejected` — `{ factId, groupId, reason: string }`
- `projection_invalidated` — `{ groupId }`
- `group_epoch_advanced` — `{ groupId, newEpoch, prevEpoch }`
- `group_ratchet_advanced` — `{ groupId }`
- `engine_state_changed` — `{ groupId, state: EngineLifecycleState, health: "nominal" | "degraded" }`
- `deferred_retry_started` — `{ groupId, count }`
- `recovered` — `{ groupId }`

**Invariants:**
- `group_epoch_advanced` triggers deferred-retry flush (matches `device-sync.ts:825` behavior).
- `group_ratchet_advanced` MUST NOT trigger deferred-retry.
- `projection_invalidated` MUST NOT be emitted on ratchet-advance `stateChanged`. Emission is reserved for restart recovery and explicit epoch-level invalidation. Emitting it on every ratchet advance would force full projection rebuild on every own-dispatch — a performance regression.
- On `domain_event_accepted`: integration layer MUST call `applyEvent(currentProjection, event.payload)` — NOT `buildProjection(fullLog)`. Full rebuild is only for restart and `projection_invalidated`.
- **Parse errors are terminal, never parked (added 2026-07-12).** A payload that decrypted but fails to decode into a `TaskEvent` can never become decodable by an epoch advance. The engine emits `domain_event_rejected` with `reason: "parse_error"` and does NOT enqueue the fact into the deferred queue. Only `unreadable` / `epoch_mismatch` participate in the L8 epoch-advance retry (I-FSM-6). This prevents both infinite unproductive retries and silent loss without signal.

**Produced by:** `src/engine/receive-engine.ts`
**Consumed by:** `src/integration/react-engine-hooks.ts`

---

### OutboxEntry

| Field | Type | Optional |
|---|---|---|
| createdAt | number | no — set ONCE before first send; IMMUTABLE across retries |
| rumorId | string | no — derived from `createdAt`; stable because `createdAt` is immutable |
| (additional fields) | TBD in Phase 6 | — |

**Invariants:**
- `createdAt` MUST NOT be updated on retry (Rule 8). Changing `createdAt` changes the event hash → new `rumorId` → receiver sees two `applicationMessage` firings with different ids and identical payload → idempotency check fails → Invariant 2 breaks.
- This seam is a Phase 6 pre-condition. **Its typed contract must be specified before Phase 6 stories are written.**

**Produced by:** `src/integration/` publish path
**Consumed by:** `src/integration/marmot-adapter.ts` outbox bridge

---

### PersistenceAdapter

| Method | Notes |
|---|---|
| `appendFact(fact: RawProtocolFactInput): Promise<AppendFactResult>` | Idempotent on `fact.id`. **Amended 2026-07-12 (Codex review, P1):** `seq` is assigned by the store on append, so the caller passes a seq-less `RawProtocolFactInput`; the store returns `{ fact, duplicate }`. A duplicate append (same `id`) mints NO new `seq` — it returns the EXISTING stored fact with `duplicate: true`. |
| `loadFacts(groupId: string): Promise<RawProtocolFact[]>` | **Ordering contract (amended 2026-07-12, S3 Stage-1 review — sev-5):** returns facts sorted by `seq` ascending (= append order). NEVER content-hash-id order. R3's watermark scan and replay depend on it. |
| `appendAcceptedEvent(event: AcceptedDomainEvent): Promise<void>` | Idempotent on `event.id` |
| `loadAcceptedEvents(groupId: string): Promise<AcceptedDomainEvent[]>` | **Ordering contract (amended 2026-07-12, S3 Stage-1 review — sev-5):** returns events in APPEND/insertion order — `appendAcceptedEvent` assigns a monotonic position; load returns sorted by it, NEVER by content-hash `id`. Load-bearing for projection determinism: `applyEvent` is order-sensitive (hard delete, no tombstone — a delete-then-higher-timestamp-update interleaving projects differently under reordering), and `replayOrder` sorts by phase ONLY, delegating within-phase order to this contract (`AcceptedDomainEvent` carries no `seq`). S4 MUST assert order preservation in a real store→load round-trip test, including a delete-before-update interleaving. |
| `saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void>` | |
| `loadCheckpoint(groupId: string): Promise<EngineCheckpoint \| null>` | |
| `saveDeferredIds(groupId: string, ids: string[]): Promise<void>` | |
| `loadDeferredIds(groupId: string): Promise<string[]>` | |
| `acceptDeferredFact(groupId: string, factId: string, event: AcceptedDomainEvent): Promise<void>` | **Added 2026-07-12 (Codex review, P1); atomicity model revised same day (Stage-1 review, sev-6):** the single API entry point for deferred→accepted acceptance, implementing R-INV-3 via **crash-safe ordering, not a cross-store transaction** (the mandated `createKVStore` infra places each store in its own IndexedDB database, and IDB transactions cannot span databases). Contract: (1) append `event` to the accepted-log FIRST (idempotent on `event.id`); (2) only after that write resolves, remove `factId` from the deferred ids. A crash between the two leaves the fact transiently in BOTH stores — never in neither — and recovery's R2a prune step reconciles it (accepted wins). Implementations MUST NOT reverse the write order and MUST NOT interleave other writes between the two steps. Owned by S11. |
| `clearGroupState(groupId: string): Promise<void>` | **Added 2026-07-12, Stage-2 cold review — P1-2 / P2-4 / P2-5.** Full per-group purge implementing FSM L11 `reset()`: deletes the raw-fact log, accepted-event log, checkpoint (which carries `bootstrapCompleted`), and deferred ids for the group. After it resolves, `loadCheckpoint` returns `null` and all `load*` methods return empty. |

**Implementation:** uses `createKVStore` (`src/marmot/storage.ts:100-133`); per-pubkey IDB namespacing (`notestr-${pubkey}-${name}`) preserved and required.

**IDB key schema** (all defined in `src/engine/engine-types.ts` per Rule 9):

| Key | Owner | Status |
|---|---|---|
| `notestr:raw-facts:${groupId}` | `raw-event-log-store.ts` | new |
| `notestr:accepted-events:${groupId}` | `raw-event-log-store.ts` | new |
| `notestr:engine-checkpoints:${groupId}` | `checkpoint-store.ts` | new |
| `notestr:deferred-ids:${groupId}` | `deferred-store.ts` | new |
| `notestr:events:${groupId}` | LEGACY `persistence.ts` | read-only during migration; removed Phase 8 |

---

### IngestSource / IngestSignal  *(resolves Open Question §4 — engine↔adapter ingest seam)*

The ET-1 contradiction is resolved by **direction of control vs. direction of coupling**: the engine *drives* ingest (decides when to catch up, when to open live, when to stop) but never *touches* marmot. `marmot-adapter.ts` is the sole site that calls `group.ingest()`, `client.network.subscription()`, `deserializeApplicationData`, and reads epoch state. It translates every marmot outcome into a marmot-free `IngestSignal` the engine consumes.

**Control interface — the engine calls these on the adapter (no marmot types cross the boundary):**

| Method | Purpose |
|---|---|
| `catchUp(): AsyncIterable<IngestSignal>` | Drain historical events through `group.ingest()` once; yields one signal per event. **Exactly-once invariant (amended 2026-07-12, S5 Stage-1 review — sev-6):** invoked EXACTLY ONCE per engine `start()`, never concurrently with itself — the sole historical cutover drain (fsm.md L3/L4/L5 funnel into one `catching_up` entry per start). It is NOT the joining-phase bootstrap channel; see `fetchBootstrap` below. |
| `openLive(onSignal: (s: IngestSignal) => void): Unsubscribe` | Open the live `client.network.subscription()`; pushes signals as they arrive. |
| `ingestPersisted(facts: RawProtocolFact[]): AsyncIterable<IngestSignal>` | **Added 2026-07-12 (Codex review, P1).** R3 crash-gap replay + L8 deferred retry: submit persisted facts through `group.ingest()`; yields one `IngestSignal` per fact. Distinct from `catchUp()` because these facts already exist in the raw log (recovery/retry re-submission), not new adapter-discovered facts. |
| `fetchBootstrap(): AsyncIterable<IngestSignal>` | **Added 2026-07-12 (amended, S5 Stage-1 review — sev-6).** Joining-phase bootstrap: fetch and decode the group's kind-30078 task-state snapshot, yielding one `IngestSignal` per synthesized bootstrap event (`message` variants with `receiptSource "bootstrap-kind-30078"`, all sharing the snapshot's fact). Drain completion = `bootstrapResolved` (fsm.md L4 guard); `T_join` races THIS drain only — NOT `catchUp()`. **CONCURRENCY INVARIANTS:** (1) `fetchBootstrap` decrypts via NIP-44 and NEVER touches the MLS ratchet, so a late-running background `fetchBootstrap` MAY safely overlap `openLive()`/`catchUp()`/`ingestPersisted()` — the adapter MUST preserve that property; (2) `catchUp()` is invoked exactly once per engine `start()` and never concurrently with itself (see its row above); (3) after a `T_join` timeout the engine proceeds to `catching_up` while the same `fetchBootstrap` iterator continues in the background — its late signals enter the normal serial signal chain (LWW-safe merge) and completion restores nominal health (H2). The adapter MUST NOT require the drain to be abandoned on timeout. Replaces the S5-original design where the joining-phase bootstrap raced `catchUp()` against `T_join` and the timeout path spawned a second concurrent `catchUp()` iterator — unimplementable, since `group.ingest()` is stateful and cannot support two concurrent drains. |
| `close(): void` | Close subscription and release marmot handles. Called by the engine during `stop()`. |

**Data interface — `IngestSignal` (discriminated union, marmot-free):**

| Variant | Fields | Meaning |
|---|---|---|
| `message` | `{ fact: RawProtocolFactInput, rumorId: string, payload: TaskEvent, epoch: string, receiptSource }` | `group.ingest` decrypted an application message; `payload` already decoded via `deserializeApplicationData` (in the adapter). |
| `deferred` | `{ fact: RawProtocolFactInput, reason: "unreadable" \| "epoch_mismatch", epoch }` | Event received but not yet decryptable; engine parks it. |
| `skipped` | `{ fact: RawProtocolFactInput }` | **Amended 2026-07-12 (Codex review, P2):** Ratchet already consumed this id (own-echo / duplicate); fact still carried so the engine can append + advance the seq watermark. Previously `{ factId: string }` — that shape could not append an own-echo/duplicate envelope not yet in the raw log. |
| `malformed` | `{ fact: RawProtocolFactInput, error: string }` | Decryption succeeded but the payload failed to decode into a `TaskEvent` (added 2026-07-12). Terminal: the engine emits `domain_event_rejected` with `reason: "parse_error"`; never parked, never retried. |
| `epoch_advanced` | `{ newEpoch: string, prevEpoch: string }` | Translated from marmot `stateChanged` when the epoch changed; triggers deferred-retry. |

**Amended 2026-07-12 (Codex review):** every variant's `fact` field is `RawProtocolFactInput` (seq-less), not `RawProtocolFact`. These facts are adapter-produced pre-persistence (or, for `ingestPersisted`, already-persisted `RawProtocolFact`s — structurally assignable to `RawProtocolFactInput` since it is a strict field subset), and `seq` is assigned only by `PersistenceAdapter.appendFact` on append. This lets `ingestPersisted` reuse the same `IngestSignal` type as `catchUp`/`openLive`.

**Invariants:**
- `IngestSignal` carries **no marmot-ts types**. `payload` is the app's own `TaskEvent` wire type; `RawProtocolFact`/`RawProtocolFactInput` are already marmot-free (a `NostrEvent` envelope). Decoding and epoch reads happen inside the adapter.
- The engine never calls `group.ingest()` or the subscription directly. The adapter never makes accept/defer/dedupe/normalize decisions — those are engine-owned.
- On entry to `catching_up` the engine opens live FIRST — `openLive()` is invoked (its signals buffered) BEFORE `catchUp()` is drained — then drains `catchUp()` to completion, then flushes the live buffer (`catching_up → buffering_live → live`). Live signals arriving during catch-up are buffered by the engine, not the adapter. **(amended 2026-07-13, S7 Stage-1 review — the prior wording said "catchUp drained before openLive," which contradicts AC-FSM-2, fsm.md §"Cutover protocol" step 1, and I-FSM-2; opening live only after catch-up drains would reopen the live-cutover gap the FSM exists to close.)**
- `epoch_advanced` maps to the engine's `group_epoch_advanced` output and the deferred-retry flush; a bare ratchet advance (no epoch change) produces no signal.

**Produced by:** `src/integration/marmot-adapter.ts`
**Consumed by:** `src/engine/receive-engine.ts` (drives via the control interface; consumes `IngestSignal`)
**Defined in:** `src/engine/engine-types.ts` (both `IngestSource` and `IngestSignal`) — the engine owns the type so the adapter implements an engine-defined interface, not vice versa.

---

## Boundary Rules

**Allowed dependency edges:**
- `src/domain/*` → nothing (pure; zero external imports)
- `src/engine/*` → `src/domain/*` (types and pure helpers only)
- `src/persistence/*` → `src/domain/*` (types only), `src/marmot/storage.ts` (IDB infrastructure)
- `src/persistence/*` → `src/engine/engine-types.ts` ONLY (amended 2026-07-12, Stage-2 cold review — P1-1): seam types + IDB key constants only — never `receive-engine.ts` or any other `src/engine/` file. **Rationale:** AC-BOUND-3 mandates persistence reference the exported key constants; without this edge the contract deadlocks (persistence cannot durably satisfy Boundary Rule 8/9 without importing the file that defines the keys).
- `src/engine/*` → `src/persistence/*` via `PersistenceAdapter` interface only (calls methods; never imports implementation)
- `src/integration/*` → `src/engine/*`, `src/domain/*`, `src/persistence/*`, React/Next.js
- `src/integration/marmot-adapter.ts` → marmot-ts (`MarmotGroup`, `MarmotClient`) — this is the ONLY file permitted to import marmot-ts types outside the engine receive path

**Forbidden:**
1. `src/engine/*` must not import `react`, `next`, `next/navigation`, or any file under `src/integration/`.
2. `src/domain/*` must not import `src/engine/`, `src/persistence/`, `src/integration/`, or the DOM.
3. `src/persistence/*` must not import `src/engine/` (EXCEPT `engine-types.ts`, types/constants only) or `src/integration/`. Persistence never calls the engine. (amended 2026-07-12, Stage-2 cold review — P1-1)
4. Any layer other than `src/integration/*` calling `useState`, `useEffect`, `useRef`, or dispatching DOM events.
5. Any new correctness logic added to `src/marmot/device-sync.ts` or `src/store/task-store.tsx` during migration. Both are scheduled for replacement.
6. `ensureMonotonicTimestamp` entering the projector or domain reducer.
7. `OutboxEntry.createdAt` being mutated after creation.
8. Any IDB key not defined in `src/engine/engine-types.ts` being introduced by an implementation agent.
9. `src/engine/receive-engine.ts` importing marmot-ts types directly. RESOLVED: the engine consumes only `IngestSignal` (marmot-free) and drives ingest via the `IngestSource` control interface; all marmot calls live in `marmot-adapter.ts`. See the IngestSource / IngestSignal seam contract.
10. `src/integration/marmot-adapter.ts` having any independent React lifecycle. ENFORCED STRUCTURALLY (resolves Open Question §8): the engine **owns** the adapter — the adapter is constructed and handed to the engine, the engine holds the only reference, and `engine.stop()` (FSM L10) calls `adapter.close()` as its final action. The React integration manages exactly **one** object (the engine) with one `useEffect` cleanup (`engine.stop()`); the adapter MUST NOT register its own effect/cleanup. Teardown order is therefore a function of call sequence inside `stop()`, not React effect registration order — the `group.off()`-before-`engine.stop()` starvation is structurally impossible.

---

## Extraction Seams  *(S13 — Library Character, spec.md §"Library Character")*

spec.md's Library Character section names the goal: `src/domain/` and `src/engine/`
should remain extractable as a standalone package without forcing abstractions that
slow delivery for hypothetical consumers that don't yet exist. This epic never built
a separate package; this section is the closing inventory a future extraction would
need, consolidating pointers into the contracts already frozen above rather than
re-deriving them.

**What the reusable core owns (per Library Character):** the receive engine, its
state machine, raw event log contracts, event normalization contracts, projection
interfaces, and persistence adapter interfaces — i.e. everything under
`src/domain/` and `src/engine/`. The app-specific shell (`src/integration/`,
`src/store/`, `src/marmot/`) owns the task domain schema, UI selectors, React
integration, and visual degraded/recovery states, and stays behind.

**The seven frozen seam contracts** (full field tables, invariants, producer/consumer
pairs, and IDB keys are in "Seam Contracts" above — not re-stated here):

| Seam | Crosses | Section |
|---|---|---|
| `RawProtocolFact` / `RawProtocolFactInput` | adapter → engine → persistence | Seam Contracts § RawProtocolFact |
| `AcceptedDomainEvent` | engine → domain projector, persistence | Seam Contracts § AcceptedDomainEvent |
| `EngineCheckpoint` | engine ↔ persistence | Seam Contracts § EngineCheckpoint |
| `EngineOutputEvent` | engine → integration | Seam Contracts § EngineOutputEvent |
| `OutboxEntry` | integration → integration (adapter outbox bridge) | Seam Contracts § OutboxEntry |
| `PersistenceAdapter` | engine → persistence (interface-only call boundary) | Seam Contracts § PersistenceAdapter |
| `IngestSource` / `IngestSignal` | engine ↔ adapter (control + data interface) | Seam Contracts § IngestSource / IngestSignal |

All seven are defined in `src/engine/engine-types.ts` (the cross-module type and
IDB-key authority — Rule 8/9) or `src/domain/domain-events.ts`/`task-events.ts`
(the wire/domain types `AcceptedDomainEvent`/`EngineOutputEvent` carry). A consumer
extracting `src/domain/` + `src/engine/` needs no other source file to recover these
contracts — `type_name`, `fields`, and `invariants` are complete as documented above.

**What keeps `src/domain/` and `src/engine/` extraction-clean** (full text in
"Boundary Rules" above): Boundary Rules 1–3 forbid `src/domain/*` importing
anything (pure, zero external imports) and forbid `src/engine/*` importing React,
Next.js, or `src/integration/*` — the two structural tests that enforce this
cumulatively (`domain-boundary.structural.test.ts` for `src/domain/*`,
`engine-boundary.structural.test.ts`'s AC-BOUND-1 for `src/engine/*`) are
themselves part of what a fork would need to carry forward to keep the extraction
honest over time. `src/engine/*` reaches `src/persistence/*` only through the
`PersistenceAdapter` interface (never an implementation import), so a consumer can
swap in any storage backend that satisfies the ten-method contract without touching
engine code. `src/domain/*` → `src/engine/*` is the one permitted inward edge (types
and pure helpers only), which is why a package boundary would most naturally sit
around `src/domain/` + `src/engine/` together, not split between them. AC-BOUND-3
(IDB key literal ownership — five keys as of S13: raw-facts, accepted-events,
engine-checkpoints, deferred-ids, outbox) and AC-BOUND-4 (single tie-break
authority, `task-crdt.ts`'s `taskWinsOver`) are the two narrower structural guards
that stop drift from silently reintroducing a second source of truth for either
concern.

---

## Recovery Sequencing  *(resolves Open Question §7 — three-way replay)*

The `recovering` lifecycle (FSM L1, taken on `start({origin:"restored"})`) rebuilds
in-memory state from three persisted stores without re-decrypting through the
already-advanced MLS ratchet. Inputs: `rawLog` (ordered by `seq`), `acceptedLog`,
`deferredIds` (set), and the `EngineCheckpoint`.

**The disambiguation rule:** a fact's disposition is decided by **which store it is
in**, plus the `seq` watermark — never by comparing content-hash ids (they are not
ordered). This is what resolves the "id in raw-log AND deferred-store, NOT in
accepted-log, yet already ingested" ambiguity.

| Step | Action |
|---|---|
| **R1 — Rebuild projection** | `projection = buildProjection(replayOrder(acceptedLog))`, where `replayOrder` = bootstrap-sourced events first, then MLS-sourced, each in `seq`/append order (NOT `acceptedAt` clock). Deterministic per Invariants 1 & 4. |
| **R2a — Prune stale deferred ids** *(added 2026-07-12)* | Compute `deferredIds ∩ {e.factId \| e ∈ acceptedLog}`; remove every such id from `deferred-store`. These are facts whose `acceptDeferredFact` crashed between the accepted-append and the deferred-remove — accepted wins (see R-INV-3). Runs BEFORE R2 so an already-accepted fact is never re-queued. |
| **R2 — Rebuild deferred queue** | Re-queue every id in `deferredIds` (post-R2a) into the `PendingRetryQueue`. Their ciphertext lives in `rawLog` keyed by id; they await `epoch_advanced` (FSM L8). Do NOT re-ingest them now. **Ids-only contract, known-lossy by design:** `deferred-store` persists fact ids ONLY — no `DeferredReason`, no `queuedAt`, no attempt count. Every rebuilt entry is therefore given a synthetic, current `queuedAt` (rebuild time) and a reset `attempts: 0`, regardless of how long the fact had actually been parked or how many retry passes it had already survived before the restart. **(extended 2026-07-12, S6 Stage-2 cold review — P3-6):** this means an entry's TTL age (`maxDeferredAgeSec`) and retry-attempt budget (`maxRetryAttempts`) BOTH reset on every restart, by the same mechanism — they are in-memory-only bookkeeping (`ingest-policy.ts`'s `DeferredPolicyEntry.queuedAt`/`attempts`), not durable fields. A parked entry can therefore evade both budgets indefinitely across repeated restarts (e.g. an entry one retry pass away from TTL-pruning or attempt-exhaustion gets a fresh budget on every crash/restart before either fires) — this is ACCEPTABLE KNOWN-LOSSY behavior BY DESIGN, not a gap to close by persisting more fields to `deferred-store` (a real format change, rejected for the same reason `DeferredReason` persistence was rejected — see `receive-engine.ts`'s `enterRecovering` R2 contract-note comment). The backstops are: relay re-sync (the fact keeps arriving on subsequent live/catch-up drains regardless of local budget state) and the deferred-queue's own `maxDeferredSize` cap-with-evict-eldest eviction, neither of which depends on age/attempt accuracy surviving a restart. |
| **R3 — Re-ingest the crash-gap tail** | For each `rawLog` fact with `seq > checkpoint.lastIngestedSeq`, submit it to the adapter for ingest. These were persisted to the raw-log but the crash preceded their ingest. Facts with `seq <= lastIngestedSeq` are NEVER re-submitted (ratchet already consumed them; outcome already in `acceptedLog` or `deferredIds`). |
| **R4 — Resume** | `recovering → catching_up` (L3): open live + drain `catchUp()` for anything that arrived on the relay while offline. |

**Invariants:**
- **R-INV-1:** Recovery disposition uses store membership + `seq` watermark only. Never order or compare facts by `id`.
- **R-INV-2:** No fact with `seq <= lastIngestedSeq` is re-submitted to ingest. (At best a no-op skip; at worst a double-apply.)
- **R-INV-3 (revised 2026-07-12, Stage-1 review sev-6):** *steady-state invariant:* `deferredIds ∩ {e.factId | e ∈ acceptedLog} = ∅` — a fact is parked XOR accepted. Acceptance goes through the single typed entry point `PersistenceAdapter.acceptDeferredFact(groupId, factId, event)`, whose contract is **accepted-first crash-safe ordering** (append accepted, then remove deferred — see the PersistenceAdapter seam contract): a hard cross-store IDB transaction is impossible under the mandated `createKVStore` per-database layout. Consequence: after a crash the intersection may be transiently non-empty (fact in BOTH stores — never in neither, because deferred-removal only follows a successful accepted-append). Recovery step **R2a** restores the invariant before the queue is rebuilt: accepted wins, the stale deferred id is pruned. Implementations MUST NOT satisfy acceptance with reversed ordering or with ad-hoc separate calls outside `acceptDeferredFact`.
- **R-INV-4:** Projection after R1+R3 equals the in-memory projection at crash time plus any gap-tail facts — i.e. Invariant 4 (rebuild equality) holds across restart.

---

## Re-join and Reset  *(implements Decision 3 — resolves Open Question §3)*

**Detection.** The engine cannot infer first-join vs restart vs re-join from
local state alone. The integration layer (which knows whether a `MarmotGroup` was
created from a fresh Welcome or rehydrated from persisted `SerializedClientState`)
passes an explicit origin into `start()`:

| `start({origin})` | Meaning | Path |
|---|---|---|
| `"restored"` | group rehydrated from persisted MLS state on app launch | L1 → `recovering` (replay local log) |
| `"welcome"` | group (re)created from a freshly processed MLS Welcome | L2 → `joining` (fetch fresh bootstrap) |

**Re-join sequencing.** A new Welcome for a group that already has local state is a
re-join (e.g. the `forget-device` per-leaf flow → re-invite). The integration
layer handles it as a **dispose-then-recreate**:

1. If an engine instance for the group is live, `stop()` it (L10).
2. Call `reset()` (L11) — clears **all** persisted per-group state: raw-log,
   accepted-log, checkpoint, deferred ids, and the `bootstrap-completed` flag.
   **Realized by `PersistenceAdapter.clearGroupState(groupId)`** (amended
   2026-07-12, Stage-2 cold review — P1-2). Note the `bootstrap-completed`
   flag lives IN the checkpoint (`EngineCheckpoint.bootstrapCompleted`) —
   clearing the checkpoint clears it too; this still satisfies Decision 3.
3. `start({origin:"welcome"})` → `joining` → fresh bootstrap snapshot rebuilds
   current task state.

**Why a full reset, not just the accepted-log.** Decision 3 (and the spec
amendment) names the accepted-log + bootstrap flag. The engine widens this to a
full per-group reset because a new Welcome makes the prior MLS ratchet
unrecoverable: the old raw-log facts are ciphertext no surviving key can decrypt,
and the old checkpoint references a dead epoch/membership. Keeping them would make
a later restart (L1) replay permanently-unreadable facts that park in the deferred
queue forever. Clearing everything and rebuilding from the fresh bootstrap is both
simpler and strictly more correct; it fully satisfies the product decision (a
re-joining device is never stranded on stale data).

**Convergence note.** Correctness of "clear local, rebuild from bootstrap" rests
on the existing kind-30078 bootstrap delivering LWW-merged current state — an
unchanged protocol behavior. No wire-format or convergence-rule change; the parent
`../protocol/task-protocol.md` is unaffected.

---

## Implementation Constraints

Numbered constraints that integration-architect subagents must comply with before dispatching stories:

1. **Product decisions — DECIDED (ADR-002, 2026-06-29). These are now binding; do not re-open:**
   - (a) **AcceptedDomainEvent.id bootstrap contract:** Bootstrap-sourced id is `"bootstrap:${groupId}:${task.id}"` (formalized in the AcceptedDomainEvent seam above). Engineering task: ensure all agents read this contract; do not invent an alternative key.
   - (b) **Re-join accepted-log reset policy — DECIDED: reset.** On re-join (new MLS Welcome), the engine clears the per-group accepted-event log and the `bootstrap-completed` IDB flag before the joining phase replays the fresh snapshot. This prevents the bootstrap idempotency key from silencing the new snapshot and stranding a re-joining device on stale data. spec.md amended (Ordering and Identity → "Re-join must reset the local accepted-event log"). Detection + sequencing delivered in the "Re-join and Reset" section (origin discriminator + dispose-then-recreate; widened to a full per-group reset). Settled before Phase 2 `appendAcceptedEvent` idempotency.
   - (c) **Invariant 3 — DECIDED: narrow to same-epoch replay.** Recovery equivalence is guaranteed from the current encryption epoch forward only; cross-epoch recovery of events undecryptable across an epoch advance is out of scope (recovered by relay re-sync instead). spec.md amended (P4, Invariant 3, Out of Scope). The expensive alternative — a per-epoch key-snapshot fork extension — was rejected as out of scope for this epic.

2. **Joining-gate timeout — DECIDED (ADR-002, 2026-06-29) and SPECIFIED.** `T_join = 8000 ms` (configurable). On timeout or terminal bootstrap failure the engine takes transition L5 → `catching_up` with `health = degraded`, rather than blocking the group. The bootstrap fetch is NOT cancelled on timeout: it continues in the background and a late result merges (LWW-safe) and restores nominal health (H2). Full wiring in [`./fsm.md`](./fsm.md) → "Joining timeout (`T_join`)". Preserves today's graceful relay-down behavior.

3. **Engine↔adapter ingest ownership — DELIVERED (2026-06-29; stale "requires a human decision" wording removed 2026-07-12).** The precondition this constraint demanded is satisfied by the `IngestSource` / `IngestSignal` seam contract (see Seam Contracts and Open Question §4): `marmot-adapter.ts` is the sole caller of `group.ingest()` and the subscription; the engine drives via `catchUp()`/`openLive()`/`close()` and consumes marmot-free `IngestSignal`s. Stories MUST implement that contract; do not re-open the ET-1 question.

4. **FSM transition table — DELIVERED in [`./fsm.md`](./fsm.md).** `receive-engine.ts` stories MUST conform to it: the `{ lifecycle, health }` encoding (degraded is orthogonal health, never a lifecycle peer), transitions L1–L11 + H1–H2, the cutover protocol, and invariants I-FSM-1..6. Any state-machine deviation from `fsm.md` is a review-blocking defect.

5. **Recovery sequencing — DELIVERED in the "Recovery Sequencing" section.** The three-way replay (raw-log / deferred-store / checkpoint) is specified as steps R1–R4 with invariants R-INV-1..4. The id-ordering ambiguity is resolved by a monotonic `seq` watermark (`lastIngestedSeq`) plus store-membership disposition; deferred facts are recovered from `deferred-store` (R2), not from a raw-log id comparison. Phase 7 stories MUST follow R1–R4.

6. **Phase 3 scope is projection-layer validation only.** State-machine behavior — joining-gate delay, live-cutover drop/reorder (`syncGroup:993-1009`), deferred-retry timing — produces no signal in Phase 3 (engine inactive in listener-only mode). FSM unit tests for `receive-engine.ts` MUST be required before Phase 5 stories to compensate. Phase 3 passing does NOT indicate state-machine correctness.

7. **Incremental projection is mandatory.** `react-engine-hooks.ts` MUST call `applyEvent(currentProjection, event.payload)` per `domain_event_accepted`. Full `buildProjection` is reserved for restart and explicit `projection_invalidated`. Emitting `projection_invalidated` on ratchet-advance `stateChanged` is forbidden (see EngineOutputEvent invariants).

8. **IDB key compliance is mandatory.** All persistence implementations MUST use keys from `src/engine/engine-types.ts`. An agent introducing a new IDB key without amending `engine-types.ts` violates Rule 9 and may cause checkpoint-store / accepted-events cross-story reference failures.

9. **Legacy `notestr:events:${groupId}` is read-only from Phase 2 onward.** No new writes after `raw-event-log-store.ts` is introduced. Removed in Phase 8.

10. **`task-crdt.ts` is the single tie-break authority.** Both `applyEvent` (`task-reducer.ts:18-32`) and the bootstrap merge gate (`device-sync.ts:1433-1452`) must delegate to `taskWinsOver`. Any new tie-break logic must go into `task-crdt.ts`; implementing it independently in either call site reconstitutes the duplicate-projection drift risk.

11. **Persistence I/O failure → degraded, never silent drop (added 2026-07-12, spec validation).** A failed `appendFact` / `appendAcceptedEvent` / `saveCheckpoint` (IDB quota exceeded, transaction abort) is a new H1 trigger cause: the engine enters `health: degraded`, retries the write with bounded backoff, and MUST NOT silently discard the fact or continue as nominal. A fact that cannot be durably appended is held in memory while degraded; if the engine stops before the write succeeds, the fact is recovered on next start via relay re-sync (same recovery channel as cross-epoch loss). Recovery of write capability restores nominal health (H2).

12. **Malformed/unreadable `EngineCheckpoint` at restart → route by store contents (added 2026-07-12, spec validation; reconciled with the L2 widening same day, Stage-1 review sev-6).** A checkpoint that exists but fails to deserialize is treated as absent, and the restored-start routing then disambiguates on the local logs (this is the single authority, mirrored by fsm.md L1/L2 guards):
    - **Raw-log or accepted-log non-empty → L1 `recovering` (preserve-and-replay).** Recovery runs with `lastIngestedSeq = 0` — R3 re-submits the full raw-log, safe because already-consumed facts yield adapter `skipped` (no-op) and `appendAcceptedEvent` is idempotent on `id`. Do NOT escalate to a full `reset()` — intact logs are more authoritative than a lost checkpoint. `health = degraded` until the first successful checkpoint save; **the preserve-and-replay arm re-infers `bootstrapCompleted = true` IMMEDIATELY on taking the arm (before any checkpoint is saved), so a crash mid-recovery re-routes the next start back to L1 preserve-and-replay rather than L2 joining over non-empty logs (revised 2026-07-12, S5 Stage-2 cold review — P2-1; the prior on-reaching-live wording allowed mid-recovery checkpoints to persist `false` and poison the routing)**.
    - **Both logs empty → L2 `joining`.** Nothing local to preserve (migration-cutover population, or corruption before anything landed); run the joining-phase bootstrap fetch.

13. **`parse_error` is terminal (added 2026-07-12, spec validation).** See the EngineOutputEvent invariant and the `malformed` IngestSignal variant: a payload that decrypted but cannot decode into a `TaskEvent` routes to `domain_event_rejected` (permanent, observable) — never to the deferred queue, never into L8 epoch-advance retry. Rationale: an epoch advance can never fix a parse error; parking it means either infinite unproductive retries or silent permanent loss.

---

## Open Questions / Accepted Risks

Items below require a verifier or integration architect to watch for and resolve. The five product-behavior decisions (former items 1–3, 5, 9) were RESOLVED on 2026-06-29 (ADR-002) and the spec amended; they are recorded here for traceability. The remaining engineering-internal items (4, 6, 7, 8) still require the integration architect to resolve before the indicated phase.

1. **RESOLVED (2026-06-29) — Phase 3 scope:** Phase 3 is scoped as **projection-layer validation only**. It does not validate state-machine behavior (joining-gate, live-cutover, deferred-retry are inactive in listener-only mode). FSM unit tests for `receive-engine.ts` are mandated as a Phase 5 entry gate to compensate (see Implementation Constraint §6). Phase 3 passing does NOT indicate state-machine correctness — no false-confidence reliance on it.

2. **RESOLVED (2026-06-29) — Invariant 3 narrowed:** Invariant 3 is narrowed to same-epoch replay only; cross-epoch recovery is out of scope (recovered by relay re-sync). spec.md amended at P4, Invariant 3, and Out of Scope. The per-epoch key-snapshot fork extension was rejected as out of scope for this epic. See Implementation Constraint §1(c).

3. **RESOLVED (2026-06-29) — Re-join resets local state:** Detection and sequencing delivered in the "Re-join and Reset" section: the integration layer passes `start({origin})` (`"restored"` vs `"welcome"`); a re-join is handled as `stop()` → `reset()` (full per-group clear) → `start({origin:"welcome"})` → fresh bootstrap. Widened from accepted-log-only to a full reset so a later restart never replays dead old-epoch ciphertext. spec.md amended (Ordering and Identity); no protocol change. See Implementation Constraint §1(b).

4. **RESOLVED (2026-06-29) — Engine<->adapter ingest seam:** Resolved by the `IngestSource` / `IngestSignal` seam contract (see Seam Contracts). The adapter is the sole marmot-coupled site (calls `group.ingest()`, the subscription, `deserializeApplicationData`, epoch reads) and emits marmot-free `IngestSignal`s; the engine drives ingest via the `IngestSource` control interface (`catchUp` / `openLive` / `close`) and makes all accept/defer/dedupe/normalize decisions, importing no marmot types. Both `IngestSource` and `IngestSignal` are defined in `engine-types.ts`. Boundary Rule 9 updated. ET-1 holds (marmot API change → only `marmot-adapter.ts`).

5. **RESOLVED (2026-06-29) — Joining-gate timeout:** Specified: `T_join = 8000 ms`, transition L5 (`joining → catching_up` degraded) on timeout/failure, background fetch continuation with late-merge → nominal (H2). See [`./fsm.md`](./fsm.md) "Joining timeout" and Implementation Constraint §2. Fully delivered; no remaining follow-up.

6. **RESOLVED (2026-06-29) — FSM transition table:** Authored in [`./fsm.md`](./fsm.md): lifecycle states, the orthogonal `{ lifecycle, health }` encoding, all transitions (L1–L11, H1–H2) with triggers/guards/entry actions, the gap-free catch-up→live cutover protocol, and six FSM invariants. This is the Phase 5 entry gate for `receive-engine.ts` stories.

7. **RESOLVED (2026-06-29) — Recovery sequencing:** Specified as the "Recovery Sequencing" section (steps R1–R4, invariants R-INV-1..4). Added a monotonic `seq` to `RawProtocolFact` and changed the checkpoint marker to `lastIngestedSeq`; recovery re-ingests only `seq > lastIngestedSeq` and recovers deferred facts from `deferred-store`. See Implementation Constraint §5.

8. **RESOLVED (2026-06-29) — Rule 10 enforced by ownership:** Replaced the unenforceable "adapter outlasts engine" convention with single-ownership: the engine owns the adapter, React manages exactly one object (the engine) with one cleanup (`engine.stop()`), and `stop()` closes the adapter last (FSM L10). The adapter has no independent React effect. Teardown order follows call sequence, not effect registration order; the `group.off()`-starvation path is structurally impossible. See Boundary Rule 10.

9. **RESOLVED (2026-06-29) — spec.md broken links:** The links to `docs/quizzl-report.md` and `docs/shophop-report.md` (which do not exist in the repo) were removed from spec.md "Lessons From Related Projects"; the distilled patterns were reframed as standing on their own. spec.md is now self-consistent on this point.
