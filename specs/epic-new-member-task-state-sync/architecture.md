# Architecture — New Member Task State Sync

## Paradigm

Modular monolith at top level; package-by-feature for module layout; hexagonal seams at external boundaries (Nostr relay, MLS via marmot-ts, IndexedDB).

## Module Map

| Module | Purpose | Directory | Owned Data |
|--------|---------|-----------|------------|
| `nostr.ts` | NIP-46 perms, NIP-44 bridge, key utilities | `src/lib/` | `NIP46_PERMS` string |
| `task-events.ts` | Task domain types: `Task`, `TaskEvent`, `TaskStateSyncPayload` (new) | `src/store/` | Type definitions only |
| `device-sync.ts` | Relay I/O, MLS ingest, task bootstrap publish/fetch (new) | `src/marmot/` | Stateless helpers; persistence delegated to persistence.ts |
| `persistence.ts` | IDB read/write for task events | `src/store/` | `notestr:events:<groupId>` IDB namespace |
| `task-store.tsx` | React context for task state; triggers bootstrap fetch (new) | `src/store/` | In-memory `TaskState`, loading flag |
| `GroupManager.tsx` | Invite UI; calls `publishTaskStateSync` after invite (new) | `src/components/` | UI state only |
| `task-protocol.md` | Wire format documentation (updated) | `docs/` | Spec document |

## Boundary Rules

- No direct imports across module boundaries.
- Cross-module access only through declared seam contracts.
- `device-sync.ts` MAY import from `persistence.ts` directly (established pattern: `appendEvent` already imported at device-sync.ts:41).
- `task-store.tsx` MAY call `useMarmot()` for signer/client/relays — it is mounted inside `MarmotProvider` (established pattern).
- `GroupManager.tsx` does NOT import task-store or persistence — all task-reading in the publish helper lives in `device-sync.ts`.

## Two-Identifier Scheme (Critical)

Every group has two distinct identifiers that are never interchangeable:

| Identifier | Source | Use |
|-----------|--------|-----|
| `group.idStr` | MLS group context bytes → lowercase hex | IDB keys (`appendEvent`, `loadEvents`, `isGroupJoinedFromWelcome`); kind-30078 d-tag |
| `getNostrGroupIdHex(group.state)` | Nostr group ID | Relay `#h` filter for kind-445; relay subscriptions |

The kind-30078 d-tag uses `group.idStr` (the MLS group ID), because both inviter and invitee derive the same `idStr` from the MLS group context after the Welcome is processed.

## New Surface: `publishTaskStateSync`

```
GroupManager.tsx:handleInvite()
  after group.inviteByKeyPackageEvent(kpEvent) succeeds
  → publishTaskStateSync(group.idStr, inviteePubkeyHex, signer, client, relays)
        ← device-sync.ts (new export)
        reads: loadEvents(groupId) + replayEvents()
        builds: TaskStateSyncPayload { version: 1, type: "task.state_sync", ... }
        encrypts: signer.nip44.encrypt(inviteePubkeyHex, JSON.stringify(payload))
        publishes: client.network.publish(relays, signedEvent)
          kind: 30078
          d-tag: notestr:task-sync:{groupId}:{inviteePubkeyHex}
        failure: non-fatal (catch + console.error, no user-visible error)
```

## New Surface: `fetchAndApplyTaskBootstrap`

```
task-store.tsx:load()
  const events = await loadEvents(groupId)
  if events.length === 0 AND (await isGroupJoinedFromWelcome(groupId)):
    await fetchAndApplyTaskBootstrap(groupId, ownPubkey, signer, client, relays)
          ← device-sync.ts (new export)
          queries: client.network.request(relays, { kinds:[30078], #d: [notestr:task-sync:{groupId}:{ownPubkey}], limit:10 })
          for each event:
            decrypts: signer.nip44.decrypt(event.pubkey, event.content) → JSON
            validates: version===1, type==="task.state_sync", groupId matches
            CRDT-gates: for each task in payload: apply LWW/FWW merge against current state
            persists: appendEvent(groupId, { type: "task.created", task }) for winning tasks
          re-reads: loadEvents(groupId) → replayEvents() → setState()
          failure: non-fatal (catch + proceed with empty state)
```

## CRDT Merge Gate

Applied before each `appendEvent` in the bootstrap fetch:

```
task NOT in store → insert (FWW)
task in store, payload.updatedAt > existing.updatedAt → accept (LWW)
task in store, equal updatedAt, payload.updatedBy < existing.updatedBy → accept (tie-break)
task in store, payload loses tie-break → skip (no-op)
empty tasks:[] payload → zero insertions (cannot wipe state)
```

## Implementation Constraints

- `signer.nip44` is optional on `EventSigner`; guard with `if (!signer.nip44) { throw ... }` or log + return early.
- `sign_event:30078` must be added to `NIP46_PERMS` in `nostr.ts` only; the unit test in `nostr.test.ts:101-107` enforces single-source-of-truth and must have 30078 added to `REQUIRED_KINDS`.
- Bootstrap tasks stored as synthetic `task.created` events — NOT as a new event type. This ensures the existing reducer handles them on re-load.
- `publishTaskStateSync` failure is non-fatal; new member gracefully degrades to empty state.
- E2E test: update TP-30 (task-sync.spec.ts) to assert B sees A's pre-join tasks; the prior assertion (empty board) was the behavior BEFORE this feature.

## Seams

- `device-sync.ts` → `persistence.ts`: `appendEvent`, `loadEvents` (existing seam, extended to bootstrap)
- `device-sync.ts` → `device-store.ts`: `isGroupJoinedFromWelcome` (existing seam, read in task-store.tsx via useMarmot chain)
- `task-store.tsx` → `device-sync.ts`: `fetchAndApplyTaskBootstrap` (new export/seam)
- `GroupManager.tsx` → `device-sync.ts`: `publishTaskStateSync` (new export/seam)
