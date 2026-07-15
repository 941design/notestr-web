/**
 * deferred-store.test.ts
 *
 * Real-IDB round-trip tests for deferred-store.ts (S11, resolving the
 * deferred half of MOCK-05-002 -- see verification.json VQ-S11-001) plus
 * its cross-store compositions (`acceptDeferredFact`, `clearGroupState`,
 * `createPersistenceAdapter`). Follows the REAL-IDB idiom established by
 * raw-event-log-store.test.ts / checkpoint-store.test.ts.
 *
 * The `idb-keyval` mock below wraps the REAL module (via `importOriginal`)
 * and adds one narrow, opt-in fault-injection hook (`updateShouldThrowForKeyPrefix`)
 * used by the "fault injection" describe block below to prove
 * `acceptDeferredFact`'s accepted-first crash-safe ordering (R-INV-3, AC-REC-6)
 * against the REAL implementation -- every other test in this file leaves
 * the hook unset, so `update()` behaves exactly as the unmocked module.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  ACCEPTED_EVENTS_KEY_PREFIX,
  DEFERRED_IDS_KEY_PREFIX,
  type AcceptedDomainEvent,
  type NostrEvent,
  type RawProtocolFactInput,
} from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
}));

/** Opt-in fault-injection switch for the "fault injection" block below. `null`
 *  (the default) means `update()` behaves exactly as the real module. */
let updateShouldThrowForKeyPrefix: string | null = null;

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>();
  return {
    ...actual,
    update: async (key: string, updater: unknown, store: unknown) => {
      if (
        updateShouldThrowForKeyPrefix !== null &&
        key.startsWith(updateShouldThrowForKeyPrefix)
      ) {
        throw new Error(`injected fault: update(${key}) failed`);
      }
      return (
        actual.update as (
          key: string,
          updater: unknown,
          store: unknown,
        ) => Promise<unknown>
      )(key, updater, store);
    },
  };
});

type DeferredStoreModule = typeof import("./deferred-store");
type CheckpointStoreModule = typeof import("./checkpoint-store");
type RawEventLogStoreModule = typeof import("./raw-event-log-store");
type StorageModule = typeof import("../marmot/storage");

let deferredStore: DeferredStoreModule;
let checkpointStore: CheckpointStoreModule;
let rawStore: RawEventLogStoreModule;
let storage: StorageModule;

const PUBKEY = "a".repeat(64);

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.resetModules();
  updateShouldThrowForKeyPrefix = null;
  storage = await import("../marmot/storage");
  deferredStore = await import("./deferred-store");
  checkpointStore = await import("./checkpoint-store");
  rawStore = await import("./raw-event-log-store");
  storage.bindStores(PUBKEY);
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function nostrEvent(id: string): NostrEvent {
  return {
    id,
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 445,
    tags: [],
    content: "ciphertext",
    sig: "c".repeat(128),
  };
}

function fact(
  id: string,
  groupId: string,
  overrides: Partial<RawProtocolFactInput> = {},
): RawProtocolFactInput {
  return {
    id,
    groupId,
    nostrEventId: id,
    nostrEvent: nostrEvent(id),
    receivedAt: 1_700_000_000_000,
    receiptSource: "live",
    epochAtReceipt: "epoch-0",
    ...overrides,
  };
}

function task(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    assignee: null,
    createdBy: "d".repeat(64),
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    updatedBy: "d".repeat(64),
  };
}

function taskCreatedPayload(taskId: string): TaskEvent {
  return { type: "task.created", task: task(taskId) };
}

function acceptedEvent(
  id: string,
  groupId: string,
  factId: string,
  overrides: Partial<AcceptedDomainEvent> = {},
): AcceptedDomainEvent {
  return {
    id,
    factId,
    sourceKind: "mls-rumor",
    groupId,
    acceptedAt: 1_700_000_000_000,
    epoch: "epoch-0",
    payload: taskCreatedPayload(id),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// saveDeferredIds / loadDeferredIds / clearDeferredIds
// ---------------------------------------------------------------------------

describe("saveDeferredIds / loadDeferredIds", () => {
  it("round-trips an id list through real IDB", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1", "fact-2", "fact-3"]);

    expect(await deferredStore.loadDeferredIds(groupId)).toEqual([
      "fact-1",
      "fact-2",
      "fact-3",
    ]);
  });

  it("returns [] for a group with nothing stored (never null/undefined, never throws)", async () => {
    expect(await deferredStore.loadDeferredIds("no-such-group")).toEqual([]);
  });

  it("overwrites wholesale on a second save", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["a", "b"]);
    await deferredStore.saveDeferredIds(groupId, ["c"]);

    expect(await deferredStore.loadDeferredIds(groupId)).toEqual(["c"]);
  });

  it("persists ids-only -- no reason/queuedAt/attempts shape sneaks in (architecture.md R2 known-lossy-by-design)", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1"]);
    const loaded = await deferredStore.loadDeferredIds(groupId);
    expect(loaded).toEqual(["fact-1"]);
    expect(typeof loaded[0]).toBe("string");
  });

  it("throws on an empty groupId", async () => {
    await expect(deferredStore.saveDeferredIds("", ["x"])).rejects.toThrow();
  });
});

describe("clearDeferredIds", () => {
  it("removes the id list -- loadDeferredIds returns [] afterward", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1"]);
    await deferredStore.clearDeferredIds(groupId);

    expect(await deferredStore.loadDeferredIds(groupId)).toEqual([]);
  });

  it("is a no-op for a group with nothing stored", async () => {
    await expect(deferredStore.clearDeferredIds("no-such-group")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// acceptDeferredFact -- accepted-first crash-safe ordering (R-INV-3)
// ---------------------------------------------------------------------------

describe("acceptDeferredFact", () => {
  it("appends to the accepted-log and removes the id from deferred-ids, against real IDB", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1", "fact-2"]);
    const event = acceptedEvent("evt-1", groupId, "fact-1");

    await deferredStore.acceptDeferredFact(groupId, "fact-1", event);

    expect(await rawStore.loadAcceptedEvents(groupId)).toEqual([event]);
    expect(await deferredStore.loadDeferredIds(groupId)).toEqual(["fact-2"]);
  });

  it("is idempotent -- accepting the same fact twice does not duplicate the accepted-log entry or error", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1"]);
    const event = acceptedEvent("evt-1", groupId, "fact-1");

    await deferredStore.acceptDeferredFact(groupId, "fact-1", event);
    await deferredStore.acceptDeferredFact(groupId, "fact-1", event);

    const accepted = await rawStore.loadAcceptedEvents(groupId);
    expect(accepted).toHaveLength(1);
    expect(await deferredStore.loadDeferredIds(groupId)).toEqual([]);
  });

  it("atomic RMW: concurrent acceptDeferredFact calls for the same group never lose an update (real IDB transaction serialization)", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1", "fact-2", "fact-3"]);

    await Promise.all([
      deferredStore.acceptDeferredFact(groupId, "fact-1", acceptedEvent("evt-1", groupId, "fact-1")),
      deferredStore.acceptDeferredFact(groupId, "fact-2", acceptedEvent("evt-2", groupId, "fact-2")),
      deferredStore.acceptDeferredFact(groupId, "fact-3", acceptedEvent("evt-3", groupId, "fact-3")),
    ]);

    expect(await deferredStore.loadDeferredIds(groupId)).toEqual([]);
    const accepted = await rawStore.loadAcceptedEvents(groupId);
    expect(accepted.map((e) => e.id).sort()).toEqual(["evt-1", "evt-2", "evt-3"]);
  });

  it("throws on an empty groupId or factId", async () => {
    const event = acceptedEvent("evt-1", "group-1", "fact-1");
    await expect(deferredStore.acceptDeferredFact("", "fact-1", event)).rejects.toThrow();
    await expect(deferredStore.acceptDeferredFact("group-1", "", event)).rejects.toThrow();
  });
});

describe("acceptDeferredFact -- fault injection (AC-REC-6, R-INV-3)", () => {
  it("a crash AFTER the accepted-log append but BEFORE the deferred-id removal leaves the fact in BOTH stores -- never lost, never silently double-counted", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1"]);
    const event = acceptedEvent("evt-1", groupId, "fact-1");

    // Inject the fault into the SECOND internal step only (the deferred-ids
    // removal, keyed by DEFERRED_IDS_KEY_PREFIX) -- the FIRST step
    // (accepted-log append, keyed by ACCEPTED_EVENTS_KEY_PREFIX) is
    // untouched and must durably succeed before the fault ever fires,
    // proving accepted-first ordering against the REAL implementation.
    updateShouldThrowForKeyPrefix = DEFERRED_IDS_KEY_PREFIX;

    await expect(
      deferredStore.acceptDeferredFact(groupId, "fact-1", event),
    ).rejects.toThrow();

    // Observable mid-crash state: accepted-first succeeded (never lost)...
    expect(await rawStore.loadAcceptedEvents(groupId)).toEqual([event]);
    // ...and the deferred removal never landed -- the id is still present
    // (transiently in BOTH stores, never in neither).
    expect(await deferredStore.loadDeferredIds(groupId)).toEqual(["fact-1"]);

    // Recovery's R2a prune (receive-engine.ts) reconciles this on the next
    // restart: deferredIds ∩ {accepted-log factIds} -> prune, accepted wins.
    // Reproduce that reconciliation step directly here to prove the fault
    // is recoverable, never double-counted:
    updateShouldThrowForKeyPrefix = null;
    const acceptedFactIds = new Set(
      (await rawStore.loadAcceptedEvents(groupId)).map((e) => e.factId),
    );
    const staleIds = await deferredStore.loadDeferredIds(groupId);
    const liveIds = staleIds.filter((id) => !acceptedFactIds.has(id));
    await deferredStore.saveDeferredIds(groupId, liveIds);

    expect(await deferredStore.loadDeferredIds(groupId)).toEqual([]);
    expect(await rawStore.loadAcceptedEvents(groupId)).toHaveLength(1);
  });

  it("a crash BEFORE either internal step touches the accepted-log at all -- the fact stays purely deferred, no partial accepted-log write", async () => {
    const groupId = "group-1";
    await deferredStore.saveDeferredIds(groupId, ["fact-1"]);
    const event = acceptedEvent("evt-1", groupId, "fact-1");

    // Fault-inject the FIRST step instead (accepted-events append) to prove
    // the deferred-id list is untouched when step 1 itself never lands.
    updateShouldThrowForKeyPrefix = ACCEPTED_EVENTS_KEY_PREFIX;

    await expect(
      deferredStore.acceptDeferredFact(groupId, "fact-1", event),
    ).rejects.toThrow();

    expect(await rawStore.loadAcceptedEvents(groupId)).toEqual([]);
    expect(await deferredStore.loadDeferredIds(groupId)).toEqual(["fact-1"]);
  });
});

// ---------------------------------------------------------------------------
// clearGroupState -- checkpoint-first clear-ordering discipline
// ---------------------------------------------------------------------------

describe("clearGroupState", () => {
  async function seedFullGroupState(groupId: string): Promise<void> {
    await rawStore.appendFact(fact("fact-1", groupId));
    await rawStore.appendAcceptedEvent(acceptedEvent("evt-1", groupId, "fact-1"));
    await checkpointStore.saveCheckpoint({
      groupId,
      savedAt: 1_700_000_000_000,
      engineState: "live",
      lastEpoch: "epoch-0",
      lastIngestedSeq: 1,
      lastAcceptedDomainEventId: "evt-1",
      bootstrapCompleted: true,
    });
    await deferredStore.saveDeferredIds(groupId, ["fact-2"]);
  }

  it("clears all four stores for the group", async () => {
    const groupId = "group-1";
    await seedFullGroupState(groupId);

    await deferredStore.clearGroupState(groupId);

    expect(await rawStore.loadFacts(groupId)).toEqual([]);
    expect(await rawStore.loadAcceptedEvents(groupId)).toEqual([]);
    expect(await checkpointStore.loadCheckpoint(groupId)).toBeNull();
    expect(await deferredStore.loadDeferredIds(groupId)).toEqual([]);
  });

  it("does not affect a different group's state", async () => {
    await seedFullGroupState("group-a");
    await seedFullGroupState("group-b");

    await deferredStore.clearGroupState("group-a");

    expect(await rawStore.loadFacts("group-b")).toHaveLength(1);
    expect(await checkpointStore.loadCheckpoint("group-b")).not.toBeNull();
  });

  it("throws on an empty groupId", async () => {
    await expect(deferredStore.clearGroupState("")).rejects.toThrow();
  });

  it("checkpoint-first discipline: a checkpoint save dispatched concurrently with clearGroupState never resurrects the checkpoint (submission-order guarantee)", async () => {
    const groupId = "group-1";
    await seedFullGroupState(groupId);

    // Dispatch a fresh checkpoint save WITHOUT awaiting it (its IDB
    // transaction is created synchronously), then immediately dispatch
    // clearGroupState -- mirroring a detached checkpoint-save retry racing
    // reset(). clearGroupState's own checkpoint clear is submitted strictly
    // after this save's transaction, so it must win.
    const racedSave = checkpointStore.saveCheckpoint({
      groupId,
      savedAt: 2_000_000_000_000,
      engineState: "live",
      lastEpoch: "epoch-5",
      lastIngestedSeq: 99,
      lastAcceptedDomainEventId: "evt-99",
      bootstrapCompleted: true,
    });
    const cleared = deferredStore.clearGroupState(groupId);

    await Promise.all([racedSave, cleared]);

    expect(await checkpointStore.loadCheckpoint(groupId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createPersistenceAdapter -- full end-to-end composition against real IDB
// ---------------------------------------------------------------------------

describe("createPersistenceAdapter", () => {
  it("assembles a fully-functional PersistenceAdapter exercising all ten methods against real IDB", async () => {
    const adapter = deferredStore.createPersistenceAdapter();
    const groupId = "group-1";

    // appendFact / loadFacts
    const { fact: fact1 } = await adapter.appendFact(fact("fact-1", groupId));
    expect(fact1.seq).toBe(1);
    expect(await adapter.loadFacts(groupId)).toEqual([fact1]);

    // appendAcceptedEvent / loadAcceptedEvents
    const event1 = acceptedEvent("evt-1", groupId, "fact-1");
    await adapter.appendAcceptedEvent(event1);
    expect(await adapter.loadAcceptedEvents(groupId)).toEqual([event1]);

    // saveCheckpoint / loadCheckpoint
    const cp = {
      groupId,
      savedAt: 1_700_000_000_000,
      engineState: "live" as const,
      lastEpoch: "epoch-0",
      lastIngestedSeq: 1,
      lastAcceptedDomainEventId: "evt-1",
      bootstrapCompleted: true,
    };
    await adapter.saveCheckpoint(cp);
    expect(await adapter.loadCheckpoint(groupId)).toEqual(cp);

    // saveDeferredIds / loadDeferredIds
    await adapter.saveDeferredIds(groupId, ["fact-2"]);
    expect(await adapter.loadDeferredIds(groupId)).toEqual(["fact-2"]);

    // acceptDeferredFact
    const { fact: fact2 } = await adapter.appendFact(fact("fact-2", groupId));
    const event2 = acceptedEvent("evt-2", groupId, fact2.id);
    await adapter.acceptDeferredFact(groupId, "fact-2", event2);
    expect(await adapter.loadDeferredIds(groupId)).toEqual([]);
    expect(await adapter.loadAcceptedEvents(groupId)).toEqual([event1, event2]);

    // clearGroupState
    await adapter.clearGroupState(groupId);
    expect(await adapter.loadFacts(groupId)).toEqual([]);
    expect(await adapter.loadAcceptedEvents(groupId)).toEqual([]);
    expect(await adapter.loadCheckpoint(groupId)).toBeNull();
    expect(await adapter.loadDeferredIds(groupId)).toEqual([]);
  });
});
