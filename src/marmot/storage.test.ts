import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

// storage.ts imports generateKeyPackageSlot from marmot-ts; stub it so the
// module resolves in the node test env without pulling the real fork.
vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
}));

// Tests run against a REAL IndexedDB (fake-indexeddb) and REAL idb-keyval, so
// the per-pubkey database naming, isolation, and the raw-IDB migration
// (enumerate → copy → delete) are all exercised for real. A fresh IDBFactory
// plus vi.resetModules() per test gives both idb-keyval and storage.ts clean
// module state (idb-keyval memoizes its default store; storage.ts memoizes
// resolved per-pubkey handles).
type Storage = typeof import("./storage");
let mod: Storage;

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.resetModules();
  mod = await import("./storage");
});

async function listDbs(): Promise<string[]> {
  const infos = await indexedDB.databases();
  return infos.map((i) => i.name).filter((n): n is string => !!n);
}

describe("per-pubkey store partitioning", () => {
  it("bindStores rejects a non-64-hex pubkey (identity safety)", () => {
    expect(() => mod.bindStores("not-hex")).toThrow();
    expect(() => mod.bindStores("A".repeat(64))).toThrow(); // uppercase not lowercase-hex
    expect(() => mod.bindStores("a".repeat(63))).toThrow(); // too short
    expect(() => mod.bindStores("a".repeat(65))).toThrow(); // too long
    expect(() => mod.bindStores("z" + "a".repeat(64))).toThrow(); // `^` anchor: junk prefix
    expect(() => mod.bindStores("a".repeat(64) + "z")).toThrow(); // `$` anchor: junk suffix
    expect(mod.getActivePubkey()).toBeNull();
  });

  it("accessing a store before bindStores throws fail-fast (AC-LIFE-2)", async () => {
    const store = mod.createKVStore<string>("groups");
    await expect(store.getItem("k")).rejects.toThrow(/before bindStores/);
    await expect(store.setItem("k", "v")).rejects.toThrow(/before bindStores/);
  });

  it("opens a notestr-${pubkey}-${name} database, prefix retained (AC-PART-1, AC-PART-2)", async () => {
    mod.bindStores(PUBKEY_A);
    await mod.createKVStore<string>("groups").setItem("k", "v");
    const names = await listDbs();
    expect(names).toContain(`notestr-${PUBKEY_A}-groups`);
    expect(names.every((n) => n.startsWith("notestr-"))).toBe(true);
  });

  it("two distinct pubkeys resolve to two distinct databases (AC-PART-1)", async () => {
    const store = mod.createKVStore<string>("groups");
    mod.bindStores(PUBKEY_A);
    await store.setItem("k", "A");
    mod.bindStores(PUBKEY_B);
    await store.setItem("k", "B");
    mod.bindStores(PUBKEY_A);
    expect(await store.getItem("k")).toBe("A");
    mod.bindStores(PUBKEY_B);
    expect(await store.getItem("k")).toBe("B");
  });

  it("a read after switching pubkey resolves against the new partition (AC-PART-4, AC-LIFE-3)", async () => {
    const store = mod.createKVStore<string>("device-names");
    mod.bindStores(PUBKEY_A);
    await store.setItem("dev", "A-secret");
    mod.bindStores(PUBKEY_B);
    expect(await store.getItem("dev")).toBeNull(); // B cannot see A's value
    mod.bindStores(PUBKEY_A);
    expect(await store.getItem("dev")).toBe("A-secret"); // A's value intact
  });

  it("unbindStores makes subsequent access throw (sign-out safety)", async () => {
    const store = mod.createKVStore<string>("groups");
    mod.bindStores(PUBKEY_A);
    await store.setItem("k", "v");
    mod.unbindStores();
    expect(mod.getActivePubkey()).toBeNull();
    await expect(store.getItem("k")).rejects.toThrow(/before bindStores/);
  });
});

describe("legacy migration (DD4)", () => {
  // Seed an origin-only legacy database via a RAW connection that closes after
  // writing — mirroring production, where the legacy DB was written by a prior
  // session (no lingering handle). idb-keyval keeps its connection open, which
  // would block the migration's deleteDatabase and is therefore not used here.
  // idb-keyval stores out-of-line: `objectStore.put(value, key)`.
  async function seedLegacy(storeName: string, key: string, value: unknown) {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(`notestr-${storeName}`, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(storeName);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }

  it("rejects a non-64-hex pubkey", async () => {
    await expect(mod.migrateLegacyPartition("nope")).rejects.toThrow();
    await expect(mod.migrateLegacyPartition("z" + "a".repeat(64))).rejects.toThrow();
    await expect(mod.migrateLegacyPartition("a".repeat(64) + "z")).rejects.toThrow();
  });

  it("is a no-op on a fresh install — creates NO origin-only database (AC-LIFE-1)", async () => {
    await mod.migrateLegacyPartition(PUBKEY_A);
    const names = await listDbs();
    // Only the migration marker may exist; no origin-only notestr-${name} store.
    expect(names.filter((n) => /^notestr-(?!partition-migration)[a-z-]+$/.test(n))).toEqual([]);
  });

  it("copies legacy data into the partition and DELETES the origin-only database (AC-LIFE-1)", async () => {
    await seedLegacy("group-state", "g1", { epoch: 3 });
    await seedLegacy("identity", "clientId", "f".repeat(64));

    await mod.migrateLegacyPartition(PUBKEY_A);

    // Data landed in the partition.
    mod.bindStores(PUBKEY_A);
    expect(await mod.createKVStore("group-state").getItem("g1")).toEqual({ epoch: 3 });
    expect(await mod.createKVStore("identity").getItem("clientId")).toBe("f".repeat(64));
    // Origin-only legacy databases are gone.
    const names = await listDbs();
    expect(names).not.toContain("notestr-group-state");
    expect(names).not.toContain("notestr-identity");
  });

  it("copies every legacy marmot store name (no name dropped)", async () => {
    const LEGACY = [
      "identity", "device-names", "group-state", "key-packages", "invite-store",
      "invited-keys", "group-sync", "joined-groups", "bootstrap-completed",
      "forgotten-slots", "failed-welcomes",
    ];
    for (const name of LEGACY) await seedLegacy(name, "sentinel", name);
    await mod.migrateLegacyPartition(PUBKEY_A);
    mod.bindStores(PUBKEY_A);
    for (const name of LEGACY) {
      expect(await mod.createKVStore(name).getItem("sentinel")).toBe(name);
    }
  });

  it("is idempotent and one-shot: a later pubkey does NOT inherit legacy data", async () => {
    await seedLegacy("group-state", "g1", { epoch: 3 });
    await mod.migrateLegacyPartition(PUBKEY_A);
    // Marker is set; re-seed legacy and migrate a different pubkey — it must skip.
    await seedLegacy("group-state", "g2", { epoch: 9 });
    await mod.migrateLegacyPartition(PUBKEY_B);
    mod.bindStores(PUBKEY_B);
    expect(await mod.createKVStore("group-state").getItem("g1")).toBeNull();
    expect(await mod.createKVStore("group-state").getItem("g2")).toBeNull();
  });

  it("migrates task event log from the legacy default keyval-store", async () => {
    const { set } = await import("idb-keyval");
    await set("notestr:events:g1", [{ id: "e1" }]); // default store (keyval-store)
    await set("some-other-lib-key", "leave-me");

    await mod.migrateLegacyPartition(PUBKEY_A);

    mod.bindStores(PUBKEY_A);
    expect(await mod.createKVStore("task-events").getItem("notestr:events:g1")).toEqual([
      { id: "e1" },
    ]);
    // Unrelated default-store key is untouched.
    const { get } = await import("idb-keyval");
    expect(await get("some-other-lib-key")).toBe("leave-me");
  });
});
