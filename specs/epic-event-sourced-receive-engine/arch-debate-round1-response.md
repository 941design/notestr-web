# Event-Sourced Receive Engine — Round 1 Debate Response

**Status:** Revised proposal incorporating Round-1 challenge. Sections marked REVISED indicate accepted changes. DEFENDED sections cite source evidence.

---

## REVISED PROPOSAL

### 1. Paradigm

**Recommended:** Functional core + imperative shell, three nested shells. **"CQRS-style" is dropped** — it added no testable constraint beyond "one owner of ingest" and imported command/query-model vocabulary not present here.

- **Inner core (pure, no I/O):** `src/domain/` — task reducer, projector, domain event types. `task-reducer.ts:5-105` is already compliant and 100% reusable.
- **Middle shell (imperative, no React):** `src/engine/` — per-group receive state machine. This is **new imperative code being built**, not existing code being liberated; the behavior is understood from device-sync.ts:643-817 but those closure variables must be reconstituted as a class with explicit start()/stop()/reset() lifecycle. Scope of new construction is larger than originally acknowledged.
- **Outer shell (React adapter):** `src/integration/`.

**On hexagonal:** rejection reason corrected — not "two I/O surfaces" but "the marmot-ts ratchet IS the domain model." A hexagonal MLS-ingest port would be a single-implementor interface reproducing all marmot concepts. `marmot-adapter.ts` already serves the adapter role; boundary rules keep marmot coupling contained (evolution trigger ET-1).

**On quizzl/shophop:** both docs confirmed absent. All cross-project justification removed; architecture stands on first-principles grounded in THIS codebase.

### 2. Module Map (key revisions)

- `src/engine/receive-engine.ts` — NEW imperative class. Absorbs ingestGroupEventsRaw/ingestLock/syncedEventIds (device-sync.ts:677-817), syncGroup cutover (895-1010), deferred parking (668-751), attachRetryOnEpochAdvance (819-870). Honestly framed as new construction with explicit lifecycle, not a lift-and-shift.
- `src/engine/engine-types.ts` — NEW. **IDB key schema specified here** (not left to implementors): `notestr:raw-facts:${groupId}`, `notestr:accepted-events:${groupId}`, `notestr:engine-checkpoints:${groupId}`, `notestr:deferred-ids:${groupId}`. Legacy `notestr:events` kept until Phase 8.
- `src/domain/domain-events.ts` — NEW. AcceptedDomainEvent with `sourceKind` discriminator and bootstrap idempotency key (below).
- `src/domain/task-projector.ts` — NEW thin. **Incremental projection**: applyEvent(currentProjection, event.payload) per domain_event_accepted (matches current task-store.tsx:219). Full buildProjection only on restart or projection_invalidated. projection_invalidated NOT emitted on ratchet-advance stateChanged.
- `src/domain/task-crdt.ts` — NEW. **Shared `taskWinsOver(candidate, existing)` tie-break helper** called by BOTH applyEvent (task-reducer.ts:18-32) and the bootstrap merge gate (device-sync.ts:1433-1452), eliminating the duplicate-projection drift risk.
- `src/persistence/{raw-event-log-store,checkpoint-store,deferred-store}.ts` — NEW. Idempotent stores over createKVStore.
- `src/integration/marmot-adapter.ts` — NEW. Owns outbox bridge (device-sync.ts:93-141) + bootstrap wrapping. Engine holds at `joining` until bootstrap resolves before `catching_up`.
- `src/integration/react-engine-hooks.ts` — NEW. Incremental applyEvent, not full rebuild on stateChanged.
- device-sync.ts / task-store.tsx — MODIFIED, slimmed; persistence.ts DEPRECATED (removed Phase 8).

### 3. Seam Contracts (revisions)

**RawProtocolFact** — `epochAtReceipt` is **diagnostic only, NOT a retrieval key** for past MLS state (no snapshot-at-epoch API exists).

**AcceptedDomainEvent**:
```
interface AcceptedDomainEvent<T = TaskEvent> {
  id: string;            // MLS-path: rumor.id. bootstrap: "bootstrap:${groupId}:${task.id}"
  factId: string | null; // null for bootstrap-sourced (no RawProtocolFact)
  sourceKind: "mls-rumor" | "bootstrap-kind-30078";
  groupId: string; acceptedAt: number; epoch: string; payload: T;
}
```
Bootstrap key is deterministic across re-runs (merge gate is relay-order-independent; wonFromBootstrap finalized before synthetic emit at device-sync.ts:1457). groupId prefix prevents cross-group task.id collision.

**EngineCheckpoint** — splits the conflated marker into `lastIngestedFactId` (all events through group.ingest = syncedEventIds) and `lastAcceptedDomainEventId` (only those yielding applicationMessage).

**EngineOutputEvent** — splits `group_epoch_advanced` from `group_ratchet_advanced` so deferred-retry triggers only on epoch advance (matches device-sync.ts:825). projection_invalidated emitted sparingly.

**OutboxEntry (new, Phase 6)** — `createdAt` set ONCE before first send, immutable across retries → stable `rumorId`. Required for Invariant 2 under retry.

### 4. Boundary Rules (revisions)
1-4, 6-7 unchanged. **Rule 5 REVISED:** "one engine owns all ingest decisions" != "bootstrap and live ingest are structurally identical." Bootstrap is the `joining` phase under engine authority; its output enters the same accepted-event log. **Rule 8 (new):** outbox entries immutable after creation. **Rule 9 (new):** IDB keys schema-defined in engine-types.ts. **Rule 10 (new):** adapter instance lifetime outlasts engine instance lifetime.

### 5. Assumptions (revisions)
- **A — REMOVED** (shadow-mode parallel-ingest impossible; see Phase 3 redesign).
- **C — REVISED:** "document fork invariant" -> "test-cover": (a) marmot-ts fork integration test asserting applicationMessage not emitted after own sendApplicationRumor; (b) engine property test asserting domain_event_accepted never fires for an event.id in the open outbox.
- **E — REVISED:** Invariant 3 formally weakened to same-epoch replay only. Cross-epoch reinterpretation requires an undesigned fork snapshot-at-epoch API.
- **F — REVISED:** ordering enforced structurally via the `joining` state gate, stronger than the current joinBarrier.
- **G (new):** Invariant 2 holds under Phase 6 retry only if OutboxEntry.createdAt is immutable (Rule 8).

### Revised Phase Plan
**Phase 3 REDESIGNED** — not parallel-ingest. The new engine observes the SAME applicationMessage callbacks from the SINGLE shared group.ingest() chain and produces its own accepted-event log; verification compares projection outputs (engine buildProjection vs legacy stateRef.current), not ingest paths. No second group.ingest() call. Phase 6 gains the OutboxEntry durability pre-condition as a blocking requirement.

### Correctness Invariants (revised)
1. deterministic replay — unchanged.
2. duplicate-delivery invariance — **qualified**: requires retries reuse original created_at (Rule 8).
3. recover+replay equality — **weakened to same-epoch only**; cross-epoch needs fork snapshot API.
4. rebuild equality — unchanged.
5. deferred convergence — unchanged.
6. optimistic-publish reconciliation — unchanged.

### Evolution Triggers
ET-1 marmot ingest API shape change -> only marmot-adapter.ts. ET-2 marmot catch-up API -> syncGroup becomes delegation; engine-internal restructure. ET-3 kind-30078 deprecation -> joining phase + adapter. ET-4 multi-writer -> conflict detection at domain_event_accepted; projector extended; seam contract changes. ET-5 cross-group projections -> new routing layer above per-group engine.

---

## ADDRESSED CONCERNS

### Blocking Concerns
- **BC-1 Shadow-mode impossible -> REVISED.** Verified ingestLock is closure-private (device-sync.ts:651 inside useEffect:506); group.ingest (700) destructively consumes ratchet keys; second pass yields skipped/no-callback. Phase 3 redesigned as projection-output comparison over the shared single ingest path. Residual: none at ingest layer.
- **BC-2 Bootstrap idempotency key -> REVISED.** Verified bootstrap decrypts via nip44 (device-sync.ts:1414), returns synthetic task.created (1457) with no rumor. Key = `bootstrap:${groupId}:${task.id}`, deterministic, sourceKind-tagged. Residual: cross-group task.id collision prevented by groupId prefix.
- **BC-3 Epoch-keyed snapshot -> REVISED.** Verified only current SerializedClientState persisted; no past-epoch retrieval API. Invariant 3 weakened to same-epoch; epochAtReceipt is diagnostic-only. Residual: cross-epoch deferred events retried against new epoch state (existing behavior); matches weakened invariant.
- **BC-4 Missing quizzl/shophop -> REVISED.** Confirmed absent. All cross-project refs removed; choices regrounded in this codebase (closure-state reset, pure reducer, mountedRef guards, bootstrap-outside-ingest). Residual: none (a spec-doc concern, not a proposal dependency).
- **BC-5 Bootstrap merge gate = 2nd projection -> REVISED.** Verified merge gate (1433-1447) duplicates applyEvent tie-break (task-reducer.ts:18-32). Shared `taskWinsOver` extracted to task-crdt.ts; bootstrap produces synthetic task.created flowing through applyEvent FWW, not a competing projection. Residual: none after extraction.

### Challenged Assumptions
- **CA-1 = BC-1** (Phase 3 redesign).
- **CA-2 = BC-3** (Invariant 3 weakened).
- **CA-3 own-echo "document" insufficient -> REVISED** to test-cover (fork test + engine property test). Residual: fork test is the detection mechanism; without it a silent change double-applies own events.
- **CA-4 bootstrap ordering not atomic -> REVISED:** structural `joining` state gate (stronger than joinBarrier device-sync.ts:515-603). Residual: live events buffer during joining, drained on cutover (correct).
- **CA-5 "95% of core" overstated -> REVISED/conceded:** task-reducer is the projector (reusable); the state machine is new imperative code. "95% exists" removed. Residual: story estimation must treat state machine as a genuine build.

### Paradigm/Other — disposition
CQRS -> dropped. Three-shell -> conceded as making-implicit-explicit, not paradigm discovery. marmot coupling -> defended (contained in marmot-adapter.ts, ET-1). projection_invalidated cost -> accepted (incremental applyEvent). Checkpoint marker conflation -> accepted (split). rumor.id retry instability -> accepted (Rule 8 / OutboxEntry). IDB key format -> accepted (schema in engine-types.ts, Rule 9). Adapter lifetime -> accepted (Rule 10).
