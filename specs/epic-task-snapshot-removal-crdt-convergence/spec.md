# Task CRDT Convergence — Remove task.snapshot and Enforce First-Write-Wins

**Status**: Specification

## Problem

Different devices in the same MLS group show different task lists for the same group — silently, permanently, with no error. Users create tasks on one device and they appear on another; then they're gone. The root cause is three interacting bugs:

### 1. task.snapshot is transmitted over the wire (violates the protocol intent)

When a device invites another (`publishTaskSnapshot` in `device-sync.ts:1369`), it publishes the current task state as a NIP-44 kind-30078 event to the relay. The receiving device (`fetchTaskSnapshot` at line 679) fetches this event and **persists it to the durable IndexedDB event log** (`appendEvent` at line 712). This side-channel snapshot is outside MLS — it is neither encrypted by the MLS group key nor bounded by MLS epoch.

### 2. task.snapshot unconditionally clears state in the reducer

`task-reducer.ts:58–64` calls `next.clear()` and replaces all state wholesale, with no timestamp check or LWW guard. Any empty snapshot anywhere in the log destroys all prior state. The property test file explicitly labels this as known failure D3 (`task-reducer.property.test.ts:1056` — *"late-arriving snapshot overwrites newer events — labelled via fc.statistics, no assertion"*).

### 3. Fan-out amplifies the damage to near-certainty

Each invite emits a snapshot. With multiple leaves per identity and multi-device invites, the empty-snapshot event lands in every peer's event log multiple times. A single corrupted leaf's "current state" (possibly empty after it itself was wiped) gets broadcast as the authoritative snapshot to every subsequent invitee.

### 4. task.created is last-write-wins (wrong)

`task-reducer.ts:10` does `next.set(event.task.id, event.task)` unconditionally. Two devices replaying the same events in different orders produce different state when there are duplicate-id creates. The correct behavior (per protocol intent and per notestr-cli's implementation) is **first-write-wins**: once a task with a given id exists, subsequent `task.created` events with the same id are no-ops.

### 5. Update tie-breaker is non-deterministic

`task.updated`, `task.status_changed`, `task.assigned`, and `task.deleted` use `event.updatedAt >= existing.updatedAt` (i.e., last-event-wins on equal timestamps). Two devices receiving the same pair of update events in different orders can produce different `Task.title` values if the events share an `updatedAt`. The `updatedBy` field is already on every update event but is not used for deterministic tie-breaking.

### Impact

An MLS group with ~7 leaves (realistic for a user with multiple browsers/sessions) will experience task-list divergence within its first few invites. The damage is permanent: once a wipe snapshot is in the event log, replaying the log always produces the post-wipe state.

## Solution

**Delete `task.snapshot` from the system entirely.** Not guarded, not deprecated — removed from the TypeScript type union, the reducer, all wire transport code, and the NIP-46 perms list.

New devices that join after epoch N receive task state via the existing kind-445 relay backfill, which already fetches all historical group messages and replays them through MLS. Events from before the join epoch are undecryptable due to MLS forward secrecy; this state is accepted as lost. The user has explicitly accepted no backwards compatibility and no migration of existing corrupted state.

Alongside the removal, fix the two reducer correctness bugs:
- `task.created` becomes first-write-wins
- update operations add a deterministic LWW tie-breaker: on equal `updatedAt`, the event with the lexicographically lower `updatedBy` pubkey wins

## Scope

### In Scope
- Remove `{ type: "task.snapshot"; tasks: Task[] }` from the `TaskEvent` union in `task-events.ts`
- Remove `case "task.snapshot"` from `task-reducer.ts`
- Remove `publishTaskSnapshot()` and `fetchTaskSnapshot()` from `device-sync.ts`, including their constants (`TASK_SNAPSHOT_KIND`, `SNAPSHOT_D_TAG`)
- Remove the `publishTaskSnapshot` call-site from `GroupManager.tsx`
- Remove `sign_event:30078` from the NIP-46 perms string in `nostr.ts`
- Add `updatedBy: string` to the `Task` interface (defaults to `""` for legacy records)
- Fix `task.created` to first-write-wins: `if (!next.has(event.task.id)) { next.set(...) }`
- Add LWW tie-breaker to all update events: `event.updatedAt > existing.updatedAt || (event.updatedAt === existing.updatedAt && event.updatedBy < existing.updatedBy)` (where `existing.updatedBy` is the new Task field)
- Delete the D3 property test (now vacuous — snapshot variant is gone)
- Promote D1 (commutativity probe for `task.updated` tie) from labelled-no-assertion to an enforced `expect` assertion
- Add idempotence property test: replaying any event a second time is a no-op on state
- Add commutativity property test: any permutation of a create+update sequence produces the same state
- Update `docs/task-protocol.md` to document first-write-wins and LWW tie-breaker

### Out of Scope
- Same-user multi-device pre-join-epoch state recovery (MLS forward secrecy is a feature here; a same-npub side channel is a separate future concern)
- CLI-side changes (coordinated separately by notestr-cli)
- Shared `notestr/task-protocol.md` spec bump (CLI team drives that; we document our side in `docs/task-protocol.md`)
- Migration scripts for existing corrupted IndexedDB state (user explicitly accepted no migration)
- Task list UI for empty-state after wipe recovery (out of scope; existing "no tasks" UI is sufficient)

## Design Decisions

### D1: task.snapshot removed vs. guarded vs. CRDT-ified
**Decision**: Remove entirely. The alternatives are:
- *Guard it (local-only enforcement)*: still susceptible to bugs where code path accidentally writes it to the log; requires runtime guards that can be bypassed.
- *CRDT-ify it (merge instead of replace)*: complex; snapshot semantics are fundamentally state-replacing which conflicts with CRDT convergence; would require vector-clock machinery for no gain.
- *Remove it*: simplest, provably convergent. New devices get state from relay backfill, which is already working.

### D2: New device bootstrap
The existing MLS pipeline in `device-sync.ts:syncGroup` already fetches all historical kind-445 events (`filter()` with no `since`) when a group loads. Events from before the join epoch are skipped by `ts-mls` (wrong MLS keys). Events from after the join epoch are applied. This IS the relay backfill. No new backfill code is needed; removing `fetchTaskSnapshot` is the only change to the join path.

Pre-join task state is permanently lost. This is the correct behavior under MLS forward secrecy.

### D3: task.created first-write-wins
Duplicate task IDs across devices should not cause data loss. If device A creates task T at epoch N and device B also sends a `task.created` for T (perhaps a retry or offline queue drain), the first one wins. The second is silently ignored. This matches notestr-cli's reducer and the protocol intent.

### D4: LWW tie-breaker storage in Task
Adding `updatedBy: string` to `Task` is necessary so the reducer can compare against the last-accepted event's author on tie. Without it, the `>=` comparison is correct for strict ordering but non-deterministic for ties. Existing `Task` records without `updatedBy` default to `""` (lowest lexicographic value), which always loses to any real pubkey — acceptable under no-migration policy.

### D5: Commutativity property test scope
The promoted D1 test should cover `task.updated` events specifically (the case where two updates share `updatedAt`). A separate commutativity test should cover create + update sequences. Both should be enforced assertions, not labelled probes.

## Technical Approach

### task-events.ts
- Remove `| { type: "task.snapshot"; tasks: Task[] }` from `TaskEvent`
- Add `updatedBy: string` to `Task`
- Update `createTask()` to set `updatedBy: createdBy` (task creator is the initial "updater")

### task-reducer.ts
- Remove `case "task.snapshot"` block (lines 58–64)
- Fix `case "task.created"`: wrap `next.set(...)` with `if (!next.has(event.task.id))`
- Update all update cases to use tie-breaker:
  ```ts
  const shouldApply = event.updatedAt > existing.updatedAt ||
    (event.updatedAt === existing.updatedAt && event.updatedBy < (existing.updatedBy ?? ""));
  ```
- For each update case that writes the task, also write `updatedBy: event.updatedBy`

### device-sync.ts
- Delete `TASK_SNAPSHOT_KIND` constant (line 331)
- Delete `SNAPSHOT_D_TAG` constant (line 333)
- Delete `fetchTaskSnapshot` function (lines 676–718)
- Remove `await fetchTaskSnapshot(group)` call from join barrier (line 607); update the comment at line 600
- Delete `publishTaskSnapshot` function (lines 1364–1407)

### GroupManager.tsx
- Remove `import { publishTaskSnapshot }` (line 16)
- Remove the snapshot publish block (lines 191–202)

### nostr.ts
- Remove `sign_event:30078` from `NIP46_PERMS` string (line 27)
- Remove the kind-30078 comment (line 23)

### task-reducer.property.test.ts
- Delete the D3 test block (lines 1055–1105 approximately)
- In D1: replace `expect(true).toBe(true)` with a real assertion:
  `expect(taskAB?.title).toBe(taskBA?.title)` (on both title and other mutated fields)
- Add new `it("[IDEMPOTENCE]")` test: applying any event twice produces the same state as applying it once
- Add new `it("[COMMUTATIVITY-CREATE-UPDATE]")` test: create+update in either order produces the same state when the task id is the same

### docs/task-protocol.md
- Add a new section `## Task reducer semantics` documenting:
  - `task.created`: first-write-wins; duplicate id → no-op
  - `task.updated` / `task.status_changed` / `task.assigned` / `task.deleted`: LWW on `updatedAt`; tie-break by `updatedBy` pubkey (lowest wins)
  - No `task.snapshot` variant exists in this implementation

## Stories

1. **Remove task.snapshot** — Type system, reducer, wire transport, call sites, nostr perms
2. **Fix task.created FWW and add LWW tie-breaker** — Task interface, reducer logic
3. **Promote property tests** — Delete D3, promote D1, add idempotence and commutativity
4. **Update protocol doc** — Document reducer semantics in docs/task-protocol.md

## Non-Goals
- Any mechanism to recover tasks that existed before the join epoch
- Any UI change to handle the empty-state after wipe (existing "no tasks" UI is fine)
- Changing the MLS bootstrap flow (kind-1059 gift wraps, key packages) — unrelated
- Changing task kinds (31337 stays as-is)
