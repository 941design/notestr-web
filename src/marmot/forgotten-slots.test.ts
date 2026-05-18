/**
 * Unit tests for src/marmot/forgotten-slots.ts
 *
 * AC-STORE-1: store is created via createKVStore (mocked below; no raw idb-keyval).
 * AC-STORE-2: loadForgottenSlots uses .keys() not getAllKeys.
 * AC-STORE-3: markSlotForgotten dispatches the DOM event AFTER the write.
 * AC-STORE-4: both named exports exist with correct signatures.
 *
 * Testing approach:
 *   - vi.mock('./storage') replaces createKVStore with a factory that returns
 *     a proxy delegating to a swappable inner store.
 *   - vi.hoisted() initialises state before vi.mock hoisting runs.
 *   - Swapping `storeRef.current` in beforeEach replaces the effective store
 *     without breaking the reference that forgotten-slots.ts holds.
 *   - global.window is set to an EventTarget so dispatchEvent works in the
 *     vitest node environment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before vi.mock factories — variables initialised here can
// be safely closed over by the mock factory below.
const { storeRef, makeInMemoryStore } = vi.hoisted(() => {
  function makeInMemoryStore<T>() {
    const data = new Map<string, T>();
    return {
      async getItem(key: string): Promise<T | null> { return data.get(key) ?? null; },
      async setItem(key: string, value: T): Promise<T> { data.set(key, value); return value; },
      async removeItem(key: string): Promise<void> { data.delete(key); },
      async clear(): Promise<void> { data.clear(); },
      async keys(): Promise<string[]> { return Array.from(data.keys()); },
    };
  }

  const ref = { current: makeInMemoryStore<true>() };
  return { storeRef: ref, makeInMemoryStore };
});

vi.mock("./storage", () => {
  // The proxy always delegates to storeRef.current, so swapping storeRef.current
  // in beforeEach changes the effective store for the already-imported module.
  const proxy = {
    getItem: (key: string) => storeRef.current.getItem(key),
    setItem: (key: string, value: true) => storeRef.current.setItem(key, value),
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
import { loadForgottenSlots, markSlotForgotten } from "./forgotten-slots";

// Minimal window shim for the vitest node environment.
function makeWindowShim(): EventTarget {
  return new EventTarget();
}

describe("forgotten-slots", () => {
  let windowShim: EventTarget;

  beforeEach(() => {
    // Replace the inner store — the proxy picks this up immediately.
    storeRef.current = makeInMemoryStore<true>();

    // Refresh the window shim.
    windowShim = makeWindowShim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).window = windowShim;
  });

  // ------------------------------------------------------------------ //
  // Q-ROBUSTNESS-1: empty store returns empty Set                       //
  // ------------------------------------------------------------------ //
  it("loadForgottenSlots returns an empty Set when the store is empty", async () => {
    const result = await loadForgottenSlots();

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  // ------------------------------------------------------------------ //
  // AC-STORE-4 + round-trip (Q-TEST_COVERAGE-1)                        //
  // ------------------------------------------------------------------ //
  it("round-trip: markSlotForgotten writes; loadForgottenSlots returns a Set containing the slot", async () => {
    await markSlotForgotten("slot-abc");

    const result = await loadForgottenSlots();

    expect(result).toBeInstanceOf(Set);
    expect(result.has("slot-abc")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("stores multiple distinct slots independently", async () => {
    await markSlotForgotten("slot-1");
    await markSlotForgotten("slot-2");

    const result = await loadForgottenSlots();

    expect(result.has("slot-1")).toBe(true);
    expect(result.has("slot-2")).toBe(true);
    expect(result.size).toBe(2);
  });

  // ------------------------------------------------------------------ //
  // AC-STORE-3: DOM event dispatch (Q-SPEC-3, Q-TEST_COVERAGE-1)       //
  // ------------------------------------------------------------------ //
  it("markSlotForgotten dispatches notestr:forgotten-slots-changed on window", async () => {
    const receivedEvents: Event[] = [];
    windowShim.addEventListener("notestr:forgotten-slots-changed", (e) => {
      receivedEvents.push(e);
    });

    await markSlotForgotten("slot-event-test");

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe("notestr:forgotten-slots-changed");
    expect(receivedEvents[0]).toBeInstanceOf(CustomEvent);
  });

  // Q-SPEC-3: event fires AFTER the IDB write so consumers can read the new slot.
  it("dispatches the DOM event after the IDB write so listeners see the new slot", async () => {
    const storeKeysAtEventTime: string[] = [];

    windowShim.addEventListener("notestr:forgotten-slots-changed", () => {
      // Synchronous listener body: setItem has already resolved because
      // markSlotForgotten awaits it before calling dispatchEvent.
      // keys() is async so we schedule a microtask and drain below.
      storeRef.current.keys().then((keys) => {
        storeKeysAtEventTime.push(...keys);
      });
    });

    await markSlotForgotten("slot-ordering");

    // Drain the microtask queue so the .then() above has run.
    await new Promise((r) => setTimeout(r, 0));

    expect(storeKeysAtEventTime).toContain("slot-ordering");
  });

  // ------------------------------------------------------------------ //
  // Q-ROBUSTNESS-2: idempotency                                         //
  // ------------------------------------------------------------------ //
  it("markSlotForgotten is idempotent — same slot twice yields a Set of size 1", async () => {
    await markSlotForgotten("slot-dup");
    await markSlotForgotten("slot-dup");

    const result = await loadForgottenSlots();

    expect(result.has("slot-dup")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("markSlotForgotten dispatches the event on each call even when idempotent", async () => {
    let eventCount = 0;
    windowShim.addEventListener("notestr:forgotten-slots-changed", () => {
      eventCount += 1;
    });

    await markSlotForgotten("slot-dup2");
    await markSlotForgotten("slot-dup2");

    expect(eventCount).toBe(2);
  });
});
