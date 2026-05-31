# Sibling-device task edits diverge: LWW tie-break collapses when two devices share a Nostr pubkey

## Description

When a user has two devices signed into the **same Nostr identity** (sibling
devices), any concurrent same-timestamp edit they each make to the same task
is silently dropped on every member's screen. This is real, user-facing data
loss for the multi-device use case.

The MLS layer recently gained MIP-03 fork resolution (marmot-ts commit
`5dcd989`) so the two devices' ratchet trees now converge after racing
commits — but the *task content* on each device stays divergent because the
task reducer's LWW gate rejects the losing-branch event identically on both
devices.

## Expected behavior

When two devices of one identity (D1, D2) each issue a different edit to the
same task at the same wall-clock second:
- One of the two edits deterministically wins on every device (D1, D2, and
  every other member of the group).
- The user does not lose their action silently. Either the edit takes effect
  or — at minimum — both devices agree on the same final state.

## Actual behavior

`updatedAt` ties → tie-break compares `updatedBy < existing.updatedBy` →
both devices have the **same pubkey** → `pubkey < pubkey` is always `false`
→ neither event satisfies the gate → **both events are rejected on both
devices**. The task stays in its pre-edit state, and the user's clicks vanish.

## Root cause

`src/store/task-reducer.ts:19-23` resolves event conflicts with a two-level
LWW compare:

```
event wins iff:
  event.updatedAt > existing.updatedAt
  || (event.updatedAt === existing.updatedAt
      && event.updatedBy < (existing.updatedBy ?? ""))
```

The comment at `src/store/task-store-utils.ts:7-9` already acknowledges
this: *"That tie-break only resolves edits by different authors."* The
follow-up comment at `src/store/task-store-utils.ts:21-23` names the
missing third level as `updatedByDevice` (a per-device clientId), but it
was never implemented.

The companion send-path fix `ensureMonotonicTimestamp`
(`src/store/task-store-utils.ts:25-42`, called from `task-store.tsx:274`
inside `dispatch()`) papers over the **same-device** case by bumping
`event.updatedAt` past `existing.updatedAt` before publish — but it has
two limitations relevant to this bug:

1. It runs only on the **send** path. The **receive** path
   (`handleApplicationMessage` at `task-store.tsx:181`) feeds remote
   events straight into `applyEvent` without bumping, so a sibling's
   remote event with a colliding timestamp is dropped at the receiver.
2. Even on the send path, two siblings each maintain their own
   `stateRef.current` and bump from their own local view. Both sibling
   edits at the same wall-clock second can both bump to `T+1` — and then
   the same LWW gate trap fires (`updatedAt` equal, `updatedBy` equal,
   no third tie-break).

Property tests acknowledge the limitation explicitly: `C1`
(permutation-independence) at
`src/store/task-reducer.property.test.ts:800-813` is scoped to
`task.status_changed`-only sequences, and `arbBoardSchedule` at
`src/store/multi-client.property.test.ts:240-257` only exercises
"different pause points in a shared total order" — neither covers
true sibling-device concurrency.

Regression introduced by commit `a0d19e3` (per project memory
`project_sibling_lww_tiebreak_divergence.md`).

## Prior art (not yet landed)

The learning store contains a high-confidence entry
`lww-tie-break-pubkey-alone-fails` (recorded 2026-05-24 from run
`bug-sibling-lww-tiebreak-divergence-2026-05-24-0833`) prescribing the exact
fix:

> Add a third level using a per-DEVICE discriminator — the MLS clientId
> (`client.keyPackages.clientId`, available as `clientId` on
> `MarmotContext`). The three-level compare is:
> 1. newer `updatedAt` wins
> 2. equal `updatedAt` → lower `updatedBy` pubkey wins
> 3. equal `updatedAt` + equal `updatedBy` → lower `updatedByDevice`
>    clientId wins
>
> This must be applied identically in ALL reducer mutation cases and in
> every CRDT merge gate (e.g. bootstrap), or devices will diverge at the
> gate that was missed.
>
> Backward compat: treat missing `updatedByDevice` as `''` everywhere.

A branch `fix/sibling-concurrent-edit-divergence` exists locally but its
only commit (`de6fedd`) is unrelated bootstrap-flag cleanup; the
prescribed reducer change was never landed.

## Reproduction approach

**Primary regression guard (preferred, deterministic):** a reducer-level
unit test in `src/store/task-reducer.test.ts` that constructs two events
with identical `updatedAt`, identical `updatedBy` pubkey, and different
`updatedByDevice` clientIds. Asserts that one event deterministically
wins and the other loses — and that the same outcome is produced
regardless of the order `applyEvent` sees them.

**Property-test broadening:** the scoped C1 invariant in
`task-reducer.property.test.ts:800-813` can be broadened once the
tie-break is deterministic across all mutation kinds for the
sibling-device case.

**E2E (secondary, flakier):** a sibling-device spec where two devices of
one identity each edit the same task at the same `updatedAt`, optionally
combined with an MLS-epoch race to trigger marmot-ts' MIP-03 rollback
path. Multi-context e2e is known-flaky per project memory
`project_multicontext_e2e_blanking.md`, so this is a complement, not a
sole proof.

## Recommended fix scope

Three layers, in order of importance:

1. **Reducer (the real fix).** Add `updatedByDevice: string` to `TaskEvent`
   (default `''` for backward compat). In `applyEvent`'s tie-break, add a
   third level `event.updatedByDevice < existing.updatedByDevice` after
   the existing `updatedBy` comparison. Apply identically in EVERY merge
   gate the codebase has — not just `applyEvent`'s mutation branches but
   any bootstrap-merge, snapshot-merge, or persistence-reconcile site.
   Populate `updatedByDevice = client.keyPackages.clientId` on dispatch
   (the field is already a stable, persisted 64-hex slot per the marmot-ts
   `clientId` contract).

2. **Rollback listener (companion fix).** Subscribe to the new marmot-ts
   `rollback` event in `src/marmot/device-sync.ts` (alongside the
   existing `applicationMessage` and `stateChanged` listeners around
   lines 869-887 / 814-865). Re-issue locally-sent task events from the
   `RollbackInfo`'s discarded-branch message list via
   `group.sendApplicationRumor`. Without this, sibling-device task
   events emitted during the fork window never reach the network at all,
   so the tie-break has nothing to break ties between.

3. **Cosmetic — dedupe `appendEvent`** (`src/store/persistence.ts:22-29`)
   keyed on a stable content hash, so re-issued events from layer 2
   don't leave duplicate IndexedDB rows. The reducer is already
   idempotent (asserted by `A13` / `C3` / `IDEMPOTENCE` in the property
   tests), so UI state is correct without this — but the log-hygiene
   improvement is small and reduces future debugging confusion.

## Fix constraints

1. **Do NOT weaken the reducer back to `>=`.** The strict `>` is what
   gives the reducer its deterministic convergence under reorder for
   the inter-author case; loosening it reintroduces the bug
   `task-same-second-edit-dropped` thought it had closed. See that
   bug's report at `bug-reports/task-same-second-edit-dropped-report.md`
   for the rationale.

2. **Must compose with the existing `ensureMonotonicTimestamp` helper.**
   That helper bumps timestamps on the **send** path; this fix adds a
   third tie-break level the reducer applies on **both** paths. They
   address different axes (ordering vs. concurrent-tie) and must not
   conflict.

3. **Backward compatibility for persisted events.** IndexedDB already
   contains historical TaskEvents written without `updatedByDevice`. The
   reducer must treat missing-or-empty `updatedByDevice` as the smallest
   possible value (`''`), so old events sort consistently against new
   ones without a migration step.

4. **Apply the tie-break at every CRDT merge gate.** The prior learning
   is explicit: "This must be applied identically in ALL reducer mutation
   cases and in every CRDT merge gate (e.g. bootstrap), or devices will
   diverge at the gate that was missed." Investigation must enumerate
   every merge gate (reducer mutation arms, `TASK_STATE_SYNC` bootstrap
   merge in `device-sync.ts` around line 1418, any snapshot reconcile).

5. **Update property tests.** The scoped C1 invariant in
   `task-reducer.property.test.ts` can be broadened once the tie-break is
   deterministic. Add a sibling-device-pair generator to
   `multi-client.property.test.ts` that exercises true concurrent edits
   from devices sharing a pubkey.

6. **Protocol doc.** `docs/task-protocol.md` describes the reducer
   semantics; the new third-level tie-break belongs in that document.

## Impact

- **Severity:** silent data loss for the entire multi-device use case
  (any user with two devices of one identity).
- **Surface:** every task mutation type (`task.updated`,
  `task.status_changed`, `task.assigned`, `task.deleted`).
- **Scope:** production UI + every receiver across all members of every
  group.

## Out of scope for this fix

- The cross-kind reorder limitation (`EDIT` vs `COMPLETE` at overlapping
  timestamps). That's a separate convergence gap noted by the same
  property tests; it is not the sibling-device bug.
- Migrating any existing diverged groups in the wild. Per marmot-ts'
  MIP-03 commit message: "Existing forked groups do not auto-heal."
- The known sibling-forget bug (`sibling-forget-fails-multi-device-same`)
  is at the MLS layer (leaf-identity matching), not the reducer, and is
  not addressed here.

## Environment notes

- `node_modules` is platform-correct for this Linux aarch64 host. Run
  all build/test via `make` (the platform stamp guard).
- Prefer reducer/store unit tests as the primary regression guard
  (`make test`). The multi-context e2e is independently flaky per
  project memory `project_multicontext_e2e_blanking.md`.
- The e2e relay (port 7777) is already running. Tests must remain
  relay-state-independent — never wipe/start/stop relay state.
- Do NOT kill processes discovered on ports; the harness fails loud on
  a busy port (per project memory `feedback_never_kill_discovered_processes.md`).

## Source

Bug surfaced by the user on 2026-05-31 after the marmot-ts MIP-03 rollback
landed (commit `5dcd989`); root cause and fix prescription confirmed
against prior learning `lww-tie-break-pubkey-alone-fails` (recorded
2026-05-24) and the companion bug report
`bug-reports/task-same-second-edit-dropped-report.md`.
