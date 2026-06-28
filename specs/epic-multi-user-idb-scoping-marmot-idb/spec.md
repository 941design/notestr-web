# Multi-user IndexedDB scoping (per-pubkey partitioning)

Source: BACKLOG.json finding promoted 2026-06-28.

## Problem

Every marmot data-layer store in notestr-web is an IndexedDB database whose
name is keyed **only by origin**, never by the signed-in user. `createKVStore(name)`
in `src/marmot/storage.ts` opens `notestr-${name}` (e.g. `notestr-groups`,
`notestr-key-packages`, `notestr-invite-store`, `notestr-failed-welcomes`,
`notestr-device-names`, `notestr-invited-keys`, `notestr-joined-groups`,
`notestr-bootstrap-completed`, `notestr-identity`, `notestr-group-sync`).

Because the database name has no pubkey component, two different npubs used in
the same browser **share the same physical stores**. When user A signs out and
user B signs in, B's app reads A's group metadata, key-package bookkeeping,
invite records, device names, and joined-group flags. This is a cross-account
metadata leak: B can observe which groups A belonged to, A's device names, and
A's invitation history — none of which B should ever see. It also corrupts B's
own state (B inherits A's `bootstrap-completed` / `joined-groups` flags, so B's
sync logic makes decisions based on A's history).

This is a privacy and correctness defect in the local data layer. It is not a
network/protocol issue — the relay and MLS layers are unaffected; the leak is
entirely client-side in how IndexedDB databases are partitioned.

## Solution

Partition the marmot IndexedDB data layer **by pubkey**: each signed-in npub
gets its own physically separate set of IndexedDB databases, so one user's app
can never open — let alone read — another user's stores. Isolation is achieved
*by construction* (different database names), not by a cleanup step that must
fire on signout.

A pre-auth boot phase exists (the app loads before the user authenticates), so
store handles can no longer be eagerly created at module load. Store creation
becomes a factory keyed by the active pubkey, established once authentication
resolves the identity and torn down / re-pointed on identity switch.

## Scope

### In Scope

- Re-key every marmot IndexedDB database created via `createKVStore` (and the
  invite store via `createInviteKVStore`) to include the active pubkey in the
  database name. This also auto-covers `notestr-forgotten-slots` and
  `notestr-failed-welcomes`, which already route through `createKVStore`.
- Partition the task event log in `src/store/persistence.ts` (currently the bare
  idb-keyval default `keyval-store`, unprefixed and unscoped) so a prior user's
  task history does not surface after an account switch. Without this, the
  privacy goal (AC-E2E-1) is only partially met — group/device metadata would be
  isolated but task *content* would still leak.
- Convert the module-level singleton store handles in `src/marmot/storage.ts`
  (`identityStore`, `deviceNamesStore`, `invitedKeysStore`, `joinedGroupsStore`,
  `bootstrapCompletedStore`, `groupSyncStore`, and the invite store) into a
  per-pubkey factory whose handles are bound after authentication.
- Define and document the database-name scheme (pubkey component shape, prefix).
- Resolve the per-device `clientId` / MLS-leaf-identity question (Design
  Decision 2 below) — whether the identity store is shared per-browser or
  partitioned per-pubkey — and implement the chosen behavior.
- A migration policy for existing single-user data sitting under the old
  origin-only `notestr-${name}` databases.
- E2E coverage proving cross-account isolation on a shared browser, integrated
  with the existing `clearAppState` fixture and the relay-state-independence rule.

### Out of Scope

- Partitioning any non-marmot browser storage (localStorage, sessionStorage,
  service-worker caches) — only the marmot IndexedDB data layer is in scope.
- A UI for multi-account switching. This epic makes the *storage* correct; any
  account-switcher UX is a separate epic.
- Encryption-at-rest of IndexedDB contents. Partitioning prevents cross-account
  reads within the app; it does not defend against an attacker with direct
  IndexedDB access (that is a different threat model).

## Design Decisions

1. **Per-pubkey partitioning, not clear-on-signout.** Isolate by giving each
   npub physically distinct IndexedDB databases. Rationale: partitioning is
   correct by construction — user B opens different databases and cannot read
   A's even if a signout cleanup never runs (defense in depth) — and it
   preserves each identity's local state across account switches (no
   re-bootstrap). Clear-on-signout is a single point of failure: an abrupt
   tab-close or crash before the cleanup fires leaks A's data to the next user.
   Refs: `src/marmot/storage.ts:25` (`createKVStore`).

2. **RESOLVED — partition the `identity`/`clientId` store per-pubkey.** The
   `clientId` (`getOrCreateClientId`, `src/marmot/storage.ts:122`) is itself a
   non-secret per-browser slot name, but the load-bearing collision is in
   `notestr-key-packages` and `notestr-group-state`: those embed the device's
   **MLS leaf signing key**. If user B loads user A's `ClientState`, every MLS
   epoch transition (commit/proposal) is signed with A's leaf key and rejected
   by other members. Since key-packages and group-state MUST be per-pubkey to
   stay self-consistent, the identity store is partitioned with them — each
   (browser, npub) becomes one self-consistent MLS leaf (clientId + KP +
   group-state in the same partition). Relay addressing already disambiguates KP
   events by `pubkey + d`, so distinct per-npub clientIds never collide on the
   network. (Validated against the leaf model via codebase exploration:
   `client.tsx:204` passes `clientId` to `MarmotClient`; group-state/key-package
   stores hold the leaf credentials.)

3. **RESOLVED — lazy DB-name resolution, not eager handle re-creation.**
   Exploration confirmed that `createKVStore(name)` only *caches* the database
   name at module load — idb-keyval does not call `indexedDB.open()` until the
   first actual get/set, and every store I/O happens inside a function invoked
   only after `MarmotProvider` mounts (pubkey known; no pre-auth IDB access).
   Therefore the module-level singleton handles are kept as-is, but
   `createKVStore` resolves its database name **lazily** from a module-level
   `activePubkey` that `bindStores(pubkey)` sets in `client.tsx` `init()` before
   any store I/O. Accessing a store while `activePubkey` is null throws
   (fail-fast — `AC-LIFE-2`). On identity switch the lazy underlying `UseStore`
   is rebuilt for the new pubkey, so handles re-point with no consumer changes.
   Injection point: `src/marmot/client.tsx` `init()`, before the existing
   `createKVStore`/`getOrCreateClientId` calls (~line 188).

4. **RESOLVED — migrate legacy data to the first pubkey that binds, one-shot.**
   Existing users have data under the old origin-only `notestr-${name}`
   databases. On the first sign-in after upgrade, that data is copied (raw-IDB
   read → partition write → delete the legacy origin-only DB) into the binding
   pubkey's partition, gated by an origin-level marker so it runs exactly once;
   a second pubkey binding later starts from an empty partition.

   *Codex-review note (accepted tradeoff):* single-vs-multi-owner of the legacy
   blob is **undetectable from local origin-only data** (it carries no pubkey
   tags). Wholesale copy to the first binder therefore risks giving that user a
   prior co-user's local data IF the browser was shared by multiple npubs
   pre-upgrade. This is accepted because (a) the common case is a single-user
   browser, where the copy is correct and preserves the user's groups/MLS leaf;
   (b) in the rare shared-browser case the legacy data was **already commingled
   under the pre-partitioning bug**, so the first binder seeing it is no worse
   than the status quo being fixed; (c) every write *after* the migration is
   correctly isolated. A future enhancement could gate migration on a
   network-verified single-owner check; tracked as a follow-up.

5. **Database-name scheme.** Database names become
   `notestr-${pubkeyComponent}-${name}` where `pubkeyComponent` is a stable,
   filesystem/IDB-safe derivation of the active pubkey (e.g. the lowercase hex
   pubkey or a fixed-length prefix — exact shape decided in implementation,
   subject to collision-safety). The `notestr-` prefix is retained so existing
   tooling and the e2e `clearAppState` fixture can still enumerate and wipe all
   notestr databases by prefix.

## Technical Approach

### `src/marmot/storage.ts`

The core change. `createKVStore(name)` must incorporate the active pubkey into
the `createStore` database name. The module-level singleton exports
(`deviceNamesStore`, `invitedKeysStore`, `joinedGroupsStore`,
`bootstrapCompletedStore`, `identityStore`, `groupSyncStore`) and the invite
store become factory-bound to the active pubkey. A sketch:

```ts
// Illustrative, not binding.
let activePubkey: string | null = null;
export function bindStores(pubkey: string): void { activePubkey = pubkey; /* re-point handles */ }
function dbName(name: string): string {
  if (!activePubkey) throw new Error("marmot store accessed before identity bound");
  return `notestr-${pubkeyComponent(activePubkey)}-${name}`;
}
```

Consumers that import the singleton handles (`device-store.ts`, `client.tsx`,
`device-sync.ts`, `forget-device.ts`, and others) must be audited so none reads
a store before `bindStores` runs, and all re-resolve handles on identity switch.

### Auth / identity-switch flow (`src/marmot/client.tsx` and the auth path)

Establish `bindStores(pubkey)` at the point the signed-in pubkey is known, and
re-point on identity switch. The `clearIdentityStore` / forget-device cleanup
paths must operate on the *active* partition.

### `src/store/persistence.ts` (task event log)

Currently imports `{ get, set }` from `idb-keyval` with no store argument, so it
uses the default `keyval-store` database (unprefixed, unscoped). Route it through
a pubkey-partitioned, `notestr-`-prefixed store so task event logs (`notestr:events:<groupId>`)
are isolated per identity and wiped by `clearAppState`. Use the same
`activePubkey`-bound mechanism as the marmot stores (DD3) for a single
partitioning model across the data layer.

### E2E fixtures (`e2e/fixtures/cleanup.ts`, `clearAppState`)

`clearAppState` already enumerates live `notestr-*` databases by prefix and
deletes them, so pubkey-partitioned names (which keep the `notestr-` prefix) are
wiped automatically. Two boy-scout hardening items: add `notestr-bootstrap-completed`
to the `KNOWN_IDB_NAMES` fallback list (currently missing — only matters on the
non-Chromium fallback path), and ensure the task-log store moves under the
`notestr-` prefix so it too is cleared. The new isolation test authenticates A,
writes state, signs out, authenticates B in the same browser context, and asserts
B observes none of A's group/device/task metadata — without depending on relay
state (relay-state-independence rule).

## Stories

Preview; finalized in `stories.json`.

- **S1 — Per-pubkey store factory** — Re-key `createKVStore`/`createInviteKVStore`
  and convert module-level singletons to a pubkey-bound factory. Covers
  AC-PART-*, AC-LIFE-*.
- **S2 — Identity/clientId partitioning** — Resolve and implement Design
  Decision 2 (leaf-identity store scoping). Covers AC-IDENT-*.
- **S3 — Legacy migration** — Implement the chosen migration policy (Design
  Decision 4). Covers AC-MIG-*.
- **S4 — Cross-account isolation E2E** — Prove isolation on a shared browser and
  extend `clearAppState`. Covers AC-E2E-*.

## Acceptance Criteria

See [`acceptance-criteria.md`](./acceptance-criteria.md).

## Relationship to Other Epics

- **epic-mls-leaf-identity-ux** — Established the per-IDB MLS leaf-identity
  model; Design Decision 2 (identity-store scoping) must stay consistent with it.
- **epic-forget-this-device** — The forget/cleanup paths (`forget-device.ts`,
  `clearIdentityStore`) operate on stores that this epic re-keys; they delete the
  *active partition's* databases (not the legacy origin-only names).
- **epic-identity-scoped-group-and-task-visibility** — **This epic supersedes its
  cross-identity path.** That feature visually marked another identity's groups as
  "detached" (greyed out, disabled) *because* the shared store leaked them across
  identities. With per-pubkey partitioning a different identity no longer sees
  another's groups at all, so there is nothing to mark detached. The detached UI
  is retained only for the same-identity case (a group whose membership was lost,
  e.g. after forgetting this device).

## Non-Goals

- Cross-device sync of the partition mapping. Each browser independently
  partitions its own local storage by pubkey; there is no networked registry.
- Defending against an attacker with direct IndexedDB / devtools access. This
  epic prevents *in-app* cross-account reads, not OS-level data extraction.
