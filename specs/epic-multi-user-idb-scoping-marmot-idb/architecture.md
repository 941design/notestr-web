# Architecture — Multi-user IndexedDB scoping

## Paradigm

Modular monolith; the marmot data layer is a package-by-feature module
(`src/marmot/`) with a single storage seam (`storage.ts`). This epic keeps the
seam but makes the database identity pubkey-aware.

## Module map

| Module | Role in this epic |
|---|---|
| `src/marmot/storage.ts` | **Owner of the partitioning mechanism.** Adds `bindStores`/`unbindStores`, `activePubkey`, lazy per-pubkey DB-name resolution in `createKVStore`. |
| `src/marmot/client.tsx` | Calls `bindStores(pubkey)` in `init()` before any store I/O; `unbindStores()` on provider unmount. |
| `src/store/persistence.ts` | Task event log moved off the bare idb-keyval default store onto a pubkey-partitioned `createKVStore`-backed store. |
| `src/marmot/{device-store,device-sync,forget-device,forgotten-slots,failed-welcomes}.ts` | Consumers — unchanged; they keep importing the same singleton handles, which now resolve per-pubkey lazily. |
| `e2e/fixtures/cleanup.ts` | `clearAppState` already prefix-enumerates `notestr-*`; boy-scout: add `notestr-bootstrap-completed` to the fallback list. |

## Boundary rules

- All IndexedDB access goes through `createKVStore` / `createInviteKVStore` in
  `storage.ts` (existing convention, enforced by `forgotten-slots.ts` /
  `failed-welcomes.ts` comments). `persistence.ts` joins this convention.
- No module resolves a database name itself; the name is computed centrally in
  `storage.ts` from `activePubkey`.

## Seams

- `bindStores(pubkey: string)` / `unbindStores()` — the lifecycle seam between
  the auth flow (`client.tsx`) and the storage layer. The only way `activePubkey`
  is set.
- Lazy `UseStore` resolution: `createKVStore(name)` returns a backend whose
  underlying idb-keyval `UseStore` is built on first I/O against
  `notestr-${pubkeyComponent(activePubkey)}-${name}`, cached per (pubkey, name).
  Accessing a store with `activePubkey === null` throws.

## Implementation constraints

- idb-keyval `createStore(dbName, storeName)` captures `dbName` eagerly, so the
  per-pubkey name must be resolved at I/O time, not at handle-construction time.
- `pubkeyComponent` must be collision-safe and IDB-name-safe; the full 64-hex
  pubkey satisfies both.
- Migration (DD4) runs at first `bindStores` for a pubkey, gated on an
  unambiguous single-identity history; ambiguous histories abandon legacy data.
- Honor relay-state-independence in the e2e isolation test.
