# ADR-001: Sender-side monotonic timestamp for sequential same-actor task edits

**Status**: Accepted
**Date**: 2026-05-24
**Type**: Lightweight
**Affects**: project-wide
**Supersedes**: none
**Superseded by**: none

## Context

The task CRDT uses Last-Write-Wins (LWW) ordering: an incoming event wins iff
`event.updatedAt > existing.updatedAt`, with a tie-break
`event.updatedBy < existing.updatedBy` (lexicographically lower pubkey wins) for
concurrent edits by distinct actors.

All producers (Board.tsx ×3, task-events.ts `createTask`) stamp events with
one-second resolution: `Math.floor(Date.now() / 1000)`. The LWW gate assumes
distinct edits get distinct `updatedAt` values — an assumption violated whenever
the same actor edits the same task twice within one wall-clock second.

When the same actor fires two mutations within one second:
- `event.updatedAt === existing.updatedAt` (same one-second bucket)
- `event.updatedBy === existing.updatedBy` (same pubkey)
- → tie-break `pubkey < pubkey` is **false** → second event silently rejected

This is real user-facing data loss: a user who assigns then immediately unassigns
a task within one second sees the task stay assigned. The drop happens in
`dispatch()` at the optimistic-apply step (`src/store/task-store.tsx:248`) and
on every receiver (`src/store/task-store.tsx:207–219`). See bug report
`bug-reports/task-same-second-edit-dropped-report.md`.

A separate but related problem — two devices of the same account (same pubkey)
making **concurrent** edits — requires a third tie-break level on a per-device
discriminator (`updatedByDevice` / MLS clientId). That fix is **not yet landed**
(branch `fix/sibling-concurrent-edit-divergence` is empty; learning
`lww-tie-break-pubkey-alone-fails` records the design). This ADR governs the
sequential same-actor fix and must compose with that eventual third level.

## Decision

Apply a **sender-side monotonic bump** in `dispatch()` (`src/store/task-store.tsx`)
before both the optimistic `setState` and the rumor publish.

The helper `ensureMonotonicTimestamp(event, existing)` in
`src/store/task-store-utils.ts`:
- If `event.type === 'task.created'` or `existing === undefined`: return event
  unchanged (First-Write-Wins; no existing state to compare).
- For the four mutation types (`task.updated`, `task.status_changed`,
  `task.assigned`, `task.deleted`): if `event.updatedAt <= existing.updatedAt`,
  return `{ ...event, updatedAt: existing.updatedAt + 1 }`.

A **synchronous `stateRef.current = nextState`** immediately after
`setState(nextState)` (before the first `await`) guards sub-frame re-entrancy:
two `dispatch()` calls in the same render cycle both read `stateRef.current`
rather than the stale React render snapshot, so each reads the post-previous-apply
state and bumps to a strictly greater timestamp.

Because the bumped `updatedAt` is embedded in the published rumor, receivers
always get the monotonically increasing value and accept the event through their
own LWW gate without any receiver-side change.

The reducer (`src/store/task-reducer.ts`) is **not modified**.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| **(A) Millisecond timestamps** — change all producers to `Date.now()` | Probabilistic: relies on an `await` gap existing between any two same-actor dispatches. Higher blast radius: Board.tsx ×3, task-events.ts, all e2e specs that hand-build events. Wire format changes. Rejected: non-deterministic. |
| **(B — chosen) Sender-side monotonic bump** — bump in `dispatch()` before apply | Single chokepoint, deterministic per-actor monotonicity, no producer or e2e spec changes, wire format (seconds) unchanged. |
| **(C) Lamport counter** — add a `seq` field to TaskEvent | Fully deterministic but requires a protocol/wire-format change, touches the task event schema, and does not compose cleanly with the existing `updatedBy` tie-break without also modifying the reducer. Deferred — would be the right choice if the ordering axis needs a third level beyond device id. |

## Consequences

**Positive**:
- Sequential same-actor rapid edits always converge to the last edit.
- Fix is in one chokepoint (`dispatch()`); producers, e2e specs, and the reducer
  are untouched.
- Deterministic: no reliance on timing gaps between async operations.
- Composes cleanly with the forthcoming `updatedByDevice` third tie-break level
  (targets the ordering axis only; leaves the concurrent-tie axis to `updatedBy`
  and eventually `updatedByDevice`).

**Negative**:
- `updatedAt` may drift a few seconds ahead of wall-clock under rapid-burst
  editing (each bump adds +1 second to the ordering key).

**Accepted Risks**:
- `updatedAt` drift is harmless because the field is an internal CRDT ordering
  key only — it is never rendered as a display date (confirmed: no date formatting
  of `updatedAt`/`createdAt` in Board.tsx, TaskCard.tsx, CreateTaskModal.tsx).
- The sibling-device concurrent-divergence bug (same pubkey, two devices,
  concurrent edits) is **not addressed** by this ADR — it requires the
  `updatedByDevice` tie-break on a separate branch.

## Evolution Triggers

Conditions under which this ADR should be reopened:

- The `updatedByDevice` / MLS clientId third tie-break lands: verify that the
  monotonic bump in `dispatch()` still composes correctly with the new gate shape.
- A Lamport counter (`seq` field) is proposed for the wire format: at that point,
  millisecond resolution or this bump may both be superseded.
- `updatedAt` is exposed in the UI as a display date: the "drift is harmless"
  assumption breaks and a display-safe field must be separated from the ordering key.

## References

- Origin: direct via `/base:adr`
- Bug report: `bug-reports/task-same-second-edit-dropped-report.md`
- Protocol doc: `docs/task-protocol.md` — "Sender-side monotonic timestamp" section
- Implementation: `src/store/task-store-utils.ts`, `src/store/task-store.tsx`
- Learning (sibling-device problem, separate): `lww-tie-break-pubkey-alone-fails`
  (run `bug-sibling-lww-tiebreak-divergence-2026-05-24-0833`)
