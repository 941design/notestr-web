# Acceptance Criteria — New Member Task State Sync (notestr-web)

## AC-1: New member sees pre-join tasks

Given a group with at least one task created by Member A,
when A invites Member B and B's client processes the MLS Welcome and loads the task store,
then B's task list MUST show all of A's pre-join tasks within 5 seconds of the join completing,
and no error MUST be thrown.

## AC-2: CRDT convergence after bootstrap

Given B has received a state sync bootstrap payload containing task T,
when B also receives live kind-445 task events that update T (new creates, updates, status changes from any group member),
then B's final task state MUST match A's state (same tasks, same field values) regardless of the order in which the bootstrap payload and live events arrived.

## AC-3: Empty group — no tasks

Given a group with zero tasks,
when A invites B and B joins,
then B MUST start with an empty task list and MUST NOT throw an error or show a failure state.

## AC-4: Bootstrap event missing — graceful degradation

Given the inviter failed to publish a state sync event (or no kind-30078 event matching the d-tag exists on the relay),
when B's client loads the task store for the welcome-joined group,
then `fetchAndApplyTaskBootstrap` MUST NOT throw an error, B's task list MUST start empty, and B MUST continue to receive and display live task events normally going forward.

## AC-5: Idempotence — bootstrap applied twice

Given B has applied a state sync bootstrap payload (synthetic `task.created` events stored in IndexedDB),
when B's client reloads and re-reads the local event log,
then B's task state MUST be identical to what it was before the reload — no task MUST be duplicated and no task MUST be lost.

## AC-6: CRDT safety — empty bootstrap cannot wipe

Given B has received at least one live `task.created` event after joining,
when B also applies a state sync bootstrap payload with `tasks: []`,
then B's task list MUST be unchanged — the empty payload MUST NOT remove or overwrite any task already in the store.

## AC-7: CRDT safety — bootstrap and live events commute

Given a state sync payload containing task T1 with `updatedAt = X`,
and a live kind-445 `task.updated` event for T1 with `updatedAt = X + 1` (arriving before or after the bootstrap),
then T1's final field values in B's store MUST reflect the later update (`updatedAt = X + 1`) regardless of application order.

## AC-8: Multi-inviter — multiple bootstrap events converge

Given two group members (A and C) both independently publish a kind-30078 state sync event for invitee B,
when B fetches and applies both events,
then B's task state MUST be identical to the result that would be produced by applying each event alone and then the other — CRDT merge MUST produce the same deterministic outcome for any application order.

## AC-9: NIP-46 permission includes sign_event:30078

Given the app builds and connects a NIP-46 signer,
when the NIP46_PERMS constant in `src/lib/nostr.ts` is inspected,
then it MUST contain the token `sign_event:30078`,
and the `REQUIRED_KINDS` array in `src/lib/nostr.test.ts` MUST include `30078` so the single-source-of-truth unit test passes.

## AC-10: Protocol documentation updated

Given the epic is complete,
then `docs/task-protocol.md` MUST contain a section that documents all five of the following:
- The kind-30078 state sync event and its purpose
- The d-tag format `notestr:task-sync:{groupId}:{inviteePubkey}`
- The `TaskStateSyncPayload` schema (version 1, all fields)
- The publish lifecycle (inviter, timing, non-fatal failure handling)
- The fetch lifecycle (new member, relay query, NIP-44 decryption, CRDT merge gate)

## AC-11: CLI interoperability

Given notestr-cli publishes a kind-30078 state sync event when inviting a web member,
then the web client MUST be able to fetch, decrypt, and apply the payload successfully, producing the correct task list.

Given the web client publishes a kind-30078 state sync event when inviting a CLI member,
then the CLI client MUST be able to fetch, decrypt, and apply the payload successfully, producing the correct task list.

(Verified manually or via a cross-client E2E test once the CLI implementation is available.)

## AC-12: Manually-joined groups do not trigger bootstrap fetch

Given a group that was joined by the user directly (not via an MLS Welcome invite — `isGroupJoinedFromWelcome` returns false),
when the task store loads and the local event log is empty,
then `fetchAndApplyTaskBootstrap` MUST NOT be called — the bootstrap relay query MUST NOT be issued for manually-joined groups.

## AC-13: Non-fatal publish failure — inviter error does not surface to user

Given `publishTaskStateSync` is called after a successful invite and the relay publish call throws an error (network failure, signer error, etc.),
then the error MUST be caught and logged (e.g. `console.error`) and MUST NOT propagate to the caller,
and the invite flow in `GroupManager.tsx` MUST complete successfully without showing an error to the user.
