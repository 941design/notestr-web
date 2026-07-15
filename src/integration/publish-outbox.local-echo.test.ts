/**
 * publish-outbox.local-echo.test.ts
 *
 * S11B (event-sourced-receive-engine epic) — coverage for
 * `PublishOutboxDeps.onLocalAccept` / `onPendingCleared`, the two OPTIONAL
 * hooks that let the engine boundary observe a locally-initiated publish's
 * optimistic accept (AC-OPT-1/5) and its later terminal outcome -- own-echo
 * reconciled, a permanent send failure, or 256-cap eviction (AC-OPT-4,
 * broadened by S11B-Fable-1). See `publish-outbox.ts`'s doc comments on both
 * fields for the full contract; this suite only asserts the wiring, not the
 * engine's own dedupe behavior.
 *
 * Follows the REAL-IDB idiom established by publish-outbox.test.ts: a fresh
 * `IDBFactory` (fake-indexeddb) plus `vi.resetModules()` per test gives
 * idb-keyval, storage.ts, and marmot-adapter.ts's module-level outbox-bridge
 * state a clean slate, and `bindStores(pubkey)` must be called before any
 * store I/O.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import type { NostrEvent } from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

type PublishOutboxModule = typeof import("./publish-outbox");
type MarmotAdapterModule = typeof import("./marmot-adapter");
type StorageModule = typeof import("../marmot/storage");

let publishOutboxMod: PublishOutboxModule;
let adapterMod: MarmotAdapterModule;
let storage: StorageModule;

const PUBKEY = "a".repeat(64);
const GROUP_ID = "group-1";
const H_TAG = "htag-1";
const RELAYS = ["wss://relay.example"];

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.resetModules();
  storage = await import("../marmot/storage");
  adapterMod = await import("./marmot-adapter");
  publishOutboxMod = await import("./publish-outbox");
  storage.bindStores(PUBKEY);
});

// ---------------------------------------------------------------------------
// Fixture builders (mirrors publish-outbox.test.ts)
// ---------------------------------------------------------------------------

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Title",
    description: overrides.description ?? "",
    status: overrides.status ?? "open",
    assignee: overrides.assignee ?? null,
    createdBy: overrides.createdBy ?? PUBKEY,
    createdAt: overrides.createdAt ?? 1_700_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000,
    updatedBy: overrides.updatedBy ?? PUBKEY,
    updatedByDevice: overrides.updatedByDevice ?? "device-A",
  };
}

function taskCreatedEvent(overrides: Partial<Task> = {}): TaskEvent {
  return { type: "task.created", task: task(overrides) };
}

interface FakeNetwork {
  publish: (relays: string[], event: NostrEvent) => Promise<unknown>;
  publishedEvents: NostrEvent[];
}

function createFakeNetwork(): FakeNetwork {
  const publishedEvents: NostrEvent[] = [];
  return {
    publishedEvents,
    async publish(_relays: string[], event: NostrEvent) {
      publishedEvents.push(event);
      return { "relay-1": { from: "relay-1", ok: true } };
    },
  };
}

let kind445Counter = 0;
function nextKind445Id(): string {
  kind445Counter += 1;
  return `kind445-${kind445Counter}`;
}

/**
 * A `sendApplicationRumor` stand-in mirroring publish-outbox.test.ts's own
 * (see that file's doc comment for why this shape matters): a fresh relay
 * event id on every invocation, with an optional one-shot throw for
 * exercising the retry path.
 */
function makeSendApplicationRumor(
  network: FakeNetwork,
  hTag: string,
  opts: { throwOnce?: boolean } = {},
) {
  let thrown = false;
  return async (rumor: Rumor): Promise<unknown> => {
    if (opts.throwOnce && !thrown) {
      thrown = true;
      throw new Error("relay rejected publish");
    }
    await network.publish(RELAYS, {
      id: nextKind445Id(),
      pubkey: rumor.pubkey,
      created_at: rumor.created_at,
      kind: 445,
      tags: [["h", hTag]],
      content: "ciphertext",
      sig: "sig",
    });
    return { "relay-1": { from: "relay-1", ok: true } };
  };
}

function createDeps(
  network: FakeNetwork,
  overrides: Partial<Parameters<PublishOutboxModule["createPublishOutbox"]>[0]> = {},
) {
  const failures: Array<{ groupId: string; taskEvent: TaskEvent; error: string }> = [];
  return {
    deps: {
      groupId: GROUP_ID,
      pubkey: PUBKEY,
      sendApplicationRumor: makeSendApplicationRumor(network, H_TAG),
      nostrGroupIdHex: () => H_TAG,
      network,
      dispatchFailureEvent: (detail: { groupId: string; taskEvent: TaskEvent; error: string }) => {
        failures.push(detail);
      },
      now: () => 1_700_000_000_000,
      ...overrides,
    },
    failures,
  };
}

// ---------------------------------------------------------------------------
// AC-OPT-1/5: onLocalAccept fires with the exact rumorId, before any send
// ---------------------------------------------------------------------------

describe("onLocalAccept: fires before send, with the OutboxEntry's exact rumorId", () => {
  it("is called exactly once with (rumorId, taskEvent), and BEFORE sendApplicationRumor", async () => {
    const network = createFakeNetwork();
    const order: string[] = [];
    const acceptCalls: Array<{ rumorId: string; taskEvent: TaskEvent }> = [];
    const taskEvent = taskCreatedEvent();
    const baseSend = makeSendApplicationRumor(network, H_TAG);
    const { deps } = createDeps(network, {
      sendApplicationRumor: async (rumor: Rumor) => {
        order.push("send");
        return baseSend(rumor);
      },
      onLocalAccept: (rumorId, te) => {
        order.push("onLocalAccept");
        acceptCalls.push({ rumorId, taskEvent: te });
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskEvent);

    expect(acceptCalls).toHaveLength(1);
    expect(acceptCalls[0]?.rumorId).toBe(entry.rumorId);
    expect(acceptCalls[0]?.taskEvent).toEqual(taskEvent);
    expect(order).toEqual(["onLocalAccept", "send"]);
  });

  it("is awaited -- publish() does not proceed to send until the returned promise settles", async () => {
    const network = createFakeNetwork();
    let releaseAccept!: () => void;
    const acceptGate = new Promise<void>((resolve) => {
      releaseAccept = resolve;
    });
    let sendCalled = false;
    const baseSend = makeSendApplicationRumor(network, H_TAG);
    const { deps } = createDeps(network, {
      sendApplicationRumor: async (rumor: Rumor) => {
        sendCalled = true;
        return baseSend(rumor);
      },
      onLocalAccept: async () => {
        await acceptGate;
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const publishPromise = outbox.publish(taskCreatedEvent());

    // Flush pending microtasks without resolving the gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCalled).toBe(false);

    releaseAccept();
    const entry = await publishPromise;

    expect(sendCalled).toBe(true);
    expect(entry.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// onLocalAccept failure never breaks publish() (internal try/catch swallow)
// ---------------------------------------------------------------------------

describe("onLocalAccept failure: never breaks publish()", () => {
  it("publish() still resolves normally when onLocalAccept throws synchronously", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network, {
      onLocalAccept: () => {
        throw new Error("onLocalAccept boom (sync)");
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());

    expect(entry.status).toBe("sent");
    expect(network.publishedEvents).toHaveLength(1);
  });

  it("publish() still resolves normally when onLocalAccept returns a rejected promise", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network, {
      onLocalAccept: async () => {
        throw new Error("onLocalAccept boom (async)");
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());

    expect(entry.status).toBe("sent");
    expect(network.publishedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onLocalAccept omitted: strictly additive, optional dependency
// ---------------------------------------------------------------------------

describe("onLocalAccept omitted: publish() behaves exactly as before", () => {
  it("publish() succeeds with no onLocalAccept in deps", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    expect(deps.onLocalAccept).toBeUndefined();
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());

    expect(entry.status).toBe("sent");
    expect(network.publishedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// retry() also calls onLocalAccept
// ---------------------------------------------------------------------------

describe("retry(): also calls onLocalAccept with the same rumorId/taskEvent", () => {
  it("calls onLocalAccept twice total, both times with the identical (rumorId, taskEvent) pair", async () => {
    const network = createFakeNetwork();
    const acceptCalls: Array<{ rumorId: string; taskEvent: TaskEvent }> = [];
    const taskEvent = taskCreatedEvent();
    const { deps } = createDeps(network, {
      sendApplicationRumor: makeSendApplicationRumor(network, H_TAG, { throwOnce: true }),
      onLocalAccept: (rumorId, te) => {
        acceptCalls.push({ rumorId, taskEvent: te });
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const first = await outbox.publish(taskEvent);
    expect(first.status).toBe("failed");

    const retried = await outbox.retry(first.rumorId);
    expect(retried.status).toBe("sent");
    expect(retried.rumorId).toBe(first.rumorId);

    expect(acceptCalls).toHaveLength(2);
    expect(acceptCalls[0]?.rumorId).toBe(first.rumorId);
    expect(acceptCalls[1]?.rumorId).toBe(first.rumorId);
    expect(acceptCalls[0]?.taskEvent).toEqual(taskEvent);
    expect(acceptCalls[1]?.taskEvent).toEqual(taskEvent);
  });
});

// ---------------------------------------------------------------------------
// AC-OPT-4 (c): onPendingCleared fires exactly on the "reconciled" transition
// ---------------------------------------------------------------------------

describe('onPendingCleared: fires exactly when the entry transitions to "reconciled"', () => {
  it("is not called for the earlier pending->sent transitions, then called once with the rumorId on reconciliation", async () => {
    const network = createFakeNetwork();
    const clearedCalls: string[] = [];
    const { deps } = createDeps(network, {
      onPendingCleared: (rumorId) => {
        clearedCalls.push(rumorId);
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    expect(entry.status).toBe("sent");
    expect(clearedCalls).toHaveLength(0);

    const reconciled = adapterMod.reconcileOwnEcho(
      { id: entry.sentEventId as string, groupId: GROUP_ID },
      1_700_000_005_000,
    );

    expect(reconciled?.status).toBe("reconciled");
    expect(clearedCalls).toEqual([entry.rumorId]);
  });
});

// ---------------------------------------------------------------------------
// S11B-Fable-1 (a): onPendingCleared also fires on a terminal send failure
// (status "failed", not auto-retried) -- the failure CustomEvent still fires
// too, since onPendingCleared carries no success/failure judgment.
// ---------------------------------------------------------------------------

describe('onPendingCleared: fires when the entry transitions to "failed" (S11B-Fable-1)', () => {
  it("clears the pending rumorId on a permanent send failure, and dispatchFailureEvent still fires", async () => {
    const network = createFakeNetwork();
    const clearedCalls: string[] = [];
    const { deps, failures } = createDeps(network, {
      sendApplicationRumor: makeSendApplicationRumor(network, H_TAG, { throwOnce: true }),
      onPendingCleared: (rumorId) => {
        clearedCalls.push(rumorId);
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());

    expect(entry.status).toBe("failed");
    expect(clearedCalls).toEqual([entry.rumorId]);
    // The pre-existing failure-observability contract is untouched --
    // onPendingCleared is an ADDITIONAL signal, not a replacement.
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBe("relay rejected publish");
  });

  it("does NOT fire a second time on a later successful retry of the same rumorId (only the failed transition cleared it)", async () => {
    const network = createFakeNetwork();
    const clearedCalls: string[] = [];
    const { deps } = createDeps(network, {
      sendApplicationRumor: makeSendApplicationRumor(network, H_TAG, { throwOnce: true }),
      onPendingCleared: (rumorId) => {
        clearedCalls.push(rumorId);
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const first = await outbox.publish(taskCreatedEvent());
    expect(first.status).toBe("failed");
    expect(clearedCalls).toEqual([first.rumorId]);

    const retried = await outbox.retry(first.rumorId);
    expect(retried.status).toBe("sent");
    // "sent" alone never clears -- only "reconciled"/"failed"/eviction do.
    expect(clearedCalls).toEqual([first.rumorId]);
  });
});

// ---------------------------------------------------------------------------
// S11B-Fable-1 (b): onPendingCleared fires when the 256-cap evicts an
// unreconciled entry from the in-memory registry (it can never reconcile
// afterward -- reconcileOwnEcho only matches tracked entries).
// ---------------------------------------------------------------------------

describe("onPendingCleared: fires when the 256-cap evicts an unreconciled entry (S11B-Fable-1)", () => {
  it("clears the pending rumorId for the evicted (oldest, still-unreconciled) entry once the group exceeds MAX_OUTBOX_ENTRIES_PER_GROUP", async () => {
    const network = createFakeNetwork();
    const cap = adapterMod.MAX_OUTBOX_ENTRIES_PER_GROUP;
    const clearedCalls: string[] = [];
    let clock = 1_700_000_000_000;
    const { deps } = createDeps(network, {
      now: () => clock,
      onPendingCleared: (rumorId) => {
        clearedCalls.push(rumorId);
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    // The FIRST entry published is the oldest by createdAt -- evict-eldest
    // means it is the one dropped once the group exceeds the cap.
    clock += 1_000;
    const oldest = await outbox.publish(taskCreatedEvent({ id: "task-oldest" }));
    expect(oldest.status).toBe("sent");
    expect(clearedCalls).toHaveLength(0);

    // Never reconciled -- publishing `cap` MORE entries pushes the group to
    // `cap + 1` tracked entries, tripping enforceOutboxCap's evict-eldest.
    for (let i = 0; i < cap; i++) {
      clock += 1_000;
      await outbox.publish(taskCreatedEvent({ id: `task-fill-${i}` }));
    }

    expect(outbox.getEntry(oldest.rumorId)).toBeUndefined();
    expect(clearedCalls).toEqual([oldest.rumorId]);
  });
});

// ---------------------------------------------------------------------------
// onPendingCleared omitted: no behavior change
// ---------------------------------------------------------------------------

describe("onPendingCleared omitted: reconciliation still proceeds normally", () => {
  it("status still ends up \"reconciled\" via getEntry, with no throw", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    expect(deps.onPendingCleared).toBeUndefined();
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    const reconciled = adapterMod.reconcileOwnEcho(
      { id: entry.sentEventId as string, groupId: GROUP_ID },
      1_700_000_005_000,
    );

    expect(reconciled?.status).toBe("reconciled");
    // S10-1: reconciliation prunes the in-memory entry -- see the equivalent
    // assertion in publish-outbox.test.ts.
    expect(outbox.getEntry(entry.rumorId)).toBeUndefined();
  });
});
