# Receive Engine — FSM Transition Table

**ADR**: docs/adr/ADR-002-event-sourced-receive-engine.md
**Architecture**: ./architecture.md (this file is linked from "Open Questions §6")
**Status**: current — **must be honored by every `receive-engine.ts` story** (Phase 5 entry gate)
**Last updated**: 2026-07-12 (Stage-2 cold review amendments — see inline "(amended 2026-07-12, Stage-2 cold review)" markers)

This is the authoritative state model for the per-group receive engine. Three
independent story authors implementing `receive-engine.ts` MUST produce the same
machine. Where this file and prose disagree, this file wins.

---

## State = `{ lifecycle, health }`

`degraded` is **not** a lifecycle state. It is an orthogonal health flag. The
engine's state is a pair: a lifecycle phase plus a health value. Encode it as a
tagged record, never a flat enum.

```ts
type Health = "nominal" | "degraded";
type Lifecycle =
  | "uninitialized"
  | "joining"
  | "recovering"
  | "catching_up"
  | "buffering_live"
  | "live"
  | "retrying_deferred"
  | "stopped";
interface EngineState { lifecycle: Lifecycle; health: Health }
```

Any **active** lifecycle (`catching_up`, `buffering_live`, `live`,
`retrying_deferred`) may carry `health: "degraded"`. `uninitialized`, `joining`,
`recovering`, and `stopped` are always `nominal` (degraded health is meaningless
before the group is operational or after it stops).

---

## Lifecycle transitions

| # | From | To | Trigger | Guard | Entry action of target |
|---|---|---|---|---|---|
| L1 | uninitialized | recovering | `start({origin:"restored"})` | EITHER a persisted `EngineCheckpoint` exists, deserializes cleanly, AND `checkpoint.bootstrapCompleted === true`; OR the checkpoint is absent/corrupt BUT the group's raw-log or accepted-log is non-empty (preserve-and-replay per architecture.md Constraint 12: recover with `lastIngestedSeq = 0`, `health = degraded`; `bootstrapCompleted` is re-inferred to `true` IMMEDIATELY on taking this arm, before any checkpoint is saved — NOT deferred to reaching `live` — amended 2026-07-12, S5 Stage-2 cold review — P2-1) (reconciled 2026-07-12, Stage-1 review sev-6) | replay persisted raw-log + accepted-log (+ checkpoint when usable) to rebuild in-memory projection; rebuild `PendingRetryQueue` from `deferred-store` (R2a prune, then R2 — NOT from the checkpoint, which carries no deferred ids) |
| L2 | uninitialized | joining | `start({origin:"welcome"})`, OR `start({origin:"restored"})` when L1's guard does not hold | origin `"welcome"` (fresh join or post-reset re-join), OR origin `"restored"` AND (a usable checkpoint has `bootstrapCompleted === false`, OR the checkpoint is absent/corrupt AND raw-log AND accepted-log are BOTH empty) (reconciled 2026-07-12, Stage-1 review sev-6) | local per-group state is empty in every reachable sub-case except the `bootstrapCompleted === false` first-join crash, whose partial residue is regenerated idempotently by the fresh bootstrap (deterministic bootstrap ids); begin bootstrap snapshot fetch with timeout `T_join` (Item 4) |
| L3 | recovering | catching_up | recovery replay completes | — | open live subscription buffered; begin historical `catchUp()` drain |
| L4 | joining | catching_up | bootstrap snapshot applied | `bootstrapResolved` | open live subscription buffered; begin historical `catchUp()` drain |
| L5 | joining | catching_up **[degraded]** | bootstrap timeout/failure | `bootstrapTimedOut ∨ bootstrapFailed` (Item 4) | same as L4 entry, but set `health = degraded`; emit `engine_state_changed{health:"degraded"}` |
| L6 | catching_up | buffering_live | historical `catchUp()` iterator done | `catchUpComplete` | begin draining the live buffer accumulated during catch-up |
| L7 | buffering_live | live | live buffer drained to empty | `liveBufferEmpty` | if arrived via recovering/joining path, emit `recovered`; if catch-up succeeded without degradation, set `health = nominal` |
| L8 | live | retrying_deferred | `epoch_advanced` signal | `deferredQueue.nonEmpty` | flush deferred queue by re-submitting parked facts for re-ingest |
| L9 | retrying_deferred | live | deferred retry pass completes | — | — |
| L10 | *any active* | stopped | `stop()` | — | `adapter.close()`; persist final checkpoint |
| L11 | *any* | uninitialized | `reset()` | — | clear in-memory state AND persisted per-group stores via `PersistenceAdapter.clearGroupState(groupId)` (amended 2026-07-12, Stage-2 cold review — P1-2): raw-log, accepted-log, checkpoint (incl. `bootstrapCompleted`), and deferred ids |

"*any active*" = `joining | recovering | catching_up | buffering_live | live | retrying_deferred`.

**L2 rationale (amended 2026-07-12, Stage-2 cold review — P1-2; narrowed same day, Stage-1 review sev-6):** the widened L2 guard covers three cases in one rule — (a) fresh join or re-join via a freshly processed Welcome (`origin === "welcome"`), (b) a crash during a first joining phase, where a checkpoint was saved with `bootstrapCompleted: false` and restart must not route around the still-incomplete bootstrap, and (c) the migration-cutover population — existing users with persisted MLS state but no engine checkpoint at all AND no engine stores, whose first engine start runs a joining-style bootstrap over their existing state. **Deliberately NOT in L2:** a corrupt/absent checkpoint over NON-EMPTY local logs — that case routes to L1 recovering (preserve-and-replay, Constraint 12): intact logs are more authoritative than a lost checkpoint, and re-bootstrapping over them would discard nothing but would redundantly re-fetch and mask local truth. The empty-vs-non-empty log check is the disambiguator between "nothing to preserve" (L2) and "preserve and replay" (L1).

**L8 latch amendment (amended 2026-07-12, S5 Stage-2 cold review — P2-4):** an `epoch_advanced` received while not `live` is LATCHED, not dropped: entry to `live` with a non-empty deferred queue and a latched advance takes L8 immediately.

---

## Health transitions (orthogonal — do not change lifecycle)

| # | From | To | Trigger |
|---|---|---|---|
| H1 | nominal | degraded | live subscription error/drop, bootstrap timeout (L5), or repeated ingest failures past threshold |
| H2 | degraded | nominal | the degradation cause cleared: live subscription re-established AND live buffer re-drained, OR a late bootstrap fetch (post-`T_join`) resolved and merged |

Health changes emit `engine_state_changed{ state, health }`. A group can be
`live + degraded` (relay flaky but operating on local state) or
`catching_up + degraded`. Degraded never blocks the lifecycle — it annotates it.

---

## Cutover protocol (catching_up → buffering_live → live)

The gap-free cutover is the reason `catching_up` and `buffering_live` are
distinct:

1. **On entry to `catching_up`** (L3/L4/L5): the engine FIRST calls
   `adapter.openLive(onSignal → liveBuffer.push(signal))`, THEN begins draining
   `adapter.catchUp()`. Live is opened *before* historical drain so no event
   arriving mid-catch-up is lost.
2. While `catching_up`: historical signals are applied immediately; live signals
   are buffered (not applied), because applying a live event before the
   historical prefix would violate replay ordering.
3. **`catchUpComplete`** (historical iterator exhausted) → `buffering_live` (L6).
4. While `buffering_live`: drain `liveBuffer` in arrival order, applying each.
   New live signals continue to append and are applied as the buffer empties.
5. **`liveBufferEmpty`** → `live` (L7). The group is now caught up to real time.

---

## Joining timeout (`T_join`) — Item 4 / Decision 4

`T_join = 8000 ms` (default; configurable per deployment).

Rationale: the bootstrap fetch is a relay query (kind-30078 + EOSE). Normal
round-trips resolve in well under this; 8 s covers slow-relay tails while bounding
the worst-case "blank board on first join" window before the engine degrades and
proceeds. This is a UX ceiling on relay-blocked joins, not a typical wait.

**Wiring:**
- On entry to `joining`, start the bootstrap fetch AND an 8 s timer. The
  bootstrap fetch is the adapter's dedicated `fetchBootstrap()` drain — NOT
  `catchUp()`; `catchUp()` runs exactly once, on entry to `catching_up`
  (amended 2026-07-12).
- `bootstrapResolved` before the timer → L4 (`catching_up`, nominal).
- Timer fires first → `bootstrapTimedOut` → L5 (`catching_up`, **degraded**).
- **The fetch is NOT cancelled on timeout.** It continues in the background. If it
  resolves later, its snapshot is merged (LWW-safe — bootstrap is order-independent)
  and health returns to `nominal` (H2, extended below). The timeout only unblocks
  the lifecycle; it never discards a pending bootstrap.
- `bootstrapFailed` (terminal fetch error) before the timer → L5 immediately
  (degraded); a re-fetch is attempted on the next live-subscription reconnect.

This preserves today's behavior: a slow/down relay never freezes the group — the
user works on locally-available state and the bootstrap is absorbed whenever it
lands.

## Guard definitions

- `bootstrapResolved` — the kind-30078 bootstrap snapshot was fetched and merged.
- `bootstrapTimedOut` — `T_join` (8000 ms) elapsed before resolution; fetch continues in background.
- `bootstrapFailed` — the bootstrap fetch errored non-retryably.
- `catchUpComplete` — `adapter.catchUp()` async iterator returned done.
- `liveBufferEmpty` — no buffered live signals remain to apply.
- `deferredQueue.nonEmpty` — at least one parked fact awaits retry.

---

## Invariants

- **I-FSM-1:** `degraded` is encoded as `health`, never as a `lifecycle` value.
  No transition targets a lifecycle of `degraded`.
- **I-FSM-2:** Live subscription is opened on entry to `catching_up`, before the
  historical drain — never after. Otherwise events between historical EOSE and
  subscription open are lost.
- **I-FSM-3:** Live signals are buffered (not applied) until `live`. Applying a
  live event during `catching_up`/`buffering_live` is forbidden (breaks ordering).
- **I-FSM-4 (amended 2026-07-12, Stage-1 review sev-5):** A checkpoint is
  persisted on every lifecycle transition and periodically within `live`.
  Restart resumes via L1 (recovering) exactly when L1's guard holds — a usable
  checkpoint with `bootstrapCompleted === true`, or an absent/corrupt checkpoint
  with non-empty local logs (preserve-and-replay). Every other restart — post-
  `reset()`, first-join crash (`bootstrapCompleted === false`), or migration-
  cutover / empty-store start — resumes via L2 (joining). See the L2 rationale.
- **I-FSM-5:** `reset()` is the only path that clears persisted per-group state;
  it always lands in `uninitialized`. Re-join after reset re-enters via L2.
- **I-FSM-6:** Deferred retry (L8) fires only on `epoch_advanced`, never on a
  bare ratchet advance (consistent with the `IngestSignal` contract).

---

## Diagram (textual)

```
        start()                          start()
uninitialized ──[no ckpt]──► joining ──[bootstrap ok]──► catching_up
      │  │       │                            ▲ │
      │  │       └──[ckpt]──► recovering ──────┘ │ openLive+drain historical
      │  │                                       ▼
      │  │                                  buffering_live ──[buffer empty]──► live
      │  │                                                                      │ ▲
      │  └──────────────── reset() ◄───── (any) ──── stop() ──► stopped         │ │
      │                                                                         │ │
      └─────────────────────────── epoch_advanced & deferred ──────────────────┘ │
                                          retrying_deferred ────────────────────-─┘
   health: nominal ⇄ degraded  (orthogonal; applies to any active lifecycle)
```
