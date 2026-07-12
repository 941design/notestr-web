import {
  get,
  set,
  del,
  update,
  clear as idbClear,
  keys as idbKeys,
  createStore,
  type UseStore,
} from "idb-keyval";
import { generateKeyPackageSlot } from "@internet-privacy/marmot-ts";

/** Matches the KeyValueStoreBackend interface expected by marmot-ts */
export interface KeyValueStoreBackend<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  /**
   * Atomic read-modify-write: `updater` sees the CURRENT stored value (or
   * `undefined` if absent) and returns the value to store, all inside ONE
   * idb-keyval `update()` call -- which itself performs the get and the put
   * inside a single IndexedDB `readwrite` transaction (idb-keyval's
   * `update()` never round-trips through two separate transactions). This
   * is what makes concurrent `updateItem` calls against the SAME key
   * serialize at the IDB layer instead of racing a separate getItem/setItem
   * pair (the lost-update hazard the old appendFact/appendAcceptedEvent
   * read-then-write had). Resolves with the value the updater returned.
   */
  updateItem(key: string, updater: (old: T | undefined) => T): Promise<T>;
}

/**
 * Per-pubkey IndexedDB partitioning.
 *
 * Every marmot store is physically isolated by the signed-in pubkey: the
 * database name is `notestr-${pubkey}-${name}`, so two npubs used in the same
 * browser open *different* databases and one can never read another's metadata,
 * key packages, MLS group-state, or task history. Isolation is by construction
 * (distinct DB names), not by a signout cleanup that must fire.
 *
 * `activePubkey` is set by `bindStores(pubkey)` (called from the auth flow in
 * client.tsx once the signed-in pubkey is known) and cleared by
 * `unbindStores()` on sign-out. Because idb-keyval's `createStore` only opens
 * the DB on first I/O — and every marmot store I/O happens after the provider
 * mounts (pubkey known) — store handles created at module load resolve their
 * physical database lazily, at first I/O, against the active pubkey.
 */
let activePubkey: string | null = null;

/** Cache of resolved idb-keyval stores, keyed by `${pubkey}:${name}`. */
const resolvedStores = new Map<string, UseStore>();

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Bind all marmot stores to a signed-in pubkey. MUST be called (from the auth
 * flow) before any marmot store is read or written. Idempotent for the same
 * pubkey; switching pubkey re-points every store to the new partition.
 */
export function bindStores(pubkey: string): void {
  if (!PUBKEY_RE.test(pubkey)) {
    throw new Error("bindStores: pubkey must be a 64-char lowercase hex string");
  }
  activePubkey = pubkey;
}

/** Clear the active binding (sign-out). Subsequent store access throws. */
export function unbindStores(): void {
  activePubkey = null;
}

/** The pubkey currently bound, or null. Exposed for tests/diagnostics. */
export function getActivePubkey(): string | null {
  return activePubkey;
}

function resolveStoreForPubkey(pubkey: string, name: string): UseStore {
  const cacheKey = `${pubkey}:${name}`;
  let store = resolvedStores.get(cacheKey);
  if (!store) {
    store = createStore(`notestr-${pubkey}-${name}`, name);
    resolvedStores.set(cacheKey, store);
  }
  return store;
}

function resolveStore(name: string): UseStore {
  if (activePubkey === null) {
    throw new Error(
      `marmot store "${name}" accessed before bindStores(pubkey) — IDB is partitioned per-pubkey`,
    );
  }
  return resolveStoreForPubkey(activePubkey, name);
}

/**
 * Creates an IndexedDB-backed key-value store using idb-keyval.
 * Each name gets its own database (`notestr-${pubkey}-${name}`) to avoid IDB
 * version conflicts and to isolate per signed-in pubkey.
 *
 * - Default (no `pinnedPubkey`): the physical database is resolved lazily at
 *   first I/O against the CURRENT active pubkey (see {@link bindStores});
 *   accessing it before a pubkey is bound throws. Used for the module-level
 *   singletons whose lifetime spans the active identity.
 * - With `pinnedPubkey`: the store is permanently bound to that one pubkey's
 *   partition, regardless of later identity switches. Use this for stores owned
 *   by a specific `MarmotClient` instance (group-state, key-packages, invites)
 *   so an in-flight task from a signed-out identity can never resolve into the
 *   newly signed-in identity's partition (cross-account corruption).
 */
export function createKVStore<T>(
  name: string,
  pinnedPubkey?: string,
): KeyValueStoreBackend<T> {
  if (pinnedPubkey !== undefined && !PUBKEY_RE.test(pinnedPubkey)) {
    throw new Error("createKVStore: pinnedPubkey must be 64-char lowercase hex");
  }
  const resolve = pinnedPubkey
    ? () => resolveStoreForPubkey(pinnedPubkey, name)
    : () => resolveStore(name);
  return {
    async getItem(key: string): Promise<T | null> {
      const value = await get<T>(key, resolve());
      return value ?? null;
    },

    async setItem(key: string, value: T): Promise<T> {
      await set(key, value, resolve());
      return value;
    },

    async removeItem(key: string): Promise<void> {
      await del(key, resolve());
    },

    async clear(): Promise<void> {
      await idbClear(resolve());
    },

    async keys(): Promise<string[]> {
      return idbKeys<string>(resolve());
    },

    async updateItem(
      key: string,
      updater: (old: T | undefined) => T,
    ): Promise<T> {
      // Resolve the store handle exactly ONCE, up front -- same as every
      // other method here -- so a mid-op identity switch (bindStores called
      // between two ticks of this async function) cannot split the read and
      // the write across two different pubkey partitions. The single
      // resolved handle is threaded through idb-keyval's update(), which
      // performs the get+put inside one readwrite transaction against that
      // one handle.
      const store = resolve();
      let updated!: T;
      await update<T | undefined>(
        key,
        (old) => {
          updated = updater(old);
          return updated;
        },
        store,
      );
      return updated;
    },
  };
}

/**
 * Names of the legacy origin-only marmot databases (`notestr-${name}`) that
 * predate per-pubkey partitioning. Used only by {@link migrateLegacyPartition}.
 */
const LEGACY_STORE_NAMES = [
  "identity",
  "device-names",
  "group-state",
  "key-packages",
  "invite-store",
  "invited-keys",
  "group-sync",
  "joined-groups",
  "bootstrap-completed",
  "forgotten-slots",
  "failed-welcomes",
] as const;

/** Origin-level (un-partitioned) marker recording the one-shot legacy migration. */
const MIGRATION_MARKER_DB = "notestr-partition-migration";

/**
 * One-shot migration of pre-partitioning data into the first pubkey's partition.
 *
 * Before this epic, all data lived in origin-only `notestr-${name}` databases
 * (and the task log in the bare idb-keyval default store). To preserve
 * continuity for the overwhelmingly common single-user browser — so an existing
 * user keeps their MLS leaf, groups, and key packages across the upgrade rather
 * than re-bootstrapping — the legacy data is copied **wholesale** (byte-for-byte
 * idb-keyval values, no merge/reinterpret, so MLS group-state stays valid) into
 * the first pubkey that binds after the upgrade.
 *
 * The copy runs at most once per browser, gated by an origin-level marker. A
 * second pubkey binding later does NOT inherit the legacy data — it starts from
 * an empty, isolated partition. Pre-upgrade browsers that were shared by
 * multiple users already had commingled data under the single origin-only
 * partition (the bug this epic fixes); attributing that legacy blob to the first
 * binder is no worse than the status quo for that binder, and every write after
 * the bind is correctly isolated.
 *
 * Idempotent: returns immediately once the marker is set.
 */
export async function migrateLegacyPartition(pubkey: string): Promise<void> {
  if (!PUBKEY_RE.test(pubkey)) {
    throw new Error("migrateLegacyPartition: pubkey must be 64-char lowercase hex");
  }
  const marker = createStore(MIGRATION_MARKER_DB, "marker");
  if (await get<string>("migratedTo", marker)) return;

  // Enumerate existing databases so we touch ONLY legacy stores that actually
  // exist — never probe a missing one (probing via idb-keyval would create an
  // empty origin-only database, re-introducing the very name we are removing).
  const existing = await listDatabaseNames();
  if (existing === null) {
    // No enumeration support (old Safari): cannot safely detect legacy data
    // without creating empties. Mark migrated and skip — those users start with
    // a clean isolated partition rather than risk an origin-only leak.
    await set("migratedTo", pubkey, marker);
    return;
  }
  const present = new Set(existing);

  for (const name of LEGACY_STORE_NAMES) {
    const legacyDb = `notestr-${name}`;
    if (!present.has(legacyDb)) continue;
    const entries = await readAllRaw(legacyDb, name);
    if (entries.length > 0) {
      const target = createStore(`notestr-${pubkey}-${name}`, name);
      for (const [key, value] of entries) {
        await set(key, value, target);
      }
    }
    // The raw read closed its connection, so this delete is not blocked.
    await deleteDatabaseSafe(legacyDb);
  }

  // Task event log: legacy lived in the bare idb-keyval default store
  // ("keyval-store") under `notestr:events:*` keys. Copy those into the
  // partitioned task-events store, then drop the originals.
  if (present.has("keyval-store")) {
    const defaultKeys = await idbKeys();
    const taskKeys = defaultKeys.filter(
      (k): k is string => typeof k === "string" && k.startsWith("notestr:events:"),
    );
    if (taskKeys.length > 0) {
      const taskTarget = createStore(`notestr-${pubkey}-task-events`, "task-events");
      for (const key of taskKeys) {
        await set(key, await get(key), taskTarget);
        await del(key);
      }
    }
  }

  await set("migratedTo", pubkey, marker);
}

/** Lists existing IndexedDB database names, or null when unavailable (old Safari). */
async function listDatabaseNames(): Promise<string[] | null> {
  if (typeof indexedDB === "undefined") return null;
  const fn = (indexedDB as IDBFactory & {
    databases?: () => Promise<{ name?: string }[]>;
  }).databases;
  if (typeof fn !== "function") return null;
  const infos = await fn.call(indexedDB);
  return infos.map((i) => i.name).filter((n): n is string => !!n);
}

/**
 * Reads every (key, value) entry from an existing IndexedDB database's object
 * store using a RAW connection that is closed before returning — so a
 * subsequent {@link deleteDatabaseSafe} is not blocked by a lingering
 * idb-keyval handle. Returns [] if the store is absent.
 */
async function readAllRaw(
  dbName: string,
  storeName: string,
): Promise<[IDBValidKey, unknown][]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.oncomplete = () => {
        db.close();
        resolve(keysReq.result.map((k, i) => [k, valsReq.result[i]]));
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

/**
 * Deletes an IndexedDB database, resolving regardless of success/error/blocked
 * so migration never hangs. No-op in environments without an IndexedDB
 * implementation (e.g. the node unit-test runner).
 */
async function deleteDatabaseSafe(dbName: string): Promise<void> {
  if (
    typeof indexedDB === "undefined" ||
    typeof indexedDB.deleteDatabase !== "function"
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * Creates the IndexedDB-backed KV store for the InviteManager.
 *
 * v0.5 collapsed the previous 3-store {received,unread,seen} layout into
 * a single discriminated-union store keyed by event/rumor id. We allocate
 * a fresh IDB ("invite-store") so old per-flow records left over from
 * v0.4 don't get reinterpreted under the new schema.
 */
export function createInviteKVStore(
  pinnedPubkey?: string,
): KeyValueStoreBackend<
  import("@internet-privacy/marmot-ts").StoredInviteEntry
> {
  return createKVStore<import("@internet-privacy/marmot-ts").StoredInviteEntry>(
    "invite-store",
    pinnedPubkey,
  );
}

const identityStore = createKVStore<string>("identity");

/**
 * Clears the local clientId from IDB.
 *
 * Called by forgetSelfDevice (S3) as part of the self-forget local-cleanup
 * sequence. Exposing a named helper (rather than the raw store handle)
 * prevents other modules from accidentally reading or writing the identity
 * store — pattern consistent with getOrCreateClientId() which already wraps
 * all identityStore access.
 *
 * After this call, the next call to getOrCreateClientId() will generate a
 * fresh UUID, so the device effectively loses its identity locally.
 */
export async function clearIdentityStore(): Promise<void> {
  await identityStore.clear();
}

export const deviceNamesStore = createKVStore<import("./device-store").DeviceMetadata>("device-names");
export const invitedKeysStore = createKVStore<true>("invited-keys");
export const joinedGroupsStore = createKVStore<true>("joined-groups");
export const bootstrapCompletedStore = createKVStore<true>("bootstrap-completed");

/**
 * Returns a stable per-browser client ID for kind 30443 addressable key packages.
 * Generated once and persisted in IndexedDB so it survives page reloads
 * but is unique per browser/device.
 *
 * Per MIP-00 the `d` tag MUST be 32 random bytes encoded as a 64-char
 * lowercase hex string; `marmot-ts@0.6.0`'s `createKeyPackageEvent` now
 * throws on non-conforming slots and MDK rejects them on the network
 * ("d tag must be exactly 64 hex characters"). We delegate minting to
 * `generateKeyPackageSlot()` so the definition of "valid slot" lives
 * in exactly one place (upstream).
 *
 * E2E tests can pin the slot deterministically by setting
 * `window.__notestrTestClientId` (via `page.addInitScript`) before the app
 * boots. The override is validated against the 64-hex shape; non-conforming
 * values are rejected so test fixtures cannot accidentally reintroduce a
 * format that MDK refuses. Gated on `NEXT_PUBLIC_E2E` so production builds
 * never honor the window var.
 *
 * Legacy slots (pre-2026-05 `notestr-<uuid>` and bare-uuid forms) are
 * migrated on read: detected by failing the 64-hex shape check, replaced
 * with a fresh 64-hex slot in IDB. Without this migration, an existing
 * notestr-web user upgrading to marmot-ts@0.6.0 would hit the new
 * `createKeyPackageEvent` throw the first time the background KP-readiness
 * task ran. The relay-side ghost under the old slot ages out via kind
 * 30443's replaceable semantics — or is tombstoned by the stale-KP
 * cleanup in client.tsx if extended for the addressable case.
 */
const CLIENT_ID_RE = /^[0-9a-f]{64}$/;

export async function getOrCreateClientId(): Promise<string> {
  if (
    process.env.NEXT_PUBLIC_E2E === "1" &&
    typeof window !== "undefined"
  ) {
    const override = (window as { __notestrTestClientId?: unknown })
      .__notestrTestClientId;
    if (typeof override === "string" && CLIENT_ID_RE.test(override)) {
      await identityStore.setItem("clientId", override);
      return override;
    }
  }
  const existing = await identityStore.getItem("clientId");
  if (existing && CLIENT_ID_RE.test(existing)) return existing;
  const id = generateKeyPackageSlot();
  await identityStore.setItem("clientId", id);
  return id;
}

const groupSyncStore = createKVStore<string[]>("group-sync");

export async function getSyncedGroupEventIds(groupId: string): Promise<string[]> {
  return (await groupSyncStore.getItem(groupId)) ?? [];
}

export async function addSyncedGroupEventIds(
  groupId: string,
  eventIds: Iterable<string>,
): Promise<void> {
  const merged = new Set(await getSyncedGroupEventIds(groupId));

  for (const eventId of eventIds) {
    merged.add(eventId);
  }

  await groupSyncStore.setItem(groupId, Array.from(merged));
}

export function createInMemoryKVStore<T>(): KeyValueStoreBackend<T> {
  const data = new Map<string, T>();

  return {
    async getItem(key: string): Promise<T | null> {
      return data.get(key) ?? null;
    },

    async setItem(key: string, value: T): Promise<T> {
      data.set(key, value);
      return value;
    },

    async removeItem(key: string): Promise<void> {
      data.delete(key);
    },

    async clear(): Promise<void> {
      data.clear();
    },

    async keys(): Promise<string[]> {
      return Array.from(data.keys());
    },

    async updateItem(
      key: string,
      updater: (old: T | undefined) => T,
    ): Promise<T> {
      // Single synchronous read-modify-write against the in-memory Map --
      // there is no async gap between the get and the set, so this is
      // atomic by construction (matches the IDB-backed implementation's
      // single-transaction guarantee).
      const next = updater(data.get(key));
      data.set(key, next);
      return next;
    },
  };
}
