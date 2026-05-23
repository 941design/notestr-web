# Acceptance Criteria — Task CRDT Convergence

## AC-TYPE-1: task.snapshot variant removed from type union
`TaskEvent` in `src/store/task-events.ts` MUST contain no `task.snapshot` variant. TypeScript compilation MUST succeed without any `@ts-ignore` on snapshot-related code. The discriminated union shrinks from N to N-1 members; no other variant is affected.

## AC-TYPE-2: Task interface has updatedBy field
`Task` in `src/store/task-events.ts` MUST have `updatedBy: string`. `createTask()` MUST set `updatedBy` equal to its `createdBy` argument so that the initial task author is the initial "last updater".

## AC-REDUCER-1: task.snapshot case removed from reducer
`src/store/task-reducer.ts` MUST contain no `case "task.snapshot"`. The `applyEvent` function MUST compile without referencing the string `"task.snapshot"` in any form.

## AC-REDUCER-2: task.created is first-write-wins
Calling `applyEvent` with a `task.created` event for a task id that already exists in the state map MUST NOT overwrite the existing entry. The map entry is unchanged; the second event is a silent no-op. The implementation MUST guard the set with `if (!next.has(event.task.id))`.

## AC-REDUCER-3: update operations write updatedBy to state
After applying any `task.updated`, `task.status_changed`, `task.assigned`, or `task.deleted` event, the resulting `Task` entry in state MUST have `updatedBy` equal to the event's `updatedBy` field. This MUST hold for all four event types.

## AC-REDUCER-4: equal-timestamp update tie-breaker is deterministic
When two update events for the same task share the same `updatedAt` value, the event with the lexicographically lower `updatedBy` pubkey MUST win, regardless of which event is applied first. Applying the sequence [A, B] and [B, A] (where `A.updatedBy < B.updatedBy` and both share `updatedAt`) MUST both produce state matching A's payload. The tie-breaker condition MUST be `event.updatedAt > existing.updatedAt || (event.updatedAt === existing.updatedAt && event.updatedBy < (existing.updatedBy ?? ""))`.

## AC-REDUCER-5: legacy Task records without updatedBy are handled gracefully
All reducer code that reads `existing.updatedBy` MUST use `existing.updatedBy ?? ""` (nullish coalescing to empty string) so that Task records stored before this epic (which have `undefined` for `updatedBy`) are treated as having the lowest possible pubkey value and always lose tie-breakers to any real pubkey. No IDB migration is performed or required.

## AC-WIRE-1: publishTaskSnapshot removed from device-sync
`src/marmot/device-sync.ts` MUST export no `publishTaskSnapshot` function. The constants `TASK_SNAPSHOT_KIND` and `SNAPSHOT_D_TAG` MUST NOT exist anywhere in the file.

## AC-WIRE-2: fetchTaskSnapshot removed from join path
The MLS join barrier in `src/marmot/device-sync.ts` MUST NOT call `fetchTaskSnapshot`. The join flow MUST resolve without fetching any kind-30078 event. The `appendEvent` call at the former line 712 (which appended the fetched snapshot to IDB) MUST be gone.

## AC-WIRE-3: GroupManager no longer calls publishTaskSnapshot
`src/components/GroupManager.tsx` MUST NOT import or call `publishTaskSnapshot`. Triggering the invite flow MUST NOT publish a kind-30078 event. Both the import statement and the call-site block MUST be deleted.

## AC-WIRE-4: kind-30078 removed from NIP-46 perms
`src/lib/nostr.ts` `NIP46_PERMS` string MUST NOT contain `sign_event:30078`. The associated kind-30078 comment MUST also be removed. TypeScript compilation MUST succeed after the change. The existing single-source-of-truth test in `src/lib/nostr.test.ts` (lines 137-159) MUST continue to pass without modification.

## AC-TEST-1: D3 property test deleted from task-reducer.property.test.ts
`src/store/task-reducer.property.test.ts` MUST contain no test block referencing `task.snapshot` event creation. The labelled-known-failure test for snapshot behavior (the D3 block, approximately lines 1055-1106) MUST be deleted entirely. No `expect(true).toBe(true)` no-op placeholder may remain in its place.

## AC-TEST-2: D1 promoted to enforced assertion in task-reducer.property.test.ts
The test previously labelled D1 (commutativity of `task.updated` on equal timestamps) in `src/store/task-reducer.property.test.ts` MUST use a real `expect` assertion — specifically verifying that applying two update events in either order produces identical task state (same `title`, same `updatedBy`, and other mutated fields). The `fc.statistics` labelled-probe form with no assertion MUST be replaced with `fc.assert(fc.property(...))`.

## AC-TEST-3: idempotence property test added
A new property test in `src/store/task-reducer.property.test.ts` MUST verify that applying any single `TaskEvent` to a state twice produces the same result as applying it once. The test MUST cover all event types present in the post-epic `TaskEvent` union and MUST be an enforced `fc.assert` (not a statistics probe).

## AC-TEST-4: commutativity create-update property test added
A new property test in `src/store/task-reducer.property.test.ts` MUST verify that a `task.created` event followed by a `task.updated` event targeting the same task id, applied in either order, produces the same final state. The test MUST be an enforced `fc.assert`.

## AC-TEST-5: task-reducer.test.ts snapshot unit test deleted
The `describe` block "task.snapshot replaces entire state" at `src/store/task-reducer.test.ts:121-133` MUST be deleted entirely. No test in that file MUST reference the string `"task.snapshot"` or the former `next.clear()` behavior.

## AC-TEST-6: multi-client.property.test.ts D3 block deleted
The D3 block in `src/store/multi-client.property.test.ts` (lines 820-877, titled "[D3] late-arriving snapshot overwrites newer events on at least one client — labelled") MUST be deleted entirely. No `task.snapshot` event construction (e.g. `type: "task.snapshot"`, `tasks: snapshotAtT0`) MUST remain in that file's D3 region.

## AC-TEST-7: all task.snapshot guards removed from multi-client.property.test.ts
All inline guards of the form `if (e.type === "task.snapshot") return e;` or `if (event.type !== "task.snapshot")` MUST be removed from `src/store/multi-client.property.test.ts`. Specifically, the guards at lines 510, 706, 814, and 863 MUST be deleted. No other reference to the string `"task.snapshot"` MUST remain anywhere in the file.

## AC-TEST-8: C2 pass-through guard removed from task-reducer.property.test.ts
The `if (e.type === "task.snapshot") { return e; }` pass-through at `src/store/task-reducer.property.test.ts:945` MUST be removed. The C2 event-relabelling map MUST handle all remaining event types without a snapshot branch.

## AC-DOC-1: task-protocol.md documents reducer semantics
`docs/task-protocol.md` MUST contain a section documenting: (a) `task.created` is first-write-wins — a duplicate id is a no-op; (b) `task.updated`, `task.status_changed`, `task.assigned`, and `task.deleted` use LWW on `updatedAt` with a deterministic tie-breaker on `updatedBy` (lowest pubkey wins); (c) no `task.snapshot` variant exists in this implementation.

## AC-BUILD-1: TypeScript compilation passes with no new errors
Running `make build` (or `npx tsc --noEmit`) MUST succeed. Removal of `task.snapshot` from the union MUST NOT leave any unhandled discriminant arms or unresolved type references anywhere in the production codebase. The `src/types/notestr-test-hooks.d.ts` import of `TaskEvent` MUST remain valid without modification.

## AC-BUILD-2: Existing unit and property tests pass
Running `make test` MUST pass all tests. No new test failures MUST be introduced by this epic's changes. This criterion applies to the surviving tests after deliberate deletions (AC-TEST-1 through AC-TEST-8); deleted tests are excluded from this count.
