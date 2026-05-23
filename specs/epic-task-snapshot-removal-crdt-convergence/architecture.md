# Architecture — Task CRDT Convergence

## Paradigm

Functional core + imperative shell. The task domain has a clean split:
- **Functional core** (`src/store/task-reducer.ts`): pure functions, no side effects, no async
- **Data types** (`src/store/task-events.ts`): the discriminated union and Task interface — the type contract shared across layers
- **Imperative shell** (`src/store/persistence.ts`, `src/store/task-store.tsx`): IDB I/O, React state, optimistic dispatch
- **Transport** (`src/marmot/device-sync.ts`): MLS pipeline, Nostr wire protocol, snapshot mechanism (the primary target of this epic's removals)

## Module Map

| Module | Purpose | Directory | Owned Data |
|--------|---------|-----------|------------|
| `task-events` | Type contract: `Task`, `TaskEvent` union, `createTask`, `TASK_EVENT_KIND` | `src/store/` | Task and TaskEvent shapes |
| `task-reducer` | Pure reducer: `applyEvent`, `replayEvents` | `src/store/` | No persistent state |
| `persistence` | IDB append-log: `appendEvent`, `loadEvents`, `saveEvents`, `clearEvents` | `src/store/` | `notestr:events:<groupId>` IDB key |
| `task-store` | React context: dispatch, mount-replay, test hooks | `src/store/` | React state + dispatch channel |
| `device-sync` | Transport: MLS receive pipeline, snapshot send/receive (**removals here**) | `src/marmot/` | No persistent state of its own |
| `GroupManager` | Invite UI: calls snapshot publish after invite (**one call site to remove**) | `src/components/` | No persistent state |
| `nostr` | Auth/NIP-46: `NIP46_PERMS`, signer lifecycle | `src/lib/` | `sign_event:30078` to be removed |

## Boundary Rules

- `src/store/` types and functions are imported by `src/marmot/`; never the reverse (exception: `task-store.tsx` imports marmot coordination primitives `beginDispatchPublishWindow`, `endDispatchPublishWindow`, `enqueueExpectedPublish`, `removeExpectedPublishByRumorId` for the publish-window trace bracket — these are not task-domain imports).
- No direct imports across module boundaries other than via the declared seam.

## Seam

The seam between `src/marmot/` and `src/store/` is the four functions exported by `persistence.ts`:
- `appendEvent(groupId, event)` — append a TaskEvent to the IDB log
- `loadEvents(groupId)` — read the full event log
- `saveEvents(groupId, events)` — bulk-replace the log
- `clearEvents(groupId)` — delete the log

`device-sync.ts` calls `appendEvent` at two sites:
1. Line 935 — incoming MLS application messages (stays after this epic)
2. Line 712 — received `task.snapshot` (deleted by this epic)

It calls `loadEvents` + `replayEvents` inside `publishTaskSnapshot` (deleted by this epic).

## Implementation Constraints

### 1. No IDB migration system
`persistence.ts` uses raw `idb-keyval` get/set with `TaskEvent[]`. Adding `updatedBy: string` to `Task` means existing stored tasks will have `undefined` for this field. All reducer code that reads `existing.updatedBy` must use `existing.updatedBy ?? ""` to handle legacy records gracefully. No migration script is needed or provided.

### 2. NIP46_PERMS locality enforced by test
`nostr.test.ts:137-159` asserts that no other source file (non-test) contains `sign_event:<N>` or `nip44_*` tokens. Removing `sign_event:30078` from the `NIP46_PERMS` string in `nostr.ts` is safe — the test checks for REQUIRED_KINDS (which 30078 is not in), not that 30078 is absent. The test should pass after removal without changes.

### 3. TypeScript exhaustiveness — no task.snapshot variant means no case gap
After removing `| { type: "task.snapshot"; tasks: Task[] }` from `TaskEvent`, the TypeScript compiler will flag any switch statement that previously had a `case "task.snapshot"` branch. The reducer's `switch(event.type)` must have its snapshot case deleted. Any remaining case statement in test files referencing the string must also be cleaned up.

### 4. test-hooks.d.ts imports TaskEvent
`src/types/notestr-test-hooks.d.ts` imports `Task` and `TaskEvent`. After the union shrinks, this import remains valid (the type still exists, just with one fewer variant). No change needed unless the file has a literal `"task.snapshot"` reference.

### 5. multi-client property test has snapshot references in multiple places
Beyond D3, the multi-client property file has `task.snapshot` guards in C2 (line 706), A15 (line 814), and other lines (510, 863). Every guard of the form `if (e.type === "task.snapshot") { return e; }` must be removed when the variant is deleted from the union.

### 6. Existing unit test in task-reducer.test.ts
`task-reducer.test.ts:121-133` has a `describe` block "task.snapshot replaces entire state" with one test. Delete this entire describe block.

## Seams (Cross-Story Dependencies)

None across stories in this epic. All four stories modify distinct modules:
- Story 1: task-events.ts, task-reducer.ts, device-sync.ts, GroupManager.tsx, nostr.ts
- Story 2: task-events.ts (Task.updatedBy), task-reducer.ts (FWW + LWW fix)
- Story 3: task-reducer.property.test.ts, multi-client.property.test.ts, task-reducer.test.ts
- Story 4: docs/task-protocol.md

Stories 1 and 2 both touch `task-events.ts` and `task-reducer.ts`. The architect should implement them together or in dependency order (Story 1 then Story 2, as Story 2 adds fields and logic to the same types).
