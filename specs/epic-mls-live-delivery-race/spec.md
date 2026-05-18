# MLS Live-Delivery Race — kind-445 Subscription Gap

## Problem

Six chromium e2e tests fail intermittently on a long-running suite, all clustered on the same architectural seam: **a second context (User B or User C) is expected to observe an MLS-encrypted task event that was just published by another context (User A), and the assertion times out at 30 s.** The same tests pass in isolation on a clean relay, pass on every short re-run, and pass on CI today only because `playwright.config.ts` enables `retries: 1` when `CI` is set.

The two timing-out assertions are:

```
[chromium] multi-user.spec.ts:145  User B sees the task via live MLS subscription   30.0s
[chromium] three-party.spec.ts:79  A creates group, invites B, invites C → B,C see g 34.2s
```

Each takes the next 1–2 tests in its describe block down with it (cascade because `beforeAll` of the next describe acts on B's state, which the failed test left half-applied):

```
multi-user.spec.ts:155  User B sees task after reload (device-sync recovery)  0ms cascade
multi-user.spec.ts:198  User A sees the move via live MLS subscription        0ms cascade
three-party.spec.ts:101 a task A creates is visible on both invitees         27ms cascade
three-party.spec.ts:135 C creates → both A and B observe                     26ms cascade
```

The `multi-user.spec.ts:145` test annotates this exact failure mode in its own comment:

```ts
// Strict live-delivery assertion. Under heavy parallel relay load
// this can flake (the kind-445 commit is occasionally missed); CI
// retries cover that. Persistent failures here are a real regression
// in live MLS delivery.
```

That comment points at a symptom, not a cause. This epic owns identifying the cause and either eliminating the race or proving that the test design has to live with it.

The race is **not** a relay-state-accumulation problem. The kind-445 subscription filter is `{kinds:[445], "#h":[<thisGroupIdHex>]}` and the group id is a fresh hash per group creation, so commits from past tests cannot match. The race lives in the consumer pipeline between **the relay's broadcast** of a freshly-published kind-445 and **the receiver's MLS state** advancing to a position where `ts-mls.group.ingest()` can decrypt it.

## Where the race lives — code map

`src/marmot/device-sync.ts:syncGroup` is the entry point that wires up a group on the receiver side. Its current shape (verbatim, lines 497–550):

```ts
const syncGroup = async (group: MarmotGroup): Promise<void> => {
  if (!mountedRef.current || groupSubs.has(group.idStr)) return;
  if (joinBarrier) await joinBarrier;

  attachAppMsgListener(group);            // ← (a)
  attachRetryOnEpochAdvance(group);       // ← (b)
  lastEpoch.set(group.idStr, group.state.groupContext.epoch);

  const filter = { kinds: [445], "#h": [hTag] };

  try {
    const initialEvents = await client.network.request(...filter);   // ← (c) one-shot REQ
    if (!mountedRef.current) return;
    await ingestGroupEvents(group, initialEvents);                   // ← (d) ingest historical
  } catch (err) { /* logged */ }

  if (!mountedRef.current) return;

  const groupSub = client.network                                    // ← (e) persistent REQ
    .subscription(...filter)
    .subscribe({ next: async (event) => { await ingestGroupEvents(group, [event]); } });
};
```

Adapter under it (`src/marmot/network.ts`):

- `client.network.request(...)` opens an NDK subscription with `{ closeOnEose: true }`. After all relays send `EOSE`, the subscription closes and stops emitting events. A 15-second hard timeout exists as a fallback. (lines 91–127)
- `client.network.subscription(...)` opens a fresh NDK subscription with `{ closeOnEose: false }`. The history replay phase happens before the first `EOSE`; live events follow after. (lines 136–176)

Companion piece — the retry queue (`src/marmot/ingest-queue.ts`, `device-sync.ts:432–468`):

- Events that `ingest()` returns as `unreadable` are parked in a per-group `PendingRetryQueue`. The queue is bounded (max 200 entries) and TTL-pruned (24 h).
- The queue drains **only** when the group's MLS epoch strictly advances (`stateChanged` listener with a `newEpoch > lastEpoch` guard).

## Failure modes — what could actually be happening

The above pipeline has at least four candidate races. They are not mutually exclusive, and the test assertion sees them all as the same symptom (`toContainText` timeout on `[data-column="open"]`). Each needs distinct instrumentation to confirm.

### F1 — Fetch-then-subscribe gap (operation-ordering race)

Between `request()` resolving (c → d) and `subscription()` registering its REQ on the relay (e), the receiver has **no open subscription**. If a fresh kind-445 lands at the relay during this window, the **relay** still has it in its DB; the **persistent subscription's history replay** *should* deliver it to the receiver when the new REQ opens. So in principle nothing should be lost.

In practice three things can break that "should":

- **NDK subscription cache.** NDK keeps an in-process LRU of seen events per filter and may dedupe a freshly arrived event against a cached `seen` set carried over from the closed `request()` subscription. The shared key is the relay-event-id; if it's marked seen, the second subscription's `event` callback never fires for it. Worth instrumenting.
- **EOSE-vs-event interleaving on the relay.** strfry processes incoming events and outgoing REQs in a single thread; under load the order in which a `closeOnEose` REQ ends and a fresh REQ begins can race against an incoming write. If the relay decides "this REQ is closing, drop pending writes for it" before the new REQ has registered its filter, the event can briefly be invisible to anyone who happens to look during that microwindow. Replay on the *next* REQ is supposed to catch it. Worth tracing the relay side with a strfry log filter.
- **NDK reconnect during the gap.** NDK opportunistically reconnects on heartbeat misses. If the websocket bounces between (c) and (e), the new REQ goes out on a fresh socket; the old REQ's CLOSE may or may not have been seen; the relay can briefly send live events on a subscription nobody is listening to. NDK has been observed to drop events here in the past.

### F2 — Welcome-epoch lag (MLS-state race)

The receiver joins the group via `joinFromWelcomeInvite` (device-sync.ts:96–115), which sets the local MLS state to whatever epoch the welcome encodes. If the admin (User A) published one or more *commits* between building the welcome and B actually receiving it — for example, an auto-invite of a sibling device — those commits are at epoch `welcomeEpoch + n`, ahead of B's local state. When B's subscription fetches the historical 445s, ts-mls applies them in `created_at` order; a commit at epoch `welcomeEpoch + n` lands as `unreadable` if B is still at `welcomeEpoch + (n - k)`.

A previous commit (`device-sync.ts:200–235`) explicitly removed a "pre-seed" optimization that was masking this case — see the long inline comment. The retry queue (introduced in the same change) is the contract that's supposed to cover stragglers: when ts-mls eventually does advance to epoch `m`, the parked event at epoch `m+1` becomes ingestible and the queue drain re-tries it.

This works as long as **another commit** comes along to advance the epoch. If the only "next thing" is an *application message* (which does not advance the epoch — it just consumes a ratchet step), the queue never drains. The test waits 30 s; nothing in the system pokes the retry queue; the assertion times out.

This is the most plausible explanation for the multi-user.spec.ts cluster, because its sequence is:

1. A creates group (epoch 0 → 1, on A only)
2. A invites B (commit, epoch 1 → 2; B receives welcome at epoch 2)
3. A creates a task (**application message at epoch 2 — no epoch advance**)
4. B should receive (3) at its current epoch 2

But what if A's auto-invite of A's *own* sibling device (auto-invite scan running in the background) fired between (2) and (3)? Then:

1. A: epoch 0 → 1 (create)
2. A: epoch 1 → 2 (invite B); B's welcome at epoch 2
3. A: epoch 2 → 3 (auto-invite A2 commit, fired by the background scan triggered by a kind-30443 from A2 that B never sees)
4. A: app message at epoch 3
5. B receives (3) and (4) via subscription
6. B's state at epoch 2; ts-mls applies (3): epoch 2 → 3, OK
7. B's state at epoch 3; ts-mls applies (4): epoch 3, decrypts, OK

In this happy path the epoch advance from (3) is sufficient. The retry queue isn't needed. But:

- If **(3) is dropped on B's side** (F1) and only (4) arrives, B can't decrypt (4) at epoch 2; (4) parks. No further commit comes. Queue never drains.
- If **(3) and (4) arrive out of order** (NDK does not preserve relay order across reconnects), (4) parks first, then (3) arrives, advances to epoch 3, queue drain retries (4), succeeds.
- If the **`stateChanged` event fires before the retry queue is updated** (a within-`ingestGroupEventsRaw` ordering question), the drain could happen against a stale snapshot of the queue.

### F3 — applicationMessage emitted but UI state not updated

`task-store.tsx` updates React state **directly** from the MLS `applicationMessage` event (`setState(applyEvent(stateRef.current, taskEvent))` at `task-store.tsx:84`). The persistence (IndexedDB write via `appendEvent`) lives on a separate listener attached by `device-sync.ts`; the React render path does **not** depend on the IDB write. So if F3 occurs, the failure is one of:

- **F3a — listener not yet attached.** The `applicationMessage` listener is registered inside `TaskStoreProvider`'s `useEffect` (`task-store.tsx:69`), which only runs after `useGroup(groupId)` resolves to a non-null `MarmotGroup`. If `ingestGroupEventsRaw` decrypts a kind-445 and emits `applicationMessage` *before* the provider's effect has run (fresh mount under load, or rapid group-id swap), the event fires into the void.
- **F3b — rumor deserialization throws.** `deserializeApplicationData` rejects rumors with empty `id` or `pubkey`. A bad rumor (sender bug, marmot-ts version skew) silently lands in the catch at `task-store.tsx:89` — kind-445 was decrypted, the listener fired, but no `setState` happened.
- **F3c — wrong `rumor.kind`.** The handler discards rumors whose kind is not `TASK_EVENT_KIND` (`task-store.tsx:81`). A protocol drift (e.g. test fixture sends a chat-kind rumor instead of a task-kind rumor) would surface as an MLS-decoded but UI-invisible event.
- **F3d — load-after-live overwrite.** `TaskStoreProvider` runs two effects on mount: a load effect that calls `loadEvents(groupId)` and on resolve does `setState(restored)` (`task-store.tsx:48–66`), and an `applicationMessage` listener effect that does `setState(applyEvent(stateRef.current, taskEvent))` (`task-store.tsx:69–99`). If a live event arrives while `loadEvents` is still resolving, the live `setState` runs first; then the late-arriving `setState(restored)` overwrites it with whatever was on disk *at the time `loadEvents` was called*. The persisted event log is written by a *separate* listener attached in `device-sync.ts` (not by the provider), so the live event may not yet appear in `restored`. Result: kind-445 was decrypted, listener fired, `setState` ran — but a stale load reply clobbered the result. There is no merge guard in current code.

F3 is distinguishable in the trace via the structured `task-store-*` trace events emitted by the provider (see § *Trace event shape*). The classifier reads those events directly rather than parsing console.debug output — `[mls-receive:task-store-in]` log lines are not authoritative for classification (they may be removed in S9 cleanup).

The earlier framing ("IndexedDB-to-React propagation lag") was wrong; there is no IDB→React subscription in this codebase. Keep that in mind when reading older comments or commit messages that cite it.

### F4 — `closeOnEose` cliff in `client.network.request`

`network.ts:91–127` resolves the Promise on the *first* `EOSE` event from any relay in the set. With multiple relays, if relay R1 sends EOSE before R2 has finished sending events, the consumer drops the events R2 still has in flight. The subsequent `subscription` call would re-fetch them — but only if R2 is still healthy at that moment. A flapping R2 between (c) and (e) is enough to lose them.

The current setup has one relay (`ws://localhost:7777`) so this cliff is not a multi-relay race in production-test. But the implementation is multi-relay-shaped, and a future config that adds a second relay would re-introduce it.

## Why this didn't blow up before the relay-reset fixture went away

The deleted `_relayReset` auto-fixture wiped kinds 1059, 445, 30443 between every spec file. It made the relay slim enough that the per-group history replay finished fast, and the gap window between `request()` and `subscription()` was small. With 26 specs of cumulative kind-1059 traffic on the relay (from prior NIP-46 connect traffic, gift wraps, and snapshot fetches), the **total event load on the relay grows monotonically**, which cannot directly affect a per-group `#h`-filtered subscription, but **does** lengthen the EOSE round-trip on every REQ, which widens the gap window in F1.

The fixture was a band-aid that suppressed the race by suppressing the load. Now the band-aid is off.

## Solution — three approaches, pick one based on what F-class the data points to

### A. Subscribe-first, then catch up via since-bridge

Replace the fetch-then-subscribe with subscribe-first:

```ts
// 1. Capture t0 = now() in seconds.
// 2. Open the persistent subscription with `since: t0`. Buffer events
//    silently until step 4.
// 3. Issue a one-shot request with `until: t0`. Process its events
//    through the lock-protected ingest path.
// 4. Drain the buffer from step 2, deduped against the `syncedEventIds`
//    set populated by step 3. Hand future events directly to ingest.
```

The cutover is a stable wall-clock instant, not a network round-trip, so there is no gap. NDK's dedup cache is irrelevant because `since`/`until` are time-based. This is a one-file change in `device-sync.ts:syncGroup` plus a small subscribe-buffer abstraction.

The cost is that NDK's `subscription` adapter (`network.ts:136`) does not currently surface `since`-based filter parameters back to the user — the filter is opaque per the `Filter` type. A small refactor lets the caller pass either `Filter` or `Filter[]` already, so adding `since: t0` is just inlining it into the filter object before passing it down.

This addresses **F1** directly. **F2** is unaffected (epoch-lag is orthogonal). **F3** unaffected. **F4** mitigated for the request side because the `until` cap on a one-shot REQ caps the per-relay event window, but the EOSE-cliff itself remains.

**Trade-off: clock-skew sensitivity.** `t0` is the local clock; the relay stamps `created_at` on its end. The two clocks can disagree by seconds. A safe `t0` would back off by a few seconds (e.g. `t0 - 5s`) so the request and subscription overlap; the dedup set handles the duplication. This is the standard "high-water-mark with overlap" pattern.

### B. Drain-on-app-message — extend the retry trigger

Currently the `pendingRetry` queue drains only on epoch advance. If the only newer event is an application message (which does not advance the epoch), the queue stays parked.

Extend the drain trigger to fire on **any** ingest activity, not only epoch transitions. Concretely: at the bottom of `ingestGroupEventsRaw`, after `processed` is computed and persisted, retry the parked queue *if* `processed.size > 0`. Cap retry depth (e.g. one retry per ingest call) to avoid storms.

This addresses **F2**. Side benefit: if F1 has dropped a commit but a later app-message arrived and parked, a fresh ingest of any kind on the same group will re-attempt the parked event. The cost is a few extra ts-mls `ingest()` calls per live event under steady-state, which are O(1) at the parsing stage and bail out fast at the "still unreadable" branch.

**Trade-off: retry storms on adversarial input.** A malformed kind-445 (signed but undecryptable forever) parks once and would re-try on every subsequent live event. The TTL prune (24 h) eventually evicts it; the per-call cost is negligible. Cap with a per-event retry count if needed.

### C. Belt-and-suspenders — periodic resync

Add a low-frequency timer (e.g. every 60 s) per group that re-issues the historical `request()` and re-runs the retry-queue drain. Catches any event missed by F1/F2/F3/F4 within a bounded window.

This is the worst design (defensive polling masking real bugs) but the cheapest to add — about 20 lines. It's worth keeping as a fallback in case A and B together don't close all the cases. Disable in test mode or use a long enough interval (60 s) that the e2e suite still hits the live path first.

## Recommended approach

**Phase 1 — Instrumentation only.** Land a per-group event log (off by default, on via a `NEXT_PUBLIC_E2E_TRACE_MLS=1` flag) that records, in chronological order:

- every `client.network.request` start/end with relay event ids and timestamps;
- every `subscription.next` callback with relay event id and group epoch at receipt;
- every `ingestGroupEventsRaw` decision (`processed`, `skipped`, `rejected`, `unreadable`) with the event id and the group epoch before/after;
- every `pendingRetry.enqueue`/`remove`;
- every `stateChanged` with old/new epoch.

With the trace running on a failing CI run, the **first thing the trace shows** is which F-class is hit. If the kind-445 never appears in any subscription callback → F1. If it appears, gets `unreadable`, and is parked but never retried → F2. If it's processed by ingest but the React UI doesn't update → F3. The trace eliminates speculation.

**Phase 2 — Apply the fix that the data points at.**

- F1 → solution A (subscribe-first with since-bridge).
- F2 → solution B (extend retry trigger to any ingest activity).
- F3 → root cause depends on the subclass. F3a is a `TaskStoreProvider` mount-ordering bug owned by that file. F3b/F3c are upstream protocol/rumor-shape bugs. None of these are fixed in this epic — if S4 finds F3 dominates, the epic terminates after S4 with a follow-up spec filed against the relevant subclass.
- F4 → fix only if multi-relay configuration is on the roadmap. Single-relay test environment doesn't trigger it.

In the most likely case the trace will point at **both F1 and F2** as compounding factors, in which case A and B should both ship; they are independent changes and don't conflict.

**Phase 3 — Validate.** Re-run the suite ten times locally with `make e2e`. Acceptance is "the multi-user / three-party clusters pass on at least nine of ten runs without retries." A single retry should be sufficient for the remaining envelope of unrelated transient flakes; on CI, retries can be relaxed back to 0 once the floor is reliably zero failures.

## Scope

### In Scope

- A new file `src/marmot/mls-trace.ts` exposing a typed trace recorder gated on `NEXT_PUBLIC_E2E_TRACE_MLS === "1"`. Exposes `record(event: TraceEvent)`, `dump(): TraceEvent[]`, `clear()`. Test hook: `window.__notestrTestMlsTrace = () => mlsTrace.dump()` when the flag is on.
- Hook calls inserted in `device-sync.ts:syncGroup`, `device-sync.ts:ingestGroupEventsRaw`, `device-sync.ts:attachRetryOnEpochAdvance`, `network.ts:request`, `network.ts:subscription`. Each call site emits one `TraceEvent` per decision/transition. Production builds compile out via the `process.env.NEXT_PUBLIC_E2E_TRACE_MLS` guard and dead-code elimination.
- A diagnostic harness in `e2e/tests/multi-user-diag.spec.ts` (currently `fixme`-marked) extended to dump the trace from both pages on first failure and write it to `e2e/.triage/mls-trace-{user}.json`. Re-runs with `FAST_CHECK_SEED` reproduce; the trace makes the F-class diagnosable.
- **Solution A**: `device-sync.ts:syncGroup` rewritten to subscribe-first, with a 5-second `since` overlap and a deduping ingest pass against the populated `syncedEventIds` set. Verified by trace logs (F1 instances disappear).
- **Solution B**: `device-sync.ts:ingestGroupEventsRaw` extended to run a single retry-queue drain pass when `processed.size > 0`, with a per-event retry cap of 3 to bound storm risk. Verified by trace logs (F2 instances drain on app-message arrival).
- A unit test in `src/marmot/ingest-queue.test.ts` covers the "drain triggered by ingest activity, not just epoch advance" path (currently the queue is only tested for enqueue/remove/prune mechanics).
- An e2e regression test that deliberately reproduces the F2 sequence: A creates group, A invites B, A invites A's sibling-device commit (advance epoch under-the-hood by triggering an auto-invite), A sends a task. B's queue should park the app message and drain on the commit's arrival without a reload. Asserts at the `__notestrTestTasks` hook within 5 s of the publish (down from the current 30 s — the entire point is to remove the slack).
- A documentation note in `docs/task-protocol.md` describing the MLS receive pipeline (subscribe-first ordering, retry trigger semantics, trace hook for debugging).
- A toggle in `playwright.config.ts` to enable `retries: 1` when `NEXT_PUBLIC_E2E_TRACE_MLS` is unset (i.e. in normal local + CI runs). When the trace flag is set, retries are 0 so a failure pins the trace to the first run.

### Out of Scope

- Solution C (periodic resync). Held as a follow-up. Only revisit if A + B together don't close the failures.
- F3 (applicationMessage emitted but UI state not updated; subclasses F3a/F3b/F3c — see § *Failure modes*). Out of this epic. If S4's report shows F3 dominates, the epic terminates and a separate spec is filed against the relevant subclass (per `acceptance-criteria.md` § AC-REPORT-2a).
- F4 (multi-relay EOSE-cliff). Single-relay test environment doesn't trigger it. Document the constraint; do not fix.
- Switching off NDK in favor of a different relay client (e.g. `applesauce-relay` directly). Out of scope.
- Modifying the relay (strfry) configuration or replacing it. The race is in the consumer.
- Reworking marmot-ts's `client.network.subscription` interface. The fix sits above the interface.
- Rewriting the test assertions to be lenient (e.g. 60-s timeout). Loosening the assertion makes flakes less common but does not eliminate them, and hides legitimate regressions. Solution must address the cause.

## Design Decisions

1. **Instrumentation before code change.** The race is real but its F-class is unknown. The cheapest path to certainty is a trace; the cost of a wrong fix (e.g. fixing F1 when the failure was F2) is wasted iteration plus residual flakes. Phase 1 is non-negotiable as the first story.
2. **Subscribe-first cutover (A) uses `since`/`until` time-based bridge, not buffer-and-replay.** Buffer-and-replay would also work but introduces an in-process queue with its own ordering semantics. Time-based bridging stays inside the established Nostr filter primitives, NDK already supports them, and it composes with the rest of the relay's machinery without new abstractions.
3. **60-second overlap on the since-bridge is sized for end-user clock skew, not the dev host.** This fix ships to all users; mobile and desktop clocks routinely drift tens of seconds without active NTP sync. 60 s gives generous headroom against legitimate skew at negligible cost — overlap is deduped by `syncedEventIds` (each duplicated event short-circuits at the dedupe filter inside `ingestGroupEventsRaw`). Five seconds (which would suffice on the dev host) is a footgun in the field. Making the value tunable or skew-aware is YAGNI until a real cross-device skew distribution is measured. The constant is named `OVERLAP_SECONDS` and lives alongside the syncGroup body.

   This is **production runtime policy**, not test scaffolding. The trade is "more duplicate history replay on every group sync" against "correctness under realistic clock skew." Correctness depends on `syncedEventIds` continuing to dedupe reliably under repeated overlap; that invariant is already load-bearing for `ingestGroupEventsRaw` and adding `OVERLAP_SECONDS` does not strengthen it. If `syncedEventIds` ever weakens (eviction, wrap-around, persistence drift), this overlap would surface duplicate ingestion, not silent loss. Keep the dedupe layer well-tested.
4. **Retry-on-ingest (B) caps retries per-event-per-epoch at 3, with reset on epoch advance.** Three is empirical: the longest legitimate epoch-skew chain observed in three-party tests is 2. The cap defends against retry storms on adversarial input (a malformed kind-445 that's signed but undecryptable forever); the reset on epoch advance defends against permanent failure when a transient race takes more than 3 attempts to resolve. Without the reset, an event that exhausts its budget within epoch N would never recover even if a legitimate decrypting commit lands at epoch N+1.
5. **Trace flag is build-time, not runtime.** `process.env.NEXT_PUBLIC_E2E_TRACE_MLS` is read at module load and inlined; the production build compiles out the trace calls. This avoids per-call overhead in production and avoids accidental trace-data leakage to users.
6. **The diagnostic harness writes JSON to `e2e/.triage/`, not console.** Two contexts × thousands of trace entries is unreadable in a tail. JSON files keyed by user (`mls-trace-A.json`, `mls-trace-B.json`) are diff-able and machine-readable; a small scripts/triage-mls-trace.ts can render a flame-chart from them.
7. **Solution A is rewriting `syncGroup`'s body, not adding a new path.** No fallback to the old fetch-then-subscribe. Either the new path works for everything or it doesn't ship. Half-on/half-off is worse than either pole.
8. **The new e2e regression test exercises F2 specifically (parked app-message, drain on commit).** This is the harder case to reproduce; F1 is "easy" to reproduce by introducing latency on the relay socket between request close and subscription open. The F2 test is what proves the fix works after Phase 2.
9. **Retry env in `playwright.config.ts` is gated on the trace flag, not on `CI`.** When `NEXT_PUBLIC_E2E_TRACE_MLS=1`, retries=0 (every failure pins a trace). When unset (normal CI + local), retries=1 (covers residual unrelated flake during the rollout). After Phase 3 succeeds, retries can drop to 0 unconditionally; that step is a separate cleanup.

## Technical Approach

### File layout

```
src/marmot/mls-trace.ts                              (new)
src/marmot/device-sync.ts                            (modified — instrumentation hooks + solution A + solution B)
src/marmot/network.ts                                (modified — request/subscription emit trace events)
src/marmot/ingest-queue.test.ts                      (new — covers drain-on-ingest)
e2e/tests/multi-user-diag.spec.ts                    (modified — trace dump on failure, removed `fixme`)
e2e/tests/mls-live-delivery.spec.ts                  (new — F2 regression test)
docs/task-protocol.md                                (modified — describe receive pipeline)
playwright.config.ts                                 (modified — retries gated on trace flag)
specs/epic-mls-live-delivery-race/                   (this epic)
```

### Trace event shape

```ts
type TraceEvent =
  | { kind: "req-start"; t: number; relay: string; filter: Filter; reqId: string }
  | { kind: "req-event"; t: number; reqId: string; eventId: string; createdAt: number }
  | { kind: "req-eose"; t: number; reqId: string; eventCount: number }
  | { kind: "req-close"; t: number; reqId: string }
  | { kind: "sub-start"; t: number; relay: string; filter: Filter; subId: string }
  | { kind: "sub-event"; t: number; subId: string; eventId: string; createdAt: number; epoch: string }
  | { kind: "sub-close"; t: number; subId: string }
  | { kind: "ingest-call"; t: number; groupId: string; eventIds: string[]; epoch: string }
  | {
      kind: "ingest-result";
      t: number;
      groupId: string;
      eventId: string;
      result: "processed" | "skipped" | "rejected" | "unreadable";
      reason?: string;
      epochBefore: string;
      epochAfter: string;
    }
  | { kind: "queue-enqueue"; t: number; groupId: string; eventId: string; queueSize: number }
  | { kind: "queue-remove"; t: number; groupId: string; eventId: string; reason: string }
  | { kind: "queue-drain"; t: number; groupId: string; trigger: "epoch-advance" | "ingest-activity"; entries: number }
  | { kind: "epoch-change"; t: number; groupId: string; from: string; to: string }
  | { kind: "publish-task"; t: number; groupId: string; taskEventId: string; rumorId: string; eventId: string; createdAt: number }
  // Task-store receive path (see F3 in § Failure modes). These let the
  // classifier distinguish F3a/F3b/F3c/F3d without parsing console output.
  | { kind: "task-store-load-start"; t: number; groupId: string }
  | { kind: "task-store-load-complete"; t: number; groupId: string; restoredCount: number }
  | { kind: "task-store-recv"; t: number; groupId: string; rumorId: string }
  | { kind: "task-store-accepted"; t: number; groupId: string; rumorId: string; taskEventId: string }
  | { kind: "task-store-rejected"; t: number; groupId: string; rumorId: string; reason: "wrong-kind" }
  | { kind: "task-store-error"; t: number; groupId: string; rumorId: string | null; reason: "deserialize-throw" | "apply-throw"; message: string };

interface MlsTrace {
  record(event: TraceEvent): void;
  dump(): TraceEvent[];
  clear(): void;
}
```

`t` is `Date.now()`. Filters are recorded as a structural copy (no Object refs) so the dump is JSON-safe.

### Solution A — subscribe-first with since-bridge

```ts
// device-sync.ts:syncGroup, replacement body for lines 511–550

const filter = (since?: number): Filter => ({ kinds: [445], "#h": [hTag], ...(since != null ? { since } : {}) });
const t0 = Math.floor(Date.now() / 1000);
const OVERLAP_SECONDS = 60; // sized for end-user clock skew, see Design Decision 3

// 1. Buffer for live events that arrive while the historical fetch is in flight.
const liveBuffer: NostrEvent[] = [];
let cutoverComplete = false;

// 2. Open the persistent subscription FIRST. While `cutoverComplete` is
//    false, route incoming events into the buffer instead of the ingest
//    pipeline. This guarantees zero gap between "now" and the open REQ
//    AND preserves "historical events ingest before live events" ordering.
const groupSub = client.network
  .subscription(relaysForGroup, [filter(t0 - OVERLAP_SECONDS)])
  .subscribe({
    next: async (event: NostrEvent) => {
      if (!cutoverComplete) {
        liveBuffer.push(event);
        return;
      }
      try {
        await ingestGroupEvents(group, [event]);
      } catch (err) { /* logged */ }
    },
  });
groupSubs.set(group.idStr, groupSub);
subs.push(groupSub);

// 3. Issue the historical one-shot request and ingest its results FIRST
//    (in created_at order). syncedEventIds dedupe inside ingestGroupEventsRaw
//    handles overlap with the persistent subscription's history replay.
try {
  const initialEvents = await client.network.request(relaysForGroup, [filter()]);
  if (!mountedRef.current) return;
  await ingestGroupEvents(group, initialEvents);
} catch (err) { /* logged */ }

if (!mountedRef.current) return;

// 4. Cutover: drain the buffer in created_at order, then flip the flag so
//    subsequent live events bypass the buffer. Events already processed in
//    step 3 are filtered out by syncedEventIds inside ingestGroupEventsRaw.
const buffered = liveBuffer.splice(0).sort((a, b) => a.created_at - b.created_at);
cutoverComplete = true;
if (buffered.length > 0) {
  try {
    await ingestGroupEvents(group, buffered);
  } catch (err) { /* logged */ }
}
```

What this guarantees: the subscription opens first (zero gap from "now" until the open REQ); historical events ingest before any live events delivered during the gap; the dedupe set inside `ingestGroupEventsRaw` collapses overlap. The `cutoverComplete` flag is closure-scoped per `syncGroup` call so concurrent syncs for different groups have independent buffers.

What this does NOT guarantee: a hard total order on epoch/commit ingestion. `created_at` is second-granularity, so a commit and an application message published in the same second can tie and end up sorted in either order. That's an in-practice acceptable approximation: ts-mls applies events in the order it sees them, and the F2 retry-on-ingest behavior (Solution B) covers any same-second out-of-order case where the app message arrives before its prerequisite commit. Solution A closes the *subscription gap*; Solution B closes the *epoch ordering ambiguity within the gap*. Both ship together for that reason.

### Solution B — drain on ingest activity

```ts
// device-sync.ts:ingestGroupEventsRaw, after the existing
// `syncedEventIds.set(...); await addSyncedGroupEventIds(...)` lines

if (processed.size === 0) return;

// Persist the new processed set first (existing code).
syncedEventIds.set(group.idStr, new Set(mergeIds(seen, processed)));
await addSyncedGroupEventIds(group.idStr, processed);

// NEW: drain the retry queue once. Bounded by per-event-per-epoch
// retry cap to prevent storms on permanently-undecryptable events.
// retryAttempts is module-scoped Map<groupId, Map<eventId, count>>.
const retryQueue = getPendingRetryQueue(group.idStr);
const parked = retryQueue.snapshot();
if (parked.length === 0) return;
const groupAttempts = retryAttempts.get(group.idStr) ?? new Map<string, number>();
retryAttempts.set(group.idStr, groupAttempts);
const fresh = parked.filter((e) => (groupAttempts.get(e.id) ?? 0) < MAX_RETRIES);
if (fresh.length === 0) return;
for (const e of fresh) groupAttempts.set(e.id, (groupAttempts.get(e.id) ?? 0) + 1);
mlsTrace.record({ kind: "queue-drain", t: Date.now(), groupId: group.idStr, trigger: "ingest-activity", entries: fresh.length });
// Re-enter via the lock-protected path so we serialise with concurrent
// live events. The set-membership of `processed` won't grow because the
// ingestGroupEventsRaw filter excludes already-seen events; but events
// that flip from `unreadable` to `processed` will be remove()d from the
// queue inside the next ingest call.
void ingestGroupEvents(group, fresh).catch((err) => {
  console.debug("[mls-receive:drain-on-ingest-failed]", err);
});

// Companion: in attachRetryOnEpochAdvance's stateChanged handler,
// when newEpoch > prev, run `retryAttempts.get(group.idStr)?.clear()`
// before the existing queue-drain so the next-epoch retry budget is fresh.
```

`MAX_RETRIES = 3` and `retryAttempts: Map<string, Map<string, number>>` (outer key: groupId, inner key: kind-445 eventId) are module-scoped. The outer entry is removed wholesale in `refreshGroupSync` when its group teardown runs (one `retryAttempts.delete(groupId)` call drops the entire inner map for that group).

The retry counter for a parked event **resets to 0 on epoch advance**. When `attachRetryOnEpochAdvance`'s `stateChanged` listener fires with `newEpoch > prev`, the inner map for that `groupId` is cleared. Rationale: a fresh commit means genuinely new MLS state, and a previously-undecryptable event might now be decryptable for a different reason (a missing intermediate commit just landed, ratchet position advanced, etc.). Without this reset, a transient race that takes more than `MAX_RETRIES` retries to resolve becomes a permanent failure — the parked event sits in the queue with its retry budget exhausted, and a later legitimate decrypting commit can no longer recover it. The 24h TTL prune still bounds cost in the pathological case.

Cap is per-event-per-epoch, not per-event-lifetime.

### F2 regression test — `e2e/tests/mls-live-delivery.spec.ts`

```ts
test("[MLS-LIVE-1] B sees A's app-message after an unrelated epoch advance lands first", async () => {
  // Sequence:
  //  - A creates group; A invites B (B receives welcome at epoch 1)
  //  - A's auto-invite scan triggers; A commits to add A's sibling KP
  //    (kind-30443 from A2 published earlier); epoch 1 -> 2
  //  - A sends a task application message at epoch 2
  //  - B's subscription delivers BOTH the commit (epoch 1->2) and the
  //    app message (epoch 2). Order is undefined.
  //  - B's view should show the task within 5 s.

  // Note: the explicit auto-invite trigger requires a kind-30443 from
  // A's sibling KP. We simulate by publishing one from a third bunker
  // pubkey alias, or by using the test hook __notestrTestArmAutoInvite
  // (added by this story).

  // ... seed the auto-invite trigger via the test hook ...
  // ... A creates task; assert B sees it within 5 s, NOT 30 s.
});
```

The hook `window.__notestrTestArmAutoInvite(siblingKpEvent)` is added to enable this test deterministically. Without it, reproducing F2 relies on background-scan timing, which is too noisy.

### Documentation note in `docs/task-protocol.md`

A new section "MLS receive pipeline (consumer-side)" describing:

- The subscribe-first ordering and why (replaces the older fetch-then-subscribe described in earlier docs).
- The retry queue's enqueue / drain triggers (epoch advance OR ingest activity).
- The trace hook (`window.__notestrTestMlsTrace`) and the `NEXT_PUBLIC_E2E_TRACE_MLS=1` build flag.
- A reference to this epic for design rationale.

### Stories

- **S1 — Trace recorder skeleton.** New `src/marmot/mls-trace.ts` with the `MlsTrace` interface and a no-op default export. The `NEXT_PUBLIC_E2E_TRACE_MLS=1`-gated implementation goes in S2. ~80 LOC. Independently mergeable; no behavioural change.
- **S2 — Trace hooks at every relevant call site.** Inline `mlsTrace.record(...)` calls in:
  - `device-sync.ts:syncGroup`, `ingestGroupEventsRaw`, `attachRetryOnEpochAdvance` — pipeline events.
  - `network.ts:request`, `network.ts:subscription` — relay traffic.
  - `task-store.tsx:dispatch` — `publish-task` (sender side) joining `taskEventId` to kind-445 `eventId`.
  - `task-store.tsx` load-effect (lines 48–66) — `task-store-load-start` and `task-store-load-complete` to detect F3d.
  - `task-store.tsx:handleApplicationMessage` (line 72) — `task-store-recv` on entry, then exactly one of `task-store-accepted` / `task-store-rejected` / `task-store-error`.

  Without the publish-side identity hook, the S3 classifier has no way to bridge "the failing UI assertion looked for task X" to "the kind-445 event id that should have surfaced X." Without the task-store hooks, F3 subclasses cannot be distinguished from each other (and console.debug strings are not authoritative — they may be removed in S9). Build-time gated. Test hook `window.__notestrTestMlsTrace` exposed when flag is on. ~180 LOC. No production behaviour change.
- **S3 — Diagnostic harness.** `e2e/tests/multi-user-diag.spec.ts` extended (un-fixme it) to run the failing 6-test cluster three times with the trace flag on, dump traces to `e2e/.triage/mls-trace-{A,B,C}.json` on each failure, and emit a one-line summary that classifies each failure as F1/F2/F3 based on the trace content. ~150 LOC.
- **S4 — Empirical F-class report.** Run S3 on CI; capture three traces per failing test. Append findings to this epic's notes (`report.md`). Decide whether A, B, both, or neither ship in S5/S6. (No code change; this story is the data-collection gate.) **If F3 dominates the report (≥50% of failures across three runs), this epic terminates after S4 and a new spec is filed for the relevant F3 subclass — see AC-REPORT-2a in `acceptance-criteria.md`.**
- **S5 — Solution A (subscribe-first with since-bridge).** `device-sync.ts:syncGroup` rewritten per the snippet above. Verified by re-running S3: zero F1-classed failures. ~50 LOC delta.
- **S6 — Solution B (drain-on-ingest).** `device-sync.ts:ingestGroupEventsRaw` extended per the snippet. `src/marmot/ingest-queue.test.ts` covers the drain-trigger contract. Verified by re-running S3: zero F2-classed failures. ~80 LOC delta.
- **S7 — F2 regression test.** `e2e/tests/mls-live-delivery.spec.ts` exercising the F2 sequence deterministically via `__notestrTestArmAutoInvite`. Asserts the task surfaces in ≤5 s. ~120 LOC.
- **S8 — Doc + retry-config cleanup.** `docs/task-protocol.md` section. `playwright.config.ts` retries gated on trace flag. After this story ships, run the suite ten times locally and once on CI; if zero failures, lower CI retries to 0 in a follow-up.
- **S9 — Cleanup of obsolete logging.** Remove the `console.debug("[mls-receive:...]")` calls superseded by the structured trace, where they don't add diagnostic value beyond what the trace provides. Optional; can be folded into S2.

S1–S2 are pure infrastructure and can ship independently. S3–S4 are the diagnostic gate. S5 and S6 are the fixes; they are independent and can ship in either order or together. S7 is the regression net for S6 specifically. S8 finalises.

## Acceptance Criteria

See `acceptance-criteria.md`.

## Relationship to Other Epics

- **`feedback_e2e_relay_independence`** (memory entry, not a code epic) — this epic is the concrete follow-up. The relay-state-independence principle is what surfaced these failures; this epic addresses them at the source rather than by suppressing the load.
- **`epic-property-tests-l3-completion`** — independent. Property tests rely on the same MLS receive pipeline; F1/F2 fixes benefit them too. The 6-min `multi-user.property.spec.ts` runtime today contains some retry slack that could shrink once F2 is closed; that tuning is a follow-up to S6, not a deliverable here.
- **`epic-property-tests-l3-multi-device`** — independent. The multi-device file's `awaitDeviceJoin` polls on `__notestrTestPubkeyLeafCount`; if that polling races against the subscription gap (F1), this epic's S5 closes it.
- **TaskStoreProvider** (`src/store/task-store.tsx`) — F3a (mount-ordering of the `applicationMessage` listener) lives here. If S4 finds F3 dominates, a separate spec captures the fix in this file. F3b/F3c live further upstream (rumor protocol / kind routing). This epic stays bounded to the MLS-receive pipeline.
- **`docs/task-protocol.md`** — modified to describe the receive pipeline and the trace hook. Reference back to this epic.
- **`playwright.config.ts`** — retries flag gated on the trace flag during the rollout; final cleanup in a follow-up after a stable run.

## Non-Goals

- Eliminating live MLS delivery races at the protocol level. NIP-01 and ts-mls have semantics that admit ordering races; the consumer must handle them gracefully. This epic delivers graceful handling, not protocol revision.
- Replacing NDK with a different relay client. Out of scope.
- Adding a multi-relay test configuration to validate F4. Held as a follow-up only if multi-relay configurations land in production.
- Suppressing the failures with looser timeouts or `test.fixme`. Explicitly the wrong direction.
- Rewriting `multi-user.spec.ts` or `three-party.spec.ts` to avoid the live-delivery assertion. The assertion is the test's value; the fix sits in the producer/consumer code path it exercises.
- Tuning retry counts, queue sizes, or TTLs as a substitute for fixing the race.

## Amendments

- **2026-05-18 — AC-HOOK-9 rewritten via RECONCILE.** Original wording asserted `taskEventId = TaskEvent.id (the inner application payload identifier)`. There is no distinct `TaskEvent.id` field in this codebase: the application-payload identifier is `rumor.id`. The trace event's `taskEventId` slot is populated with `rumor.id` (`task-store.tsx:163`, `device-sync.ts:228`) — same value as `rumorId`. The AC is rewritten to document that semantics. Reference: S3 `result.json` GAP-1.
- **2026-05-18 — AC-DIAG-1 rewritten via RECONCILE.** Original wording said the diagnostic harness "runs as part of `make e2e`" (implying always-on). Reality: the harness is gated on `DIAG=1` (`test.skip(!DIAG, ...)` at `e2e/tests/multi-user-diag.spec.ts:126`), preserving the pre-existing developer-opt-in gate. The AC is rewritten to require the `DIAG=1` gate; an always-on follow-up is deferred until classifier stability is demonstrated (per AC-VAL-1). Reference: S3 `result.json` GAP-4.
- **2026-05-18 — AC-DIAG-2 rewritten via RECONCILE.** Original wording said the harness runs "the 6-test failing cluster up to 3 times". Reality: the harness runs a single representative multi-user live-delivery scenario, 3 retries. Architectural reasons: (a) AC-X-NO-TEST-WEAKEN-1 forbids modifying the original failing-cluster tests, (b) Playwright spec files are independent — cross-spec orchestration from a test body is not supported. The other failing-cluster tests share the same architectural shape and classify under the same F-classes, so the representative-scenario verdicts generalize. S4 `report.md` will document cross-cluster generalization explicitly.
- **2026-05-18 — AC-DIAG-3a rewritten via RECONCILE.** Original wording prescribed a fixture helper `recordExpectedTask(taskEventId)` writing expected eventIds per assertion. Reality: the harness reads the dispatched rumor.id from the sender via `window.__notestrTestSentRumors(groupIdStr)` and writes `{rumorId, taskTitle, runId}` to `e2e/.triage/expected-task-{run}.json`. No helper named `recordExpectedTask` exists; the correlator is `rumor.id` (per AC-HOOK-9 rewrite). The AC is rewritten to reflect the implemented mechanism.
- **2026-05-18 — AC-DIAG-4 rewritten via RECONCILE.** Original wording said "when `NEXT_PUBLIC_E2E_TRACE_MLS` is unset, the harness still runs but skips the trace dump and the classification." Reality: a two-flag gate is in place — `DIAG=1` is the outer skip gate; `NEXT_PUBLIC_E2E_TRACE_MLS=1` is the inner TRACE_MODE gate. With `DIAG=1` alone the harness runs in vanilla rerun-on-failure mode (no trace capture); with `DIAG=0` (the default) the harness skips entirely. The AC is rewritten to describe both gates explicitly. Cross-reference: AC-DIAG-1 (DIAG gate), GAP-4 in S3 `result.json`.
