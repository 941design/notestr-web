# New Member Task State Sync (notestr-web)

**Status**: Feature Request

**Companion spec**: `specs/epic-new-member-task-state-sync-cli/spec.md`

---

## Problem

When a user is invited to an existing notestr group, they join with an empty task list. Every task created before their join epoch is encrypted under MLS epoch keys they never held — this is MLS forward secrecy, a cryptographic property that cannot be overridden at the protocol layer.

The snapshot mechanism that previously bridged this gap (`publishTaskSnapshot` / `fetchTaskSnapshot`, kind-30078, removed in epic-task-snapshot-removal-crdt-convergence) was not safe: it replaced task state wholesale, a single empty snapshot destroyed all tasks, and fan-out amplified that destruction across every subsequent invite. The removal was correct. The bootstrap gap it leaves is now the problem.

### Current behavior (post-removal)

1. Member A invites Member B.
2. B's client processes the MLS Welcome and joins the group.
3. B's sync engine fetches all historical kind-445 events from the relay.
4. Pre-join events are undecryptable — silently skipped.
5. B sees an empty task list. Existing tasks are invisible to B permanently.

### Desired behavior

1. Member A invites Member B. Immediately after the MLS Welcome commit, A publishes the current CRDT-merged task list, NIP-44 encrypted to B's Nostr pubkey, as a parameterized-replaceable Nostr event (kind 30078).
2. B's client, after processing the Welcome, queries the relay for this event and applies the task payload using CRDT-merge semantics — never state replacement.
3. B sees A's pre-join tasks immediately.
4. All subsequent kind-445 task events are applied on top of the bootstrapped state via the existing live sync. CRDT convergence ensures the final state is identical regardless of order.

---

## Wire Protocol

This epic introduces one new event type shared with notestr-cli. Both clients must implement identical publish and consume behavior for interoperability.

### Event

| Field | Value |
|---|---|
| Kind | `30078` (NIP-44 encrypted, parameterized replaceable) |
| `d` tag | `notestr:task-sync:{groupIdHex}:{inviteePubkeyHex}` |
| Encryption | NIP-44 v2, sender = inviter's Nostr keypair, recipient = invitee's Nostr pubkey |

### Encrypted payload (JSON)

```json
{
  "version": 1,
  "type": "task.state_sync",
  "groupId": "<hex group id>",
  "tasks": [
    {
      "id": "<uuid>",
      "title": "<string>",
      "description": "<string>",
      "status": "open | in_progress | done | cancelled",
      "assignee": "<hex pubkey | null>",
      "createdBy": "<hex pubkey>",
      "createdAt": 1716000000,
      "updatedBy": "<hex pubkey>",
      "updatedAt": 1716000000
    }
  ],
  "syncedAt": 1716000000,
  "inviterPubkey": "<hex pubkey>"
}
```

`tasks` contains only non-deleted tasks. Deleted tasks are excluded (see D4).

### Relay query (new member)

```json
{ "kinds": [30078], "#d": ["notestr:task-sync:{groupId}:{myPubkey}"], "limit": 10 }
```

The new member does not filter by `authors` — they may not know which group member invited them. All events matching the d-tag are fetched; NIP-44 decryption with the member's own private key is the authentication gate. Events that fail decryption are silently skipped.

### CRDT merge semantics (critical)

The payload is never applied as state replacement. Each task in the payload is merged into the local store using the same rules as the live reducer:

- **Task not in store** → insert (equivalent to FWW accepting the first write)
- **Task in store, `payload.updatedAt > existing.updatedAt`** → accept (LWW)
- **Task in store, equal `updatedAt`** → accept if `payload.updatedBy < existing.updatedBy` (deterministic tie-breaker)
- **Task in store, payload loses tie-breaker** → no-op

An empty `tasks: []` payload has zero effect — it cannot wipe state under any race condition.

---

## Solution

### Publish side — inviter (`GroupManager.tsx`, `device-sync.ts`)

After `group.inviteByKeyPackageEvent(freshestKeyPackage)` succeeds in `GroupManager.tsx`:

1. Read the current task list for the group from IndexedDB via `loadEvents(groupId)` + `replayEvents()`.
2. Filter to non-deleted tasks (all keys present in the resulting `TaskState` map).
3. Serialize the payload as `TaskStateSyncPayload` (version 1).
4. NIP-44 encrypt with the invitee's hex pubkey as recipient (the `hex` variable already computed from `npubToHex(inviteNpub.trim())`).
5. Publish kind-30078 with d-tag `notestr:task-sync:{group.idStr}:{hex}` via `client.network`.
6. Failure to publish is non-fatal — log the error, do not surface to the user. The new member gracefully degrades to an empty state.

### Fetch side — new member (`device-sync.ts`, `task-store.tsx`)

In `task-store.tsx`, after loading the event log for a group (`loadEvents(groupId)`), if:
- the event log is empty, **and**
- `isGroupJoinedFromWelcome(groupId)` returns true

Then fetch bootstrap state:

1. Query the relay for kind-30078 events matching d-tag `notestr:task-sync:{groupId}:{ownPubkey}`.
2. For each event, attempt NIP-44 decryption with own private key via `client.nip44Decrypt()`.
3. For each successfully decrypted payload: validate `version === 1`, `type === "task.state_sync"`, `groupId` matches.
4. Apply each task in the payload by storing a synthetic `task.created` event to the local IndexedDB event log via `appendEvent(groupId, ...)` — one per task that passes the CRDT merge gate.
5. Re-run `replayEvents()` to rebuild in-memory state.
6. If no events are found or all decryption attempts fail: proceed with empty state (no error thrown, no user-facing error). Optionally surface a transient UI hint.

Storing bootstrapped tasks as synthetic `task.created` events in IndexedDB ensures persistence: after a page reload, the bootstrapped state is recovered from the local log without needing another relay query.

### CRDT merge at store time

Before calling `appendEvent`, check the CRDT gate:
- If the task ID already exists in the current in-memory state and the incoming task would lose the LWW comparison → skip `appendEvent` for that task.
- This prevents the bootstrap from overwriting newer live state that arrived in the window between join and bootstrap fetch.

---

## Scope

### In Scope

- `GroupManager.tsx`: call `publishTaskStateSync` after `inviteByKeyPackageEvent` succeeds; pass group ID, invitee pubkey hex, and current task state
- `device-sync.ts`: add `publishTaskStateSync(groupId, inviteePubkeyHex, tasks: Task[])` — reads from IndexedDB, serializes, NIP-44 encrypts, publishes kind-30078
- `task-store.tsx`: after loading empty event log for a welcome-joined group, fetch and apply bootstrap state via `fetchAndApplyTaskBootstrap(groupId, ownPubkey)`
- `device-sync.ts`: add `fetchAndApplyTaskBootstrap(groupId, ownPubkey)` — relay query, NIP-44 decrypt, CRDT-gated `appendEvent` calls
- `nostr.ts`: add `sign_event:30078` back to `NIP46_PERMS`
- `docs/task-protocol.md`: document the new event, d-tag format, payload schema, publish/fetch lifecycle, and CRDT merge semantics
- E2E test: invite → join → new member sees pre-join tasks immediately; create task after join → both members see it

### Out of Scope

- Refreshing bootstrap state for members who were already in the group and re-sync (live relay subscription handles this)
- Syncing group metadata or member list (carried in the MLS Welcome)
- CLI-side changes (separate spec: `epic-new-member-task-state-sync-cli`)
- Compression or chunking for large task lists (> 1000 tasks)
- UI indication of sync progress beyond graceful empty-state
- Re-bootstrap on demand (e.g., member explicitly requests re-sync)
- Migration of existing groups that were created before this feature shipped

---

## Design Decisions

### D1: Out-of-band NIP-44 vs. in-MLS application messages

**Option A (rejected)**: Publish current task state as fresh `task.created` kind-445 MLS application messages in the new epoch.
- All existing group members receive and must process N redundant events for a bootstrap that only benefits the new member.
- Existing state + bootstrap events must converge via FWW — which works, but original `createdAt` timestamps must be preserved in the payload for correctness, adding complexity.
- Produces permanent relay noise that compounds with group size and task count.
- Bootstrap events are indistinguishable from live task events in the audit trail.

**Option B (chosen)**: NIP-44 out-of-band to invitee's pubkey, kind-30078.
- Point-to-point: only the new member pays the query and decryption cost.
- No MLS involvement after the Welcome.
- Relay operator can observe the d-tag metadata (group ID, invitee pubkey) but not task content.
- Attack surface: inviter provides stale or wrong task state. This is corrected by live kind-445 events going forward. Application state compromise (wrong task list) is qualitatively different from cryptographic key compromise. The Matrix CVE (MSC3061) involved forwarding key material; this approach forwards application data, which has no equivalent attack class.

### D2: Inviter as publisher

The inviting device is the natural publisher: it has the group context, just committed the Welcome, and has the invitee's pubkey in scope. It holds the most recent view of group task state.

In multi-admin groups, multiple members could publish simultaneously for the same invite. The new member fetches all, decrypts all, applies all — CRDT merge handles any differences. Since tasks converge correctly under the FWW/LWW rules, multiple simultaneous bootstrap events are safe.

The event is parameterized replaceable per inviter: a re-invite by the same admin for the same member (e.g., after a leave/rejoin cycle) replaces the old event with a fresher snapshot.

### D3: Task objects, not event replay

The payload carries current merged `Task` objects, not a replay of historical `TaskEvent` records. Reasons:
- Compact: one object per task regardless of how many edits it has had.
- Decoupled: the bootstrap format does not need to version-match the internal event log format.
- Correct: applying Task objects via the CRDT merge gate (FWW/LWW) produces the same result as replaying all events.

On receive, bootstrap tasks are stored as synthetic `task.created` events. This is the simplest path to persistence without introducing a new event type in the reducer.

### D4: Deleted tasks excluded

Deleted tasks are excluded from the payload. Since pre-join kind-445 events are undecryptable, a new member cannot receive `task.created` events for IDs the inviter knows as deleted. Post-join creates for a known-deleted ID would be new events — the FWW rule (only insert if ID not already in store) does not guard against this case because the delete removes the ID from the store.

**Risk**: If task IDs are reused (they are UUIDs — effectively never reused), a post-join `task.created` for a formerly-deleted ID would be accepted. In practice this cannot happen.

**Future consideration**: If a strong tombstone guarantee is needed, include a `deletedIds: string[]` field in the payload (v2). Not needed for v1.

### D5: Graceful degradation when bootstrap event not found

A missing bootstrap event (inviter offline, publish failure, timing race) is not fatal. The new member starts with an empty task list and receives live events going forward. This is strictly no worse than the current behavior. A silent degradation is preferred over a blocking error on join.

Optional: a transient UI hint ("Loading task history…" → timeout → "Task history unavailable — you'll see new tasks as they arrive") may be added to `Board.tsx` without blocking the epic.

### D6: Bootstrap applied at task-store load, not at join time

The bootstrap fetch happens in `task-store.tsx` at the React layer, not inside `device-sync.ts` at the marmot layer. Reasons:
- `device-sync.ts` does not have direct access to the task store (correct separation).
- The task store already knows when a group's event log is empty and whether the group was joined from a Welcome (`isGroupJoinedFromWelcome`).
- Bootstrap state needs to be stored via `appendEvent`, which is already wired into the task store's loading path.

The `fetchAndApplyTaskBootstrap` function is implemented in `device-sync.ts` (relay query + NIP-44 decrypt) and called from `task-store.tsx` (where `appendEvent` and `replayEvents` live).

### D7: `sign_event:30078` re-added to NIP-46 perms

This permission was removed in epic-task-snapshot-removal-crdt-convergence as part of removing the snapshot feature. The new publish-side behavior requires it again. The permission is scoped to kind-30078 only and does not grant broader signing authority.
