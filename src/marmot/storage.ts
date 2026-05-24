import {
  get,
  set,
  del,
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
}

/**
 * Creates an IndexedDB-backed key-value store using idb-keyval.
 * Each name gets its own database to avoid IDB version conflicts.
 */
export function createKVStore<T>(name: string): KeyValueStoreBackend<T> {
  const store: UseStore = createStore(`notestr-${name}`, name);

  return {
    async getItem(key: string): Promise<T | null> {
      const value = await get<T>(key, store);
      return value ?? null;
    },

    async setItem(key: string, value: T): Promise<T> {
      await set(key, value, store);
      return value;
    },

    async removeItem(key: string): Promise<void> {
      await del(key, store);
    },

    async clear(): Promise<void> {
      await idbClear(store);
    },

    async keys(): Promise<string[]> {
      return idbKeys<string>(store);
    },
  };
}

/**
 * Creates the IndexedDB-backed KV store for the InviteManager.
 *
 * v0.5 collapsed the previous 3-store {received,unread,seen} layout into
 * a single discriminated-union store keyed by event/rumor id. We allocate
 * a fresh IDB ("invite-store") so old per-flow records left over from
 * v0.4 don't get reinterpreted under the new schema.
 */
export function createInviteKVStore(): KeyValueStoreBackend<
  import("@internet-privacy/marmot-ts").StoredInviteEntry
> {
  return createKVStore<import("@internet-privacy/marmot-ts").StoredInviteEntry>(
    "invite-store",
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
  };
}
