import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
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

// ── Pinned-pubkey createKVStore: validation and isolation ─────────────────────
//
// (no AC; spec-gap — pinnedPubkey isolation for MarmotClient instances has
//  observable behavior but no named AC in epic-multi-user-idb-scoping-marmot-idb)
describe("createKVStore — pinnedPubkey validation and isolation", () => {
  it("rejects a non-64-lowercase-hex pinnedPubkey before any I/O", () => {
    const bad = [
      "bad",
      "A".repeat(64), // uppercase not allowed
      "a".repeat(63), // too short
      "a".repeat(65), // too long
      "z".repeat(64), // 'z' is outside [0-9a-f]
      "a".repeat(63) + "G", // one non-hex char
    ];
    for (const p of bad) {
      expect(() => mod.createKVStore("name", p)).toThrow();
    }
    // Valid pubkey does not throw
    expect(() => mod.createKVStore("name", PUBKEY_A)).not.toThrow();
  });

  it("pinned store always reads from the pinning pubkey's partition — switching active pubkey is transparent (AC-PART-4 / pinnedPubkey variant)", async () => {
    const pinnedStore = mod.createKVStore<string>("groups", PUBKEY_A);
    mod.bindStores(PUBKEY_A);
    await pinnedStore.setItem("secret", "alpha");

    // Switch active identity to B — the pinned handle must still resolve to A
    mod.bindStores(PUBKEY_B);
    expect(await pinnedStore.getItem("secret")).toBe("alpha");
  });

  it("pinned store data is invisible from the same logical store accessed without pinning under a different pubkey", async () => {
    const pinnedStore = mod.createKVStore<string>("groups", PUBKEY_A);
    mod.bindStores(PUBKEY_A);
    await pinnedStore.setItem("shared-key", "A-value");

    mod.bindStores(PUBKEY_B);
    const unpinnedUnderB = mod.createKVStore<string>("groups");
    expect(await unpinnedUnderB.getItem("shared-key")).toBeNull();
  });

  it("property: data written to a pubkey-pinned store never appears in the unpinned store of another pubkey [Family B - isolation]", async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (key, value) => {
          const storeName = `pin-iso-${run++}`;
          const pinnedStore = mod.createKVStore<string>(storeName, PUBKEY_A);
          mod.bindStores(PUBKEY_A);
          await pinnedStore.setItem(key, value);
          mod.bindStores(PUBKEY_B);
          const bStore = mod.createKVStore<string>(storeName);
          return (await bStore.getItem(key)) === null;
        }
      ),
      { numRuns: 5 }
    );
  });

  it("data written to a pinned store lands in the pinning pubkey's partitioned IDB, not the default store", async () => {
    // A pinned store resolves against PUBKEY_A regardless of the active pubkey.
    // An unpinned store under PUBKEY_A resolves to the SAME physical IDB.
    // If the pinned resolve accidentally returned undefined (routing to the default store),
    // the unpinned read from the partitioned IDB returns null — catching the mis-routing.
    const pinnedStore = mod.createKVStore<string>("groups", PUBKEY_A);
    const unpinnedA = mod.createKVStore<string>("groups"); // lazy — resolves against active pubkey
    mod.bindStores(PUBKEY_A);
    await pinnedStore.setItem("witness", "partitioned");
    expect(await unpinnedA.getItem("witness")).toBe("partitioned");
  });
});

// ── removeItem, clear, keys — the three untested CRUD operations ──────────────
//
// (no AC; spec-gap — KeyValueStoreBackend CRUD contract is implied by the
//  interface but not enumerated in epic-multi-user-idb-scoping-marmot-idb ACs)
describe("createKVStore — removeItem, clear, keys", () => {
  let store: import("./storage").KeyValueStoreBackend<string>;

  beforeEach(() => {
    mod.bindStores(PUBKEY_A);
    store = mod.createKVStore<string>("crud-test");
  });

  describe("removeItem", () => {
    it("setItem then removeItem leaves the key absent", async () => {
      await store.setItem("k", "v");
      await store.removeItem("k");
      expect(await store.getItem("k")).toBeNull();
    });

    it("removing a non-existent key is a no-op", async () => {
      await expect(store.removeItem("ghost")).resolves.toBeUndefined();
    });

    it("only the targeted key is removed; sibling keys survive", async () => {
      await store.setItem("keep", "yes");
      await store.setItem("remove", "yes");
      await store.removeItem("remove");
      expect(await store.getItem("keep")).toBe("yes");
      expect(await store.getItem("remove")).toBeNull();
    });
  });

  describe("clear", () => {
    it("all previously-set keys read as absent after clear()", async () => {
      await store.setItem("k1", "v1");
      await store.setItem("k2", "v2");
      await store.clear();
      expect(await store.getItem("k1")).toBeNull();
      expect(await store.getItem("k2")).toBeNull();
    });

    it("keys() returns [] after clear()", async () => {
      await store.setItem("k1", "v1");
      await store.clear();
      expect(await store.keys()).toEqual([]);
    });

    it("scoped to this store name — a different store name is unaffected", async () => {
      const other = mod.createKVStore<string>("other-store");
      await store.setItem("k", "v");
      await other.setItem("k", "v");
      await store.clear();
      expect(await other.getItem("k")).toBe("v");
    });
  });

  describe("keys", () => {
    it("empty store returns []", async () => {
      expect(await store.keys()).toEqual([]);
    });

    it("contains exactly the set of keys that have been set and not removed", async () => {
      await store.setItem("alpha", "1");
      await store.setItem("beta", "2");
      const after2 = await store.keys();
      expect(after2).toEqual(expect.arrayContaining(["alpha", "beta"]));
      expect(after2.length).toBe(2);
      await store.removeItem("alpha");
      expect(await store.keys()).toEqual(["beta"]);
    });

    it("property: keys() reflects setItem/removeItem operations over arbitrary key sets [Family A - round-trip]", async () => {
      let run = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), {
            minLength: 1,
            maxLength: 8,
          }),
          async (keysToAdd) => {
            const s = mod.createKVStore<string>(`keys-prop-${run++}`);
            for (const k of keysToAdd) await s.setItem(k, "v");
            const got = await s.keys();
            return (
              got.length === keysToAdd.length &&
              keysToAdd.every((k) => got.includes(k))
            );
          }
        ),
        { numRuns: 10 }
      );
    });
  });
});

// ── getOrCreateClientId (AC-IDENT-1) ─────────────────────────────────────────
describe("getOrCreateClientId (AC-IDENT-1)", () => {
  beforeEach(() => {
    mod.bindStores(PUBKEY_A);
  });

  it("returns a 64-char lowercase hex string [output contract — kills CLIENT_ID_RE anchor/length/charset survivors]", async () => {
    const id = await mod.getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent: repeated calls within the same partition return the same value [Family B - idempotence]", async () => {
    const first = await mod.getOrCreateClientId();
    const second = await mod.getOrCreateClientId();
    expect(second).toBe(first);
  });

  it("rejects a legacy-format stored clientId and replaces it with a fresh 64-hex value", async () => {
    // Seed the identity IDB directly with a pre-2026-05 legacy format
    // that fails CLIENT_ID_RE (e.g. old "notestr-<uuid>" format).
    const { set, createStore: makeStore } = await import("idb-keyval");
    const identityDb = makeStore(`notestr-${PUBKEY_A}-identity`, "identity");
    await set("clientId", "notestr-old-uuid-xxxxxxxx", identityDb);

    const id = await mod.getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe("notestr-old-uuid-xxxxxxxx");
  });

  it("property: the returned ID always satisfies the 64-hex output contract across multiple calls [Family C - output contract]", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 4 }), async (extraCalls) => {
        const ids = await Promise.all(
          Array.from({ length: extraCalls + 1 }, () =>
            mod.getOrCreateClientId()
          )
        );
        return ids.every((id) => /^[0-9a-f]{64}$/.test(id));
      }),
      { numRuns: 5 }
    );
  });

  it("rejects a stored clientId longer than 64 chars even if it ends with 64 valid hex chars [kills CLIENT_ID_RE missing-^ anchor]", async () => {
    // "a" + "b"×64 = 65-char all-hex string. Passes /[0-9a-f]{64}$/ (no ^ anchor)
    // but FAILS /^[0-9a-f]{64}$/ (the correct regex requiring exactly 64 chars).
    const legacyTooLong = "a" + "b".repeat(64);
    const { set, createStore: makeStore } = await import("idb-keyval");
    const identityDb = makeStore(`notestr-${PUBKEY_A}-identity`, "identity");
    await set("clientId", legacyTooLong, identityDb);
    const id = await mod.getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{64}$/); // exactly 64 hex chars
    expect(id).not.toBe(legacyTooLong);   // not the over-length value
  });

  it("rejects a stored clientId that has extra characters after 64 hex chars [kills CLIENT_ID_RE missing-$ anchor]", async () => {
    // "a"×64 + "z" starts with 64 hex chars then a non-hex suffix. Passes /^[0-9a-f]{64}/
    // (no $ anchor) but FAILS /^[0-9a-f]{64}$/ (the correct regex).
    const legacyWithSuffix = "a".repeat(64) + "z";
    const { set, createStore: makeStore } = await import("idb-keyval");
    const identityDb = makeStore(`notestr-${PUBKEY_A}-identity`, "identity");
    await set("clientId", legacyWithSuffix, identityDb);
    const id = await mod.getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(legacyWithSuffix);
  });

  it("persists the generated client ID under the 'clientId' key for future retrieval [kills setItem-key mutation]", async () => {
    // Verifies the ID is stored at 'clientId', not at '' or any other key.
    // If setItem's key is mutated to '', get('clientId') returns undefined — catching it.
    const id = await mod.getOrCreateClientId();
    const { get, createStore: makeStore } = await import("idb-keyval");
    const identityDb = makeStore(`notestr-${PUBKEY_A}-identity`, "identity");
    expect(await get("clientId", identityDb)).toBe(id);
  });
});

// ── clearIdentityStore (AC-IDENT-1 lifecycle) ────────────────────────────────
describe("clearIdentityStore (AC-IDENT-1 lifecycle)", () => {
  it("clearing the identity store causes the next getOrCreateClientId to regenerate a fresh ID", async () => {
    mod.bindStores(PUBKEY_A);

    // Seed a known conforming clientId (distinct from the mock output "f"×64)
    // so we can tell "used cached" apart from "regenerated".
    const knownId = "1".repeat(64);
    const { set, get, createStore: makeStore } = await import("idb-keyval");
    const identityDb = makeStore(`notestr-${PUBKEY_A}-identity`, "identity");
    await set("clientId", knownId, identityDb);

    const first = await mod.getOrCreateClientId();
    expect(first).toBe(knownId); // confirms the seeded value was used

    await mod.clearIdentityStore();

    // The identity IDB is now empty
    expect(await get("clientId", identityDb)).toBeUndefined();

    // Next call regenerates via the stub (returns "f"×64)
    const second = await mod.getOrCreateClientId();
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe("f".repeat(64)); // stub output
    expect(second).not.toBe(knownId); // not the now-cleared value
  });
});

// ── getSyncedGroupEventIds / addSyncedGroupEventIds ──────────────────────────
//
// (no AC; spec-gap — group sync deduplication has no named AC in any current epic)
describe("getSyncedGroupEventIds and addSyncedGroupEventIds", () => {
  beforeEach(() => {
    mod.bindStores(PUBKEY_A);
  });

  it("unknown group starts with an empty event list", async () => {
    expect(await mod.getSyncedGroupEventIds("unknown-group")).toEqual([]);
  });

  it("added event IDs are retrievable", async () => {
    await mod.addSyncedGroupEventIds("g1", ["e1", "e2"]);
    const ids = await mod.getSyncedGroupEventIds("g1");
    expect(ids).toEqual(expect.arrayContaining(["e1", "e2"]));
    expect(ids.length).toBe(2);
  });

  it("duplicate event IDs are deduplicated — the result is a set", async () => {
    await mod.addSyncedGroupEventIds("g1", ["e1", "e2"]);
    await mod.addSyncedGroupEventIds("g1", ["e2", "e3"]);
    const ids = await mod.getSyncedGroupEventIds("g1");
    expect(ids).toEqual(expect.arrayContaining(["e1", "e2", "e3"]));
    expect(ids.length).toBe(3);
  });

  it("groups are isolated: events added to one group do not appear in another", async () => {
    await mod.addSyncedGroupEventIds("g1", ["e1"]);
    expect(await mod.getSyncedGroupEventIds("g2")).toEqual([]);
  });

  it("accepts any iterable, not just arrays (e.g. Set<string>)", async () => {
    await mod.addSyncedGroupEventIds("g1", new Set(["e1", "e2"]));
    const ids = await mod.getSyncedGroupEventIds("g1");
    expect(ids).toEqual(expect.arrayContaining(["e1", "e2"]));
  });

  it("property: merged event list is the union of all added batches, with no duplicates [Family B - set semantics]", async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 0,
          maxLength: 8,
        }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 0,
          maxLength: 8,
        }),
        async (batch1, batch2) => {
          const groupId = `sync-prop-${run++}`;
          await mod.addSyncedGroupEventIds(groupId, batch1);
          await mod.addSyncedGroupEventIds(groupId, batch2);
          const result = await mod.getSyncedGroupEventIds(groupId);
          const expected = new Set([...batch1, ...batch2]);
          return (
            result.length === expected.size &&
            result.every((id) => expected.has(id))
          );
        }
      ),
      { numRuns: 10 }
    );
  });
});

// ── createInMemoryKVStore — in-memory KeyValueStoreBackend implementation ─────
//
// (no AC; spec-gap — in-memory fallback has no spec; used in tests and offline
//  scenarios but its contract is entirely implicit in the KeyValueStoreBackend interface)
describe("createInMemoryKVStore", () => {
  it("getItem on an empty store returns null", async () => {
    const store = mod.createInMemoryKVStore<string>();
    expect(await store.getItem("k")).toBeNull();
  });

  it("setItem/getItem round-trip: stored value is retrievable and setItem returns the value", async () => {
    const store = mod.createInMemoryKVStore<string>();
    const returned = await store.setItem("k", "hello");
    expect(returned).toBe("hello");
    expect(await store.getItem("k")).toBe("hello");
  });

  it("removeItem makes the key absent; subsequent getItem returns null", async () => {
    const store = mod.createInMemoryKVStore<string>();
    await store.setItem("k", "v");
    await store.removeItem("k");
    expect(await store.getItem("k")).toBeNull();
  });

  it("removeItem of a non-existent key is a no-op", async () => {
    const store = mod.createInMemoryKVStore<string>();
    await expect(store.removeItem("ghost")).resolves.toBeUndefined();
  });

  it("clear() removes all keys; getItem returns null and keys() returns []", async () => {
    const store = mod.createInMemoryKVStore<string>();
    await store.setItem("k1", "v1");
    await store.setItem("k2", "v2");
    await store.clear();
    expect(await store.getItem("k1")).toBeNull();
    expect(await store.getItem("k2")).toBeNull();
    expect(await store.keys()).toEqual([]);
  });

  it("keys() tracks exactly the live set of keys", async () => {
    const store = mod.createInMemoryKVStore<string>();
    expect(await store.keys()).toEqual([]);
    await store.setItem("a", "1");
    await store.setItem("b", "2");
    const after2 = await store.keys();
    expect(after2).toEqual(expect.arrayContaining(["a", "b"]));
    expect(after2.length).toBe(2);
    await store.removeItem("a");
    expect(await store.keys()).toEqual(["b"]);
  });

  it("two instances are isolated — writes to one never appear in the other", async () => {
    const s1 = mod.createInMemoryKVStore<string>();
    const s2 = mod.createInMemoryKVStore<string>();
    await s1.setItem("k", "from-s1");
    expect(await s2.getItem("k")).toBeNull();
    await s2.setItem("k", "from-s2");
    expect(await s1.getItem("k")).toBe("from-s1");
  });

  it("property: CRUD contract holds for arbitrary string keys and values [Family A - round-trip]", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 30 }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.string({ minLength: 0, maxLength: 50 }),
        async (keys, value) => {
          const store = mod.createInMemoryKVStore<string>(); // fresh per run — no IDB
          for (const k of keys) await store.setItem(k, value);
          const gotKeys = await store.keys();
          const allPresent =
            gotKeys.length === keys.length &&
            (await Promise.all(keys.map((k) => store.getItem(k)))).every(
              (v) => v === value
            );
          // Remove first key and verify specificity
          await store.removeItem(keys[0]);
          const removed = (await store.getItem(keys[0])) === null;
          return allPresent && removed;
        }
      ),
      { numRuns: 20 }
    );
  });
});
