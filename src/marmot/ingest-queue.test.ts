import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NostrEvent } from "applesauce-core/helpers/event";

import { createPendingRetryQueue } from "./ingest-queue";

// Minimal NostrEvent fixture — the queue only reads `id` and
// `created_at`; the rest can be stubbed.
function makeEvent(id: string, createdAt = 1_700_000_000): NostrEvent {
  return {
    id,
    kind: 445,
    pubkey: "a".repeat(64),
    created_at: createdAt,
    tags: [],
    content: "",
    sig: "b".repeat(128),
  } as NostrEvent;
}

describe("createPendingRetryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000 * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues events and reports size", () => {
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 3600 });
    expect(q.size).toBe(0);
    q.enqueue(makeEvent("a"));
    q.enqueue(makeEvent("b"));
    expect(q.size).toBe(2);
  });

  it("deduplicates by event id", () => {
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 3600 });
    q.enqueue(makeEvent("a"));
    q.enqueue(makeEvent("a"));
    q.enqueue(makeEvent("a", 2_000_000_000));
    expect(q.size).toBe(1);
  });

  it("preserves FIFO order in snapshot()", () => {
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 3600 });
    q.enqueue(makeEvent("first", 100));
    q.enqueue(makeEvent("second", 200));
    q.enqueue(makeEvent("third", 300));
    expect(q.snapshot().map((e) => e.id)).toEqual(["first", "second", "third"]);
  });

  it("remove() deletes the named entry", () => {
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 3600 });
    q.enqueue(makeEvent("a"));
    q.enqueue(makeEvent("b"));
    q.enqueue(makeEvent("c"));
    q.remove("b");
    expect(q.size).toBe(2);
    expect(q.snapshot().map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("remove() on a missing id is a no-op", () => {
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 3600 });
    q.enqueue(makeEvent("a"));
    q.remove("nope");
    expect(q.size).toBe(1);
  });

  it("snapshot() is a stable copy — mutations don't affect the queue", () => {
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 3600 });
    q.enqueue(makeEvent("a"));
    q.enqueue(makeEvent("b"));
    const snap = q.snapshot();
    snap.pop();
    expect(q.size).toBe(2);
  });

  it("caps at maxSize and evicts the eldest (insertion order)", () => {
    const q = createPendingRetryQueue({ maxSize: 3, maxAgeSec: 3600 });
    q.enqueue(makeEvent("first"));
    q.enqueue(makeEvent("second"));
    q.enqueue(makeEvent("third"));
    q.enqueue(makeEvent("fourth"));
    expect(q.size).toBe(3);
    expect(q.snapshot().map((e) => e.id)).toEqual([
      "second",
      "third",
      "fourth",
    ]);
  });

  it("prune() drops entries older than maxAgeSec (by event.created_at)", () => {
    const now = 1_700_000_000;
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 60 });
    q.enqueue(makeEvent("fresh", now - 10));
    q.enqueue(makeEvent("stale", now - 120));
    q.enqueue(makeEvent("older", now - 3600));
    q.prune(now);
    expect(q.size).toBe(1);
    expect(q.snapshot().map((e) => e.id)).toEqual(["fresh"]);
  });

  it("prune() uses queuedAt fallback when created_at is absurd", () => {
    const now = 1_700_000_000;
    vi.setSystemTime(new Date(now * 1000));
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 60 });
    // created_at far in the future → age() falls back to queuedAt
    q.enqueue(makeEvent("weird", 9_999_999_999));
    expect(q.size).toBe(1);
    // Advance 2 minutes
    vi.setSystemTime(new Date((now + 120) * 1000));
    q.prune();
    expect(q.size).toBe(0);
  });

  it("rejects non-positive maxSize", () => {
    expect(() =>
      createPendingRetryQueue({ maxSize: 0, maxAgeSec: 60 }),
    ).toThrow();
    expect(() =>
      createPendingRetryQueue({ maxSize: -5, maxAgeSec: 60 }),
    ).toThrow();
  });

  it("rejects non-positive maxAgeSec", () => {
    expect(() =>
      createPendingRetryQueue({ maxSize: 10, maxAgeSec: 0 }),
    ).toThrow();
    expect(() =>
      createPendingRetryQueue({ maxSize: 10, maxAgeSec: -1 }),
    ).toThrow();
  });

  it("ignores events without an id", () => {
    const q = createPendingRetryQueue({ maxSize: 10, maxAgeSec: 60 });
    q.enqueue({ ...makeEvent("ok"), id: "" } as NostrEvent);
    expect(q.size).toBe(0);
  });
});
