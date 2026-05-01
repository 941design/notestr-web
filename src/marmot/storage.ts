import {
  get,
  set,
  del,
  clear as idbClear,
  keys as idbKeys,
  createStore,
  type UseStore,
} from "idb-keyval";

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
export const deviceNamesStore = createKVStore<import("./device-store").DeviceMetadata>("device-names");
export const invitedKeysStore = createKVStore<true>("invited-keys");
export const joinedGroupsStore = createKVStore<true>("joined-groups");

/**
 * Returns a stable per-browser client ID for kind 30443 addressable key packages.
 * Generated once and persisted in IndexedDB so it survives page reloads
 * but is unique per browser/device.
 *
 * E2E tests can pin the slot deterministically by setting
 * `window.__notestrTestClientId` (via `page.addInitScript`) before the app
 * boots. Without that, every fresh browser context generates a new UUID,
 * and across many test sessions the relay accumulates ghost slots under
 * the shared bunker pubkey — each one a "device" the auto-invite scan will
 * try to pull into every new group. With the override, contexts that play
 * the same logical role across tests publish to the same slot, kind 30443's
 * replaceable semantics collapse them on the relay, and the scan sees one
 * KP per intended device. Gated on `NEXT_PUBLIC_E2E` so production builds
 * never honor the window var.
 */
export async function getOrCreateClientId(): Promise<string> {
  if (
    process.env.NEXT_PUBLIC_E2E === "1" &&
    typeof window !== "undefined"
  ) {
    const override = (window as { __notestrTestClientId?: unknown })
      .__notestrTestClientId;
    if (typeof override === "string" && override.length > 0) {
      await identityStore.setItem("clientId", override);
      return override;
    }
  }
  const existing = await identityStore.getItem("clientId");
  if (existing) return existing;
  const id = `notestr-${crypto.randomUUID()}`;
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
