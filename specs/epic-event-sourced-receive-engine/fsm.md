# Receive Engine — FSM Transition Table

**ADR**: docs/adr/ADR-002-event-sourced-receive-engine.md
**Architecture**: ./architecture.md (this file is linked from "Open Questions §6")
**Status**: current — **must be honored by every `receive-engine.ts` story** (Phase 5 entry gate)
**Last updated**: 2026-06-29

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
| L1 | uninitialized | recovering | `start()` | a persisted `EngineCheckpoint` exists for this group | replay persisted raw-log + accepted-log + checkpoint to rebuild in-memory projection and `PendingRetryQueue` |
| L2 | uninitialized | joining | `start({origin:"welcome"})` | no checkpoint exists (first join, or post-reset re-join) | local per-group state is already empty here (a re-join arrives via `reset()` → `start()`, see "Re-join & Reset" in architecture.md); begin bootstrap snapshot fetch with timeout `T_join` (Item 4) |
| L3 | recovering | catching_up | recovery replay completes | — | open live subscription buffered; begin historical `catchUp()` drain |
| L4 | joining | catching_up | bootstrap snapshot applied | `bootstrapResolved` | open live subscription buffered; begin historical `catchUp()` drain |
| L5 | joining | catching_up **[degraded]** | bootstrap timeout/failure | `bootstrapTimedOut ∨ bootstrapFailed` (Item 4) | same as L4 entry, but set `health = degraded`; emit `engine_state_changed{health:"degraded"}` |
| L6 | catching_up | buffering_live | historical `catchUp()` iterator done | `catchUpComplete` | begin draining the live buffer accumulated during catch-up |
| L7 | buffering_live | live | live buffer drained to empty | `liveBufferEmpty` | if arrived via recovering/joining path, emit `recovered`; if catch-up succeeded without degradation, set `health = nominal` |
| L8 | live | retrying_deferred | `epoch_advanced` signal | `deferredQueue.nonEmpty` | flush deferred queue by re-submitting parked facts for re-ingest |
| L9 | retrying_deferred | live | deferred retry pass completes | — | — |
| L10 | *any active* | stopped | `stop()` | — | `adapter.close()`; persist final checkpoint |
| L11 | *any* | uninitialized | `reset()` | — | clear in-memory state AND persisted per-group stores (raw-log, accepted-log, checkpoint, deferred, `bootstrap-completed`) |

"*any active*" = `joining | recovering | catching_up | buffering_live | live | retrying_deferred`.

---

## Health transitions (orthogonal — do not change lifecycle)

| # | From | To | Trigger |
|---|---|---|---|
| H1 | nominal | degraded | live subscription error/drop, bootstrap timeout (L5), or repeated ingest failures past threshold |
| H2 | degraded | nominal | live subscription re-established AND live buffer re-drained to empty |

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

## Guard definitions

- `bootstrapResolved` — the kind-30078 bootstrap snapshot was fetched and merged.
- `bootstrapTimedOut` — `T_join` elapsed before resolution (Item 4 sets `T_join`).
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
- **I-FSM-4:** A checkpoint is persisted on every lifecycle transition and
  periodically within `live`. Restart always resumes via L1 (recovering), never
  L2 (joining), unless `reset()` cleared the checkpoint.
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
