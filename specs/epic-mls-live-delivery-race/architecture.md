# Architecture — MLS Live-Delivery Race

_Synthesized from `exploration.json` on 2026-05-18 during RESUME (no `arch_debate: true` flag). Living document; the story-planner populates seams as cross-story dependencies surface._

## Paradigm

Modular monolith at the top level. Package-by-feature within `src/` (each feature owns its module dir; the MLS receive surface is split across `src/marmot/` and the `src/store/` consumer). External boundaries are hexagonal seams: NDK relay client (`NostrNetworkInterface`), marmot-ts (`MarmotClient`), IndexedDB persistence (`src/persistence/`). This epic does not introduce new top-level modules; it surgically modifies the existing receive surface.

## Module map

The five modules this epic touches:

| Module | Purpose | Directory | Owned data |
|---|---|---|---|
| `marmot.client` | MarmotProvider, NDK init, MarmotClient construction, KP lifecycle, window test-hook installation | `src/marmot/client.tsx` | NDK signer, MarmotClient, KP cache, `window.__notestr*` hooks (419-543) |
| `marmot.device-sync` | MLS receive pipeline for task data: kind-445 subscription, ingest, retry queue, Welcome join, auto-invite | `src/marmot/device-sync.ts` | `groupSubs`, `syncedEventIds`, `pendingRetry`, `ingestLock`, `lastEpoch`, `joinBarrier`, `appMsgHandlersRef`, `stateChangeHandlersRef` |
| `marmot.network` | `NdkNetworkAdapter` — stateless NDK→`NostrNetworkInterface` adapter | `src/marmot/network.ts` | None (stateless); each call holds a transient NDK subscription |
| `marmot.ingest-queue` | Pure factory `createPendingRetryQueue()` — FIFO Map<eventId, PendingEntry>, bounded (200), TTL (24h) | `src/marmot/ingest-queue.ts` | Closure over Map |
| `task-store` | UI-facing consumer of decrypted task data. Two effects: load + applicationMessage listener | `src/store/task-store.tsx` | React state, IDB-loaded snapshot, dispatch path |
| `mls-trace` (NEW, S1) | Build-flag-gated trace recorder — pure module | `src/marmot/mls-trace.ts` | In-process buffer of `TraceEvent[]` when `NEXT_PUBLIC_E2E_TRACE_MLS=1`, else no-op |

S1 introduced `mls-trace` as a new module; S5 (Solution A) restructures `marmot.device-sync.syncGroup` (lines 514-525 + 529-550); S6 (Solution B) extends `marmot.device-sync.ingestGroupEventsRaw` with a drain trigger and introduces module-local `retryAttempts: Map<groupId, Map<eventId, number>>`.

## Boundary rules

- **No direct imports across module boundaries.** Cross-module access only through declared seam contracts.
- `mls-trace` is a leaf — imported by `client`, `device-sync`, `network`, `task-store`. It must not import any of them (pure module, no `react`/`next`/DOM deps; only `import type` from `applesauce-core/helpers/filter`).
- `marmot.network` adapts NDK to `NostrNetworkInterface`. It must not be aware of MLS groups or epochs — `device-sync` owns those. The S2 hook compromise (sub-event emitted in device-sync's subscription callback instead of network's, because only device-sync has the group epoch) is the documented exception.
- `marmot.ingest-queue` is pure — it does not call `mlsTrace.record`. The queue's mutations are observed via `queue-drain` events emitted by `device-sync` callers (per AC-HOOK-3, AC-B-4).
- `node_modules/@nostr-dev-kit/ndk` and `node_modules/@internet-privacy/marmot-ts` are not patched, vendored, or version-bumped (AC-X-NO-NDK-CHANGE-1, AC-X-NO-MARMOT-CHANGE-1). The marmot-ts `NostrNetworkInterface` is not modified.
- `docker-compose.e2e.yml`, `strfry.conf`, and the relay container are not modified (AC-X-NO-RELAY-CHANGE-1).
- E2E tests must remain relay-state-independent (`feedback_e2e_relay_independence`). No new fixture that resets, wipes, or asserts against relay state (AC-X-RELAY-INDEPENDENCE-1).

## Seams

Cross-story dependencies the planner identified during Mode 2:

- **S1 → S2/S3/S4/S5/S6**: every downstream story imports `mls-trace` to record events. The contract is the `TraceEvent` discriminated union — adding a new event kind requires extending the union AND the classifier (`e2e/fixtures/mls-trace-classify.ts`).
- **S2 → S3**: the S3 classifier consumes the trace events S2 inserts. The classifier's correlator is `rumor.id` (per AC-HOOK-9 / AC-DIAG-3a as amended 2026-05-18). The bridge from `rumor.id` to kind-445 `eventId` is GAP-2's option (c) — sender-side tracking via `expectedPublishByHTag` in device-sync.ts.
- **S3 → S4**: `report.md` (S4) consumes the per-run classify log (`e2e/.triage/mls-trace-classify.log`) and trace dumps from S3.
- **S4 → S5/S6/escape-hatch**: report decides whether F1 (→ S5) or F2 (→ S6) dominates, both, or terminates via F3 clause (AC-REPORT-2a). The S5 + S6 stories are mutually independent in code (different functions) but logically gated on S4's verdict.
- **S6 → S7**: S7's regression test verifies S6's drain-on-ingest path. AC-REG-5 explicitly reverts S6's body and confirms the new test fails — a binary contract between the two.
- **S5/S6 → S8**: S8's docs entry references the shipped consumer-side retry contract. Out-of-order ship: S8 can land before S7 if S5+S6 are in.

## Implementation constraints

- **Build-time flag inlining.** `NEXT_PUBLIC_E2E_TRACE_MLS === "1"` is a Next.js build-time constant (Next.js inlines `NEXT_PUBLIC_*`). Production bundles DCE the recording branch. No runtime check.
- **Trace recorder is symmetric about JSON-clone.** `record()` and `dump()` both deep-clone via `JSON.parse(JSON.stringify(...))` to close mutation leaks in both directions (call-site → recorder, recorder → consumer). `TraceEvent` is JSON-safe by construction.
- **`epoch` fields serialize as `string`** (bigint serialized) so dumps are JSON-safe.
- **`ingestLock` (device-sync.ts:413-430) must be preserved** through S5's subscribe-first restructure — serializing concurrent ingest calls is load-bearing for "desired gen in the past" error avoidance (AC-A-6).
- **`syncedEventIds` dedupe (device-sync.ts) must be preserved** through S5's overlap — events delivered both via subscription replay and the historical request must resolve to one `processed` (AC-A-4).
- **Per-syncGroup-call closure scope** for S5's `liveBuffer` + `cutoverComplete` flag (AC-A-1b) — a second concurrent `syncGroup` call (different group) has its own buffer.
- **Per-epoch retry counter reset** (AC-B-2a) — `attachRetryOnEpochAdvance`'s `stateChanged` listener clears the inner Map for that groupId on `newEpoch > prev`, BEFORE the existing epoch-advance queue-drain runs. The S3 classifier's F2 verdict assumes this reset semantics.
- **macOS sub-second clock skew** in `since` filters (GAP-5) is covered by S5's 60s OVERLAP_SECONDS (60000× margin). Documented in the constant's comment, referencing Design Decision 3 of spec.md.
- **Test hook installation** (`__notestrTestMlsTrace`, `__notestrTestArmAutoInvite` in S7, etc.) is gated on the build flag and lives in `marmot.client`. Production builds DCE the install block.
- **playwright.config.ts retries logic** (AC-DOC-3) gates retries on the trace flag: `retries: process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1" ? 0 : 1`. When the trace flag is on, a failure pins a trace; otherwise retries=1 covers residual flake during the rollout.
- **GAP-3 (CI references):** AC-X-CI-1 and AC-DOC-4 reference "CI runs" but no CI infrastructure exists in this repo. These ACs are satisfied by **local consecutive `make e2e` runs** documented in `report.md`. Filing CI as a separate epic is out of scope here.
- **GAP-2 (sender-side rumor→eventId bridge):** marmot-ts's `sendApplicationRumor` does not return the kind-445 event id. The bridge is sender-side tracking via `expectedPublishByHTag` (`device-sync.ts:50-255`) — kind-445 publishes observed during an open dispatch window are correlated with the queued rumor by hTag + temporal proximity. Ambiguity (multiple kind-445 publishes during one window — e.g. an auto-invite commit interleaved) is handled by dropping the queued entry and emitting NO `publish-task` for that rumor; the classifier sees the missing publish-task and verdicts that test as `unknown` (per AC-REPORT-3). This is intentional — emitting a wrong `publish-task` would silently misroute F-class verdicts.

## Amendments

Track AC/spec divergences and corrections here. (Spec `## Amendments` is the canonical record; this section cross-references.)

- **2026-05-18 (RECONCILE)** — Five S2/S3 ACs rewritten to match implemented mechanism (rumor.id correlator, DIAG=1 gate, representative scenario, `__notestrTestSentRumors` lookup, two-flag TRACE_MODE). See `spec.md ## Amendments` for full text. `reconciliation.json` records the post-adjudication verdicts (all five become `unverifiable` until S3 verification completes).
