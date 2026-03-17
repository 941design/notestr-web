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
 * Creates the 3 IndexedDB-backed KV stores needed by InviteReader.
 */
export function createInviteStore(): import("@internet-privacy/marmot-ts").InviteStore {
  return {
    received: createKVStore("invite-received"),
    unread: createKVStore("invite-unread"),
    seen: createKVStore("invite-seen"),
  };
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
