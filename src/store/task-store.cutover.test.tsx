/**
 * task-store.cutover.test.tsx
 *
 * CUTOVER (S12): S9's original dual-path premise (legacy `applicationMessage`
 * listener vs. engine, compared side by side) no longer applies -- the
 * legacy path (task-store.tsx's own listener, its `state`/`loading`
 * machinery, and the S9 `activeRead` selector ternary) was removed in S12,
 * and the engine is now the SOLE, unconditional receive path regardless of
 * `NEXT_PUBLIC_ENGINE_TASK_READS`. This file keeps only the tests whose
 * value survives that premise change: the engine path's behavior in
 * isolation. Behavioral proof that the removed legacy path no longer fires
 * (plus the engine path's own dedicated coverage of what it used to
 * provide) lives in `task-store.listener-removal.test.tsx`.
 *
 * Retained (adapted to drop the legacy-path comparison half):
 *  - a create -> update -> status_changed sequence through the REAL engine
 *    (task-projector.ts's `applyEvent`) resolves to the expected final task.
 *  - loading=true while still catching_up (before the projection is
 *    populated), loading=false only once the fixture task is visible.
 *
 * Retired (tested behavior that no longer exists in production code):
 *  - "flag OFF, the legacy listener still fires" (the listener is gone).
 *  - "S9-1 regression: flag OFF + deps ready, engine must not run" (S12
 *    inverts this exact premise -- the engine MUST run once deps are ready,
 *    regardless of the flag; see task-store.listener-removal.test.tsx).
 *  - "both flag states converge" (there is only one path left to compare
 *    against itself).
 *
 * Test-only DI, not production wiring: `TaskStoreProviderProps.
 * engineIngestSourceOverride` substitutes the real marmot-adapter
 * `IngestSource` so this file never needs to simulate a real
 * `MarmotGroup`/`MarmotClient` -- the same "mock IngestSource +
 * origin:'welcome'" recipe proven in
 * `src/integration/react-engine-hooks.test.tsx`'s AC-INV-4 suite (real
 * `createReceiveEngine`, real S4 `raw-event-log-store`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { IDBFactory } from "fake-indexeddb";
import type { IngestSignal, IngestSource, RawProtocolFactInput } from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

// storage.ts (imported transitively by raw-event-log-store.ts /
// checkpoint-store.ts) imports generateKeyPackageSlot from marmot-ts;
// task-store.tsx itself imports deserializeApplicationData/
// getNostrGroupIdHex. Stub exactly these three so the module graph resolves
// in the node test env without pulling the real fork -- same idiom as
// react-engine-hooks.test.tsx / raw-event-log-store.test.ts.
vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
  deserializeApplicationData: (data: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(data)),
  getNostrGroupIdHex: () => "test-h-tag",
}));

// task-store.tsx's own composition-root deps (`useGroup`/`useMarmot`) --
// replaced with a controllable fake. This file never sets a real group, so
// `readyForEngine` is satisfied entirely via `engineIngestSourceOverride`.
vi.mock("../marmot/client", () => ({
  useGroup: () => undefined,
  useMarmot: () => ({
    pubkey: "",
    client: null,
    signer: null,
    relays: [] as string[],
  }),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// vitest.config.ts runs this suite under `environment: "node"` (no DOM).
// task-store.tsx's PRE-EXISTING `isTestRuntime()` window-hook-registration
// effect assumes a `window` global whenever `NODE_ENV === "test"` -- true
// under vitest by default. This is the first test to mount
// `<TaskStoreProvider>` under vitest, so it is the first to need a `window`
// stand-in; a minimal self-referencing shim (not jsdom, which this repo does
// not depend on) is sufficient since this file never asserts against the
// window-hook surface itself.
if (typeof window === "undefined") {
  // A plain, non-circular stand-in -- NOT `globalThis` itself, which would
  // create a self-referencing `window.window.window...` cycle that blew the
  // heap (empirically) when something in the react-test-renderer/vitest
  // pipeline tried to walk it.
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
}

const { act, create } = TestRenderer;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function fixtureTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    assignee: null,
    createdBy: "pk-fixture",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    updatedBy: "pk-fixture",
  };
}

function factInput(id: string, groupId: string): RawProtocolFactInput {
  return {
    id,
    groupId,
    nostrEventId: id,
    nostrEvent: {
      id,
      pubkey: "pk-fixture",
      created_at: 1_700_000_000,
      kind: 445,
      tags: [],
      content: "ciphertext",
      sig: "sig",
    },
    receivedAt: 1_700_000_000_000,
    receiptSource: "historical",
    epochAtReceipt: "epoch-0",
  };
}

/** Engine-path fixture: a task-created payload, wrapped as an
 *  `IngestSignal` the engine's `catchUp()` drain yields during "welcome"
 *  origin's catching_up phase. */
function messageSignal(groupId: string, taskEvent: TaskEvent, id: string): IngestSignal {
  return {
    type: "message",
    fact: factInput(id, groupId),
    rumorId: id,
    payload: taskEvent,
    epoch: "epoch-0",
    receiptSource: "historical",
  };
}

async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Trimmed from react-engine-hooks.test.tsx's `createMockIngestSource` --
 *  only `catchUp`/`fetchBootstrap` scripting is needed for this file's
 *  origin:"welcome" fixtures. */
function createFixtureIngestSource(catchUpSignals: IngestSignal[]): IngestSource {
  return {
    catchUp() {
      return fromArray(catchUpSignals);
    },
    openLive() {
      return () => {};
    },
    ingestPersisted() {
      return fromArray([]);
    },
    fetchBootstrap() {
      return fromArray([]);
    },
    close() {},
  };
}

/**
 * A scripted `IngestSource` whose `catchUp()` drain PAUSES (via an
 * externally-resolved gate) right after the engine has entered it, before
 * yielding any signal. This lets a test observe `TaskStoreProvider`'s
 * exposed `loading` value while the engine is provably still mid-
 * `"catching_up"` (i.e. BEFORE the projection is populated) rather than
 * only being able to assert on the eventual settled state. `started`
 * resolves once the async generator body has run up to the `await gate`
 * point -- which happens only after `enterCatchingUp`'s own
 * `transitionTo(gen, "catching_up")` has already committed (see
 * receive-engine.ts's `enterCatchingUp`: it awaits `transitionTo` BEFORE
 * calling `adapter.catchUp()`), so by the time `started` resolves the
 * "catching_up" `engine_state_changed` has already been emitted upstream of
 * this gate.
 */
function createGatedFixtureIngestSource(
  groupId: string,
  taskEvent: TaskEvent,
  factId: string,
): { source: IngestSource; started: Promise<void>; release: () => void } {
  let releaseFn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  let startedFn!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    startedFn = resolve;
  });

  async function* gatedCatchUp(): AsyncIterable<IngestSignal> {
    startedFn();
    await gate;
    yield messageSignal(groupId, taskEvent, factId);
  }

  const source: IngestSource = {
    catchUp: () => gatedCatchUp(),
    openLive() {
      return () => {};
    },
    ingestPersisted() {
      return fromArray([]);
    },
    fetchBootstrap() {
      return fromArray([]);
    },
    close() {},
  };
  return { source, started: startedPromise, release: releaseFn };
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

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("task-store.tsx engine read path (post-S12 cutover)", () => {
  const PUBKEY = "a".repeat(64);
  let taskStoreModule: typeof import("./task-store");
  let storage: typeof import("../marmot/storage");

  beforeEach(async () => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    storage = await import("../marmot/storage");
    taskStoreModule = await import("./task-store");
    storage.bindStores(PUBKEY);
  });

  function TasksProbe({ onRender }: { onRender: (tasks: Task[], loading: boolean) => void }) {
    const { tasks, loading } = taskStoreModule.useTaskStore();
    onRender(tasks, loading);
    return null;
  }

  it(
    "a fixture task-created event delivered through the REAL engine " +
      "(scripted IngestSource) is reflected in tasks",
    async () => {
      const groupId = "group-engine";
      const fixtureTaskId = "engine-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      const ingestSourceOverride = createFixtureIngestSource([
        messageSignal(groupId, taskEvent, "engine-fact-1"),
      ]);

      let latestTasks: Task[] = [];
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={ingestSourceOverride}
          >
            <TasksProbe onRender={(tasks) => (latestTasks = tasks)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));

      expect(latestTasks.map((t) => t.id)).toEqual([fixtureTaskId]);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "CUTOVER-CORRECTNESS (S12): a task accepted+persisted in one mount is " +
      "present again after unmount/remount of the SAME group, via " +
      "loadCheckpoint routing the second mount to origin:'restored' -> " +
      "recovering (rebuilt from the durable accepted-log), NOT a re-fetched " +
      "'welcome' bootstrap",
    async () => {
      const groupId = "group-restored-origin";
      const fixtureTaskId = "restored-origin-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };

      // First mount: no checkpoint exists yet, so `engineOrigin` resolves
      // "welcome". The engine accepts the fixture task via its own ingest
      // signal and, per receive-engine.ts's checkpoint-on-transition/
      // checkpoint-on-stop behavior, durably saves a checkpoint (this test
      // is the first production-composition-root exercise of that
      // durability -- see architecture.json judgment call
      // "s12-real-persistence-adapter-wiring-required-not-optional").
      const firstIngestSource = createFixtureIngestSource([
        messageSignal(groupId, taskEvent, "restored-origin-fact-1"),
      ]);
      let firstTasks: Task[] = [];
      let firstRenderer!: ReturnType<typeof create>;
      await act(async () => {
        firstRenderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={firstIngestSource}
          >
            <TasksProbe onRender={(tasks) => (firstTasks = tasks)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });
      await waitUntil(() => firstTasks.some((t) => t.id === fixtureTaskId));
      await act(async () => {
        firstRenderer.unmount();
      });
      // `useReceiveEngine`'s cleanup calls `void engine.stop()`
      // fire-and-forget (an effect cleanup cannot be async) -- give its
      // checkpoint save a few ticks to durably land before the second
      // mount reads it back.
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await flush(10);
        });
      }

      // Second mount, SAME groupId: a fresh IngestSource whose catchUp/
      // fetchBootstrap both yield NOTHING. If the fixture task reappears,
      // it can ONLY be because the restored-origin recovery path rebuilt
      // the projection from the durable accepted-log (R1) -- there is no
      // remote signal left to re-deliver it.
      const secondIngestSource = createFixtureIngestSource([]);
      let secondTasks: Task[] = [];
      let secondRenderer!: ReturnType<typeof create>;
      await act(async () => {
        secondRenderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={secondIngestSource}
          >
            <TasksProbe onRender={(tasks) => (secondTasks = tasks)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });
      await waitUntil(() => secondTasks.some((t) => t.id === fixtureTaskId));

      expect(secondTasks.map((t) => t.id)).toEqual([fixtureTaskId]);

      await act(async () => {
        secondRenderer.unmount();
      });
    },
  );

  it(
    "S12-2: a durable accepted-log with NO checkpoint (e.g. a checkpoint " +
      "save that failed while the accepted-log append succeeded) still " +
      "routes the mount to origin:'restored' and recovers the log, rather " +
      "than origin:'welcome' losing it -- while a genuinely fresh group " +
      "(no checkpoint, no logs) correctly stays on 'welcome' and surfaces " +
      "nothing from the same empty IngestSource",
    async () => {
      const recoveredTaskId = "s12-2-recovered-task-1";
      const recoveredTaskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(recoveredTaskId),
      };

      // Seed ONLY the accepted-event log directly (bypassing loadCheckpoint
      // entirely -- no checkpoint is ever written for this group). This is
      // the IDB-partial-write scenario S12-2 defends against: an accepted
      // append landed durably, but a checkpoint save did not.
      const rawEventLogStore = await import("../persistence/raw-event-log-store");
      const groupIdWithOrphanedLog = "group-s12-2-orphaned-log-no-checkpoint";
      await rawEventLogStore.appendAcceptedEvent({
        id: "s12-2-orphaned-accepted-event-1",
        factId: "s12-2-orphaned-fact-1",
        sourceKind: "mls-rumor",
        groupId: groupIdWithOrphanedLog,
        acceptedAt: 1_700_000_000_000,
        epoch: "epoch-0",
        payload: recoveredTaskEvent,
      });

      // An IngestSource that yields NOTHING on catchUp/fetchBootstrap: if
      // the task reappears, it can ONLY be because origin:'restored' fired
      // and the engine's own Constraint-12 checkpoint-absent-but-logs-
      // present routing (receive-engine.ts start(), the
      // `rawLog.length === 0 && acceptedLog.length === 0` branch) recovered
      // it from the durable accepted-log -- there is no signal left to
      // deliver it any other way.
      const emptyIngestSource = createFixtureIngestSource([]);
      let recoveredTasks: Task[] = [];
      let recoveredRenderer!: ReturnType<typeof create>;
      await act(async () => {
        recoveredRenderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupIdWithOrphanedLog}
            engineIngestSourceOverride={emptyIngestSource}
          >
            <TasksProbe onRender={(tasks) => (recoveredTasks = tasks)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });
      await waitUntil(() => recoveredTasks.some((t) => t.id === recoveredTaskId));
      expect(recoveredTasks.map((t) => t.id)).toEqual([recoveredTaskId]);
      await act(async () => {
        recoveredRenderer.unmount();
      });

      // Control: a group with genuinely NO prior durable state (no
      // checkpoint, no logs) mounted against the SAME kind of empty
      // IngestSource must correctly stay on origin:'welcome' and surface
      // no tasks -- proving the fix didn't just make every mount route
      // 'restored' unconditionally.
      const freshGroupId = "group-s12-2-genuinely-fresh";
      const freshIngestSource = createFixtureIngestSource([]);
      let freshTasks: Task[] = [];
      let freshLoading = true;
      let freshRenderer!: ReturnType<typeof create>;
      await act(async () => {
        freshRenderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={freshGroupId}
            engineIngestSourceOverride={freshIngestSource}
          >
            <TasksProbe
              onRender={(tasks, loading) => {
                freshTasks = tasks;
                freshLoading = loading;
              }}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });
      await waitUntil(() => freshLoading === false);
      expect(freshTasks).toEqual([]);
      await act(async () => {
        freshRenderer.unmount();
      });
    },
  );

  it(
    "a create -> update -> status_changed sequence through the REAL engine " +
      "(task-projector.ts's applyEvent) converges to the expected full Task",
    async () => {
      const fixtureTaskId = "convergence-seq-task-1";
      const created: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      const updated: TaskEvent = {
        type: "task.updated",
        taskId: fixtureTaskId,
        changes: { title: "Updated title", description: "Updated description" },
        updatedAt: 1_700_000_001_000,
        updatedBy: "pk-fixture",
        updatedByDevice: "device-a",
      };
      const statusChanged: TaskEvent = {
        type: "task.status_changed",
        taskId: fixtureTaskId,
        status: "done",
        updatedAt: 1_700_000_002_000,
        updatedBy: "pk-fixture",
        updatedByDevice: "device-a",
      };
      const sequence = [created, updated, statusChanged];

      const groupId = "group-convergence-seq-engine";
      const ingestSourceOverride = createFixtureIngestSource(
        sequence.map((evt, i) =>
          messageSignal(groupId, evt, `engine-fact-convergence-seq-${i}`),
        ),
      );
      let engineTasks: Task[] = [];
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={ingestSourceOverride}
          >
            <TasksProbe onRender={(tasks) => (engineTasks = tasks)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });
      await waitUntil(
        () => engineTasks.find((t) => t.id === fixtureTaskId)?.status === "done",
      );
      const engineTask = engineTasks.find((t) => t.id === fixtureTaskId);
      await act(async () => {
        renderer.unmount();
      });

      expect(engineTask).toMatchObject({
        id: fixtureTaskId,
        title: "Updated title",
        description: "Updated description",
        status: "done",
        updatedBy: "pk-fixture",
        updatedByDevice: "device-a",
      });
    },
  );

  it(
    "the engine path reports loading=true while still catching_up (before " +
      "the projection is populated), and loading=false only once the " +
      "fixture task is actually visible",
    async () => {
      const groupId = "group-loading-semantics";
      const fixtureTaskId = "loading-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      const { source, started, release } = createGatedFixtureIngestSource(
        groupId,
        taskEvent,
        "loading-fact-1",
      );

      let latestTasks: Task[] = [];
      let latestLoading = true;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={source}
          >
            <TasksProbe
              onRender={(tasks, loading) => {
                latestTasks = tasks;
                latestLoading = loading;
              }}
            />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      // Let the engine progress through joining -> catching_up and pause
      // right there (gated before yielding the fixture signal). By the time
      // `started` resolves, "catching_up"'s engine_state_changed has already
      // committed upstream (see createGatedFixtureIngestSource's doc
      // comment).
      //
      // CUTOVER (S12): `EngineTaskBridge` no longer mounts synchronously
      // within the FIRST render -- `TaskStoreProvider`'s `engineOrigin`
      // resolution (a `loadCheckpoint` IDB round-trip) is a genuine extra
      // async hop before the bridge (and therefore the engine, and
      // therefore `catchUp()`) exists at all. A single rigid `act(async ()
      // => { await started })` block can miss that hop entirely under
      // react-test-renderer (a state update landing between two `act()`
      // calls isn't guaranteed to flush a re-render before the next `act()`
      // call's body runs). Poll instead -- same `waitUntil` idiom already
      // used elsewhere in this file, which wraps each attempt in its own
      // `act()` and so reliably observes a state update that lands between
      // polls.
      let startedResolved = false;
      started.then(() => {
        startedResolved = true;
      });
      await waitUntil(() => startedResolved);
      await act(async () => {
        await flush(20);
      });

      expect(latestLoading).toBe(true);
      expect(latestTasks.map((t) => t.id)).not.toContain(fixtureTaskId);

      release();
      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));

      expect(latestLoading).toBe(false);

      await act(async () => {
        renderer.unmount();
      });
    },
  );
});
