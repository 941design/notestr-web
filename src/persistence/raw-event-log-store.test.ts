/**
 * raw-event-log-store.test.ts
 *
 * Unit tests for the S4 fact/accepted-event half of `PersistenceAdapter`
 * (see raw-event-log-store.ts's module doc comment). Follows the REAL-IDB
 * idiom established by src/marmot/storage.test.ts: a fresh `IDBFactory`
 * (fake-indexeddb) plus `vi.resetModules()` per test gives both
 * idb-keyval and storage.ts clean module state, and `bindStores(pubkey)`
 * must be called before any store I/O (storage.ts partitions IDB per
 * signed-in pubkey).
 *
 * This exercises a REAL createKVStore/idb-keyval/fake-indexeddb round
 * trip end to end -- no store-level mocking. Plain describe/it/expect
 * (no fast-check): the load-bearing invariants here are exact
 * idempotency and exact ordering against a concrete backend, which
 * example-based fixtures prove more directly and readably than a
 * generated-input property would.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type {
  AcceptedDomainEvent,
  NostrEvent,
  RawProtocolFactInput,
} from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

// storage.ts imports generateKeyPackageSlot from marmot-ts; stub it so the
// module resolves in the node test env without pulling the real fork.
vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
}));

type RawEventLogStoreModule = typeof import("./raw-event-log-store");
type StorageModule = typeof import("../marmot/storage");

let store: RawEventLogStoreModule;
let storage: StorageModule;

const PUBKEY = "a".repeat(64);

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.resetModules();
  storage = await import("../marmot/storage");
  store = await import("./raw-event-log-store");
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

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: "Task " + id,
    description: "",
    status: "open",
    assignee: null,
    createdBy: "d".repeat(64),
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    updatedBy: "d".repeat(64),
    ...overrides,
  };
}

function acceptedEvent(
  id: string,
  groupId: string,
  payload: TaskEvent,
  overrides: Partial<AcceptedDomainEvent> = {},
): AcceptedDomainEvent {
  return {
    id,
    factId: id,
    sourceKind: "mls-rumor",
    groupId,
    acceptedAt: 1_700_000_000_000,
    epoch: "epoch-0",
    payload,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// appendFact
// ---------------------------------------------------------------------------

describe("appendFact", () => {
  it("is idempotent on fact.id: a byte-identical second call is a no-op (real IDB round-trip)", async () => {
    const groupId = "group-1";
    const input = fact("fact-1", groupId);

    const first = await store.appendFact(input);
    const second = await store.appendFact(input);

    expect(second.duplicate).toBe(true);
    expect(second.fact.seq).toBe(first.fact.seq);

    const loaded = await store.loadFacts(groupId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(first.fact);
  });

  it("assigns strictly increasing seqs (1, 2, 3) for facts appended to the same group", async () => {
    const groupId = "group-1";
    const r1 = await store.appendFact(fact("fact-1", groupId));
    const r2 = await store.appendFact(fact("fact-2", groupId));
    const r3 = await store.appendFact(fact("fact-3", groupId));

    expect([r1.fact.seq, r2.fact.seq, r3.fact.seq]).toEqual([1, 2, 3]);

    const loaded = await store.loadFacts(groupId);
    expect(loaded.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(loaded.map((f) => f.id)).toEqual(["fact-1", "fact-2", "fact-3"]);
  });

  it("assigns seq independently per group -- each group's first fact gets seq 1", async () => {
    const groupA = "group-a";
    const groupB = "group-b";

    const a1 = await store.appendFact(fact("a-1", groupA));
    const b1 = await store.appendFact(fact("b-1", groupB));
    const a2 = await store.appendFact(fact("a-2", groupA));

    expect(a1.fact.seq).toBe(1);
    expect(b1.fact.seq).toBe(1);
    expect(a2.fact.seq).toBe(2);

    expect((await store.loadFacts(groupA)).map((f) => f.id)).toEqual(["a-1", "a-2"]);
    expect((await store.loadFacts(groupB)).map((f) => f.id)).toEqual(["b-1"]);
  });

  it("throws on an empty fact.id", async () => {
    await expect(store.appendFact(fact("", "group-1"))).rejects.toThrow();
  });

  it("throws on an empty fact.groupId", async () => {
    await expect(store.appendFact(fact("fact-1", ""))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadFacts
// ---------------------------------------------------------------------------

describe("loadFacts", () => {
  it("returns [] for a group with nothing appended (never null/undefined, never throws)", async () => {
    const result = await store.loadFacts("no-such-group");
    expect(result).toEqual([]);
  });

  it("preserves seq order regardless of append order (non-id-sorted, non-alphabetical)", async () => {
    const groupId = "group-1";
    // Append ids in an order that would visibly diverge from seq order if
    // the store (wrongly) sorted by id.
    await store.appendFact(fact("zeta", groupId));
    await store.appendFact(fact("alpha", groupId));
    await store.appendFact(fact("mu", groupId));

    const loaded = await store.loadFacts(groupId);
    expect(loaded.map((f) => f.id)).toEqual(["zeta", "alpha", "mu"]);
    expect(loaded.map((f) => f.seq)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// appendAcceptedEvent
// ---------------------------------------------------------------------------

describe("appendAcceptedEvent", () => {
  it("is idempotent on event.id: a byte-identical second call is a no-op (real IDB round-trip)", async () => {
    const groupId = "group-1";
    const event = acceptedEvent("evt-1", groupId, {
      type: "task.created",
      task: task("t1"),
    });

    await store.appendAcceptedEvent(event);
    await store.appendAcceptedEvent(event);

    const loaded = await store.loadAcceptedEvents(groupId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(event);
  });

  it("keys idempotency on id alone -- a second append with the SAME id but different payload does not overwrite (AC-INV-2 split-gate proof)", async () => {
    const groupId = "group-1";
    const first = acceptedEvent("evt-1", groupId, {
      type: "task.created",
      task: task("t1", { title: "first payload" }),
    });
    const second = acceptedEvent("evt-1", groupId, {
      type: "task.created",
      task: task("t1", { title: "different payload, same id" }),
    });

    await store.appendAcceptedEvent(first);
    await store.appendAcceptedEvent(second);

    const loaded = await store.loadAcceptedEvents(groupId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(first);
  });

  it("throws on an empty event.id", async () => {
    const event = acceptedEvent("", "group-1", {
      type: "task.created",
      task: task("t1"),
    });
    await expect(store.appendAcceptedEvent(event)).rejects.toThrow();
  });

  it("throws on an empty event.groupId", async () => {
    const event = acceptedEvent("evt-1", "", {
      type: "task.created",
      task: task("t1"),
    });
    await expect(store.appendAcceptedEvent(event)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadAcceptedEvents
// ---------------------------------------------------------------------------

describe("loadAcceptedEvents", () => {
  it("returns [] for a group with nothing appended (never null/undefined, never throws)", async () => {
    const result = await store.loadAcceptedEvents("no-such-group");
    expect(result).toEqual([]);
  });

  it(
    "preserves EXACT append order for delete-before-update interleaving " +
      "(architecture.md S3 Stage-1 review sev-5, non-negotiable: created, " +
      "deleted, updated -- never sorted by id, never sorted by acceptedAt)",
    async () => {
      const groupId = "group-1";
      const taskId = "t1";

      const created = acceptedEvent("z-created", groupId, {
        type: "task.created",
        task: task(taskId, { updatedAt: 1000 }),
      });
      const deleted = acceptedEvent("m-deleted", groupId, {
        type: "task.deleted",
        taskId,
        updatedAt: 1001,
        updatedBy: "d".repeat(64),
      });
      const updated = acceptedEvent("a-updated", groupId, {
        type: "task.updated",
        taskId,
        changes: { title: "renamed after delete" },
        updatedAt: 2000, // higher updatedAt than `created`
        updatedBy: "d".repeat(64),
      });

      // Append in EXACTLY this order: created, deleted, updated. Note the
      // ids are deliberately in reverse-alphabetical order relative to
      // append order (z, m, a) and acceptedAt/updatedAt values do NOT
      // ascend monotonically with append order either -- so an id-sort,
      // an acceptedAt-sort, or an updatedAt-sort would all visibly reorder
      // this sequence away from the correct append order.
      await store.appendAcceptedEvent(created);
      await store.appendAcceptedEvent(deleted);
      await store.appendAcceptedEvent(updated);

      const loaded = await store.loadAcceptedEvents(groupId);
      expect(loaded.map((e) => e.id)).toEqual([
        "z-created",
        "m-deleted",
        "a-updated",
      ]);
      expect(loaded).toEqual([created, deleted, updated]);
    },
  );

  it("preserves append order for a general non-id-sorted, non-alphabetical sequence", async () => {
    const groupId = "group-1";
    const e1 = acceptedEvent("zebra", groupId, {
      type: "task.created",
      task: task("t1"),
    });
    const e2 = acceptedEvent("apple", groupId, {
      type: "task.status_changed",
      taskId: "t1",
      status: "in_progress",
      updatedAt: 1001,
      updatedBy: "d".repeat(64),
    });
    const e3 = acceptedEvent("mango", groupId, {
      type: "task.assigned",
      taskId: "t1",
      assignee: "e".repeat(64),
      updatedAt: 1002,
      updatedBy: "d".repeat(64),
    });

    await store.appendAcceptedEvent(e1);
    await store.appendAcceptedEvent(e2);
    await store.appendAcceptedEvent(e3);

    const loaded = await store.loadAcceptedEvents(groupId);
    expect(loaded.map((e) => e.id)).toEqual(["zebra", "apple", "mango"]);
  });
});

// ---------------------------------------------------------------------------
// clearRawAndAcceptedLogs
// ---------------------------------------------------------------------------

describe("clearRawAndAcceptedLogs", () => {
  it("purges both the fact log and accepted-event log for the given group, leaving other groups intact", async () => {
    const groupA = "group-a";
    const groupB = "group-b";

    await store.appendFact(fact("a-fact-1", groupA));
    await store.appendFact(fact("a-fact-2", groupA));
    await store.appendAcceptedEvent(
      acceptedEvent("a-evt-1", groupA, { type: "task.created", task: task("t1") }),
    );

    await store.appendFact(fact("b-fact-1", groupB));
    await store.appendAcceptedEvent(
      acceptedEvent("b-evt-1", groupB, { type: "task.created", task: task("t2") }),
    );

    await store.clearRawAndAcceptedLogs(groupA);

    expect(await store.loadFacts(groupA)).toEqual([]);
    expect(await store.loadAcceptedEvents(groupA)).toEqual([]);

    expect((await store.loadFacts(groupB)).map((f) => f.id)).toEqual(["b-fact-1"]);
    expect((await store.loadAcceptedEvents(groupB)).map((e) => e.id)).toEqual([
      "b-evt-1",
    ]);
  });

  it("resolves without error when clearing a group that was never written", async () => {
    await expect(
      store.clearRawAndAcceptedLogs("never-written-group"),
    ).resolves.toBeUndefined();
    expect(await store.loadFacts("never-written-group")).toEqual([]);
    expect(await store.loadAcceptedEvents("never-written-group")).toEqual([]);
  });

  it("restarts seq at 1 for facts appended after a clear (CORRECT under L11: reset() also wipes the checkpoint watermark, so a restarted seq never compares against a stale one)", async () => {
    const groupId = "group-1";
    await store.appendFact(fact("fact-1", groupId));
    await store.appendFact(fact("fact-2", groupId));

    await store.clearRawAndAcceptedLogs(groupId);

    const postClear = await store.appendFact(fact("fact-3", groupId));
    expect(postClear.fact.seq).toBe(1);

    const loaded = await store.loadFacts(groupId);
    expect(loaded.map((f) => f.id)).toEqual(["fact-3"]);
    expect(loaded.map((f) => f.seq)).toEqual([1]);
  });

  it("throws on an empty groupId", async () => {
    await expect(store.clearRawAndAcceptedLogs("")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Concurrency (cold P1-1 remediation): single-transaction RMW closes the
// lost-update race a getItem/setItem split had under concurrent same-group
// appends.
// ---------------------------------------------------------------------------

describe("concurrent appends to the same group (single-transaction RMW, P1-1)", () => {
  it("N=25 concurrent appendFact calls for the same group produce exactly 25 facts with seqs exactly 1..25 (unique, gapless)", async () => {
    const groupId = "group-concurrent";
    const N = 25;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => store.appendFact(fact(`fact-${i}`, groupId))),
    );

    // None of the 25 distinct ids should collide, so every result is fresh.
    expect(results.every((r) => r.duplicate === false)).toBe(true);

    const loaded = await store.loadFacts(groupId);
    expect(loaded).toHaveLength(N);

    const seqs = loaded.map((f) => f.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(N); // no duplicate seq minted

    const ids = new Set(loaded.map((f) => f.id));
    expect(ids.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(ids.has(`fact-${i}`)).toBe(true);
    }
  });

  it("N=25 concurrent appendAcceptedEvent calls for the same group produce exactly 25 entries (id-set complete; append order = resolution order is NOT asserted)", async () => {
    const groupId = "group-concurrent";
    const N = 25;

    const events = Array.from({ length: N }, (_, i) =>
      acceptedEvent(`evt-${i}`, groupId, { type: "task.created", task: task(`t${i}`) }),
    );

    await Promise.all(events.map((e) => store.appendAcceptedEvent(e)));

    const loaded = await store.loadAcceptedEvents(groupId);
    expect(loaded).toHaveLength(N);

    const ids = new Set(loaded.map((e) => e.id));
    expect(ids.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(ids.has(`evt-${i}`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Field-picking (cold P3-2): extra enumerable / function-valued props on a
// structurally-typed input must never enter the durable log.
// ---------------------------------------------------------------------------

describe("field-picking (P3-2): extra caller properties never enter the durable log", () => {
  it("appendFact stores exactly the 8 RawProtocolFact fields, dropping any extra enumerable or function-valued prop, and does not throw", async () => {
    const groupId = "group-1";
    const input = fact("fact-extra", groupId) as RawProtocolFactInput & {
      unexpectedExtra?: string;
      suspiciousFn?: () => void;
    };
    input.unexpectedExtra = "should-not-be-persisted";
    input.suspiciousFn = () => {
      throw new Error("must never be invoked or persisted");
    };

    const result = await store.appendFact(input);

    expect(Object.keys(result.fact).sort()).toEqual(
      [
        "id",
        "seq",
        "groupId",
        "nostrEventId",
        "nostrEvent",
        "receivedAt",
        "receiptSource",
        "epochAtReceipt",
      ].sort(),
    );

    const loaded = await store.loadFacts(groupId);
    expect(loaded).toHaveLength(1);
    expect(Object.keys(loaded[0]).sort()).toEqual(Object.keys(result.fact).sort());
  });

  it("appendAcceptedEvent stores exactly the 7 AcceptedDomainEvent fields, dropping any extra enumerable or function-valued prop, and does not throw", async () => {
    const groupId = "group-1";
    const event = acceptedEvent("evt-extra", groupId, {
      type: "task.created",
      task: task("t1"),
    }) as AcceptedDomainEvent & {
      unexpectedExtra?: string;
      suspiciousFn?: () => void;
    };
    event.unexpectedExtra = "should-not-be-persisted";
    event.suspiciousFn = () => {
      throw new Error("must never be invoked or persisted");
    };

    await expect(store.appendAcceptedEvent(event)).resolves.toBeUndefined();

    const loaded = await store.loadAcceptedEvents(groupId);
    expect(loaded).toHaveLength(1);
    expect(Object.keys(loaded[0]).sort()).toEqual(
      ["id", "factId", "sourceKind", "groupId", "acceptedAt", "epoch", "payload"].sort(),
    );
  });
});
