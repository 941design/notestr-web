/**
 * task-store.local-echo-readiness.test.tsx
 *
 * S12-Fable-1 cutover-regression fix (sev-5 blocker, Stage-2 review).
 *
 * CUTOVER (S12) deleted task-store.tsx's legacy unconditional optimistic
 * apply/persist block and left `dispatch`'s own-edit visibility ENTIRELY
 * dependent on `publishOutbox.publish`'s internal `onLocalAccept` call --
 * which only reflects the edit locally if `EngineTaskBridge`'s
 * `dispatchLocal` happened to already be wired at the EXACT moment
 * `publishOutbox` decided to send. `publishOutbox` (one IDB read to
 * rehydrate) and the engine mount (two IDB reads for origin routing, THEN
 * mount) settle independently, in EITHER order, and the slower one
 * routinely loses:
 *
 *  - WINDOW A: `publishOutbox` itself not yet constructed -- the edit is
 *    sent nowhere and reflected nowhere, `dispatch` still resolves as
 *    success.
 *  - WINDOW B: `publishOutbox` ready, `dispatchLocal` NOT yet wired -- the
 *    edit IS sent to the group (the own kind-445 event exists on the
 *    network), but the local accept silently no-ops. The engine's own-echo
 *    suppression then classifies the returning own-published event as
 *    "skipped" (already known to be this device's own send), so the edit
 *    is NEVER accepted into the author's own projection -- permanently
 *    invisible locally despite reaching every other member and despite
 *    `dispatch` having already resolved as success.
 *
 * This file reproduces BOTH windows deterministically (by gating the async
 * reads each readiness signal depends on) and proves the fix: `dispatch`
 * now drives the local accept directly, decoupled from outbox timing, and
 * waits on whichever readiness signal is still outstanding instead of
 * racing them.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { IDBFactory } from "fake-indexeddb";
import type { IngestSignal, IngestSource, NostrEvent } from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

const PUBKEY = "a".repeat(64);
const H_TAG = "test-h-tag";
const GROUP_EVENT_KIND = 445;

vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
  deserializeApplicationData: (data: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(data)),
  getNostrGroupIdHex: () => H_TAG,
  GROUP_EVENT_KIND: 445,
}));

class FakeGroup {
  readonly state = {};
  sendApplicationRumor = vi.fn(async (_rumor: unknown) => undefined);
  private listeners = new Map<string, Set<(data: Uint8Array) => void>>();

  on(event: string, handler: (data: Uint8Array) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
  }

  off(event: string, handler: (data: Uint8Array) => void): void {
    this.listeners.get(event)?.delete(handler);
  }
}

type FakeNetworkPublish = Mock<
  (relays: string[], event: NostrEvent) => Promise<Record<string, { from: string; ok: boolean }>>
>;

interface FakeClient {
  network: { publish: FakeNetworkPublish };
  keyPackages: { clientId: string };
}

function createFakeClient(clientId: string): FakeClient {
  return {
    network: {
      publish: vi.fn<
        (relays: string[], event: NostrEvent) => Promise<Record<string, { from: string; ok: boolean }>>
      >(async () => ({ "relay-1": { from: "relay-1", ok: true } })),
    },
    keyPackages: { clientId },
  };
}

let currentFakeGroup: FakeGroup | undefined;
let currentFakeClient: FakeClient | undefined;
vi.mock("../marmot/client", () => ({
  useGroup: () => currentFakeGroup,
  useMarmot: () => ({
    pubkey: currentFakeClient ? PUBKEY : "",
    client: currentFakeClient ?? null,
    signer: null,
    relays: [] as string[],
  }),
}));

// WINDOW B fixture: `task-store.tsx`'s own `engineOrigin` effect (and, via
// the SAME underlying functions, `EngineTaskBridge`'s internal mount-time
// persistence seed) call these two reads. Gating them, while every OTHER
// export of each module (saveCheckpoint, appendAcceptedEvent, appendFact,
// ...) passes through untouched to the real implementation, lets this file
// hold "engine origin never resolves" open for as long as a test needs,
// without breaking the engine's actual accept/append machinery.
let checkpointGate: Promise<void> | null = null;
vi.mock("../persistence/checkpoint-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persistence/checkpoint-store")>();
  return {
    ...actual,
    loadCheckpoint: async (groupId: string) => {
      if (checkpointGate) await checkpointGate;
      return actual.loadCheckpoint(groupId);
    },
  };
});
let acceptedEventsGate: Promise<void> | null = null;
vi.mock("../persistence/raw-event-log-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../persistence/raw-event-log-store")>();
  return {
    ...actual,
    loadAcceptedEvents: async (groupId: string) => {
      if (acceptedEventsGate) await acceptedEventsGate;
      return actual.loadAcceptedEvents(groupId);
    },
  };
});

// WINDOW A fixture: gate ONLY the "outbox" KV store's `getItem` (what
// publish-outbox.ts's `loadPersisted()` calls) -- every other store name
// goes through untouched to the real, fake-indexeddb-backed implementation.
// Same pattern task-store.dispatch.test.tsx already established for forcing
// a rejection; this file gates timing instead.
let outboxGetItemGate: Promise<void> | null = null;
vi.mock("../marmot/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../marmot/storage")>();
  return {
    ...actual,
    createKVStore(name: string, pinnedPubkey?: string) {
      const real = actual.createKVStore(name, pinnedPubkey);
      if (name !== "outbox") return real;
      return {
        ...real,
        async getItem(key: string) {
          if (outboxGetItemGate) await outboxGetItemGate;
          return real.getItem(key);
        },
      };
    },
  };
});

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
}

const { act, create } = TestRenderer;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function fixtureTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    assignee: null,
    createdBy: PUBKEY,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    updatedBy: PUBKEY,
  };
}

async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function createEmptyIngestSource(): IngestSource {
  return {
    catchUp: () => fromArray<IngestSignal>([]),
    openLive() {
      return () => {};
    },
    ingestPersisted() {
      return fromArray<IngestSignal>([]);
    },
    fetchBootstrap() {
      return fromArray<IngestSignal>([]);
    },
    close() {},
  };
}

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  { maxAttempts = 200, stepMs = 5 }: { maxAttempts?: number; stepMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < maxAttempts && !predicate(); i++) {
    await act(async () => {
      await flush(stepMs);
    });
  }
  if (!predicate()) {
    throw new Error(
      `waitUntil: predicate did not become true within ${maxAttempts} attempts`,
    );
  }
}

async function settle(ticks = 10, stepMs = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await flush(stepMs);
    });
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("task-store.tsx S12-Fable-1: dispatch does not silently drop own edits", () => {
  let taskStoreModule: typeof import("./task-store");
  let storage: typeof import("../marmot/storage");

  beforeEach(async () => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    checkpointGate = null;
    acceptedEventsGate = null;
    outboxGetItemGate = null;
    storage = await import("../marmot/storage");
    taskStoreModule = await import("./task-store");
    storage.bindStores(PUBKEY);
    currentFakeGroup = undefined;
    currentFakeClient = undefined;
  });

  afterEach(() => {
    checkpointGate = null;
    acceptedEventsGate = null;
    outboxGetItemGate = null;
    vi.restoreAllMocks();
  });

  function TasksProbe({
    onRender,
    onReady,
  }: {
    onRender: (tasks: Task[], pending: ReadonlySet<string>) => void;
    onReady: (dispatch: (event: TaskEvent) => Promise<void>) => void;
  }) {
    const { tasks, dispatch, pendingTaskIds } = taskStoreModule.useTaskStore();
    onRender(tasks, pendingTaskIds);
    onReady(dispatch);
    return null;
  }

  it(
    "WINDOW B: dispatchLocal not yet wired when publishOutbox is already " +
      "ready -- dispatch() must not resolve as a false success while the " +
      "own edit is permanently dropped; it must wait, then reflect the " +
      "edit locally BEFORE sending",
    async () => {
      const groupId = "group-window-b";
      const group = new FakeGroup();
      const client = createFakeClient("device-window-b");
      currentFakeGroup = group;
      currentFakeClient = client;
      const ingestSourceOverride = createEmptyIngestSource();

      // Hold engine-origin resolution open indefinitely -- EngineTaskBridge
      // never mounts, so `dispatchLocal` never becomes available, until this
      // test explicitly releases it below.
      const originGate = createDeferred();
      checkpointGate = originGate.promise;
      acceptedEventsGate = originGate.promise;

      let latestTasks: Task[] = [];
      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={ingestSourceOverride}
          >
            <TasksProbe
              onRender={(tasks) => (latestTasks = tasks)}
              onReady={(d) => (dispatch = d)}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      // Let the outbox-construction effect's real, ungated `loadPersisted()`
      // settle -- `publishOutbox` becomes ready while the engine stays
      // blocked on `originGate`.
      await settle();

      const fixtureTaskId = "window-b-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };

      let dispatchSettled = false;
      let dispatchPromise: Promise<void> | undefined;
      await act(async () => {
        dispatchPromise = dispatch!(taskEvent).then(() => {
          dispatchSettled = true;
        });
        await flush(0);
      });

      // The pre-fix bug: `publishOutbox` was already ready, so dispatch
      // called `publish()` immediately, which sent the rumor to the group
      // (onLocalAccept silently no-op'd) and resolved as success right
      // away. The fix: dispatch must NOT have sent anything yet, and must
      // NOT have resolved yet -- it is waiting on the engine boundary.
      expect(group.sendApplicationRumor).not.toHaveBeenCalled();
      expect(dispatchSettled).toBe(false);
      expect(latestTasks.some((t) => t.id === fixtureTaskId)).toBe(false);

      // Now let engine-origin resolution proceed -- EngineTaskBridge mounts,
      // `dispatchLocal` becomes available, and the blocked dispatch() call
      // should unblock, accept locally, and THEN send.
      originGate.resolve();

      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));
      await dispatchPromise;

      expect(dispatchSettled).toBe(true);
      expect(group.sendApplicationRumor).toHaveBeenCalledTimes(1);
      expect(latestTasks.map((t) => t.id)).toContain(fixtureTaskId);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "WINDOW A: publishOutbox not yet constructed when the engine is already " +
      "live -- own-edit reflection must NOT be gated on outbox readiness; " +
      "the edit appears locally immediately, the send follows once the " +
      "outbox becomes ready",
    async () => {
      const groupId = "group-window-a";
      const group = new FakeGroup();
      const client = createFakeClient("device-window-a");
      currentFakeGroup = group;
      currentFakeClient = client;
      const ingestSourceOverride = createEmptyIngestSource();

      // Hold the outbox's own rehydration open indefinitely -- `publishOutbox`
      // never becomes ready until this test explicitly releases it below.
      // Engine-origin resolution is left ungated (fast, real, empty
      // fake-indexeddb), so `EngineTaskBridge` mounts quickly.
      const outboxGate = createDeferred();
      outboxGetItemGate = outboxGate.promise;

      let latestTasks: Task[] = [];
      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={ingestSourceOverride}
          >
            <TasksProbe
              onRender={(tasks) => (latestTasks = tasks)}
              onReady={(d) => (dispatch = d)}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      // Give the engine (origin resolution + mount) plenty of time to
      // settle -- the outbox stays blocked throughout, regardless of how
      // long this settle runs.
      await settle();

      const fixtureTaskId = "window-a-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };

      let dispatchSettled = false;
      let dispatchPromise: Promise<void> | undefined;
      await act(async () => {
        dispatchPromise = dispatch!(taskEvent).then(() => {
          dispatchSettled = true;
        });
        await flush(0);
      });

      // Local reflection must NOT wait on the outbox: the task is already
      // visible even though the send half is still blocked.
      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));
      expect(group.sendApplicationRumor).not.toHaveBeenCalled();
      expect(dispatchSettled).toBe(false);

      // Release the outbox -- the deferred send half should now complete
      // and dispatch() should resolve.
      outboxGate.resolve();

      await waitUntil(() => dispatchSettled);
      await dispatchPromise;

      expect(group.sendApplicationRumor).toHaveBeenCalledTimes(1);
      expect(latestTasks.map((t) => t.id)).toContain(fixtureTaskId);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "WINDOW B regression check: the direct local-accept call and " +
      "publish()'s own internal onLocalAccept call do not double-count -- " +
      "exactly one pending entry, and own-echo reconciliation still clears it",
    async () => {
      const groupId = "group-window-b-dedupe";
      const group = new FakeGroup();
      const client = createFakeClient("device-window-b-dedupe");
      currentFakeGroup = group;
      currentFakeClient = client;
      const ingestSourceOverride = createEmptyIngestSource();

      const sentEventId = "kind445-window-b-dedupe-1";
      group.sendApplicationRumor = vi.fn(async (_rumor: unknown) => {
        const event: NostrEvent = {
          id: sentEventId,
          pubkey: PUBKEY,
          created_at: Math.floor(Date.now() / 1000),
          kind: GROUP_EVENT_KIND,
          tags: [["h", H_TAG]],
          content: "ciphertext",
          sig: "sig",
        };
        await client.network.publish([], event);
        return undefined;
      });

      const originGate = createDeferred();
      checkpointGate = originGate.promise;
      acceptedEventsGate = originGate.promise;

      let latestPending: ReadonlySet<string> = new Set();
      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={ingestSourceOverride}
          >
            <TasksProbe
              onRender={(_tasks, pending) => (latestPending = pending)}
              onReady={(d) => (dispatch = d)}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      await settle();

      const fixtureTaskId = "window-b-dedupe-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };

      let dispatchPromise: Promise<void> | undefined;
      await act(async () => {
        dispatchPromise = dispatch!(taskEvent);
        await flush(0);
      });

      originGate.resolve();
      await waitUntil(() => latestPending.has(fixtureTaskId));
      await dispatchPromise;

      // Exactly one task pending -- the direct dispatchLocal call and
      // publish()'s own internal (idempotent, dedupe-by-id) onLocalAccept
      // call did not register two separate pending entries.
      expect(latestPending.size).toBe(1);
      expect(group.sendApplicationRumor).toHaveBeenCalledTimes(1);

      const marmotAdapterModule = await import("../integration/marmot-adapter");
      await act(async () => {
        const reconciled = marmotAdapterModule.reconcileOwnEcho(
          { id: sentEventId, groupId },
          Date.now(),
        );
        expect(reconciled?.status).toBe("reconciled");
      });

      await waitUntil(() => !latestPending.has(fixtureTaskId));
      expect(latestPending.size).toBe(0);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "regression guard: readyForEngine permanently false (no marmot session) " +
      "-- dispatch() still does not throw or hang, matching the pre-existing " +
      "degenerate no-op contract",
    async () => {
      const groupId = "group-no-session";
      const group = new FakeGroup();
      const client = createFakeClient("device-no-session");
      currentFakeGroup = group;
      currentFakeClient = client;
      // Deliberately NO engineIngestSourceOverride, and this file's
      // `useMarmot` mock always returns `signer: null` -- `readyForEngine`
      // stays false permanently, `EngineTaskBridge` never mounts.

      let latestPending: ReadonlySet<string> = new Set();
      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider groupId={groupId}>
            <TasksProbe
              onRender={(_tasks, pending) => (latestPending = pending)}
              onReady={(d) => (dispatch = d)}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      await settle();

      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask("no-session-task-1"),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      expect(latestPending.size).toBe(0);

      await act(async () => {
        renderer.unmount();
      });
    },
  );
});
