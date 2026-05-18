# MLS Live-Delivery Race — Acceptance Criteria

These criteria are derived from `spec.md` and map to the stories in the spec's § *Stories*. Each AC is observable from a test run, a trace dump, or a code-review readthrough. Pre-existing terminology (F1/F2/F3/F4 failure modes; A/B/C solution candidates) is used as-is from the spec.

## Terminology

- **Trace** — the JSON event log emitted by `src/marmot/mls-trace.ts` when `NEXT_PUBLIC_E2E_TRACE_MLS=1` is set at build time. A trace is per-page (per browser context).
- **F-class** — one of the four failure modes named in the spec: F1 (fetch-then-subscribe gap), F2 (welcome-epoch lag with no draining commit), F3 (applicationMessage emitted but UI state not updated; subclasses F3a/F3b/F3c/F3d), F4 (multi-relay EOSE-cliff).
- **Failing cluster** — the six chromium tests named in `spec.md`'s problem section (`multi-user.spec.ts:145/155/198`, `three-party.spec.ts:79/101/135`).
- **Strict assertion window** — the 5-second polling envelope used in S7's regression test.

## S1 — Trace recorder skeleton

- **AC-TRACE-1** — `src/marmot/mls-trace.ts` exists and exports `MlsTrace` (interface), `TraceEvent` (discriminated union), and a default no-op implementation.
- **AC-TRACE-2** — When `process.env.NEXT_PUBLIC_E2E_TRACE_MLS !== "1"`, the default implementation's `record`, `dump`, and `clear` are no-ops with no allocation. Verified by reading the source: each method is empty or returns a frozen empty array.
- **AC-TRACE-3** — When `process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1"`, `record` pushes to an internal array; `dump` returns a defensive copy; `clear` empties the array.
- **AC-TRACE-4** — All `TraceEvent` shapes from `spec.md` § *Trace event shape* are present in the union type.
- **AC-TRACE-5** — `mls-trace.ts` has zero runtime dependencies on `react`, `next`, or DOM APIs. It is a pure module.

## S2 — Trace hooks at every relevant call site

- **AC-HOOK-1** — `device-sync.ts:syncGroup` records `req-start`/`req-eose`/`req-close` for the historical fetch and `sub-start`/`sub-close` for the persistent subscription.
- **AC-HOOK-2** — `device-sync.ts:ingestGroupEventsRaw` records one `ingest-call` per call (before the loop) and one `ingest-result` per yielded result from `group.ingest(events)`. The `epochBefore` and `epochAfter` fields capture the pre/post epoch around each result.
- **AC-HOOK-3** — `device-sync.ts:attachRetryOnEpochAdvance` records `epoch-change` on every `stateChanged` firing where `newEpoch > prev`. Records `queue-drain` with `trigger: "epoch-advance"` when the queue has entries to drain.
- **AC-HOOK-4** — `network.ts:request` records `req-start` before opening the NDK subscription, one `req-event` per event delivered before `EOSE`, and `req-eose` + `req-close` on resolution.
- **AC-HOOK-5** — `network.ts:subscription` records `sub-start` on subscribe, `sub-event` on every callback, `sub-close` on unsubscribe.
- **AC-HOOK-6** — When `NEXT_PUBLIC_E2E_TRACE_MLS === "1"`, `window.__notestrTestMlsTrace = () => mlsTrace.dump()` is exposed by `MarmotProvider`. When unset, the hook is not installed (verified by reading `src/marmot/client.tsx`).
- **AC-HOOK-7** — When `NEXT_PUBLIC_E2E_TRACE_MLS` is unset at build time, the resolved `MlsTrace` implementation is the no-op default exported by `mls-trace.ts`. The no-op default's `record`, `dump`, and `clear` method bodies are empty (verified by reading the source). Production-call cost is one empty function invocation per trace site. The `__notestrTestMlsTrace` window-hook installation in `MarmotProvider` is gated on the same build-time check (`process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1"`), so when unset the hook installation block is dead code. (No bundle-grep assertion is made; minification mangles identifiers and would defeat a literal grep regardless. The contract is the source-level no-op shape.)
- **AC-HOOK-8** (advisory, not a merge gate) — Empirical trace-size budget: per-event ≤ 1 KB serialized, total ≤ 1 MB on a 30-second test scenario. Spot-measured during S3 and recorded for future tuning. Not enforced at PR time.
- **AC-HOOK-9** — Identity-mapping trace event. The sender records a `publish-task` trace event with shape `{ kind: "publish-task", t, groupId, taskEventId, rumorId, eventId, createdAt }` at the moment a task rumor is committed to a kind-445 and sent to the relay. The hook is inserted on the sender side gated on the same build-time flag. Identifier semantics: `rumorId = rumor.id` (the application-payload identifier produced by NIP-44 rumor finalization); `taskEventId = rumor.id` as well — there is no distinct application-payload `TaskEvent.id` in this codebase; the rumor.id IS the task event identifier (see `task-store.tsx:163`, `device-sync.ts:228`, GAP-1); `eventId = NostrEvent.id` (the outer kind-445 relay event id). Without this trace event, S3's classifier cannot bridge "the failing UI assertion expected task X" to "the kind-445 event id that should have surfaced X." *(Rewritten via RECONCILE 2026-05-18; see `spec.md ## Amendments`.)*
- **AC-HOOK-10** — Task-store receive trace events. `TaskStoreProvider` emits structured trace events (gated on the same build-time flag) so the F3 classifier can distinguish subclasses without parsing console.debug output:
  - `task-store-load-start { groupId }` — at the top of the `load()` function inside the load-on-mount `useEffect` (`task-store.tsx:48`).
  - `task-store-load-complete { groupId, restoredCount }` — immediately before `setState(restored)` resolves the load (`task-store.tsx:55–57`). `restoredCount = restored.size`.
  - `task-store-recv { groupId, rumorId }` — first line inside `handleApplicationMessage`, after `deserializeApplicationData` succeeds and before the kind check.
  - `task-store-accepted { groupId, rumorId, taskEventId }` — immediately before `setState(nextState)` at `task-store.tsx:85`.
  - `task-store-rejected { groupId, rumorId, reason: "wrong-kind" }` — when the early return at `task-store.tsx:81` fires.
  - `task-store-error { groupId, rumorId, reason, message }` — inside the catch at `task-store.tsx:89`. `reason` is `"deserialize-throw"` if `deserializeApplicationData` threw (rumorId is null in that case) or `"apply-throw"` for other paths.
  - The classifier (AC-DIAG-3b) consumes these events directly. Console.debug lines like `[mls-receive:task-store-in]` are NOT authoritative for classification and may be removed in S9 cleanup.

## S3 — Diagnostic harness

- **AC-DIAG-1** — `e2e/tests/multi-user-diag.spec.ts` is no longer `fixme`-marked. It runs as part of `make e2e` when `DIAG=1` is set in the environment; otherwise the test bodies skip via `test.skip(!DIAG, ...)`, preserving the existing developer-opt-in gate that keeps long diagnostic runs out of the default suite. Always-on execution is deferred to a follow-up once classifier stability is established (per AC-VAL-1). *(Rewritten via RECONCILE 2026-05-18; see `spec.md ## Amendments`.)*
- **AC-DIAG-2** — When `DIAG=1` and `NEXT_PUBLIC_E2E_TRACE_MLS=1` (TRACE_MODE), the harness runs a representative multi-user live-delivery scenario up to 3 times and writes per-page traces to `e2e/.triage/mls-trace-{A,B}-{run}.json` on every failure. (Each context's trace is independent.) The representative scenario is chosen because (a) AC-X-NO-TEST-WEAKEN-1 forbids modifying the original failing-cluster tests and (b) Playwright spec files are independent — cross-spec orchestration from a test body is not supported. The other failing-cluster tests share the same architectural shape (kind-445 publish → live MLS subscription → UI assertion timeout) and classify under the same F-classes, so the representative-scenario verdicts generalize. S4's `report.md` documents cross-cluster generalization with the rationale. *(Rewritten via RECONCILE 2026-05-18; see `spec.md ## Amendments`.)*
- **AC-DIAG-3** — On each failure, the harness emits a single-line console summary classifying the failure as F1, F2, F3 (with subclass F3a/F3b/F3c), or `unknown` based on the trace contents. Classification consumes the sender's trace AND the receiver's trace, joined via the identity prerequisite below.
- **AC-DIAG-3a** — Identity-mapping prerequisite. To classify a failure, the harness needs to know which kind-445 `eventId` should have surfaced the failing UI assertion. Mapping path:
  - The harness reads the dispatched rumor.id from the sender via `window.__notestrTestSentRumors(groupIdStr)` (returns rumors in insertion order; the harness picks the most recent — the task just dispatched). The result is written to `e2e/.triage/expected-task-{run}.json` carrying `{rumorId, taskTitle, runId}` per assertion.
  - The sender's trace contains a `publish-task` record (per AC-HOOK-9) joining `rumorId` to the kind-445 `eventId`.
  - The classifier reads `expected-task-{run}.json`, looks up the matching `publish-task` in the sender's trace by `rumorId`, extracts the kind-445 `eventId`, and uses it as the lookup key against the receiver's trace. *(Rewritten via RECONCILE 2026-05-18; see `spec.md ## Amendments`.)*
- **AC-DIAG-3b** — Classifier rules. All rules operate on structured trace events (NOT console.debug strings). The lookup chain is: failed assertion → expected `taskEventId` (per AC-DIAG-3a) → matching `publish-task` in sender's trace → kind-445 `eventId`. Then, in the receiver's trace:
  - **F1** — `eventId` does NOT appear in any `sub-event` within the test's timeout window. (The kind-445 the sender emitted never reached the receiver's subscription pipeline.)
  - **F2** — `eventId` appears in `sub-event` AND in an `ingest-result` with `result: "unreadable"` AND no subsequent `queue-drain` involving that `eventId` fires before the timeout. (The MLS layer parked it and never drained.)
  - **F3** — `eventId` appears in `sub-event` AND `ingest-result` with `result: "processed"`, but the UI assertion still timed out. The MLS layer succeeded; the failure is in the task-store. Subclass via the receiver's `task-store-*` events for the matching `rumorId` (looked up from the sender's `publish-task.rumorId` field):
    - **F3a — listener not attached.** No `task-store-recv` event is recorded for this `rumorId`. The `applicationMessage` listener had not been registered yet when the event fired.
    - **F3b — handler errored.** A `task-store-error` event is recorded with `reason: "deserialize-throw"` or `"apply-throw"`. The handler ran but threw before `setState`.
    - **F3c — wrong kind.** A `task-store-rejected` event is recorded with `reason: "wrong-kind"`. The rumor was discarded by the kind check.
    - **F3d — load-after-live overwrite.** A `task-store-accepted` event is recorded for this `rumorId`, AND a `task-store-load-complete` event is recorded *after* it on the receiver's timeline, AND the load-complete's `restoredCount` does not include the accepted task. (Detection rule: `task-store-accepted.t < task-store-load-complete.t` for the same `groupId`. The mount-time load resolved late and clobbered the live update.)
  - **`unknown`** — none of the above match. Print the relevant trace excerpt for manual triage.
- **AC-DIAG-4** — When `DIAG=1` is set but `NEXT_PUBLIC_E2E_TRACE_MLS` is unset (TRACE_MODE=false), the harness runs but skips trace capture and classification — behavior reduces to a vanilla rerun-on-failure pass. The harness logs that trace mode is off and falls through to the pre-existing triangulation test. When `DIAG=0` (the default), the harness skips entirely (see AC-DIAG-1). *(Rewritten via RECONCILE 2026-05-18; see `spec.md ## Amendments`.)*
- **AC-DIAG-5** — The harness's classification logic lives in `e2e/fixtures/mls-trace-classify.ts` (separate file) and has its own unit tests. The unit tests provide synthetic traces representing each F-class and assert the classifier's verdict.
- **AC-DIAG-6** — The harness completes within 12 minutes (3 × 4 min worst case for the 6-test cluster). Wall-clock is recorded in epic completion notes.

## S4 — Empirical F-class report

- **AC-REPORT-1** — A `report.md` is committed under `specs/epic-mls-live-delivery-race/` after S3 lands and runs three times on CI. It enumerates each of the 6 cluster tests and lists the classifier's verdict per run.
- **AC-REPORT-2** — The report explicitly identifies whether F1, F2, F3, both/all, or neither dominate. The decision to ship S5 (Solution A), S6 (Solution B), both, or to terminate the epic is documented in the report with a one-paragraph rationale.
- **AC-REPORT-2a** — F3 termination clause. If the report finds F3 dominates (≥50% of the failing-cluster failures classified as F3 across three runs), this epic terminates after S4. ACs S5 through S9 (and their cross-cutting checks AC-X-CI-1, AC-A-*, AC-B-*, AC-REG-*) are deferred and are NOT gates for closing this epic. A new spec is filed scoped to the dominant F3 subclass:
  - F3a → `TaskStoreProvider` mount-ordering fix (register the listener via a non-effect path or via `useGroup`'s emission contract so events are not lost between group-load and listener-attach).
  - F3b → upstream rumor-shape audit (sender producing rumors with empty `id`/`pubkey`).
  - F3c → upstream protocol/kind-routing audit (rumor kind drift).
  - F3d → `TaskStoreProvider` load/live merge guard (e.g. drop late-arriving load results if any live event already mutated state, or merge `restored` against current state instead of replacing it).

  The new spec references this report. **Termination is only valid if the classifier could actually distinguish F3 subclasses on this run.** If `unknown` exceeds 20% of failures, the classifier is underspecified and the termination clause does not apply — fix the classifier first.
- **AC-REPORT-3** — If the report finds `unknown` failures, it lists them as separate follow-ups with a one-paragraph description each.

## S5 — Solution A (subscribe-first with since-bridge)

- **AC-A-1** — `device-sync.ts:syncGroup` lines 511–550 replaced with the body in `spec.md` § *Solution A*. The persistent subscription is opened **before** the historical request.
- **AC-A-1a** — Buffer/cutover semantics. While the historical fetch is in flight, events delivered by the persistent subscription are routed into a `liveBuffer: NostrEvent[]` (closure-scoped to the `syncGroup` call), NOT into `ingestGroupEvents`. After the historical fetch's `ingestGroupEvents` call resolves, the buffer is drained in `created_at` order via a single `ingestGroupEvents` call, and a `cutoverComplete` flag flips so subsequent live events bypass the buffer and ingest directly. This guarantees historical events ingest before any live events delivered during the gap, preserving epoch ordering.
- **AC-A-1b** — Cutover state-machine is per-`syncGroup`-call (closure-scoped, not module-scoped). A second concurrent `syncGroup` call (e.g. for a different group) has its own buffer and `cutoverComplete` flag.
- **AC-A-2** — The persistent subscription's filter includes `since: <t0 - 60>` where `t0 = Math.floor(Date.now() / 1000)` at sync start. The 60-second overlap accommodates end-user clock skew (see Design Decision 3 in `spec.md`). The historical request uses no `since`/`until` (full history).
- **AC-A-3** — The 60-second overlap is a constant in code (named `OVERLAP_SECONDS`), not a runtime config. Documented in a code comment referencing Design Decision 3.
- **AC-A-4** — `syncedEventIds` dedupe in `ingestGroupEventsRaw` is unchanged; events delivered both via subscription replay and via the historical request resolve to a single `processed` per id (verified by inspecting the trace: each event id appears at most once with `result: "processed"`).
- **AC-A-5** — Re-running S3 after this story merges produces zero F1-classified failures across 30 runs (10 runs × 3 trials). Recorded in the report.
- **AC-A-6** — The pre-existing `ingestLock` (`device-sync.ts:413–430`) still serialises ingest calls. Concurrent live-subscription deliveries do not race against the historical fetch. Verified by absence of "desired gen in the past" errors in the trace.
- **AC-A-7** — `multi-user.spec.ts:145` ("User B sees the task via live MLS subscription") passes ten consecutive times locally without retries.

## S6 — Solution B (drain on ingest activity)

- **AC-B-1** — `device-sync.ts:ingestGroupEventsRaw` runs the parked queue drain when `processed.size > 0`, after persisting the new `syncedEventIds` set.
- **AC-B-2** — A module-scoped `retryAttempts: Map<string, Map<string, number>>` tracks per-event retry counts, keyed `groupId → eventId → count`. The constant `MAX_RETRIES = 3` caps per-event retries within a single epoch.
- **AC-B-2a** — Reset on epoch advance. When `attachRetryOnEpochAdvance`'s `stateChanged` listener fires with `newEpoch > prev`, the inner map for that `groupId` is cleared (every parked event's counter resets to 0) BEFORE the existing epoch-advance queue-drain runs. This ensures a transient race that takes more than `MAX_RETRIES` attempts within one epoch can still recover when a fresh decrypting commit advances the epoch.
- **AC-B-3** — Events whose per-epoch retry count has reached `MAX_RETRIES` are NOT re-attempted by the ingest-activity drain trigger within that epoch. They remain in the parked queue. The next epoch advance resets the counter (per AC-B-2a) and they become eligible again.
- **AC-B-4** — The drain emits a `queue-drain` trace event with `trigger: "ingest-activity"` (or `"epoch-advance"` for the existing path).
- **AC-B-5** — `refreshGroupSync` (existing teardown for un-loaded groups, `device-sync.ts:553–581`) calls `retryAttempts.delete(groupId)` (one operation; drops the inner map entirely) when removing a group's other state.
- **AC-B-6** — `src/marmot/ingest-queue.test.ts` (new unit-test file) covers:
  - `enqueue` is idempotent (existing) — re-confirmed.
  - `prune` removes TTL-expired entries (existing) — re-confirmed.
  - **NEW**: drain-on-ingest does not enter an infinite retry loop within an epoch when an event remains `unreadable`. Specifically: simulate three consecutive ingest calls within epoch N where the parked event remains undecryptable; assert that exactly three retry attempts are made (one per ingest call) and the fourth ingest call does not retry the same event.
  - **NEW**: epoch-reset semantics. After the three-retry exhaustion above, simulate an `epoch-change` to N+1; assert the inner counter for that event resets to 0, and the next ingest call within epoch N+1 retries the event again.
  - **NEW**: per-group keying. Two groups with parked events of the same `eventId` (extremely unlikely in practice but trivially possible if the test fabricates ids) maintain independent counters. `retryAttempts.delete(groupA)` does not affect `groupB`'s counters.
- **AC-B-7** — Re-running S3 after this story merges produces zero F2-classified failures across 30 runs.
- **AC-B-8** — `three-party.spec.ts:79` passes ten consecutive times locally without retries.

## S7 — F2 regression test

- **AC-REG-1** — `e2e/tests/mls-live-delivery.spec.ts` exists. Its single test exercises the F2 sequence deterministically.
- **AC-REG-2** — A new test hook `window.__notestrTestArmAutoInvite(siblingKpEvent: NostrEvent): Promise<void>` is added to `MarmotProvider`. When called, it injects `siblingKpEvent` into the auto-invite scan as if it had been published by a sibling device, triggering the auto-invite commit flow on the next scan tick.
- **AC-REG-3** — The regression test calls `__notestrTestArmAutoInvite` between A's group creation and A's task dispatch, forcing the F2 sequence (commit + app-message arrive in undefined order on B).
- **AC-REG-4** — The assertion `await expect(openColumnB).toContainText(TASK_TITLE, { timeout: 5000 })` passes within 5 s (down from the 30-s envelope of the existing tests).
- **AC-REG-5** — Reverting Solution B (re-applying the original `ingestGroupEventsRaw`) causes this test to fail consistently. Verified once during S6 implementation, then reverted. Documented in the report.
- **AC-REG-6** — Test is mobile-skipped (multi-context tests don't run on mobile projects).

## S8 — Documentation and retry config

- **AC-DOC-1** — `docs/task-protocol.md` has a new top-level section "MLS receive pipeline (consumer-side)" describing the subscribe-first ordering, retry-trigger contract (epoch advance OR ingest activity), and the trace hook.
- **AC-DOC-2** — The doc section references this epic by name.
- **AC-DOC-3** — `playwright.config.ts` retries logic reads:
  ```ts
  retries: process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1" ? 0 : 1,
  ```
  When the trace flag is on, retries are disabled so a failure pins a trace. When unset, retries are 1 (covers residual flake during the rollout).
- **AC-DOC-4** — A follow-up is filed (in `specs/` or as a tracker issue) to drop retries to 0 unconditionally after S5+S6 ship and the failing-cluster floor is reliably zero across 50 consecutive CI runs.

## S9 — Cleanup of obsolete logging (optional)

- **AC-CLEAN-1** — Where the structured trace duplicates information that an old `console.debug("[mls-receive:...]")` previously emitted, the `console.debug` is removed. Trace remains the single source of truth.
- **AC-CLEAN-2** — Where `console.debug` carries information not in the trace (e.g. catch-block error messages), it is retained.
- **AC-CLEAN-3** — No production logging is added beyond what existed pre-epic; the trace is gated on the build flag.

## Cross-cutting

- **AC-X-NO-NDK-CHANGE-1** — `node_modules/@nostr-dev-kit/ndk` is not patched, vendored, or version-bumped. NDK behaviour is taken as-is and worked around above the `client.network.*` interface.
- **AC-X-NO-MARMOT-CHANGE-1** — `node_modules/@internet-privacy/marmot-ts` is not patched. The marmot-ts client interface (`NostrNetworkInterface`) is not modified. All changes sit in `src/marmot/` (consumer side).
- **AC-X-NO-RELAY-CHANGE-1** — `docker-compose.e2e.yml`, `strfry.conf`, and the relay container itself are not modified.
- **AC-X-NO-TEST-WEAKEN-1** — None of the existing failing-cluster tests have their timeouts extended, assertions weakened, or `test.fixme` applied as part of this epic. The 30-s envelope on `multi-user.spec.ts:145` and `three-party.spec.ts:79` is unchanged. (S7's new test uses 5 s, which is tighter.)
- **AC-X-CI-1** — `make e2e` (chromium + Mobile Chrome + Mobile Safari) with all stories merged passes on CI for ten consecutive runs **with `playwright.config.ts` retries=1** (the rollout configuration per AC-DOC-3). This epic ships with retries=1; the further tightening to retries=0 unconditionally is tracked as the follow-up in AC-DOC-4 and is NOT a deliverable of this epic. (Rationale: retries=1 covers residual unrelated flake during rollout; pinning the floor to 0 requires a longer observation window than this epic provides.)
- **AC-X-PROD-1** (advisory, not a merge gate) — Production-bundle size is not expected to grow more than a few KB compressed (the trace recorder no-op shell + new constants). Spot-check via `make build` size comparison if convenient; not enforced at PR time.
- **AC-X-RELAY-INDEPENDENCE-1** — The relay-state-independence principle (memory: `feedback_e2e_relay_independence`) is upheld. No new fixture is added that resets, wipes, or asserts against relay state. The retry mechanism is consumer-side. Re-stated in the spec's § *Non-Goals*.

## Manual Validation

- **AC-VAL-1 (during S4)** — Run `NEXT_PUBLIC_E2E_TRACE_MLS=1 make e2e` and inspect three F-class verdicts in `e2e/.triage/mls-trace-classify.log`. Confirm the classifier disagrees with itself on at most one of the six tests across three runs (i.e. classification is stable). Recorded in the report.
- **AC-VAL-2 (advisory, after S5)** — Optional exploratory check during S5 implementation: simulate a relay-socket delay (e.g. `tc qdisc add dev lo root netem delay 100ms` or equivalent) on the dev host, run the failing cluster three times pre-S5 and three times post-S5, and confirm F1 failures appear pre-S5 and not post-S5. Operational and host-network-coupled; not a merge gate. Skip if S3 traces from a real CI run already provide sufficient evidence.
- **AC-VAL-3 (after S6)** — Run S7's regression test 50 times consecutively. All pass. Recorded.
- **AC-VAL-4 (post-rollout)** — One week after S5+S6 land, query CI for the count of `multi-user.spec.ts:145` and `three-party.spec.ts:79` retries triggered. Expected: ≤2 across the week. If higher, file a follow-up.
- **AC-VAL-5 (one-shot regression confirmation)** — Reintroduce the deleted `_relayReset` fixture in a local working tree (do NOT commit). Run `make e2e` ten times. Compare the failure rate to the post-S5/S6 baseline (without the fixture). The two should be statistically indistinguishable; if they aren't, a residual relay-state dependency exists and a follow-up is filed. Procedure: apply the fixture, record both runs' outcomes in `report.md`, then revert via `git restore` (no commit). The report cites this validation; no commit-log entry is required because the fixture revert is local-only.
