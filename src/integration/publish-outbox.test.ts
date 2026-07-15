/**
 * publish-outbox.test.ts
 *
 * S10 (Phase 6, event-sourced-receive-engine epic) — AC-PUB-1 coverage plus
 * this story's pre-impl verification commitments (VQ-S10-001/002/005/006;
 * see specs/epic-event-sourced-receive-engine/S10-publish-outbox-reconciliation/
 * verification.json).
 *
 * Follows the REAL-IDB idiom established by raw-event-log-store.test.ts /
 * storage.test.ts: a fresh `IDBFactory` (fake-indexeddb) plus
 * `vi.resetModules()` per test gives idb-keyval, storage.ts, and
 * marmot-adapter.ts's module-level outbox-bridge state a clean slate, and
 * `bindStores(pubkey)` must be called before any store I/O. "Restart" in
 * the AC-PUB-1 tests below is simulated the same way: `vi.resetModules()` +
 * fresh dynamic re-imports, with the SAME fake IndexedDB left in place (the
 * durable store survives; every in-memory module singleton does not) — this
 * is what makes a restart-durability claim meaningful rather than vacuous.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import { outboxKey, type NostrEvent, type OutboxEntry } from "../engine/engine-types";
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
// Fixture builders
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
 * A `sendApplicationRumor` stand-in that mirrors what marmot-ts really does
 * internally: it calls `network.publish(relays, kind445Event)` with a FRESH
 * relay event id, distinct on every invocation (the real marmot-ts
 * `sendApplicationRumor` never returns that id to its caller — the GAP this
 * story's outbox bridge exists to work around).
 */
function makeSendApplicationRumor(
  network: FakeNetwork,
  hTag: string,
  opts: { extraInterleavedKind445?: boolean; throwOnce?: boolean } = {},
) {
  let thrown = false;
  return async (rumor: Rumor): Promise<unknown> => {
    if (opts.extraInterleavedKind445) {
      // Simulate an auto-invite/per-leaf-remove commit publishing a SECOND
      // kind-445 on the same hTag inside our own publish window.
      await network.publish(RELAYS, {
        id: nextKind445Id(),
        pubkey: "commit-author",
        created_at: rumor.created_at,
        kind: 445,
        tags: [["h", hTag]],
        content: "commit-ciphertext",
        sig: "sig",
      });
    }
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
// VQ-S10-001: OutboxEntry.status gets REAL transitions, not set-once
// ---------------------------------------------------------------------------

describe("OutboxEntry status: real transitions driven by actual send/receive events", () => {
  it("advances pending -> sent on a successful send, then sent -> reconciled on own-echo -- never set once at creation", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    expect(entry.status).toBe("sent");
    expect(entry.sentEventId).not.toBeNull();
    expect(entry.ownEchoObservedAt).toBeNull();

    const reconciled = adapterMod.reconcileOwnEcho(
      { id: entry.sentEventId as string, groupId: GROUP_ID },
      1_700_000_005_000,
    );

    expect(reconciled).not.toBeNull();
    expect(reconciled?.status).toBe("reconciled");
    expect(reconciled?.ownEchoObservedAt).toBe(1_700_000_005_000);
    // S10-1: a reconciled entry is PRUNED (its purpose is served) -- the
    // returned snapshot above still reflects "reconciled" (same object
    // reference, mutated before removal), but a fresh lookup finds nothing.
    expect(outbox.getEntry(entry.rumorId)).toBeUndefined();
  });

  it("advances pending -> failed on a send throw, with lastError populated and the failure event dispatched", async () => {
    const network = createFakeNetwork();
    const { deps, failures } = createDeps(network, {
      sendApplicationRumor: makeSendApplicationRumor(network, H_TAG, { throwOnce: true }),
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());

    expect(entry.status).toBe("failed");
    expect(entry.lastError).toContain("relay rejected publish");
    expect(entry.sentEventId).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain("relay rejected publish");
  });

  it("reconciling a fact whose id does not match any tracked sentEventId is a no-op", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    const result = adapterMod.reconcileOwnEcho(
      { id: "some-unrelated-relay-event-id", groupId: GROUP_ID },
      1_700_000_005_000,
    );

    expect(result).toBeNull();
    expect(outbox.getEntry(entry.rumorId)?.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// VQ-S10-005 / Boundary Rule 7: createdAt/rumorId immutable across retries
// ---------------------------------------------------------------------------

describe("createdAt/rumorId immutability across retries", () => {
  it("retry() reuses the SAME createdAt and rumorId as the original publish() (byte-identical), only attempts/status change", async () => {
    const network = createFakeNetwork();
    let shouldThrow = true;
    const { deps } = createDeps(network, {
      sendApplicationRumor: async (rumor: Rumor) => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("transient network failure");
        }
        await network.publish(RELAYS, {
          id: nextKind445Id(),
          pubkey: rumor.pubkey,
          created_at: rumor.created_at,
          kind: 445,
          tags: [["h", H_TAG]],
          content: "ciphertext",
          sig: "sig",
        });
        return {};
      },
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const first = await outbox.publish(taskCreatedEvent());
    expect(first.status).toBe("failed");
    expect(first.attempts).toBe(1);

    const retried = await outbox.retry(first.rumorId);
    expect(retried.status).toBe("sent");
    expect(retried.attempts).toBe(2);

    // The load-bearing assertion: createdAt and rumorId are BYTE-IDENTICAL
    // across the failed attempt and the successful retry.
    expect(retried.createdAt).toBe(first.createdAt);
    expect(retried.rumorId).toBe(first.rumorId);
    expect(retried.taskEvent).toEqual(first.taskEvent);
  });

  it("retry() throws for an rumorId no entry is tracked for", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    await expect(outbox.retry("never-published")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VQ-S10-006 (SECURITY): own-echo must not misclassify a same-content event
// from a DIFFERENT device/pubkey as reconciled
// ---------------------------------------------------------------------------

describe("own-echo reconciliation security: distinguishes genuine own-echo from a same-content foreign publish", () => {
  it("a same-content event authored on a different device (different kind-445 event id) does NOT reconcile our entry", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    // Device A publishes.
    const entryA = await outbox.publish(taskCreatedEvent({ updatedByDevice: "device-A" }));
    expect(entryA.status).toBe("sent");
    expect(entryA.sentEventId).not.toBeNull();

    // Device B independently publishes IDENTICAL task content but with a
    // DIFFERENT updatedByDevice -- different rumor content -> different MLS
    // ciphertext -> a DIFFERENT content-addressed kind-445 event id. This
    // models the collision scenario VQ-S10-006 is concerned with: same
    // logical mutation, different device, arriving as a foreign relay event
    // (never registered as one of OUR OutboxEntry.sentEventId values).
    const foreignEventId = "kind445-from-device-B";
    expect(foreignEventId).not.toBe(entryA.sentEventId);

    const result = adapterMod.reconcileOwnEcho(
      { id: foreignEventId, groupId: GROUP_ID },
      1_700_000_005_000,
    );

    expect(result).toBeNull();
    expect(outbox.getEntry(entryA.rumorId)?.status).toBe("sent");
    expect(outbox.getEntry(entryA.rumorId)?.ownEchoObservedAt).toBeNull();
  });

  it("matching is scoped by groupId as well as by exact event id (defense in depth)", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    const sentEventId = entry.sentEventId as string;

    // Same event id, but a fact reporting a DIFFERENT groupId must not match.
    const result = adapterMod.reconcileOwnEcho(
      { id: sentEventId, groupId: "some-other-group" },
      1_700_000_005_000,
    );

    expect(result).toBeNull();
    expect(outbox.getEntry(entry.rumorId)?.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// AC-PUB-1: convergence regardless of own-echo timing relative to a restart
// ---------------------------------------------------------------------------

describe("AC-PUB-1: optimistic local publish reconciles to the same durable state whether own-echo is observed before or after a restart", () => {
  it("(a) own-echo observed BEFORE restart: reconciled status survives the restart unchanged", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    const reconciled = adapterMod.reconcileOwnEcho(
      { id: entry.sentEventId as string, groupId: GROUP_ID },
      1_700_000_005_000,
    );
    expect(reconciled?.status).toBe("reconciled");

    // --- restart: fresh modules, SAME fake IndexedDB ---
    vi.resetModules();
    storage = await import("../marmot/storage");
    adapterMod = await import("./marmot-adapter");
    publishOutboxMod = await import("./publish-outbox");
    storage.bindStores(PUBKEY);

    const network2 = createFakeNetwork();
    const { deps: deps2 } = createDeps(network2);
    const restarted = publishOutboxMod.createPublishOutbox(deps2);
    const persisted = await restarted.loadPersisted();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("reconciled");
    expect(persisted[0]?.createdAt).toBe(entry.createdAt);
    expect(persisted[0]?.rumorId).toBe(entry.rumorId);
  });

  it("(b) own-echo observed AFTER restart: the rehydrated entry still reconciles, converging to the SAME final status as (a)", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    expect(entry.status).toBe("sent"); // own-echo NOT yet observed

    // --- restart: fresh modules, SAME fake IndexedDB, BEFORE reconciling ---
    vi.resetModules();
    storage = await import("../marmot/storage");
    adapterMod = await import("./marmot-adapter");
    publishOutboxMod = await import("./publish-outbox");
    storage.bindStores(PUBKEY);

    const network2 = createFakeNetwork();
    const { deps: deps2 } = createDeps(network2);
    const restarted = publishOutboxMod.createPublishOutbox(deps2);
    const persistedBeforeEcho = await restarted.loadPersisted();
    expect(persistedBeforeEcho[0]?.status).toBe("sent");

    // Own-echo arrives AFTER the restart, against the REHYDRATED registry.
    const reconciledAfterRestart = adapterMod.reconcileOwnEcho(
      { id: entry.sentEventId as string, groupId: GROUP_ID },
      1_700_000_009_000,
    );
    expect(reconciledAfterRestart?.status).toBe("reconciled");

    const finalPersisted = (await storage
      .createKVStore<OutboxEntry[]>("outbox")
      .getItem(outboxKey(GROUP_ID))) as OutboxEntry[] | null;

    // Converges to the SAME final status/createdAt/rumorId as scenario (a).
    expect(finalPersisted).toHaveLength(1);
    expect(finalPersisted?.[0]?.status).toBe("reconciled");
    expect(finalPersisted?.[0]?.createdAt).toBe(entry.createdAt);
    expect(finalPersisted?.[0]?.rumorId).toBe(entry.rumorId);
  });

  it("(a) and (b) converge to byte-identical createdAt/rumorId and the same final status, even though own-echo timing relative to restart differs", async () => {
    async function runScenario(reconcileBeforeRestart: boolean): Promise<OutboxEntry> {
      (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      vi.resetModules();
      let s = await import("../marmot/storage");
      let a = await import("./marmot-adapter");
      let p = await import("./publish-outbox");
      s.bindStores(PUBKEY);

      const network = createFakeNetwork();
      const { deps } = createDeps(network);
      const outbox = p.createPublishOutbox(deps);
      const entry = await outbox.publish(taskCreatedEvent());

      if (reconcileBeforeRestart) {
        a.reconcileOwnEcho({ id: entry.sentEventId as string, groupId: GROUP_ID }, 1_700_000_005_000);
      }

      // restart
      vi.resetModules();
      s = await import("../marmot/storage");
      a = await import("./marmot-adapter");
      p = await import("./publish-outbox");
      s.bindStores(PUBKEY);

      const network2 = createFakeNetwork();
      const { deps: deps2 } = createDeps(network2);
      const restarted = p.createPublishOutbox(deps2);
      await restarted.loadPersisted();

      if (!reconcileBeforeRestart) {
        a.reconcileOwnEcho({ id: entry.sentEventId as string, groupId: GROUP_ID }, 1_700_000_009_000);
      }

      const stored = (await s
        .createKVStore<OutboxEntry[]>("outbox")
        .getItem(outboxKey(GROUP_ID))) as OutboxEntry[] | null;
      return stored?.[0] as OutboxEntry;
    }

    const branchA = await runScenario(true);
    const branchB = await runScenario(false);

    expect(branchA.status).toBe("reconciled");
    expect(branchB.status).toBe("reconciled");
    expect(branchA.createdAt).toBe(branchB.createdAt);
    expect(branchA.rumorId).toBe(branchB.rumorId);
    expect(branchA.status).toBe(branchB.status);
  });
});

// ---------------------------------------------------------------------------
// Degraded case: an ambiguous publish window still advances out of "pending"
// ---------------------------------------------------------------------------

describe("ambiguous publish window (interleaved commit) degrades gracefully", () => {
  it("a send that observes 2 kind-445s in its window still reports status \"sent\" (via the fallback), with sentEventId left null", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network, {
      sendApplicationRumor: makeSendApplicationRumor(network, H_TAG, {
        extraInterleavedKind445: true,
      }),
    });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());

    expect(entry.status).toBe("sent");
    expect(entry.sentEventId).toBeNull();

    // Own-echo can never fire for this entry (no attributed id) -- a
    // documented degraded case, not a correctness bug.
    const result = adapterMod.reconcileOwnEcho(
      { id: "any-id", groupId: GROUP_ID },
      1_700_000_005_000,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wiring proof: MarmotIngestAdapter.doIngestBatch really calls
// reconcileOwnEcho on a skipped result, not just the exported function
// tested in isolation above.
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter wiring: a real skipped IngestResult reconciles a tracked OutboxEntry", () => {
  it("group.ingest() yielding a skipped result whose event id matches our sentEventId reconciles via the real ingest path", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);
    const entry = await outbox.publish(taskCreatedEvent());
    const sentEventId = entry.sentEventId as string;

    const skippedEvent: NostrEvent = {
      id: sentEventId,
      pubkey: PUBKEY,
      created_at: 1_700_000_000,
      kind: 445,
      tags: [["h", H_TAG]],
      content: "ciphertext",
      sig: "sig",
    };

    const stubGroup = {
      state: { groupContext: { epoch: 0n } },
      async *ingest(events: NostrEvent[]) {
        for (const event of events) {
          yield { kind: "skipped" as const, event, message: undefined, reason: "self-echo" };
        }
      },
    };
    const stubClient = {
      network: {
        request: async () => [skippedEvent],
        subscription: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
      },
    };

    const adapter = adapterMod.createMarmotIngestAdapter({
      group: stubGroup as unknown as Parameters<MarmotAdapterModule["createMarmotIngestAdapter"]>[0]["group"],
      client: stubClient as unknown as Parameters<MarmotAdapterModule["createMarmotIngestAdapter"]>[0]["client"],
      groupId: GROUP_ID,
      relays: RELAYS,
      signer: {},
      ownPubkey: PUBKEY,
      getNostrGroupIdHex: () => H_TAG,
      getGroupMembers: () => [PUBKEY],
      now: () => 1_700_000_005_000,
    });

    const signals = [];
    for await (const signal of adapter.catchUp()) {
      signals.push(signal);
    }

    expect(signals).toHaveLength(1);
    expect(signals[0]?.type).toBe("skipped");
    // S10-1: reconciliation via the real ingest path prunes the entry too --
    // see the equivalent assertion in the isolated reconcileOwnEcho test
    // above.
    expect(outbox.getEntry(entry.rumorId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// S10-1: unbounded outbox growth (Stage-1 review, sev-5 BLOCKER)
// ---------------------------------------------------------------------------

describe("S10-1: outbox growth is bounded in every flag configuration", () => {
  it("own-echo reconciliation prunes the entry from the IN-MEMORY registry immediately, while the durable record survives (AC-PUB-1 is preserved -- see marmot-adapter.ts's enforceOutboxCap design note)", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    expect(entry.status).toBe("sent");

    const reconciled = adapterMod.reconcileOwnEcho(
      { id: entry.sentEventId as string, groupId: GROUP_ID },
      1_700_000_005_000,
    );
    expect(reconciled?.status).toBe("reconciled");

    // In-memory: pruned immediately -- reconciliation is idempotent/terminal,
    // so nothing further ever needs to find this entry via getEntry.
    expect(outbox.getEntry(entry.rumorId)).toBeUndefined();

    // Durable: intact, with status "reconciled" -- this is AC-PUB-1's
    // contract (a reconciled-before-restart entry must still read back as
    // "reconciled" via loadPersisted()). Verified via a fresh "restart" read
    // (same idiom as the AC-PUB-1 tests above), which forces the
    // fire-and-forget durable write to have flushed.
    vi.resetModules();
    storage = await import("../marmot/storage");
    adapterMod = await import("./marmot-adapter");
    publishOutboxMod = await import("./publish-outbox");
    storage.bindStores(PUBKEY);

    const network2 = createFakeNetwork();
    const { deps: deps2 } = createDeps(network2);
    const restarted = publishOutboxMod.createPublishOutbox(deps2);
    const persisted = await restarted.loadPersisted();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("reconciled");
    expect(persisted[0]?.rumorId).toBe(entry.rumorId);
  });

  it("the durable outbox never exceeds the per-group cap under many mutations (evict-eldest by createdAt)", async () => {
    const network = createFakeNetwork();
    const cap = adapterMod.MAX_OUTBOX_ENTRIES_PER_GROUP;
    const total = cap + 20;

    let clock = 1_700_000_000_000;
    const { deps } = createDeps(network, { now: () => clock });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    for (let i = 0; i < total; i++) {
      clock += 1_000;
      await outbox.publish(taskCreatedEvent({ id: `task-${i}` }));
    }

    vi.resetModules();
    storage = await import("../marmot/storage");
    adapterMod = await import("./marmot-adapter");
    publishOutboxMod = await import("./publish-outbox");
    storage.bindStores(PUBKEY);

    const network2 = createFakeNetwork();
    const { deps: deps2 } = createDeps(network2);
    const restarted = publishOutboxMod.createPublishOutbox(deps2);
    const persisted = await restarted.loadPersisted();

    expect(persisted.length).toBeLessThanOrEqual(cap);
    // Evict-eldest: the survivors are the MOST RECENT `cap` entries by
    // createdAt (the oldest `total - cap` were dropped).
    const createdAts = persisted.map((e) => e.createdAt).sort((a, b) => a - b);
    const expectedOldestSurviving = 1_700_000_000_000 + (total - cap + 1) * 1_000;
    expect(createdAts[0]).toBeGreaterThanOrEqual(expectedOldestSurviving);
  });

  it("stays bounded even when reconcileOwnEcho never runs (own-echo permanently unobserved)", async () => {
    const network = createFakeNetwork();
    const cap = adapterMod.MAX_OUTBOX_ENTRIES_PER_GROUP;
    const total = cap + 20;

    let clock = 1_700_000_000_000;
    const { deps } = createDeps(network, { now: () => clock });
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    for (let i = 0; i < total; i++) {
      clock += 1_000;
      await outbox.publish(taskCreatedEvent({ id: `task-${i}` }));
    }
    // Deliberately never call reconcileOwnEcho -- mirrors an entry whose
    // own-echo is permanently lost (relay partition, group departure before
    // it arrives, etc.), so MarmotIngestAdapter.doIngestBatch (the only
    // reconcileOwnEcho call site) never fires for it.

    vi.resetModules();
    storage = await import("../marmot/storage");
    adapterMod = await import("./marmot-adapter");
    publishOutboxMod = await import("./publish-outbox");
    storage.bindStores(PUBKEY);

    const network2 = createFakeNetwork();
    const { deps: deps2 } = createDeps(network2);
    const restarted = publishOutboxMod.createPublishOutbox(deps2);
    const persisted = await restarted.loadPersisted();

    expect(persisted.length).toBeLessThanOrEqual(cap);
  });
});

// ---------------------------------------------------------------------------
// S10-2: in-memory outbox registry has no per-identity reset (Stage-1
// review, sev-3)
// ---------------------------------------------------------------------------

describe("S10-2: in-memory outbox registry does not retain a prior identity's entries across an identity switch", () => {
  it("resetOutboxEntriesForIdentityChange() clears the in-memory registry without touching the durable store", async () => {
    const network = createFakeNetwork();
    const { deps } = createDeps(network);
    const outbox = publishOutboxMod.createPublishOutbox(deps);

    const entry = await outbox.publish(taskCreatedEvent());
    expect(adapterMod.getOutboxEntry(entry.rumorId)).toBeDefined();

    adapterMod.resetOutboxEntriesForIdentityChange();

    expect(adapterMod.getOutboxEntry(entry.rumorId)).toBeUndefined();
    expect(outbox.getEntry(entry.rumorId)).toBeUndefined();

    // The durable store (a DIFFERENT identity's data lives in a DIFFERENT
    // IDB partition entirely -- src/marmot/storage.ts's per-pubkey
    // isolation -- so this reset only needs to address the process-global
    // in-memory Map) is untouched: a fresh loadPersisted() still finds it.
    const persisted = await outbox.loadPersisted();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.rumorId).toBe(entry.rumorId);
  });
});
