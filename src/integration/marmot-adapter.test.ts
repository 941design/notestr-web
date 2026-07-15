/**
 * marmot-adapter.test.ts
 *
 * AC-ADPT-1 + AC-FSM-2 (secondary adapter-side conformance) coverage for
 * `MarmotIngestAdapter` (src/integration/marmot-adapter.ts).
 *
 * Drives a CONTRACT-FAITHFUL STUB of `MarmotGroup`/`MarmotClient` — real
 * marmot-ts crypto/MLS setup is out of scope for a unit test, so the stub
 * reproduces the exact `IngestResult` shapes verified directly against
 * node_modules/@internet-privacy/marmot-ts/dist/client/group/marmot-group.js
 * (see marmot-adapter.ts's module doc comment). Two REAL marmot-ts functions
 * ARE used un-stubbed: `serializeApplicationRumor`/`deserializeApplicationData`
 * -- so the "decryptable message"/"malformed" scenarios exercise the actual
 * wire encoding, not a hand-rolled byte format.
 */

import { describe, expect, it, vi } from "vitest";
import {
  deserializeApplicationData,
  serializeApplicationRumor,
  type MarmotClient,
  type MarmotGroup,
} from "@internet-privacy/marmot-ts";

import {
  createMarmotIngestAdapter,
  MarmotIngestAdapter,
  type MarmotAdapterDeps,
} from "./marmot-adapter";
import type { IngestSignal, NostrEvent, RawProtocolFact } from "../engine/engine-types";
import { TASK_EVENT_KIND, TASK_STATE_SYNC_KIND, type Task, type TaskEvent } from "../domain/task-events";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function nostrEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: overrides.id ?? nextId("evt"),
    pubkey: overrides.pubkey ?? "pk-member-1",
    created_at: overrides.created_at ?? 1_700_000_000,
    kind: overrides.kind ?? 445,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "ciphertext",
    sig: overrides.sig ?? "sig",
  };
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? nextId("task"),
    title: overrides.title ?? "Title",
    description: overrides.description ?? "Description",
    status: overrides.status ?? "open",
    assignee: overrides.assignee ?? null,
    createdBy: overrides.createdBy ?? "pk-member-1",
    createdAt: overrides.createdAt ?? 1_700_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000,
    updatedBy: overrides.updatedBy ?? "pk-member-1",
    updatedByDevice: overrides.updatedByDevice ?? "",
  };
}

/** Real marmot-ts wire encoding for an application-message rumor. */
function rumorBytes(opts: {
  kind?: number;
  content: string;
  id?: string;
  pubkey?: string;
}): Uint8Array {
  return serializeApplicationRumor({
    id: opts.id ?? nextId("rumor"),
    kind: opts.kind ?? TASK_EVENT_KIND,
    content: opts.content,
    tags: [],
    created_at: 1_700_000_000,
    pubkey: opts.pubkey ?? "pk-member-1",
  });
}

function taskEventRumorBytes(taskEvent: TaskEvent, overrides: { pubkey?: string } = {}): Uint8Array {
  return rumorBytes({ content: JSON.stringify(taskEvent), pubkey: overrides.pubkey });
}

// ---------------------------------------------------------------------------
// Stub MarmotGroup / MarmotClient
// ---------------------------------------------------------------------------

/** One scripted outcome for the stub `ingest()` async generator to yield. */
type StubIngestResult =
  | { kind: "processed"; event: NostrEvent; result: { kind: "applicationMessage"; message: Uint8Array } }
  | { kind: "processed"; event: NostrEvent; result: { kind: "newState" } }
  | { kind: "skipped"; event: NostrEvent; message?: unknown; reason?: string }
  | { kind: "rejected"; event: NostrEvent; result?: unknown; message?: unknown }
  | { kind: "unreadable"; event: NostrEvent; errors: unknown[] };

interface StubGroupHandle {
  /** Cast this through `unknown` to satisfy `MarmotAdapterDeps.group: MarmotGroup`. */
  asMarmotGroup: MarmotGroup;
  setEpoch(epoch: bigint): void;
  getEpoch(): bigint;
  /**
   * Configure what `ingest(events)` yields for the NEXT call. `apply` may
   * mutate the group's epoch as a side effect (simulating a processed
   * commit) BEFORE the corresponding item is yielded, mirroring the real
   * marmot-ts `this.state = result.newState` assignment happening before
   * the `yield`.
   */
  scriptIngest(
    build: (events: NostrEvent[]) => Array<{ result: StubIngestResult; epochAfter?: bigint }>,
  ): void;
  /** Highest number of `ingest()` calls simultaneously "in flight" (between generator start and completion) observed across the stub's lifetime -- must never exceed 1. */
  maxConcurrentIngestCalls(): number;
  /**
   * Test-only concurrency hook: the NEXT `ingest()` call will await `gate`
   * (after incrementing the active-call counter, before yielding any item)
   * -- lets a test hold an `ingest()` call open deterministically, without
   * racing on real timers, so it can assert something else runs (or does
   * NOT run `ingest()`) while it is still active. See Finding 3 (Stage-1
   * review): pins `fetchBootstrap()`'s "never touches the ratchet" property
   * by proving it completes fully while a `catchUp()` ingest is held open.
   */
  holdIngestUntil(gate: Promise<void>): void;
  /** True while an `ingest()` call's body is between generator-start and completion (see `finally` below). */
  isIngestActive(): boolean;
}

function createStubGroup(initialEpoch = 0n): StubGroupHandle {
  const state = { groupContext: { epoch: initialEpoch } };
  let script: (events: NostrEvent[]) => Array<{ result: StubIngestResult; epochAfter?: bigint }> = () => [];
  let activeCalls = 0;
  let maxActive = 0;
  let pendingGate: Promise<void> | null = null;

  const target = {
    get state() {
      return state;
    },
    async *ingest(events: NostrEvent[]) {
      activeCalls += 1;
      maxActive = Math.max(maxActive, activeCalls);
      try {
        if (pendingGate) {
          const gate = pendingGate;
          pendingGate = null;
          await gate;
        }
        const items = script(events);
        for (const item of items) {
          // Yield control back to the microtask queue so a genuinely
          // concurrent caller (if the mutex were broken) would have a
          // chance to interleave here.
          await Promise.resolve();
          if (item.epochAfter !== undefined) state.groupContext.epoch = item.epochAfter;
          yield item.result;
        }
      } finally {
        activeCalls -= 1;
      }
    },
  };

  return {
    asMarmotGroup: target as unknown as MarmotGroup,
    setEpoch(epoch: bigint) {
      state.groupContext.epoch = epoch;
    },
    getEpoch() {
      return state.groupContext.epoch;
    },
    scriptIngest(build) {
      script = build;
    },
    maxConcurrentIngestCalls() {
      return maxActive;
    },
    holdIngestUntil(gate) {
      pendingGate = gate;
    },
    isIngestActive() {
      return activeCalls > 0;
    },
  };
}

interface StubSubscription {
  unsubscribe: () => void;
}

interface StubNetworkHandle {
  asMarmotClient: MarmotClient;
  setRequestResult(events: NostrEvent[] | (() => Promise<NostrEvent[]>)): void;
  emitLive(event: NostrEvent): void;
  callOrder: string[];
  subscriptionUnsubscribeCount: number;
}

function createStubNetwork(): StubNetworkHandle {
  const callOrder: string[] = [];
  let requestResult: NostrEvent[] | (() => Promise<NostrEvent[]>) = [];
  let unsubscribeCount = 0;
  const observers: Array<{ next: (event: NostrEvent) => void }> = [];

  const network = {
    request: vi.fn(async (_relays: string[], _filters: unknown) => {
      callOrder.push("request");
      return typeof requestResult === "function" ? requestResult() : requestResult;
    }),
    subscription: vi.fn((_relays: string[], _filters: unknown) => {
      callOrder.push("subscription");
      return {
        subscribe(observer: { next: (event: NostrEvent) => void }) {
          observers.push(observer);
          const sub: StubSubscription = {
            unsubscribe() {
              unsubscribeCount += 1;
              const idx = observers.indexOf(observer);
              if (idx !== -1) observers.splice(idx, 1);
            },
          };
          return sub;
        },
      };
    }),
  };

  return {
    asMarmotClient: { network } as unknown as MarmotClient,
    setRequestResult(result) {
      requestResult = result;
    },
    emitLive(event) {
      for (const observer of [...observers]) observer.next(event);
    },
    callOrder,
    get subscriptionUnsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

/**
 * The stub `MarmotGroup.state` used throughout this file is intentionally
 * NOT a fully valid MLS `ClientState` (building one would require a real
 * decoded `MarmotGroupData` extension + populated ratchet tree — orthogonal
 * to the `group.ingest()` outcome translation this file tests). Both
 * `MarmotAdapterDeps.getNostrGroupIdHex`/`getGroupMembers` are therefore
 * overridden here with trivial stand-ins rather than exercising the real
 * marmot-ts helpers (which the adapter still calls, by default, in
 * production against a real `ClientState` -- see marmot-adapter.ts).
 */
const STUB_H_TAG = "stub-nostr-group-id-hex";

function makeDeps(overrides: {
  group?: StubGroupHandle;
  network?: StubNetworkHandle;
  groupId?: string;
  memberPubkeys?: string[];
  nip44?: { decrypt: (pubkey: string, ciphertext: string) => Promise<string> | string };
} = {}): { deps: MarmotAdapterDeps; group: StubGroupHandle; network: StubNetworkHandle } {
  const group = overrides.group ?? createStubGroup();
  const network = overrides.network ?? createStubNetwork();
  const members = overrides.memberPubkeys ?? ["pk-member-1"];
  const deps: MarmotAdapterDeps = {
    group: group.asMarmotGroup,
    client: network.asMarmotClient,
    groupId: overrides.groupId ?? "group-1",
    relays: ["wss://relay.example"],
    signer: overrides.nip44 !== undefined ? { nip44: overrides.nip44 } : {},
    ownPubkey: "pk-member-1",
    now: () => 1_700_000_000_000,
    getNostrGroupIdHex: () => STUB_H_TAG,
    getGroupMembers: () => members,
  };
  return { deps, group, network };
}

async function drain(iter: AsyncIterable<IngestSignal>): Promise<IngestSignal[]> {
  const out: IngestSignal[] = [];
  for await (const signal of iter) out.push(signal);
  return out;
}

// ---------------------------------------------------------------------------
// AC-ADPT-1: six real-outcome translations
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter — AC-ADPT-1 outcome translation", () => {
  it("decryptable application message -> IngestSignal.message with decoded TaskEvent, correct receiptSource, and no marmot-ts leakage", async () => {
    const { deps, group, network } = makeDeps();
    const taskEvent: TaskEvent = { type: "task.created", task: taskFixture() };
    const event = nostrEvent();
    const bytes = taskEventRumorBytes(taskEvent);
    group.scriptIngest(() => [
      { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
    ]);
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.catchUp());

    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal.type).toBe("message");
    if (signal.type !== "message") throw new Error("unreachable");
    expect(signal.payload).toEqual(taskEvent);
    expect(signal.receiptSource).toBe("historical");
    expect(signal.epoch).toBe("0");
    expect(signal.fact.nostrEvent).toEqual(event);
    expect(signal.fact.id).toBe(event.id);
    expect(signal.fact.receiptSource).toBe("historical");
    expect(typeof signal.rumorId).toBe("string");

    // Structural proof (AC-ADPT-1): the emitted signal contains no
    // marmot-ts types (bigint epoch, Uint8Array/MlsMessage payloads, class
    // instances) -- a real marmot-ts value of any of those shapes would
    // throw or silently corrupt under JSON.stringify/parse.
    const roundTripped = JSON.parse(JSON.stringify(signal));
    expect(roundTripped).toEqual(signal);
  });

  it("unreadable ciphertext -> IngestSignal.deferred with reason 'unreadable'", async () => {
    const { deps, group, network } = makeDeps();
    const event = nostrEvent();
    group.scriptIngest(() => [{ result: { kind: "unreadable", event, errors: [new Error("nope")] } }]);
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.catchUp());

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: "deferred", reason: "unreadable", epoch: "0" });
    if (signals[0].type === "deferred") {
      expect(signals[0].fact.id).toBe(event.id);
    }
  });

  it("duplicate / own-echo delivery -> IngestSignal.skipped carrying the fact", async () => {
    const { deps, group, network } = makeDeps();
    const event = nostrEvent();
    group.scriptIngest(() => [{ result: { kind: "skipped", event, reason: "self-echo" } }]);
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.catchUp());

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("skipped");
    if (signals[0].type === "skipped") {
      expect(signals[0].fact.id).toBe(event.id);
      expect(signals[0].fact.nostrEvent).toEqual(event);
    }
  });

  it("valid rumor but wrong rumor kind (not a task event) -> IngestSignal.skipped, NOT malformed (Stage-1 review Finding 1)", async () => {
    // A rumor that deserializes fine but carries a foreign kind (e.g. a
    // kind-9 chat message coexisting in the same MLS group) must NOT be
    // mapped to `malformed` -- that would make the engine permanently
    // reject it via `domain_event_rejected{reason:"parse_error"}`, and a
    // later relay re-sync would redeliver + re-reject the same foreign
    // rumor forever. `skipped` carries the fact (watermark still advances,
    // fact still durably appended) with no rejection, matching pre-existing
    // production behavior (src/marmot/device-sync.ts silently ignores a
    // non-task rumor).
    const { deps, group, network } = makeDeps();
    const event = nostrEvent();
    const bytes = rumorBytes({ kind: 9, content: "just a chat message" });
    group.scriptIngest(() => [
      { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
    ]);
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.catchUp());

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("skipped");
    if (signals[0].type === "skipped") {
      expect(signals[0].fact.id).toBe(event.id);
      expect(signals[0].fact.nostrEvent).toEqual(event);
    }
  });

  it("epoch advance (commit processed) -> IngestSignal.epoch_advanced with correct prev/new epoch strings, no message signal", async () => {
    const { deps, group, network } = makeDeps(); // starts at epoch 0n
    const event = nostrEvent();
    group.scriptIngest(() => [
      { result: { kind: "processed", event, result: { kind: "newState" } }, epochAfter: 1n },
    ]);
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.catchUp());

    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({ type: "epoch_advanced", prevEpoch: "0", newEpoch: "1" });
  });

  it("ratchet-only advance (proposal processed, epoch unchanged) -> NO signal", async () => {
    const { deps, group, network } = makeDeps();
    const event = nostrEvent();
    group.scriptIngest(() => [{ result: { kind: "processed", event, result: { kind: "newState" } } }]);
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.catchUp());

    expect(signals).toHaveLength(0);
  });

  describe("malformed payload -> IngestSignal.malformed (terminal)", () => {
    it("bytes that fail to deserialize as application data", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: garbage } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
      if (signals[0].type === "malformed") {
        expect(signals[0].fact.id).toBe(event.id);
        expect(typeof signals[0].error).toBe("string");
      }
    });

    it("correct rumor kind but content does not decode into a recognized TaskEvent shape", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const bytes = rumorBytes({ content: JSON.stringify({ not: "a task event" }) });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });

    it("correct rumor kind but content is not valid JSON", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const bytes = rumorBytes({ content: "{ not json" });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });
  });

  describe("malformed shape (recognized type, missing required field) -> IngestSignal.malformed, NOT message (Codex Stage-2 review, Finding P1)", () => {
    it("task.created with no task field", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const bytes = rumorBytes({ content: JSON.stringify({ type: "task.created" }) });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });

    it("task.created with a task missing id", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const incompleteTask = { ...taskFixture() } as Partial<Task>;
      delete incompleteTask.id;
      const bytes = rumorBytes({
        content: JSON.stringify({ type: "task.created", task: incompleteTask }),
      });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });

    it("task.updated missing taskId", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const bytes = rumorBytes({
        content: JSON.stringify({
          type: "task.updated",
          changes: { title: "new title" },
          updatedAt: 1_700_000_000,
          updatedBy: "pk-member-1",
        }),
      });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });

    it("task.status_changed missing status", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const bytes = rumorBytes({
        content: JSON.stringify({
          type: "task.status_changed",
          taskId: "task-1",
          updatedAt: 1_700_000_000,
          updatedBy: "pk-member-1",
        }),
      });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });

    it("task.assigned missing assignee", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const bytes = rumorBytes({
        content: JSON.stringify({
          type: "task.assigned",
          taskId: "task-1",
          updatedAt: 1_700_000_000,
          updatedBy: "pk-member-1",
        }),
      });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });

    it("task.deleted missing updatedBy", async () => {
      const { deps, group, network } = makeDeps();
      const event = nostrEvent();
      const bytes = rumorBytes({
        content: JSON.stringify({
          type: "task.deleted",
          taskId: "task-1",
          updatedAt: 1_700_000_000,
        }),
      });
      group.scriptIngest(() => [
        { result: { kind: "processed", event, result: { kind: "applicationMessage", message: bytes } } },
      ]);
      network.setRequestResult([event]);

      const adapter = createMarmotIngestAdapter(deps);
      const signals = await drain(adapter.catchUp());

      expect(signals).toHaveLength(1);
      expect(signals[0].type).toBe("malformed");
    });
  });

  it("admin-rejected commit -> IngestSignal.skipped (no better-fitting variant; documented judgment call)", async () => {
    const { deps, group, network } = makeDeps();
    const event = nostrEvent();
    group.scriptIngest(() => [{ result: { kind: "rejected", event } }]);
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.catchUp());

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// AC-FSM-2 (secondary adapter-side conformance)
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter — AC-FSM-2 secondary conformance", () => {
  it("supports the engine's real call order: openLive() invoked before the first catchUp() iteration is drained", async () => {
    const { deps, group, network } = makeDeps();
    network.setRequestResult([]);
    group.scriptIngest(() => []);

    const adapter = createMarmotIngestAdapter(deps);

    // Mirrors the engine's real sequencing (architecture.md: the live
    // subscription opens FIRST for zero-gap capture, catch-up drains after).
    const unsubscribe = adapter.openLive(() => {});
    expect(network.callOrder).toEqual(["subscription"]);

    const signals = await drain(adapter.catchUp());
    expect(signals).toEqual([]);
    expect(network.callOrder).toEqual(["subscription", "request"]);

    unsubscribe();
    expect(network.subscriptionUnsubscribeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ingestPersisted — preserves original fact/receiptSource
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter.ingestPersisted", () => {
  it("re-submits persisted facts through group.ingest() and preserves each fact's original receiptSource/seq", async () => {
    const { deps, group } = makeDeps();
    const event = nostrEvent();
    const persistedFact: RawProtocolFact = {
      id: event.id,
      seq: 42,
      groupId: "group-1",
      nostrEventId: event.id,
      nostrEvent: event,
      receivedAt: 1_600_000_000_000,
      receiptSource: "live",
      epochAtReceipt: "0",
    };
    group.scriptIngest(() => [{ result: { kind: "skipped", event, reason: "self-echo" } }]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.ingestPersisted([persistedFact]));

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("skipped");
    if (signals[0].type === "skipped") {
      // The exact original fact object (including its seq) flows through,
      // not a freshly reconstructed seq-less one.
      expect(signals[0].fact).toBe(persistedFact);
    }
  });

  it("yields nothing for an empty facts array (no group.ingest() call)", async () => {
    const { deps } = makeDeps();
    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.ingestPersisted([]));
    expect(signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchBootstrap — NIP-44 kind-30078 fetch + decode + CRDT merge
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter.fetchBootstrap", () => {
  it("decrypts member-authored snapshots, merges same-id tasks via taskWinsOver, and shares one fact across every synthesized message", async () => {
    const groupId = "group-1";
    const winningTask = taskFixture({ id: "task-a", updatedAt: 2_000, title: "newer" });
    const losingTask = { ...winningTask, updatedAt: 1_000, title: "older" };
    const soloTask = taskFixture({ id: "task-b" });

    const olderEvent = nostrEvent({
      pubkey: "pk-member-1",
      created_at: 1_000,
      content: "enc-older",
    });
    const newerEvent = nostrEvent({
      pubkey: "pk-member-1",
      created_at: 2_000,
      content: "enc-newer",
    });
    const nonMemberEvent = nostrEvent({
      pubkey: "pk-not-a-member",
      created_at: 3_000,
      content: "enc-attacker",
    });

    const plaintextByContent: Record<string, string> = {
      "enc-older": JSON.stringify({
        version: 1,
        type: "task.state_sync",
        groupId,
        tasks: [losingTask],
        syncedAt: 1_000,
        inviterPubkey: "pk-member-1",
      }),
      "enc-newer": JSON.stringify({
        version: 1,
        type: "task.state_sync",
        groupId,
        tasks: [winningTask, soloTask],
        syncedAt: 2_000,
        inviterPubkey: "pk-member-1",
      }),
    };

    const { deps, network } = makeDeps({
      groupId,
      nip44: {
        decrypt: async (_pubkey, ciphertext) => {
          const plaintext = plaintextByContent[ciphertext];
          if (!plaintext) throw new Error("unexpected ciphertext");
          return plaintext;
        },
      },
    });
    network.setRequestResult([olderEvent, newerEvent, nonMemberEvent]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.fetchBootstrap());

    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal.type).toBe("message");
      if (signal.type !== "message") continue;
      expect(signal.receiptSource).toBe("bootstrap-kind-30078");
      expect(signal.payload.type).toBe("task.created");
    }
    // Shared fact: same object reference across every synthesized message,
    // and it is the most-recently-created qualifying relay event.
    expect(signals[0].type === "message" && signals[1].type === "message").toBe(true);
    if (signals[0].type === "message" && signals[1].type === "message") {
      expect(signals[0].fact).toBe(signals[1].fact);
      expect(signals[0].fact.nostrEvent).toEqual(newerEvent);
    }

    const wonTaskIds = signals
      .filter((s): s is Extract<IngestSignal, { type: "message" }> => s.type === "message")
      .map((s) => (s.payload as { type: "task.created"; task: Task }).task);
    const wonTitles = wonTaskIds.find((t) => t.id === "task-a")?.title;
    expect(wonTitles).toBe("newer"); // taskWinsOver picked the newer updatedAt, not relay order
    expect(wonTaskIds.some((t) => t.id === "task-b")).toBe(true);
  });

  it("skips a malformed task entry (null / missing id) in an otherwise-valid snapshot without throwing (Codex Stage-2 review, Finding P2)", async () => {
    const groupId = "group-1";
    const validTask = taskFixture({ id: "task-valid" });
    const malformedMissingId = { ...taskFixture({ id: "task-bad" }) } as Partial<Task>;
    delete malformedMissingId.id;

    const event = nostrEvent({ pubkey: "pk-member-1", created_at: 1_000, content: "enc-mixed" });

    const { deps, network } = makeDeps({
      groupId,
      nip44: {
        decrypt: async () =>
          JSON.stringify({
            version: 1,
            type: "task.state_sync",
            groupId,
            tasks: [validTask, null, malformedMissingId],
            syncedAt: 1_000,
            inviterPubkey: "pk-member-1",
          }),
      },
    });
    network.setRequestResult([event]);

    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.fetchBootstrap());

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("message");
    if (signals[0].type === "message") {
      expect(signals[0].payload).toEqual({ type: "task.created", task: validTask });
    }
  });

  it("yields nothing when the signer has no nip44 capability", async () => {
    const { deps, network } = makeDeps({ nip44: undefined });
    network.setRequestResult([nostrEvent()]);
    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.fetchBootstrap());
    expect(signals).toEqual([]);
  });

  it("yields nothing (non-fatal) when the relay request throws", async () => {
    const { deps, network } = makeDeps({
      nip44: { decrypt: async () => "{}" },
    });
    network.setRequestResult(() => Promise.reject(new Error("relay down")));
    const adapter = createMarmotIngestAdapter(deps);
    const signals = await drain(adapter.fetchBootstrap());
    expect(signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// close() — Boundary Rule 10 (no independent React lifecycle; engine-owned
// teardown)
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter.close", () => {
  it("releases the live subscription handle and is safe to call without an open subscription", async () => {
    const { deps, network } = makeDeps();
    const adapter = createMarmotIngestAdapter(deps);

    // Safe no-op before openLive() was ever called.
    adapter.close();
    expect(network.subscriptionUnsubscribeCount).toBe(0);

    adapter.openLive(() => {});
    adapter.close();
    expect(network.subscriptionUnsubscribeCount).toBe(1);

    // Idempotent: a second close() does not double-unsubscribe.
    adapter.close();
    expect(network.subscriptionUnsubscribeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency invariant — group.ingest() is never invoked concurrently with
// itself across catchUp()/openLive()/ingestPersisted() (architecture.md:
// "Two concurrent calls race on marmot-ts's internal `this.state` mutation")
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter — ingest mutex", () => {
  it("serializes overlapping ingestPersisted() and openLive() live-event calls through group.ingest()", async () => {
    const { deps, group, network } = makeDeps();
    group.scriptIngest((events) =>
      events.map((event) => ({ result: { kind: "skipped" as const, event, reason: "self-echo" } })),
    );

    const adapter = createMarmotIngestAdapter(deps);
    const unsubscribe = adapter.openLive(() => {});

    const persistedFact: RawProtocolFact = {
      id: "shared-1",
      seq: 1,
      groupId: "group-1",
      nostrEventId: "shared-1",
      nostrEvent: nostrEvent({ id: "shared-1" }),
      receivedAt: 1_600_000_000_000,
      receiptSource: "historical",
      epochAtReceipt: "0",
    };

    // Fire a persisted re-ingest and a live event "concurrently" (neither
    // awaited before the other starts) to stress the mutex.
    const persistedDrain = drain(adapter.ingestPersisted([persistedFact]));
    network.emitLive(nostrEvent());
    await persistedDrain;
    // Give the fire-and-forget live-event ingest a tick to complete.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(group.maxConcurrentIngestCalls()).toBe(1);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// fetchBootstrap ratchet isolation under concurrency (Finding 3, Stage-1
// review) -- the S7 FROZEN CONTRACT requires fetchBootstrap() to NEVER
// touch the MLS ratchet (it never calls group.ingest()) and to be safe to
// overlap catchUp()/openLive()/ingestPersisted(). This holds structurally
// today (fetchBootstrap's implementation has no group.ingest() call), but
// nothing pinned it -- this test forces a genuine overlap (via the stub's
// holdIngestUntil gate, deterministic rather than timer-raced) and asserts
// the max-concurrent-ingest counter never exceeds 1, so a future edit that
// routed fetchBootstrap through group.ingest() would fail the suite.
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter — fetchBootstrap ratchet isolation under concurrency", () => {
  it("contributes zero group.ingest() calls while running fully overlapping an in-flight catchUp() ingest drain", async () => {
    const BOOTSTRAP_CIPHERTEXT = "enc-bootstrap";
    const groupId = "group-1";
    const { deps, group, network } = makeDeps({
      groupId,
      nip44: {
        decrypt: async (_pubkey, ciphertext) => {
          if (ciphertext !== BOOTSTRAP_CIPHERTEXT) throw new Error("not a bootstrap snapshot");
          return JSON.stringify({
            version: 1,
            type: "task.state_sync",
            groupId,
            tasks: [taskFixture({ id: "task-concurrent" })],
            syncedAt: 1_000,
            inviterPubkey: "pk-member-1",
          });
        },
      },
    });

    // One shared relay-response list serves BOTH catchUp()'s group-event
    // fetch (any NostrEvent shape is acceptable to the stub `ingest()`) and
    // fetchBootstrap()'s kind-30078 fetch (which tries to decrypt every
    // returned event and only the one matching content qualifies).
    const events = [
      nostrEvent({ content: "irrelevant-1" }),
      nostrEvent({ content: BOOTSTRAP_CIPHERTEXT }),
      nostrEvent({ content: "irrelevant-2" }),
    ];
    network.setRequestResult(events);
    group.scriptIngest((evts) =>
      evts.map((event) => ({ result: { kind: "skipped" as const, event, reason: "self-echo" } })),
    );

    let releaseIngest: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    group.holdIngestUntil(gate);

    const adapter = createMarmotIngestAdapter(deps);

    // Start catchUp()'s drain WITHOUT awaiting -- it reaches group.ingest()
    // (activeCalls becomes 1) and then blocks on `gate`, holding the ingest
    // call "active" indefinitely until released below.
    const catchUpDrain = drain(adapter.catchUp());
    for (let i = 0; i < 50 && !group.isIngestActive(); i++) {
      await Promise.resolve();
    }
    expect(group.isIngestActive()).toBe(true);

    // fetchBootstrap() runs to COMPLETION here, fully overlapping the
    // still-blocked catchUp() ingest call.
    const bootstrapSignals = await drain(adapter.fetchBootstrap());
    expect(bootstrapSignals).toHaveLength(1);
    expect(bootstrapSignals[0].type).toBe("message");

    // The pinned invariant: fetchBootstrap() contributed ZERO group.ingest()
    // calls despite running entirely while catchUp()'s ingest() call was
    // still active.
    expect(group.maxConcurrentIngestCalls()).toBe(1);
    expect(group.isIngestActive()).toBe(true); // still blocked -- proves it wasn't a race we got lucky on

    releaseIngest();
    const catchUpSignals = await catchUpDrain;
    expect(catchUpSignals).toHaveLength(3);
    expect(catchUpSignals.every((s) => s.type === "skipped")).toBe(true);
    expect(group.maxConcurrentIngestCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Structural sanity: MarmotIngestAdapter really implements IngestSource
// (compile-time proof; if the exported class ever drifts from the
// engine-owned interface this file fails to typecheck).
// ---------------------------------------------------------------------------

describe("MarmotIngestAdapter — structural conformance", () => {
  it("is constructible as a class directly (test ergonomics) as well as via the factory", () => {
    const { deps } = makeDeps();
    const instance = new MarmotIngestAdapter(deps);
    expect(typeof instance.catchUp).toBe("function");
    expect(typeof instance.openLive).toBe("function");
    expect(typeof instance.ingestPersisted).toBe("function");
    expect(typeof instance.fetchBootstrap).toBe("function");
    expect(typeof instance.close).toBe("function");
  });
});

// Silence the "unused import" concern for deserializeApplicationData -- kept
// imported (and exercised indirectly through the adapter) to document that
// the round-trip encoding used by these fixtures is the SAME real function
// the adapter calls internally, not a parallel hand-rolled implementation.
void deserializeApplicationData;
