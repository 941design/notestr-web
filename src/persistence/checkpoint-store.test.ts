/**
 * checkpoint-store.test.ts
 *
 * Real-IDB round-trip tests for checkpoint-store.ts (S11, resolving the
 * checkpoint half of MOCK-05-002 -- see verification.json VQ-S11-001).
 * Follows the REAL-IDB idiom established by raw-event-log-store.test.ts /
 * src/marmot/storage.test.ts: a fresh `IDBFactory` (fake-indexeddb) plus
 * `vi.resetModules()` per test gives both idb-keyval and storage.ts clean
 * module state, and `bindStores(pubkey)` must be called before any store
 * I/O.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { EngineCheckpoint } from "../engine/engine-types";

vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
}));

type CheckpointStoreModule = typeof import("./checkpoint-store");
type StorageModule = typeof import("../marmot/storage");

let store: CheckpointStoreModule;
let storage: StorageModule;

const PUBKEY = "a".repeat(64);

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.resetModules();
  storage = await import("../marmot/storage");
  store = await import("./checkpoint-store");
  storage.bindStores(PUBKEY);
});

function checkpoint(
  groupId: string,
  overrides: Partial<EngineCheckpoint> = {},
): EngineCheckpoint {
  return {
    groupId,
    savedAt: 1_700_000_000_000,
    engineState: "live",
    lastEpoch: "epoch-0",
    lastIngestedSeq: 5,
    lastAcceptedDomainEventId: "evt-5",
    bootstrapCompleted: true,
    ...overrides,
  };
}

describe("saveCheckpoint / loadCheckpoint", () => {
  it("round-trips a checkpoint through real IDB byte-for-byte", async () => {
    const groupId = "group-1";
    const cp = checkpoint(groupId);

    await store.saveCheckpoint(cp);
    const loaded = await store.loadCheckpoint(groupId);

    expect(loaded).toEqual(cp);
  });

  it("returns null for a group with no persisted checkpoint (never throws)", async () => {
    const loaded = await store.loadCheckpoint("no-such-group");
    expect(loaded).toBeNull();
  });

  it("overwrites wholesale on a second save -- the new value fully replaces the old, no merge", async () => {
    const groupId = "group-1";
    await store.saveCheckpoint(
      checkpoint(groupId, { lastIngestedSeq: 3, bootstrapCompleted: false }),
    );
    const second = checkpoint(groupId, {
      lastIngestedSeq: 9,
      bootstrapCompleted: true,
      lastEpoch: "epoch-2",
    });
    await store.saveCheckpoint(second);

    const loaded = await store.loadCheckpoint(groupId);
    expect(loaded).toEqual(second);
  });

  it("persists checkpoints for distinct groups independently", async () => {
    const a = checkpoint("group-a", { lastIngestedSeq: 1 });
    const b = checkpoint("group-b", { lastIngestedSeq: 2 });
    await store.saveCheckpoint(a);
    await store.saveCheckpoint(b);

    expect(await store.loadCheckpoint("group-a")).toEqual(a);
    expect(await store.loadCheckpoint("group-b")).toEqual(b);
  });

  it("round-trips the null-until-first-observation fields (lastEpoch/lastAcceptedDomainEventId) faithfully", async () => {
    const groupId = "group-1";
    const cp = checkpoint(groupId, {
      lastEpoch: null,
      lastAcceptedDomainEventId: null,
      bootstrapCompleted: false,
      engineState: "joining",
    });
    await store.saveCheckpoint(cp);

    expect(await store.loadCheckpoint(groupId)).toEqual(cp);
  });

  it("throws on an empty checkpoint.groupId", async () => {
    await expect(store.saveCheckpoint(checkpoint(""))).rejects.toThrow();
  });

  it("field-picks the stored value -- an extra enumerable property on the input never round-trips", async () => {
    const groupId = "group-1";
    const cp = checkpoint(groupId) as EngineCheckpoint & { extra?: string };
    cp.extra = "should not persist";
    await store.saveCheckpoint(cp);

    const loaded = await store.loadCheckpoint(groupId);
    expect(loaded).not.toHaveProperty("extra");
  });
});

describe("clearCheckpoint", () => {
  it("removes a persisted checkpoint -- loadCheckpoint returns null afterward", async () => {
    const groupId = "group-1";
    await store.saveCheckpoint(checkpoint(groupId));
    expect(await store.loadCheckpoint(groupId)).not.toBeNull();

    await store.clearCheckpoint(groupId);

    expect(await store.loadCheckpoint(groupId)).toBeNull();
  });

  it("is a no-op (resolves without error) for a group with nothing stored", async () => {
    await expect(store.clearCheckpoint("no-such-group")).resolves.toBeUndefined();
  });

  it("does not affect other groups' checkpoints", async () => {
    await store.saveCheckpoint(checkpoint("group-a"));
    await store.saveCheckpoint(checkpoint("group-b"));

    await store.clearCheckpoint("group-a");

    expect(await store.loadCheckpoint("group-a")).toBeNull();
    expect(await store.loadCheckpoint("group-b")).not.toBeNull();
  });

  it("throws on an empty groupId", async () => {
    await expect(store.clearCheckpoint("")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Submission-order clear discipline (S11 ledger watch item: "a
// reset-during-transition / detached-save must NOT resurrect a checkpoint").
// A save DISPATCHED (its underlying IDB transaction created) strictly
// before a clear must not survive that clear, because IndexedDB executes
// same-scope transactions in the order they were created -- proven here
// against the real backend, not merely asserted.
// ---------------------------------------------------------------------------

describe("submission-order clear discipline", () => {
  it("a save dispatched before a clear does not resurrect the checkpoint, even if awaited after the clear starts", async () => {
    const groupId = "group-1";
    const cp = checkpoint(groupId);

    // Dispatch the save WITHOUT awaiting it first (its IDB transaction is
    // created synchronously by idb-keyval's set() at this call), then
    // immediately dispatch the clear. This mirrors the real hazard: a
    // detached checkpoint-save retry in flight when reset() begins.
    const savePromise = store.saveCheckpoint(cp);
    const clearPromise = store.clearCheckpoint(groupId);

    await Promise.all([savePromise, clearPromise]);

    expect(await store.loadCheckpoint(groupId)).toBeNull();
  });
});
