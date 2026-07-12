# Event-Sourced Receive Engine and Deterministic Projection Architecture — Acceptance Criteria

Pointers, not restatement: full seam field tables live in `architecture.md`
("Seam Contracts"); the full transition table lives in `fsm.md`. This file
states only what must be observably true.

## Terminology

- **canonical record (X)** — the raw `RawProtocolFact` log plus the persisted MLS/client/group state and engine metadata needed to reinterpret it (spec.md P2). The durable source of truth the invariants below are stated over.
- **replay(X)** — deterministic re-interpretation of X into an ordered `AcceptedDomainEvent` log via `replayOrder`: bootstrap-sourced events before MLS-sourced events, each internally ordered by `seq`/append order (never `acceptedAt`).
- **projection** — the deterministic, rebuildable task-state materialization produced by `buildProjection` (full rebuild) or `applyEvent` (incremental fold) over `AcceptedDomainEvent`s.
- **seq** — the monotonic per-group receipt sequence assigned when a `RawProtocolFact` is appended to the raw log; the sole ordering/recovery-watermark key. Content-hash `id` values are never ordered and never used for sequencing.
- **watermark (`lastIngestedSeq`)** — the `EngineCheckpoint` field marking the `seq` of the last raw fact that completed `group.ingest`. Recovery re-submits only facts with `seq > lastIngestedSeq`.
- **T_join** — the 8000 ms joining-gate timeout (`fsm.md` "Joining timeout").
- **lifecycle / health** — the FSM's orthogonal state pair. `lifecycle` is one of 8 named phases; `health` is `"nominal" | "degraded"` and never appears as a `lifecycle` value (I-FSM-1).

## Known TAGs

- **INV** — the six spec.md Correctness Invariants (1–5; Invariant 6 is tagged `PUB`).
- **PUB** — publish/outbox reconciliation (Invariant 6), phase-6-gated.
- **FSM** — conformance to `fsm.md`'s transition table and invariants I-FSM-1..6.
- **REC** — Recovery Sequencing (R1–R4, R-INV-1..4) and re-join/reset.
- **PERS** — Implementation Constraints 11–13 (persistence-failure handling).
- **BOUND** — structural Boundary Rules, lint/grep-enforceable.
- **MIG** — migration-safety ACs spanning the Phase 1–9 strangler rollout.

## Correctness Invariants (AC-INV, AC-PUB)

**AC-INV-1** — `buildProjection(replayOrder(acceptedLog))` MUST produce a deep-equal projection on every invocation for a fixed, unchanged `acceptedLog`.
*Observable:* a `fast-check` property test in `src/domain/task-projector.property.test.ts` generates arbitrary well-formed `AcceptedDomainEvent[]` logs in valid replay order, calls `buildProjection` twice on the identical log, and asserts the two results are deep-equal across >=100 runs; it additionally asserts `log.reduce(applyEvent, empty)` deep-equals the one-shot `buildProjection` result. A projector that reads wall-clock time or mutates shared state fails this test.

**AC-INV-2** — Re-appending a `RawProtocolFact` or `AcceptedDomainEvent` whose `id` already exists MUST NOT change the persisted log length or the resulting projection.
*Observable:* persistence half: a unit test calls `appendFact`/`appendAcceptedEvent` twice with the same `id` and asserts `loadFacts`/`loadAcceptedEvents` returns exactly one entry; projector half: `buildProjection`/`applyEvent` require unique-id logs (id-dedup is a persistence-layer precondition, enforced by `appendAcceptedEvent` idempotency and proven by S4's unit tests); a projector property test asserts re-applying an already-applied event is a no-op. *(amended 2026-07-12, S3 Stage-2 cold review — the prior phrasing implied projector-side id-dedup that was never the design)*

**AC-INV-3** — `projection(recover(prefix(X)) + replay(suffix(X)))` MUST equal `projection(replay(X))` for every event decryptable under the epoch active at recovery time. Events left undecryptable by an epoch advance before recovery MUST be excluded from this equality (P4 carve-out) and MUST NOT cause the equality check to fail.
*Observable:* an integration test splits a fixture log into a pre-crash prefix and post-crash suffix within one epoch, runs recovery (R1–R4) on the prefix then replays the suffix, and asserts the result deep-equals an uninterrupted single-pass replay of the full log. A second fixture introduces one fact made undecryptable by a simulated epoch advance and asserts that fact is excluded from **both** projections while the rest of the equality still holds — proving the carve-out is scoped to the epoch-crossing fact only, not a blanket exemption.

**AC-INV-4** — For any accepted-event log `L`, `buildProjection` over `L` loaded from the persistence adapter MUST equal the projection reached by incrementally applying the same events via `applyEvent` as they were accepted.
*Observable:* a test drives the engine through a sequence of `domain_event_accepted` outputs (folding an in-memory projection incrementally), independently loads the same events via `PersistenceAdapter.loadAcceptedEvents`, calls `buildProjection`, and asserts deep-equality between the two.

**AC-INV-5** — A deferred fact that becomes readable after a later `epoch_advanced` signal MUST reach the projection via the engine's own L8/L9 retry flow, with no externally-triggered reload, full rebuild, or explicit re-fetch call.
*Observable:* a test parks a fact via an `unreadable` `IngestSignal` (asserting `envelope_deferred` is emitted and the projection is unchanged), fires `epoch_advanced`, and — without the test calling `buildProjection` or any manual re-sync itself — asserts `domain_event_accepted` is eventually emitted for the same fact and the projection updates accordingly, purely from the engine's own retry transition.

**AC-PUB-1** *(phase-6-gated — `OutboxEntry`'s field contract beyond `createdAt`/`rumorId` is TBD until Phase 6; this AC holds the invariant's place and MUST be re-validated against the finalized contract before Phase 6 stories close)* — Optimistic local publish MUST reconcile to the same durable projected task state regardless of whether local own-echo was observed before or after a restart.
*Observable:* once `OutboxEntry` lands, a test publishes a task mutation and restarts the engine (a) after own-echo was observed and (b) before own-echo was observed, and asserts both branches converge to the same final projected state and the same outbox reconciliation status, with `createdAt`/`rumorId` unchanged across retries (Rule 8 / Boundary Rule 7).

## FSM Conformance (AC-FSM)

**AC-FSM-1** (I-FSM-1) — `degraded` MUST be represented exclusively as `EngineState.health`, never as a `lifecycle` value.
*Observable:* a test drives the engine through all documented transitions (L1–L11) via a mock adapter and asserts `lifecycle` is always one of the 8 `Lifecycle` union members and is never `"degraded"`.

**AC-FSM-2** (I-FSM-2) — On every transition into `catching_up` (L3, L4, L5) the engine MUST call `adapter.openLive()` before beginning to drain `adapter.catchUp()`.
*Observable:* a test with a mock `IngestSource` records call order for each of the three entry paths (`recovering→catching_up`, `joining→catching_up` nominal, `joining→catching_up` degraded-on-timeout) and asserts `openLive` precedes the first `catchUp` iteration in every case.

**AC-FSM-3** (I-FSM-3) — Live signals arriving while `catching_up` or `buffering_live` MUST be buffered, not applied, until `liveBufferEmpty` is reached in `buffering_live`.
*Observable:* a test injects a live `IngestSignal` mid-catch-up and asserts no projection change occurs for it until after `catchUpComplete` and buffer drain begin; it asserts the buffered event is applied in arrival order once draining starts, and asserts applying a buffered event ahead of an earlier historical one fails the test.

**AC-FSM-4** (I-FSM-4) — `saveCheckpoint` MUST be called at least once per lifecycle transition, plus periodically while the engine remains `live`.
*Observable:* a test drives N scripted transitions and asserts the mock `PersistenceAdapter.saveCheckpoint` call count is >= N; a fake-timer test asserts at least one additional `saveCheckpoint` call occurs during an extended `live` period with zero transitions.

**AC-FSM-5** (I-FSM-5) — `reset()` (L11) MUST be the only operation that clears persisted per-group state (raw-log, accepted-log, checkpoint, deferred ids, `bootstrap-completed`), and MUST always land the engine in `lifecycle: "uninitialized"`.
*Observable:* a test calls `reset()` on an engine with non-empty persisted stores and asserts all five are empty afterward with `lifecycle === "uninitialized"`; a second test drives every other transition and asserts none of them empties the stores. A follow-up `start({origin:"welcome"})` after `reset()` asserts L2 into `joining`, not L1 into `recovering`.

**AC-FSM-6** (I-FSM-6) — `retrying_deferred` (L8) MUST be entered only on `group_epoch_advanced` with a non-empty deferred queue; `group_ratchet_advanced` MUST NOT trigger it.
*Observable:* a test with a non-empty deferred queue emits `group_ratchet_advanced` and asserts `lifecycle` is unchanged, then emits `group_epoch_advanced` on the same engine and asserts `lifecycle` becomes `retrying_deferred`.

**AC-FSM-7** — On entry to `joining` the engine MUST start an 8000 ms (`T_join`) timer alongside the bootstrap fetch. If the timer fires first, the engine MUST take L5 into `catching_up` with `health: "degraded"` while the bootstrap fetch continues uncancelled in the background; a subsequently-resolving late bootstrap MUST merge and MUST restore `health: "nominal"` (H2).
*Observable:* a fake-timer test starts the engine in `joining` with a bootstrap promise resolving at 9000 ms; it asserts the transition to `catching_up`/degraded happens at the 8000 ms mark, asserts the bootstrap promise is never aborted/rejected by the engine, and asserts that when it resolves at 9000 ms the engine emits `engine_state_changed{health:"nominal"}` with the bootstrap snapshot's events merged into the projection.

**AC-FSM-8** — The `catching_up → buffering_live → live` cutover MUST apply every historical and live-arrived fact exactly once — no fact dropped, no fact duplicated — even when live facts arrive concurrently with the historical drain.
*Observable:* a property test generates a random interleaving of historical facts and live facts arriving during the historical drain, drives the engine through cutover, and asserts the final applied-fact id set equals the union of historical+live ids with no duplicates and no omissions, and that every historical fact is applied before any live fact reaches the projection.

## Recovery Sequencing & Re-join (AC-REC)

**AC-REC-1** (R1) — Recovery MUST rebuild the projection as `buildProjection(replayOrder(acceptedLog))`: all bootstrap-sourced events before all MLS-sourced events, each internally ordered by `seq`/append order, never by `acceptedAt`.
*Observable:* a test constructs an `acceptedLog` where a bootstrap-sourced event has a later `acceptedAt` than an MLS-sourced event (simulated clock skew), runs recovery, and asserts the bootstrap event is folded before the MLS event — proving `acceptedAt` is not the sort key.

**AC-REC-2** (R2) — Recovery MUST re-populate `PendingRetryQueue` from `deferredIds` without resubmitting those facts to the adapter for ingest during the `recovering` phase.
*Observable:* a test seeds `deferredIds` with N ids, runs recovery, and asserts the mock adapter's ingest call log contains zero calls referencing those N ids during R2, while the engine's deferred-count output shows exactly N ids afterward.

**AC-REC-3** (R3, R-INV-2) — Recovery MUST resubmit to ingest only `rawLog` facts with `seq > checkpoint.lastIngestedSeq`; facts with `seq <= lastIngestedSeq` MUST NEVER be resubmitted.
*Observable:* a test builds a `rawLog` with facts at `seq` 1–10 and a checkpoint `lastIngestedSeq: 6`, runs recovery, and asserts the adapter receives exactly facts `seq` 7–10 for ingest and zero calls for `seq` 1–6.

**AC-REC-4** (R4) — After R1–R3 complete, the engine MUST transition `recovering → catching_up` (L3) and open live plus drain `catchUp()` for events that arrived while offline.
*Observable:* a test asserts the `engine_state_changed` sequence after `start({origin:"restored"})` is `recovering` then `catching_up`, and that `adapter.openLive`/`adapter.catchUp` fire only after R1–R3's synchronous rebuild steps complete.

**AC-REC-5** (R-INV-1) — A fact's recovery disposition MUST be decided by store membership plus the `seq` watermark; content-hash `id` values MUST NOT be compared to derive order or disposition.
*Observable:* a property test generates `RawProtocolFact` ids as random hex strings deliberately unordered relative to their `seq`, and asserts each fact's re-ingest/skip/defer disposition depends only on `seq` vs. `lastIngestedSeq` and store membership — reshuffling the id strings while holding `seq` and store membership fixed MUST NOT change any fact's disposition.

**AC-REC-6** (R-INV-3) — `deferredIds ∩ {e.factId | e ∈ acceptedLog}` MUST always be empty; when a deferred fact is later accepted, its removal from `deferred-store` and append to `accepted-log` MUST happen as a single atomic persistence operation.
*Observable:* a fault-injection test accepts a previously-deferred fact and throws immediately after the first of the two store operations; it asserts the fact is recoverable as still-deferred (never lost, never double-counted in both stores) after a subsequent recovery pass.

**AC-REC-7** (R-INV-4) — Projection after R1+R3 MUST equal the in-memory projection at crash time plus any gap-tail facts ingested during R3.
*Observable:* an integration test records the final projection of an uninterrupted run over a fixture log, then re-runs the same fixture with a simulated crash partway through (engine stopped before trailing facts are checkpointed) followed by `start({origin:"restored"})` recovery and continued replay of the remainder, and asserts the recovered-and-continued projection deep-equals the uninterrupted projection.

**AC-REC-8** — A re-join (new MLS Welcome for a group with existing local state) MUST be sequenced as `stop()` (L10) → `reset()` (L11, full per-group clear: raw-log, accepted-log, checkpoint, deferred ids, `bootstrap-completed`) → `start({origin:"welcome"})` (L2, fresh bootstrap).
*Observable:* a test seeds all five persisted stores for a group, drives the re-join sequence, and asserts the `lifecycle` passes through `stopped` then `uninitialized` then `joining` in that order, and that all five stores are empty immediately after `reset()` and before the fresh bootstrap snapshot is applied.

**AC-REC-9** — `start({origin:"restored"})` MUST take L1 into `recovering` if and only if a persisted `EngineCheckpoint` exists for the group; `start({origin:"welcome"})` MUST take L2 into `joining` when no checkpoint exists.
*Observable:* one test seeds a checkpoint and calls `start({origin:"restored"})`, asserting `lifecycle === "recovering"`; another clears all state and calls `start({origin:"welcome"})`, asserting `lifecycle === "joining"` with no recovery replay (`loadFacts`/`loadAcceptedEvents`) invoked.

## Persistence Failure Handling (AC-PERS)

**AC-PERS-1** (Implementation Constraint 11) — A failing `appendFact`/`appendAcceptedEvent`/`saveCheckpoint` call MUST set `health: "degraded"` (H1), MUST retain the fact in memory, and MUST retry with bounded backoff; the fact MUST NOT be silently discarded.
*Observable:* a test makes the mock `PersistenceAdapter.appendFact` throw for the first K calls; it asserts `engine_state_changed{health:"degraded"}` is emitted after the first failure, asserts `appendFact` is retried at least K+1 times with bounded backoff (fake timers), and asserts the fact's content is present in the engine's pending in-memory state throughout. When call K+1 succeeds, it asserts `engine_state_changed{health:"nominal"}` (H2) follows.

**AC-PERS-2** (Implementation Constraint 12) — A persisted `EngineCheckpoint` that exists but fails to deserialize MUST be treated as no-checkpoint for recovery (`lastIngestedSeq = 0`, full raw-log resubmitted in R3), MUST NOT trigger `reset()`, and MUST enter `catching_up` with `health: "degraded"` until the first successful checkpoint save.
*Observable:* a test seeds `loadCheckpoint` to return a value failing shape validation, calls `start({origin:"restored"})`, and asserts: the raw-log and accepted-log seeded before the call remain intact (no `reset()` wipe); every raw-log fact is resubmitted to ingest as if `lastIngestedSeq === 0`; the engine enters `catching_up` with `health: "degraded"`; health returns to `nominal` after the next successful `saveCheckpoint`.

**AC-PERS-3** (Implementation Constraint 13) — A `malformed` `IngestSignal` MUST produce `domain_event_rejected{reason:"parse_error"}`, MUST NOT be enqueued into the deferred queue, and MUST NOT be retried on a subsequent `epoch_advanced`.
*Observable:* a test feeds a `malformed` signal and asserts `domain_event_rejected{reason:"parse_error"}` is emitted with the deferred-queue count unchanged; it then emits `group_epoch_advanced` and asserts no re-ingest attempt occurs for that fact's id — while a sibling `unreadable`/`epoch_mismatch` fact seeded in the same test IS retried, a differential assertion proving the two paths diverge.

## Structural Boundary Rules (AC-BOUND)

**AC-BOUND-1** (Boundary Rules 1, 9) — No file under `src/engine/` MUST import `react`, `next`, `next/navigation`, any path under `src/integration/`, or any marmot-ts package specifier.
*Observable:* a grep-based structural test scans every `.ts` file under `src/engine/` for `import` statements matching those specifiers and asserts zero matches; introducing a single disallowed import flips the test from pass to fail.

**AC-BOUND-2** (Boundary Rule 2) — No file under `src/domain/` MUST import `src/engine/`, `src/persistence/`, `src/integration/`, or reference a DOM global (`document`, `window`).
*Observable:* a grep-based structural test scans every `.ts` file under `src/domain/` for `import` statements referencing those three paths and for identifier usages of `document`/`window`, asserting zero matches on both counts.

**AC-BOUND-3** (Boundary Rule 8 / Implementation Constraint 8) — No file other than `src/engine/engine-types.ts` MUST introduce a new IndexedDB key literal for this epic's stores (`raw-facts`, `accepted-events`, `engine-checkpoints`, `deferred-ids`); persistence implementations MUST reference the exported key constants rather than inlining the string. **(amended 2026-07-12, Stage-2 cold review — P2-8)**
*Observable:* a grep-based test scans ALL of `src/` (recursive, `.ts` and `.tsx`), excluding only `engine-types.ts` itself, for inlined `notestr:raw-facts:`/`notestr:accepted-events:`/`notestr:engine-checkpoints:`/`notestr:deferred-ids:` string/template literals and asserts zero matches; introducing an inlined duplicate anywhere else flips the test to fail. **(amended 2026-07-12, Stage-2 cold review)**

**AC-BOUND-4** (Implementation Constraint 10) — Both the task projector's `applyEvent` and the bootstrap merge gate MUST call `taskWinsOver` from `src/domain/task-crdt.ts`; neither call site MUST implement an independent three-level (`updatedAt`/`updatedBy`/`updatedByDevice`) comparator.
*Observable:* a grep/AST-based test asserts both call sites import `taskWinsOver` from `src/domain/task-crdt.ts`, and scans the repo for any second function comparing all three of `updatedAt`, `updatedBy`, and `updatedByDevice` — reintroducing the duplicated bootstrap-gate comparator that existed at `device-sync.ts:1433-1452` before migration flips this test from pass to fail.

**AC-BOUND-5** (Boundary Rule 10) — `src/integration/marmot-adapter.ts` MUST register zero independent React lifecycle hooks; `src/integration/react-engine-hooks.ts` MUST manage exactly one `useEffect` per group whose cleanup calls `engine.stop()`, which in turn calls `adapter.close()` as its final action (L10).
*Observable:* a grep-based test asserts zero occurrences of `useEffect`/`useState`/`useRef` in `marmot-adapter.ts`; a runtime test unmounts the engine hook and asserts `engine.stop` was called exactly once and `adapter.close` was invoked as the last call inside `stop()`'s execution (call-order assertion on a mock adapter).

## Migration Safety (AC-MIG)

**AC-MIG-1** — From Phase 2 (once `raw-event-log-store.ts` exists) onward, no file other than the pre-existing read/write paths in `src/store/persistence.ts` MUST write to the legacy IDB key `notestr:events:${groupId}`.
*Observable:* a grep-based test scans the repository, excluding `src/store/persistence.ts`'s existing implementation, for any write call site targeting a key matching `notestr:events:` and asserts zero matches; run as a CI gate at every phase-boundary commit from Phase 2 onward.

**AC-MIG-2** (Boundary Rule 5) — Across Phases 1–7, `src/marmot/device-sync.ts` and `src/store/task-store.tsx` MUST NOT gain new decision logic (new `if`/`switch`/ternary branches or new correctness-bearing exported functions) relative to the Phase-1 baseline; changes MUST be limited to deletions, stubbing, and delegation to the new engine.
*Observable:* a scripted diff check (`git diff <phase-1-baseline>..<current> -- src/marmot/device-sync.ts src/store/task-store.tsx`) run at each phase-boundary commit asserts zero added control-flow-branch lines that lack a matching removed line (straight branch relocation into the engine is allowed; net-new branching is not).

**AC-MIG-3** — After Phase 8, `src/store/task-store.tsx` MUST contain zero `applicationMessage` listener registrations; the file MUST consume projected state via `react-engine-hooks.ts` only.
*Observable:* a grep-based test asserts zero matches for `applicationMessage` in `src/store/task-store.tsx`, run as the Phase-8 exit gate; the pre-Phase-8 tree has exactly one such match (`task-store.tsx:181-255`), so the check is state-discriminating across the phase boundary.

**AC-MIG-4** — The full existing unit-test suite (vitest) and e2e suite (Playwright) MUST exit zero at every phase-boundary commit (end of each of Phases 1 through 9), with no test skipped, `.only`-scoped, or deleted solely to force a pass.
*Observable:* CI runs `make test` and the e2e suite at each phase-boundary tag and asserts exit code 0 for both; a diff of the test-file list between phase boundaries asserts no pre-existing test file was deleted or had assertions weakened without a replacement covering the same behavior.

### Adapter translation fidelity (ADPT)

**AC-ADPT-1** *(added 2026-07-12 during story planning — closes the Mode-2-flagged adapter coverage gap)* — `marmot-adapter.ts` MUST translate each real marmot-ts ingest outcome into exactly the corresponding marmot-free `IngestSignal` variant: a decrypted application message → `message` (with decoded `TaskEvent` payload and correct `receiptSource`); a not-yet-decryptable event → `deferred` with reason `unreadable`/`epoch_mismatch`; an already-consumed id (own-echo/duplicate) → `skipped`; an epoch change → `epoch_advanced` (and a bare ratchet advance produces NO signal); a decrypted-but-undecodable payload → `malformed`. No marmot-ts type may appear in any emitted signal.
*Observable:* an adapter unit/integration test drives a real (or contract-faithful stub of) `MarmotGroup` through each outcome — decryptable message, unreadable ciphertext, duplicate delivery, epoch advance, ratchet-only advance, malformed payload — and asserts the exact `IngestSignal` sequence emitted, plus a type-level/structural assertion that signal payloads contain no marmot-ts imports.

## Manual Validation

None. Every invariant, transition, recovery step, boundary rule, and migration
gate in this epic is machine-checkable via unit tests, property tests,
integration tests, or grep/lint-based structural checks. No AC in this file
requires a human observer.

| MV id | Behavioral intent | Owner | Blocked on |
|-------|-------------------|-------|------------|
| — | (none) | — | — |
