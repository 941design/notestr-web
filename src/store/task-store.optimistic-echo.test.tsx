/**
 * task-store.optimistic-echo.test.tsx
 *
 * S11B (optimistic-local-echo) end-to-end wiring coverage through the REAL
 * `TaskStoreProvider` component tree — VQ-S11B-008's specific claim: that
 * `dispatch()`'s existing `if (publishOutbox) { await publishOutbox.publish(...) }`
 * delegation call, with NO new lines added to `dispatch()`'s own body, is
 * enough to route a locally-authored task through the engine boundary
 * (`publishOutbox`'s `onLocalAccept` dep -> `engineHookStateRef.current
 * .dispatchLocal` -> `ReceiveEngine.acceptLocal` -> a `domain_event_accepted`
 * folded by `react-engine-hooks.ts` into the SAME projection `activeRead`
 * exposes when the strangler flag is on).
 *
 * Complements (does not duplicate) the lower-level suites that already prove
 * each link of this chain in isolation:
 *  - src/engine/receive-engine.optimistic-local-echo.test.ts (acceptLocal itself)
 *  - src/integration/publish-outbox.local-echo.test.ts (onLocalAccept/onPendingCleared wiring)
 *  - src/integration/react-engine-hooks.optimistic-local-echo.test.tsx (dispatchLocal/confirmLocal/pendingTaskIds)
 * This file is the only one that proves the chain holds THROUGH
 * `TaskStoreProvider`'s actual composition, with a REAL dispatch() call.
 *
 * Combines two existing fixture patterns rather than extending either file
 * directly (mirrors task-store.dispatch.test.tsx's own "deliberately a
 * separate file" rationale):
 *  - task-store.cutover.test.tsx's `engineIngestSourceOverride` +
 *    `NEXT_PUBLIC_ENGINE_TASK_READS` flag-toggle DI seam, needed to mount
 *    `EngineTaskBridge` without a real `MarmotGroup`/`MarmotClient`.
 *  - task-store.dispatch.test.tsx's `FakeGroup`/`FakeClient` (a real,
 *    non-null `group`/`client`/`pubkey` triple), needed because the
 *    publishOutbox-construction effect (where `onLocalAccept`/`onPendingCleared`
 *    are wired) gates on `group && client && pubkey` — cutover.test.tsx's
 *    `client: null` mock never constructs a `publishOutbox` at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { IDBFactory } from "fake-indexeddb";
import type { IngestSignal, IngestSource, NostrEvent } from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

const PUBKEY = "a".repeat(64);
const ENV_FLAG = "NEXT_PUBLIC_ENGINE_TASK_READS";
const H_TAG = "test-h-tag";
/** Real value of `@internet-privacy/marmot-ts`'s `GROUP_EVENT_KIND` (445) --
 *  mocked below since marmot-adapter.ts's `ensureOutboxNetworkWrapped` keys
 *  its kind-445 attribution on this constant (see the S11B-Opus-1
 *  remediation's onPendingCleared-simulation test, which drives that wrapper
 *  directly). */
const GROUP_EVENT_KIND = 445;

// Same three-module stub set task-store.cutover.test.tsx / task-store.dispatch.test.tsx
// already establish -- see either file's comments for why each is needed to
// resolve the module graph under vitest's node environment.
vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
  deserializeApplicationData: (data: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(data)),
  getNostrGroupIdHex: () => H_TAG,
  GROUP_EVENT_KIND: 445,
}));

class FakeGroup {
  readonly state = {};
  // Deliberately NOT `readonly` (unlike other Fake* fixtures in this repo):
  // the onPendingCleared-simulation test below reassigns this to a variant that
  // also drives `client.network.publish` so marmot-adapter.ts's own-echo
  // attribution wrapper can attribute a sentEventId. Default behavior
  // (a bare vi.fn resolving undefined) is unchanged for every other test.
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

vi.mock("./persistence", () => ({
  loadEvents: async () => [],
  appendEvent: async () => {},
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
}

const { act, create } = TestRenderer;

// ---------------------------------------------------------------------------
// Fixtures
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

/** An `IngestSource` that never yields/pushes anything -- proves whatever
 *  the test observes did NOT arrive via any remote/ingest path. */
function createEmptyIngestSource(): { source: IngestSource; catchUpSpy: ReturnType<typeof vi.fn> } {
  const catchUpSpy = vi.fn(() => fromArray<IngestSignal>([]));
  const source: IngestSource = {
    catchUp: catchUpSpy,
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
  return { source, catchUpSpy };
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

/**
 * CUTOVER (S12): `EngineTaskBridge` no longer mounts synchronously within
 * the FIRST render -- `TaskStoreProvider`'s `engineOrigin` resolution (a
 * `loadCheckpoint` IDB round-trip against the now-real, durable
 * `PersistenceAdapter`) is a genuine extra async hop before the bridge (and
 * therefore `dispatchLocal`) exists at all. A single `act(async () => {
 * await flush(20) })` settle window (sized for the old synchronous-mount
 * world) is not reliably enough ticks for that hop plus `useReceiveEngine`'s
 * own mount-time persistence seed to land -- a `dispatch()` that fires
 * before `dispatchLocal` is wired silently no-ops via optional chaining
 * (by design, see `PublishOutboxDeps.onLocalAccept`'s doc comment), so the
 * fixture task would never reach the projection. Settling over several
 * small act()-wrapped flushes (rather than one) reliably gives React
 * enough passes to flush a state update that lands between ticks -- same
 * property `waitUntil`'s own polling loop already relies on.
 */
async function settle(ticks = 10, stepMs = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await flush(stepMs);
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("task-store.tsx S11B: optimistic local echo, end-to-end through TaskStoreProvider", () => {
  let taskStoreModule: typeof import("./task-store");
  let storage: typeof import("../marmot/storage");
  let marmotAdapterModule: typeof import("../integration/marmot-adapter");
  let originalFlag: string | undefined;

  beforeEach(async () => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    originalFlag = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
    storage = await import("../marmot/storage");
    taskStoreModule = await import("./task-store");
    // Same module graph task-store.tsx -> publish-outbox.ts resolves to
    // (both imported after this beforeEach's vi.resetModules()), so
    // `reconcileOwnEcho`/`ensureOutboxNetworkWrapped`'s module-level
    // registries below are the SAME instances dispatch()'s publishOutbox
    // mutates.
    marmotAdapterModule = await import("../integration/marmot-adapter");
    storage.bindStores(PUBKEY);
    currentFakeGroup = undefined;
    currentFakeClient = undefined;
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[ENV_FLAG];
    } else {
      process.env[ENV_FLAG] = originalFlag;
    }
    vi.restoreAllMocks();
  });

  function TasksProbe({
    onRender,
    onReady,
    onPending,
  }: {
    onRender: (tasks: Task[]) => void;
    onReady: (dispatch: (event: TaskEvent) => Promise<void>) => void;
    onPending?: (pendingTaskIds: ReadonlySet<string>) => void;
  }) {
    const { tasks, dispatch, pendingTaskIds } = taskStoreModule.useTaskStore();
    onRender(tasks);
    onReady(dispatch);
    onPending?.(pendingTaskIds);
    return null;
  }

  it(
    "AC-OPT-1 / VQ-S11B-008: flag ON, dispatching a task.created shows it in " +
      "`tasks` immediately, with NO signal ever delivered through the engine " +
      "ingest source (proves the accept came from the engine-boundary local " +
      "path, not from any remote/ingest delivery)",
    async () => {
      process.env[ENV_FLAG] = "1";
      const groupId = "group-s11b-immediate";
      const group = new FakeGroup();
      const client = createFakeClient("device-s11b-1");
      currentFakeGroup = group;
      currentFakeClient = client;
      const { source: ingestSourceOverride, catchUpSpy } = createEmptyIngestSource();

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
      // Let the outbox-construction effect's loadPersisted() AND
      // TaskStoreProvider's engineOrigin/EngineTaskBridge mount settle
      // before dispatching -- see `settle`'s own doc comment.
      await settle();

      const fixtureTaskId = "s11b-immediate-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));

      expect(latestTasks.map((t) => t.id)).toContain(fixtureTaskId);
      // The engine's historical drain never yielded anything -- the ONLY way
      // this task could be visible is the local-accept path.
      expect(catchUpSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "flag ON: the send path is unaffected by the new local-accept wiring -- " +
      "sendApplicationRumor is still called exactly once per dispatch",
    async () => {
      process.env[ENV_FLAG] = "1";
      const groupId = "group-s11b-send-unaffected";
      const group = new FakeGroup();
      const client = createFakeClient("device-s11b-2");
      currentFakeGroup = group;
      currentFakeClient = client;
      const { source: ingestSourceOverride } = createEmptyIngestSource();

      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={ingestSourceOverride}
          >
            <TasksProbe onRender={() => {}} onReady={(d) => (dispatch = d)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      await settle();

      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask("s11b-send-task-1"),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      expect(group.sendApplicationRumor).toHaveBeenCalledTimes(1);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "regression guard: flag OFF (default -- now a no-op post-S12 cutover, " +
      "kept for historical VQ-S11B naming), dispatch still sends normally " +
      "and the task still appears via the engine-boundary local-accept path",
    async () => {
      // Flag intentionally left OFF/unset -- beforeEach already deletes it.
      // CUTOVER (S12): the flag no longer gates whether the engine mounts
      // (see task-store.tsx's `shouldMountEngine`) -- it is asserted here
      // only to document that this test's behavior does NOT depend on it.
      expect(process.env[ENV_FLAG]).toBeUndefined();

      const groupId = "group-s11b-flag-off";
      const group = new FakeGroup();
      const client = createFakeClient("device-s11b-3");
      currentFakeGroup = group;
      currentFakeClient = client;
      // CUTOVER (S12): `readyForEngine` needs EITHER a real
      // `group && client && signer && pubkey` quadruple (this file's
      // `useMarmot` mock always returns `signer: null`, so that path is
      // never satisfied) OR this override -- required now that the engine
      // is the ONLY path a dispatched task can reach `tasks` through (the
      // legacy optimistic apply/appendEvent this test used to rely on is
      // retired).
      const { source: ingestSourceOverride } = createEmptyIngestSource();

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
      await settle();

      const fixtureTaskId = "s11b-flag-off-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));
      expect(latestTasks.map((t) => t.id)).toContain(fixtureTaskId);
      // And the send still happened -- no crash from the
      // onLocalAccept/onPendingCleared wiring.
      expect(group.sendApplicationRumor).toHaveBeenCalledTimes(1);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "AC-OPT-3 convergence smoke test: a create -> update sequence, both " +
      "dispatched locally with flag ON and no remote signal, converges to " +
      "the expected final task exactly as the legacy path would",
    async () => {
      process.env[ENV_FLAG] = "1";
      const groupId = "group-s11b-sequence";
      const group = new FakeGroup();
      const client = createFakeClient("device-s11b-4");
      currentFakeGroup = group;
      currentFakeClient = client;
      const { source: ingestSourceOverride } = createEmptyIngestSource();

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
      await settle();

      const fixtureTaskId = "s11b-sequence-task-1";
      const created: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      await act(async () => {
        await dispatch!(created);
      });
      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));

      const updated: TaskEvent = {
        type: "task.updated",
        taskId: fixtureTaskId,
        changes: { title: "Updated via local echo" },
        updatedAt: 1_700_000_001_000,
        updatedBy: PUBKEY,
        updatedByDevice: "device-s11b-4",
      };
      await act(async () => {
        await dispatch!(updated);
      });
      await waitUntil(
        () => latestTasks.find((t) => t.id === fixtureTaskId)?.title === "Updated via local echo",
      );

      const finalTask = latestTasks.find((t) => t.id === fixtureTaskId);
      expect(finalTask).toMatchObject({
        id: fixtureTaskId,
        title: "Updated via local echo",
      });

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  // ---------------------------------------------------------------------------
  // S11B-Opus-1 remediation: `useTaskStore().pendingTaskIds` (AC-OPT-4's
  // pending/confirmed signal) reaches the app consumer surface.
  // ---------------------------------------------------------------------------

  it(
    "AC-OPT-4: flag ON, a dispatched task is pending until its own-echo is " +
      "reconciled, then clears -- through `useTaskStore().pendingTaskIds`",
    async () => {
      process.env[ENV_FLAG] = "1";
      const groupId = "group-s11b-pending";
      const group = new FakeGroup();
      const client = createFakeClient("device-s11b-pending");
      currentFakeGroup = group;
      currentFakeClient = client;
      const { source: ingestSourceOverride } = createEmptyIngestSource();

      // Reassign sendApplicationRumor so it ALSO drives
      // `client.network.publish` with a real kind-445 event -- this is what
      // lets marmot-adapter.ts's `ensureOutboxNetworkWrapped` (wrapping
      // `client.network.publish` when `createPublishOutbox` constructs)
      // attribute a `sentEventId`, which `reconcileOwnEcho` below matches on.
      const sentEventId = "kind445-pending-1";
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
              onRender={() => {}}
              onReady={(d) => (dispatch = d)}
              onPending={(p) => (latestPending = p)}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      await settle();

      const fixtureTaskId = "s11b-pending-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      // Pending: the local edit was accepted but its own-echo has not been
      // observed yet.
      await waitUntil(() => latestPending.has(fixtureTaskId));
      expect(latestPending.has(fixtureTaskId)).toBe(true);

      // Simulate the outbox reconciliation (own-echo observed): matches the
      // `sentEventId` attributed above, same as a real relay round-trip
      // would via marmot-adapter.ts's live ingest path.
      await act(async () => {
        const reconciled = marmotAdapterModule.reconcileOwnEcho(
          { id: sentEventId, groupId },
          Date.now(),
        );
        expect(reconciled?.status).toBe("reconciled");
      });

      // Confirmed: pending clears once reconciled.
      await waitUntil(() => !latestPending.has(fixtureTaskId));
      expect(latestPending.has(fixtureTaskId)).toBe(false);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "regression guard: no engineIngestSourceOverride and no real signer " +
      "(readyForEngine false), `pendingTaskIds` stays empty -- " +
      "`EngineTaskBridge` never mounts, so `engineHookState` never advances " +
      "past `INITIAL_ENGINE_HOOK_STATE`'s empty Set. CUTOVER (S12): this is " +
      "no longer a flag-OFF scenario (the flag is a no-op post-cutover) -- " +
      "it exercises task-store.tsx's `readyForEngine` deps-not-ready gate " +
      "instead, which still legitimately keeps the bridge unmounted.",
    async () => {
      const groupId = "group-s11b-pending-flag-off";
      const group = new FakeGroup();
      const client = createFakeClient("device-s11b-pending-flag-off");
      currentFakeGroup = group;
      currentFakeClient = client;

      let latestPending: ReadonlySet<string> = new Set();
      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          // Deliberately no `engineIngestSourceOverride` -- combined with
          // this file's `useMarmot` mock always returning `signer: null`,
          // `readyForEngine` stays false and `EngineTaskBridge` never
          // mounts.
          <taskStoreModule.TaskStoreProvider groupId={groupId}>
            <TasksProbe
              onRender={() => {}}
              onReady={(d) => (dispatch = d)}
              onPending={(p) => (latestPending = p)}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      await settle();

      expect(latestPending.size).toBe(0);

      const fixtureTaskId = "s11b-pending-flag-off-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      // No engine mounted -- no local-accept path exists, so pending stays
      // empty even after a dispatch.
      expect(latestPending.size).toBe(0);

      await act(async () => {
        renderer.unmount();
      });
    },
  );
});
