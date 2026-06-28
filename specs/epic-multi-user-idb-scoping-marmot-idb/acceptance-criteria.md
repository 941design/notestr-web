# Multi-user IndexedDB scoping (per-pubkey partitioning) — Acceptance Criteria

## Terminology

- **partition** — the set of IndexedDB databases owned by one pubkey, named with
  that pubkey's component embedded in the database name.
- **active pubkey** — the pubkey of the currently signed-in identity, to which
  marmot store handles are bound.
- **origin-only name** — the legacy database name form `notestr-${name}` with no
  pubkey component.
- **pubkeyComponent** — the stable, IDB-safe derivation of a pubkey used in the
  database name.

## Known TAGs

- **PART** — partitioning of stores by pubkey.
- **LIFE** — store-handle lifecycle (factory binding, pre-auth safety).
- **IDENT** — identity / clientId store scoping (Design Decision 2).
- **MIG** — legacy data migration (Design Decision 4).
- **E2E** — end-to-end cross-account isolation behavior.

## Store partitioning (S1)

**AC-PART-1** — `createKVStore(name)` MUST open an IndexedDB database whose name
embeds the active pubkey's `pubkeyComponent`; two distinct active pubkeys MUST
produce two distinct database names for the same `name`.

**AC-PART-2** — Database names produced by `createKVStore` MUST retain the
`notestr-` prefix so all notestr partitions remain enumerable/wipeable by prefix.

**AC-PART-3** — `createInviteKVStore()` MUST produce a pubkey-partitioned invite
store consistent with AC-PART-1 (the invite store is not exempt from
partitioning).

**AC-PART-4** — After binding pubkey A, writing a value through any store handle,
re-binding to pubkey B, then reading the same key through the same logical store
MUST NOT return A's value (the read resolves against B's partition).

**AC-PART-6** — The task event log (`src/store/persistence.ts`) MUST persist and
read task events through a pubkey-partitioned, `notestr-`-prefixed store; after
re-binding from pubkey A to pubkey B, `loadEvents` for a group MUST NOT return
events written under A's partition.

## Store lifecycle (S1)

**AC-LIFE-1** — No marmot store handle MUST perform an IndexedDB open against an
origin-only name after this epic (every `createStore` call resolves a
pubkey-partitioned name once an identity is bound).

**AC-LIFE-2** — Accessing a marmot store before an active pubkey is bound MUST
fail fast (throw / reject) rather than silently opening an origin-only database.

**AC-LIFE-3** — On identity switch from pubkey A to pubkey B, subsequent store
operations MUST resolve against B's partition without a page reload.

## Identity / clientId scoping (S2)

**AC-IDENT-1** — `getOrCreateClientId()` MUST behave per the resolved Design
Decision 2: each active pubkey MUST receive a clientId from its own partition,
and switching the active pubkey MUST NOT return the prior pubkey's clientId
(when DD2 resolves to per-pubkey partitioning).

**AC-IDENT-2** — The resolved scoping for the identity store MUST be consistent
with the per-IDB MLS leaf-identity model: a single (browser, pubkey) pair MUST
map to exactly one device leaf identity.

## Legacy migration (S3)

**AC-MIG-1** — When exactly one identity has ever been used on this browser and
legacy origin-only data exists, first authentication MUST apply the resolved
migration policy (Design Decision 4) deterministically.

**AC-MIG-2** — Migration MUST run at most once per browser (origin-level marker
gate): after the first pubkey migrates, a later pubkey MUST start from an empty
partition and MUST NOT inherit the migrated data. (Single-vs-multi-owner of the
legacy blob is undetectable from origin-only data; see Design Decision 4 for the
accepted tradeoff. The one-shot gate bounds the exposure to the first binder.)

**AC-MIG-3** — Re-running the migration path (e.g. a second sign-in by the same
user) MUST be idempotent: it MUST NOT duplicate or corrupt already-migrated
partition data.

## Cross-account isolation (S4)

**AC-E2E-1** — In a single browser context, after user A creates a group and
signs out, user B signing in MUST NOT see A's group in the sidebar, A's device
names, or A's invitation history.

**AC-E2E-2** — User B's sync decisions MUST NOT be influenced by A's
`bootstrap-completed` / `joined-groups` flags (B starts from its own empty
partition state).

**AC-E2E-3** — `clearAppState` MUST wipe all `notestr-*` partitions (every
pubkey partition plus any legacy origin-only databases), leaving no
cross-account residue between tests.

**AC-E2E-4** — The isolation test MUST assert on app-observable state (sidebar,
device list, identity panel), MUST NOT assert on relay state, and MUST NOT
start/stop/wipe the relay (relay-state-independence rule).

## Cross-Cutting Invariants

**AC-PART-5** — No code path in `src/marmot/` MUST construct an origin-only
`notestr-${name}` database name after this epic (static check: no `createStore`
call resolves a name lacking a pubkey component once bound).

## Manual Validation

| MV id | Behavioral intent | Owner | Blocked on |
|-------|-------------------|-------|------------|
| (none) | All acceptance criteria are automatable via unit + e2e; no manual-only checks. | — | — |
