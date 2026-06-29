# Epic Architecture: event-sourced-receive-engine

**ADR**: docs/adr/ADR-002-event-sourced-receive-engine.md
**Status**: current
**Last updated**: 2026-06-29

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

---

## Seam Contracts

### RawProtocolFact

| Field | Type | Optional |
|---|---|---|
| id | string | no — `nostrEvent.id`; content-addressed; idempotency key |
| groupId | string | no — `group.idStr` (MLS hex group ID) |
| nostrEventId | string | no — same as `id`; explicit for query clarity |
| nostrEvent | NostrEvent | no — full relay envelope |
| receivedAt | number | no — client-side ms at ingest call (`Date.now()`) |
| receiptSource | `"historical" \| "live" \| "bootstrap-kind-30078"` | no |
| epochAtReceipt | string | no — DIAGNOSTIC ONLY |

**Invariants:**
- `id` is stable across duplicate deliveries of the same relay event (content-addressed).
- `epochAtReceipt` MUST NOT be used as a retrieval key for past `SerializedClientState`. No snapshot-at-epoch API exists in marmot-ts. This field is diagnostic metadata only.
- Bootstrap-sourced facts enter the same store as MLS-sourced facts; `receiptSource` discriminates origin.
- `nostrEvent.content` is encrypted MLS ciphertext; raw-fact storage does not attempt decryption.

**Produced by:** `src/integration/marmot-adapter.ts`
**Consumed by:** `src/engine/receive-engine.ts` (ingest), `src/persistence/raw-event-log-store.ts` (durability)
**IDB key:** `notestr:raw-facts:${groupId}` (defined in `src/engine/engine-types.ts`)

---

### AcceptedDomainEvent

| Field | Type | Optional |
|---|---|---|
| id | string | no — MLS path: `rumor.id`; bootstrap: `"bootstrap:${groupId}:${task.id}"` |
| factId | `string \| null` | no — `null` for bootstrap-sourced (no `RawProtocolFact` backing) |
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
| lastEpoch | string | no — MLS epoch string |
| lastIngestedFactId | string | no — last `RawProtocolFact.id` through `group.ingest` (= `syncedEventIds`; includes processed + skipped) |
| lastAcceptedDomainEventId | string | no — last `AcceptedDomainEvent.id` produced |
| deferredNostrEventIds | string[] | no — events in `PendingRetryQueue` at checkpoint time |

**Invariants:**
- `lastIngestedFactId` and `lastAcceptedDomainEventId` are DISTINCT markers. An unreadable/deferred event advances `lastIngestedFactId` but NOT `lastAcceptedDomainEventId`. Conflating them is a known anti-pattern from the original proposal.
- OPEN RISK: Recovery sequencing across raw-log / deferred-store / checkpoint is UNSPECIFIED (see Open Questions §7). Do not implement Phase 7 without a defined three-way intersection replay protocol.
- On restart, engine uses `lastIngestedFactId` to skip already-processed raw-log facts during recovery replay.

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
- `envelope_deferred` — `{ factId, groupId, reason: "unreadable" | "epoch_mismatch" | "parse_error" }`
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
| `appendFact(fact: RawProtocolFact): Promise<void>` | Idempotent on `fact.id` |
| `loadFacts(groupId: string): Promise<RawProtocolFact[]>` | |
| `appendAcceptedEvent(event: AcceptedDomainEvent): Promise<void>` | Idempotent on `event.id` |
| `loadAcceptedEvents(groupId: string): Promise<AcceptedDomainEvent[]>` | |
| `saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void>` | |
| `loadCheckpoint(groupId: string): Promise<EngineCheckpoint \| null>` | |
| `saveDeferredIds(groupId: string, ids: string[]): Promise<void>` | |
| `loadDeferredIds(groupId: string): Promise<string[]>` | |

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
| `catchUp(): AsyncIterable<IngestSignal>` | Drain historical events through `group.ingest()` once; yields one signal per event. |
| `openLive(onSignal: (s: IngestSignal) => void): Unsubscribe` | Open the live `client.network.subscription()`; pushes signals as they arrive. |
| `close(): void` | Close subscription and release marmot handles. Called by the engine during `stop()`. |

**Data interface — `IngestSignal` (discriminated union, marmot-free):**

| Variant | Fields | Meaning |
|---|---|---|
| `message` | `{ fact: RawProtocolFact, rumorId: string, payload: TaskEvent, epoch: string, receiptSource }` | `group.ingest` decrypted an application message; `payload` already decoded via `deserializeApplicationData` (in the adapter). |
| `deferred` | `{ fact: RawProtocolFact, reason: "unreadable" \| "epoch_mismatch", epoch }` | Event received but not yet decryptable; engine parks it. |
| `skipped` | `{ factId: string }` | Ratchet already consumed this id (own-echo / duplicate); no payload. |
| `epoch_advanced` | `{ newEpoch: string, prevEpoch: string }` | Translated from marmot `stateChanged` when the epoch changed; triggers deferred-retry. |

**Invariants:**
- `IngestSignal` carries **no marmot-ts types**. `payload` is the app's own `TaskEvent` wire type; `RawProtocolFact` is already marmot-free (a `NostrEvent` envelope). Decoding and epoch reads happen inside the adapter.
- The engine never calls `group.ingest()` or the subscription directly. The adapter never makes accept/defer/dedupe/normalize decisions — those are engine-owned.
- `catchUp()` must be drained to completion before `openLive()` is invoked for the same group (the engine's `catching_up → buffering_live` transition); live signals arriving during catch-up are buffered by the engine, not the adapter.
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
- `src/engine/*` → `src/persistence/*` via `PersistenceAdapter` interface only (calls methods; never imports implementation)
- `src/integration/*` → `src/engine/*`, `src/domain/*`, `src/persistence/*`, React/Next.js
- `src/integration/marmot-adapter.ts` → marmot-ts (`MarmotGroup`, `MarmotClient`) — this is the ONLY file permitted to import marmot-ts types outside the engine receive path

**Forbidden:**
1. `src/engine/*` must not import `react`, `next`, `next/navigation`, or any file under `src/integration/`.
2. `src/domain/*` must not import `src/engine/`, `src/persistence/`, `src/integration/`, or the DOM.
3. `src/persistence/*` must not import `src/engine/` or `src/integration/`. Persistence never calls the engine.
4. Any layer other than `src/integration/*` calling `useState`, `useEffect`, `useRef`, or dispatching DOM events.
5. Any new correctness logic added to `src/marmot/device-sync.ts` or `src/store/task-store.tsx` during migration. Both are scheduled for replacement.
6. `ensureMonotonicTimestamp` entering the projector or domain reducer.
7. `OutboxEntry.createdAt` being mutated after creation.
8. Any IDB key not defined in `src/engine/engine-types.ts` being introduced by an implementation agent.
9. `src/engine/receive-engine.ts` importing marmot-ts types directly. RESOLVED: the engine consumes only `IngestSignal` (marmot-free) and drives ingest via the `IngestSource` control interface; all marmot calls live in `marmot-adapter.ts`. See the IngestSource / IngestSignal seam contract.
10. `src/integration/marmot-adapter.ts` being torn down before `src/engine/receive-engine.ts` is stopped.

---

## Implementation Constraints

Numbered constraints that integration-architect subagents must comply with before dispatching stories:

1. **Product decisions — DECIDED (ADR-002, 2026-06-29). These are now binding; do not re-open:**
   - (a) **AcceptedDomainEvent.id bootstrap contract:** Bootstrap-sourced id is `"bootstrap:${groupId}:${task.id}"` (formalized in the AcceptedDomainEvent seam above). Engineering task: ensure all agents read this contract; do not invent an alternative key.
   - (b) **Re-join accepted-log reset policy — DECIDED: reset.** On re-join (new MLS Welcome), the engine clears the per-group accepted-event log and the `bootstrap-completed` IDB flag before the joining phase replays the fresh snapshot. This prevents the bootstrap idempotency key from silencing the new snapshot and stranding a re-joining device on stale data. spec.md amended (Ordering and Identity → "Re-join must reset the local accepted-event log"). Remaining engineering work: detect re-join vs plain restart and sequence the reset before `appendAcceptedEvent` idempotency lands (Phase 2).
   - (c) **Invariant 3 — DECIDED: narrow to same-epoch replay.** Recovery equivalence is guaranteed from the current encryption epoch forward only; cross-epoch recovery of events undecryptable across an epoch advance is out of scope (recovered by relay re-sync instead). spec.md amended (P4, Invariant 3, Out of Scope). The expensive alternative — a per-epoch key-snapshot fork extension — was rejected as out of scope for this epic.

2. **Joining-gate timeout — DECIDED (ADR-002, 2026-06-29): timeout → degraded.** The `joining` gate must have an explicit timeout; on timeout or bootstrap failure the engine transitions forward into `catching_up`/`live` in a `degraded` health state rather than blocking the group. This preserves today's graceful relay-down behavior (`bootstrap` fails non-fatally at `device-sync.ts:602`, work continues locally, sync catches up later). spec.md amended (Desired Engine State Machine). Remaining engineering work: choose the timeout value and wire the `joining → degraded` failure transition.

3. **Engine + adapter stories require a human decision before implementation:** Resolve who calls `group.ingest()` and who drives the subscription before either `receive-engine.ts` or `marmot-adapter.ts` stories are written. Both cannot simultaneously call `group.ingest()` — this is the ET-1 contradiction identified in Round 2. Deliver a typed contract specifying what the engine receives from the adapter (raw `NostrEvent[]`, `IngestResult` async iterable, or other) as a precondition.

4. **FSM transition table — DELIVERED in [`./fsm.md`](./fsm.md).** `receive-engine.ts` stories MUST conform to it: the `{ lifecycle, health }` encoding (degraded is orthogonal health, never a lifecycle peer), transitions L1–L11 + H1–H2, the cutover protocol, and invariants I-FSM-1..6. Any state-machine deviation from `fsm.md` is a review-blocking defect.

5. **Recovery sequencing specification required before Phase 7.** The three-way intersection replay protocol (raw-log / deferred-store / checkpoint) is undefined. An unreadable event has its id in raw-log AND deferred-store but NOT accepted-log, yet `lastIngestedFactId` is set. On recovery: skipping facts `<= lastIngestedFactId` silently drops the deferred event needing retry; not skipping re-ingests already-processed events. This ambiguity is a Phase 7 blocker.

6. **Phase 3 scope is projection-layer validation only.** State-machine behavior — joining-gate delay, live-cutover drop/reorder (`syncGroup:993-1009`), deferred-retry timing — produces no signal in Phase 3 (engine inactive in listener-only mode). FSM unit tests for `receive-engine.ts` MUST be required before Phase 5 stories to compensate. Phase 3 passing does NOT indicate state-machine correctness.

7. **Incremental projection is mandatory.** `react-engine-hooks.ts` MUST call `applyEvent(currentProjection, event.payload)` per `domain_event_accepted`. Full `buildProjection` is reserved for restart and explicit `projection_invalidated`. Emitting `projection_invalidated` on ratchet-advance `stateChanged` is forbidden (see EngineOutputEvent invariants).

8. **IDB key compliance is mandatory.** All persistence implementations MUST use keys from `src/engine/engine-types.ts`. An agent introducing a new IDB key without amending `engine-types.ts` violates Rule 9 and may cause checkpoint-store / accepted-events cross-story reference failures.

9. **Legacy `notestr:events:${groupId}` is read-only from Phase 2 onward.** No new writes after `raw-event-log-store.ts` is introduced. Removed in Phase 8.

10. **`task-crdt.ts` is the single tie-break authority.** Both `applyEvent` (`task-reducer.ts:18-32`) and the bootstrap merge gate (`device-sync.ts:1433-1452`) must delegate to `taskWinsOver`. Any new tie-break logic must go into `task-crdt.ts`; implementing it independently in either call site reconstitutes the duplicate-projection drift risk.

---

## Open Questions / Accepted Risks

Items below require a verifier or integration architect to watch for and resolve. The five product-behavior decisions (former items 1–3, 5, 9) were RESOLVED on 2026-06-29 (ADR-002) and the spec amended; they are recorded here for traceability. The remaining engineering-internal items (4, 6, 7, 8) still require the integration architect to resolve before the indicated phase.

1. **RESOLVED (2026-06-29) — Phase 3 scope:** Phase 3 is scoped as **projection-layer validation only**. It does not validate state-machine behavior (joining-gate, live-cutover, deferred-retry are inactive in listener-only mode). FSM unit tests for `receive-engine.ts` are mandated as a Phase 5 entry gate to compensate (see Implementation Constraint §6). Phase 3 passing does NOT indicate state-machine correctness — no false-confidence reliance on it.

2. **RESOLVED (2026-06-29) — Invariant 3 narrowed:** Invariant 3 is narrowed to same-epoch replay only; cross-epoch recovery is out of scope (recovered by relay re-sync). spec.md amended at P4, Invariant 3, and Out of Scope. The per-epoch key-snapshot fork extension was rejected as out of scope for this epic. See Implementation Constraint §1(c).

3. **RESOLVED (2026-06-29) — Re-join resets the accepted-log:** On re-join the engine clears the per-group accepted-event log and `bootstrap-completed` flag before replaying the fresh snapshot, preventing the bootstrap idempotency key from silencing the new snapshot. spec.md amended (Ordering and Identity). See Implementation Constraint §1(b). Engineering follow-up: re-join-vs-restart detection and reset sequencing.

4. **RESOLVED (2026-06-29) — Engine<->adapter ingest seam:** Resolved by the `IngestSource` / `IngestSignal` seam contract (see Seam Contracts). The adapter is the sole marmot-coupled site (calls `group.ingest()`, the subscription, `deserializeApplicationData`, epoch reads) and emits marmot-free `IngestSignal`s; the engine drives ingest via the `IngestSource` control interface (`catchUp` / `openLive` / `close`) and makes all accept/defer/dedupe/normalize decisions, importing no marmot types. Both `IngestSource` and `IngestSignal` are defined in `engine-types.ts`. Boundary Rule 9 updated. ET-1 holds (marmot API change → only `marmot-adapter.ts`).

5. **RESOLVED (2026-06-29) — Joining-gate timeout:** The `joining` gate gets an explicit timeout; on timeout/bootstrap-failure the engine transitions forward into `catching_up`/`live` in `degraded` health rather than blocking the group, preserving today's graceful relay-down behavior. spec.md amended (Desired Engine State Machine). See Implementation Constraint §2. Engineering follow-up: timeout value and the `joining → degraded` transition wiring.

6. **RESOLVED (2026-06-29) — FSM transition table:** Authored in [`./fsm.md`](./fsm.md): lifecycle states, the orthogonal `{ lifecycle, health }` encoding, all transitions (L1–L11, H1–H2) with triggers/guards/entry actions, the gap-free catch-up→live cutover protocol, and six FSM invariants. This is the Phase 5 entry gate for `receive-engine.ts` stories.

7. **Recovery sequencing unspecified:** Three-way intersection replay protocol (raw-log / deferred-store / checkpoint) is undefined (see Implementation Constraint §5). Required before Phase 7. The ambiguity between "skip facts <= `lastIngestedFactId`" and "re-ingest already-processed events" cannot be resolved by an implementation agent without context.

8. **Rule 10 enforcement gap:** Adapter-outlasts-engine has no enforcement mechanism. `useEffect` cleanup order in a shared React provider is registration-order dependent, not guaranteed. Adapter torn down first → `group.off()` removes `applicationMessage`/`stateChanged` before `engine.stop()`, starving the engine during teardown — reproducing the `mountedRef` guard problem (`device-sync.ts:508-509`) the epic aims to eliminate. Must be verified or structurally enforced before the joining-phase story is implemented.

9. **RESOLVED (2026-06-29) — spec.md broken links:** The links to `docs/quizzl-report.md` and `docs/shophop-report.md` (which do not exist in the repo) were removed from spec.md "Lessons From Related Projects"; the distilled patterns were reframed as standing on their own. spec.md is now self-consistent on this point.
