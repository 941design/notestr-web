/**
 * Unit tests for src/marmot/failed-welcomes.ts
 *
 * AC-LOG-3: dedup invariant (same giftWrapEventId → exactly 1 record).
 * AC-LOG-4: notestr:failed-welcomes-changed dispatched after every mutation.
 * VQ-S1-003: since-filter semantics.
 * VQ-S1-007: append/load/dismiss/prune round-trip.
 * VQ-S1-011: no fake-indexeddb — uses vi.hoisted proxy + Map.
 *
 * Testing approach:
 *   - vi.hoisted() initialises state before vi.mock hoisting runs.
 *   - vi.mock('./storage') replaces createKVStore with a factory that returns
 *     a proxy delegating to a swappable inner store (storeRef.current).
 *   - Swapping storeRef.current in beforeEach resets effective store state
 *     without breaking the reference held by failed-welcomes.ts.
 *   - global.window is replaced with a fresh EventTarget each test so
 *     dispatchEvent works in the vitest node environment and listeners
 *     do not leak across tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FailedWelcomeRecord } from "./failed-welcomes";

// vi.hoisted runs before vi.mock factories — variables initialised here
// can be safely closed over by the mock factory below.
const { storeRef, makeInMemoryStore } = vi.hoisted(() => {
  type Rec = FailedWelcomeRecord;

  function makeInMemoryStore() {
    const data = new Map<string, Rec>();
    return {
      async getItem(key: string): Promise<Rec | null> {
        return data.get(key) ?? null;
      },
      async setItem(key: string, value: Rec): Promise<Rec> {
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

  const ref = { current: makeInMemoryStore() };
  return { storeRef: ref, makeInMemoryStore };
});

vi.mock("./storage", () => {
  // Proxy always delegates to storeRef.current so swapping storeRef.current
  // in beforeEach changes the effective store for the already-imported module.
  const proxy = {
    getItem: (key: string) => storeRef.current.getItem(key),
    setItem: (key: string, value: FailedWelcomeRecord) =>
      storeRef.current.setItem(key, value),
    removeItem: (key: string) => storeRef.current.removeItem(key),
    clear: () => storeRef.current.clear(),
    keys: () => storeRef.current.keys(),
  };

  return {
    createKVStore: vi.fn(() => proxy),
    clearIdentityStore: vi.fn().mockResolvedValue(undefined),
  };
});

// Import AFTER the mock declaration.
import {
  appendFailedWelcome,
  forgetFailedWelcome,
  loadFailedWelcomes,
  pruneOlderThan,
} from "./failed-welcomes";

// Minimal window shim for the vitest node environment.
function makeWindowShim(): EventTarget {
  return new EventTarget();
}

function makeRecord(
  overrides: Partial<FailedWelcomeRecord> = {},
): FailedWelcomeRecord {
  return {
    recordedAt: Date.now(),
    giftWrapEventId: "evt-001",
    innerKind: 444,
    innerCreatedAt: 0,
    inviterPubkey: "aabbcc",
    groupId: null,
    kpRef: null,
    failureReason: "unknown",
    failureDetail: "test error",
    ...overrides,
  };
}

describe("failed-welcomes", () => {
  let windowShim: EventTarget;

  beforeEach(() => {
    // Replace inner store — proxy picks this up immediately.
    storeRef.current = makeInMemoryStore();
    // Refresh window shim.
    windowShim = makeWindowShim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).window = windowShim;
  });

  // ------------------------------------------------------------------ //
  // 1. appendFailedWelcome → record persisted + event dispatched        //
  // ------------------------------------------------------------------ //
  it("appendFailedWelcome stores the record and dispatches the DOM event", async () => {
    const received: Event[] = [];
    windowShim.addEventListener("notestr:failed-welcomes-changed", (e) => {
      received.push(e);
    });

    const rec = makeRecord({ giftWrapEventId: "wrap-1" });
    await appendFailedWelcome(rec);

    const stored = await loadFailedWelcomes();
    expect(stored).toHaveLength(1);
    expect(stored[0].giftWrapEventId).toBe("wrap-1");
    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(CustomEvent);
    expect(received[0].type).toBe("notestr:failed-welcomes-changed");
  });

  // ------------------------------------------------------------------ //
  // 2. Dedup: same giftWrapEventId twice → exactly 1 record (AC-LOG-3)  //
  // ------------------------------------------------------------------ //
  it("dedup: appending same giftWrapEventId twice yields exactly 1 record", async () => {
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "dup", failureReason: "unknown" }));
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "dup", failureReason: "no_matching_kp" }));

    const stored = await loadFailedWelcomes();
    expect(stored).toHaveLength(1);
    // Last write wins (upsert semantics).
    expect(stored[0].failureReason).toBe("no_matching_kp");
  });

  // ------------------------------------------------------------------ //
  // 3. loadFailedWelcomes({ since: T }) time-filter (VQ-S1-007)         //
  // ------------------------------------------------------------------ //
  it("loadFailedWelcomes({ since }) returns only records with recordedAt >= since", async () => {
    const now = Date.now();
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "old", recordedAt: now - 10000 }));
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "new", recordedAt: now }));

    const result = await loadFailedWelcomes({ since: now - 5000 });
    expect(result).toHaveLength(1);
    expect(result[0].giftWrapEventId).toBe("new");
  });

  // ------------------------------------------------------------------ //
  // 4. forgetFailedWelcome → record removed + event dispatched          //
  // ------------------------------------------------------------------ //
  it("forgetFailedWelcome removes the record and dispatches the DOM event", async () => {
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "to-forget" }));

    const received: Event[] = [];
    windowShim.addEventListener("notestr:failed-welcomes-changed", (e) => {
      received.push(e);
    });

    await forgetFailedWelcome("to-forget");

    const stored = await loadFailedWelcomes();
    expect(stored).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("notestr:failed-welcomes-changed");
  });

  // ------------------------------------------------------------------ //
  // 5. pruneOlderThan → removes old, keeps recent + event dispatched    //
  // ------------------------------------------------------------------ //
  it("pruneOlderThan removes old records, keeps recent ones, dispatches event", async () => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 86400 * 1000;

    // Record 31 days old — should be pruned.
    await appendFailedWelcome(
      makeRecord({ giftWrapEventId: "stale", recordedAt: now - thirtyDaysMs - 1000 }),
    );
    // Record 1 day old — should survive.
    await appendFailedWelcome(
      makeRecord({ giftWrapEventId: "fresh", recordedAt: now - 86400 * 1000 }),
    );

    const received: Event[] = [];
    windowShim.addEventListener("notestr:failed-welcomes-changed", (e) => {
      received.push(e);
    });

    await pruneOlderThan(thirtyDaysMs);

    const stored = await loadFailedWelcomes();
    expect(stored).toHaveLength(1);
    expect(stored[0].giftWrapEventId).toBe("fresh");
    // Event must have been dispatched.
    expect(received.length).toBeGreaterThanOrEqual(1);
  });

  // ------------------------------------------------------------------ //
  // 6. pruneOlderThan still dispatches event when nothing is pruned     //
  // ------------------------------------------------------------------ //
  it("pruneOlderThan dispatches the event even when no records are pruned", async () => {
    const received: Event[] = [];
    windowShim.addEventListener("notestr:failed-welcomes-changed", (e) => {
      received.push(e);
    });

    await pruneOlderThan(30 * 86400 * 1000);

    expect(received).toHaveLength(1);
  });

  // ------------------------------------------------------------------ //
  // 7. failureDetail is truncated to 500 chars                          //
  // ------------------------------------------------------------------ //
  it("appendFailedWelcome truncates failureDetail to 500 characters", async () => {
    const longDetail = "x".repeat(1000);
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "trunc", failureDetail: longDetail }));

    const stored = await loadFailedWelcomes();
    expect(stored[0].failureDetail.length).toBe(500);
  });

  // ------------------------------------------------------------------ //
  // 8. loadFailedWelcomes returns results sorted descending by recordedAt //
  // ------------------------------------------------------------------ //
  it("loadFailedWelcomes returns records sorted by recordedAt descending", async () => {
    const now = Date.now();
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "a", recordedAt: now - 2000 }));
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "b", recordedAt: now }));
    await appendFailedWelcome(makeRecord({ giftWrapEventId: "c", recordedAt: now - 1000 }));

    const stored = await loadFailedWelcomes();
    expect(stored[0].giftWrapEventId).toBe("b");
    expect(stored[1].giftWrapEventId).toBe("c");
    expect(stored[2].giftWrapEventId).toBe("a");
  });

  // ------------------------------------------------------------------ //
  // 9. DOM event fires AFTER IDB write (ordering invariant)             //
  // ------------------------------------------------------------------ //
  it("dispatches the DOM event after the IDB write so listeners see the new record", async () => {
    const keysAtEventTime: string[] = [];

    windowShim.addEventListener("notestr:failed-welcomes-changed", () => {
      storeRef.current.keys().then((keys) => {
        keysAtEventTime.push(...keys);
      });
    });

    await appendFailedWelcome(makeRecord({ giftWrapEventId: "ordering-test" }));
    // Drain the microtask queue.
    await new Promise((r) => setTimeout(r, 0));

    expect(keysAtEventTime).toContain("ordering-test");
  });
});
