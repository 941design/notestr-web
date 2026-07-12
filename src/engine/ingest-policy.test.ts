/**
 * ingest-policy.test.ts
 *
 * Unit tests for ingest-policy.ts's two responsibilities: (1) in-memory
 * dedupe of processed accepted-event ids, (2) the deferred/retry-budget
 * queue (cap+evict-eldest, TTL-prune, bounded-retry accounting). Answers
 * VQ-S5-001's "real bounded-retry accounting rather than an unconditional
 * pass-through" directly: several tests below assert retryBatch()
 * genuinely excludes exhausted entries and that recordAttempt performs real
 * accounting, not a pass-through no-op.
 */

import { describe, expect, it } from "vitest";
import { createIngestPolicy, DEFAULT_INGEST_POLICY_OPTIONS } from "./ingest-policy";
import type { RawProtocolFact } from "./engine-types";

function makeFact(id: string, seq: number, groupId = "group-1"): RawProtocolFact {
  return {
    id,
    seq,
    groupId,
    nostrEventId: id,
    nostrEvent: {
      id,
      pubkey: "pk",
      created_at: 1000,
      kind: 445,
      tags: [],
      content: "cipher",
      sig: "sig",
    },
    receivedAt: 1000,
    receiptSource: "live",
    epochAtReceipt: "epoch-0",
  };
}

describe("createIngestPolicy: constructor validation", () => {
  it("throws on non-positive maxDeferredSize", () => {
    expect(() =>
      createIngestPolicy({ ...DEFAULT_INGEST_POLICY_OPTIONS, maxDeferredSize: 0 }),
    ).toThrow();
  });
  it("throws on non-positive maxDeferredAgeSec", () => {
    expect(() =>
      createIngestPolicy({ ...DEFAULT_INGEST_POLICY_OPTIONS, maxDeferredAgeSec: -1 }),
    ).toThrow();
  });
  it("throws on non-positive maxRetryAttempts", () => {
    expect(() =>
      createIngestPolicy({ ...DEFAULT_INGEST_POLICY_OPTIONS, maxRetryAttempts: 0 }),
    ).toThrow();
  });
});

describe("dedupe: hasProcessed / markProcessed", () => {
  it("starts with no ids processed", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    expect(policy.hasProcessed("evt-1")).toBe(false);
  });

  it("marks an id processed and reports it thereafter", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    policy.markProcessed("evt-1");
    expect(policy.hasProcessed("evt-1")).toBe(true);
    expect(policy.hasProcessed("evt-2")).toBe(false);
  });

  it("markProcessed is idempotent (repeat calls are safe no-ops)", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    policy.markProcessed("evt-1");
    policy.markProcessed("evt-1");
    expect(policy.hasProcessed("evt-1")).toBe(true);
  });
});

describe("deferred queue: enqueueDeferred dedupe", () => {
  it("enqueues a new factId and returns true", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    const isNew = policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 1000);
    expect(isNew).toBe(true);
    expect(policy.hasDeferred("f1")).toBe(true);
    expect(policy.deferredSize).toBe(1);
  });

  it("re-enqueuing an already-queued factId is a no-op and returns false", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 1000);
    const isNew = policy.enqueueDeferred("f1", makeFact("f1", 1), "epoch_mismatch", 2000);
    expect(isNew).toBe(false);
    expect(policy.deferredSize).toBe(1);
  });

  it("removeDeferred removes a queued entry", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 1000);
    policy.removeDeferred("f1");
    expect(policy.hasDeferred("f1")).toBe(false);
    expect(policy.deferredSize).toBe(0);
  });

  it("removeDeferred on a non-queued id is a safe no-op", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    expect(() => policy.removeDeferred("nope")).not.toThrow();
  });

  it("deferredFactIds returns ids in FIFO insertion order", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 1000);
    policy.enqueueDeferred("f2", makeFact("f2", 2), "unreadable", 1001);
    policy.enqueueDeferred("f3", makeFact("f3", 3), "unreadable", 1002);
    expect(policy.deferredFactIds()).toEqual(["f1", "f2", "f3"]);
  });
});

describe("deferred queue: cap with evict-eldest", () => {
  it("evicts the eldest entry once maxDeferredSize is exceeded", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 2,
      maxDeferredAgeSec: 1000,
      maxRetryAttempts: 10,
    });
    policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 1000);
    policy.enqueueDeferred("f2", makeFact("f2", 2), "unreadable", 1001);
    expect(policy.deferredSize).toBe(2);
    policy.enqueueDeferred("f3", makeFact("f3", 3), "unreadable", 1002);
    expect(policy.deferredSize).toBe(2);
    expect(policy.hasDeferred("f1")).toBe(false); // eldest evicted
    expect(policy.hasDeferred("f2")).toBe(true);
    expect(policy.hasDeferred("f3")).toBe(true);
  });
});

describe("deferred queue: TTL prune", () => {
  it("prunes entries older than maxDeferredAgeSec", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 100,
      maxDeferredAgeSec: 10, // 10s
      maxRetryAttempts: 10,
    });
    policy.enqueueDeferred("old", makeFact("old", 1), "unreadable", 0);
    policy.enqueueDeferred("fresh", makeFact("fresh", 2), "unreadable", 9_000);
    // nowMs = 20_000ms => old entry age = 20s > 10s cutoff; fresh entry age = 11s > 10s too.
    // Use a nowMs that only stales "old" (age 15s) but not "fresh" (age 6s).
    policy.pruneDeferred(15_000);
    expect(policy.hasDeferred("old")).toBe(false);
    expect(policy.hasDeferred("fresh")).toBe(true);
  });

  it("does not prune entries within the age window", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 100,
      maxDeferredAgeSec: 100,
      maxRetryAttempts: 10,
    });
    policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 0);
    policy.pruneDeferred(5_000); // 5s old, well within 100s
    expect(policy.hasDeferred("f1")).toBe(true);
  });

  it("pruneDeferred returns the removed entries (S6 -- was previously void, so callers had no way to persist/report what was pruned)", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 100,
      maxDeferredAgeSec: 10,
      maxRetryAttempts: 10,
    });
    policy.enqueueDeferred("old", makeFact("old", 1), "epoch_mismatch", 0);
    policy.enqueueDeferred("fresh", makeFact("fresh", 2), "unreadable", 9_000);

    const removed = policy.pruneDeferred(15_000);
    expect(removed.map((e) => e.factId)).toEqual(["old"]);
    expect(removed[0].reason).toBe("epoch_mismatch");
    expect(removed[0].fact.id).toBe("old");

    // No entries aged out -> empty array, not undefined.
    expect(policy.pruneDeferred(15_001)).toEqual([]);
  });
});

describe("bounded-retry accounting (VQ-S5-001: real accounting, not pass-through)", () => {
  it("recordAttempt increments the entry's attempt counter, observable via retryBatch/isExhausted", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 100,
      maxDeferredAgeSec: 1000,
      maxRetryAttempts: 3,
    });
    policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 1000);

    expect(policy.isExhausted("f1")).toBe(false);
    expect(policy.retryBatch().map((e) => e.factId)).toEqual(["f1"]);

    policy.recordAttempt("f1");
    expect(policy.retryBatch()[0].attempts).toBe(1);
    expect(policy.isExhausted("f1")).toBe(false);

    policy.recordAttempt("f1");
    policy.recordAttempt("f1");
    // 3 attempts recorded, maxRetryAttempts=3 => exhausted (attempts >= max)
    expect(policy.isExhausted("f1")).toBe(true);
  });

  it("retryBatch excludes an exhausted entry from the next batch (real accounting, not an unconditional pass-through)", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 100,
      maxDeferredAgeSec: 1000,
      maxRetryAttempts: 2,
    });
    policy.enqueueDeferred("exhausted", makeFact("exhausted", 1), "unreadable", 1000);
    policy.enqueueDeferred("fresh", makeFact("fresh", 2), "unreadable", 1000);

    policy.recordAttempt("exhausted");
    policy.recordAttempt("exhausted");

    const batch = policy.retryBatch();
    expect(batch.map((e) => e.factId)).toEqual(["fresh"]);
  });

  it("exhaustedEntries() returns exactly the entries retryBatch() excludes (S6 ledger obligation 2 -- was previously undiscoverable)", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 100,
      maxDeferredAgeSec: 1000,
      maxRetryAttempts: 2,
    });
    policy.enqueueDeferred("exhausted", makeFact("exhausted", 1), "unreadable", 1000);
    policy.enqueueDeferred("fresh", makeFact("fresh", 2), "unreadable", 1000);

    expect(policy.exhaustedEntries()).toEqual([]);

    policy.recordAttempt("exhausted");
    policy.recordAttempt("exhausted");

    const exhausted = policy.exhaustedEntries();
    expect(exhausted.map((e) => e.factId)).toEqual(["exhausted"]);
    // Complementary to retryBatch(): the two sets are disjoint and cover
    // every queued entry.
    const batch = policy.retryBatch();
    expect(batch.map((e) => e.factId)).toEqual(["fresh"]);

    // exhaustedEntries() does NOT itself remove anything -- the caller
    // (receive-engine.ts) is responsible for calling removeDeferred.
    expect(policy.hasDeferred("exhausted")).toBe(true);
  });

  it("an exhausted entry remains queued (counted in deferredSize) rather than being silently dropped", () => {
    const policy = createIngestPolicy({
      maxDeferredSize: 100,
      maxDeferredAgeSec: 1000,
      maxRetryAttempts: 1,
    });
    policy.enqueueDeferred("f1", makeFact("f1", 1), "unreadable", 1000);
    policy.recordAttempt("f1");
    expect(policy.isExhausted("f1")).toBe(true);
    expect(policy.deferredSize).toBe(1);
    expect(policy.hasDeferred("f1")).toBe(true);
  });

  it("recordAttempt on a non-queued id is a safe no-op", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    expect(() => policy.recordAttempt("nope")).not.toThrow();
  });

  it("isExhausted on a non-queued id is false", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    expect(policy.isExhausted("nope")).toBe(false);
  });

  it("retryBatch entries carry the fully-sequenced RawProtocolFact needed by IngestSource.ingestPersisted", () => {
    const policy = createIngestPolicy(DEFAULT_INGEST_POLICY_OPTIONS);
    const fact = makeFact("f1", 42);
    policy.enqueueDeferred("f1", fact, "epoch_mismatch", 1000);
    const [entry] = policy.retryBatch();
    expect(entry.fact).toBe(fact);
    expect(entry.fact.seq).toBe(42);
    expect(entry.reason).toBe("epoch_mismatch");
  });
});
