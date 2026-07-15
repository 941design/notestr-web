/**
 * react-engine-hooks.optimistic-local-echo.test.tsx
 *
 * S11B optimistic local echo coverage for `useReceiveEngine`'s
 * `dispatchLocal`/`confirmLocal`/`pendingTaskIds` additions (see
 * react-engine-hooks.ts's "OPTIMISTIC LOCAL ECHO (S11B)" comments). This
 * file is deliberately self-contained (its own Harness/mountHook/waitUntil
 * idiom, its own fixture builders) rather than importing from
 * react-engine-hooks.test.tsx -- that file's helpers are module-local, and
 * this repo's test files are generally self-contained by convention.
 *
 * Coverage:
 *  - AC-OPT-1: `dispatchLocal` makes a locally-authored task visible in the
 *    hook's projection on the next render, with zero signals ever delivered
 *    through the `IngestSource` (proves visibility does not depend on any
 *    ingest/relay input).
 *  - AC-OPT-4: `pendingTaskIds` gains a task id on `dispatchLocal` and loses
 *    it on the matching `confirmLocal` (self-clearing); an unrelated/unknown
 *    rumorId passed to `confirmLocal` is a silent no-op.
 *  - Multiple in-flight edits to the SAME task id: `pendingTaskIds` stays
 *    true until EVERY pending rumorId for that task is confirmed (per-task
 *    Set semantics, not a single boolean flag).
 *  - `dispatchLocal`/`confirmLocal` referential stability: `useCallback([])`
 *    means the SAME mount returns the SAME function identity across
 *    renders -- callers (`task-store.tsx`) depend on this to avoid effect
 *    thrashing.
 *  - `dispatchLocal` is a safe no-op once its mount's engine is gone
 *    (captured before unmount, called after -- `engineRef.current` is null
 *    by then).
 *
 * All tests here drive the REAL `createReceiveEngine` (not the `FakeEngine`
 * double `react-engine-hooks.test.tsx` reserves for its own fold/expose
 * suite) -- `dispatchLocal` needs a real `acceptLocal` to actually run.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";

import {
  useReceiveEngine,
  type ReceiveEngineHookState,
  type UseReceiveEngineParams,
} from "./react-engine-hooks";
import {
  createReceiveEngine,
  createRealEngineScheduler,
  type ReceiveEngine,
} from "../engine/receive-engine";
import type {
  AcceptedDomainEvent,
  EngineCheckpoint,
  IngestSignal,
  IngestSource,
  PersistenceAdapter,
  RawProtocolFact,
} from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, create } = TestRenderer;

// ---------------------------------------------------------------------------
// react-test-renderer + async-effect polling helpers (same idiom as
// react-engine-hooks.test.tsx -- see that file's comment for why `waitUntil`
// re-enters `act()` rather than a single flush).
// ---------------------------------------------------------------------------

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

function Harness(
  props: UseReceiveEngineParams & {
    onRender: (state: ReceiveEngineHookState) => void;
  },
) {
  const state = useReceiveEngine(props);
  props.onRender(state);
  return null;
}

async function mountHook(params: UseReceiveEngineParams): Promise<{
  renderer: ReturnType<typeof create>;
  latest: () => ReceiveEngineHookState;
}> {
  let latest!: ReceiveEngineHookState;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <Harness
        {...params}
        onRender={(s) => {
          latest = s;
        }}
      />,
    );
  });
  return { renderer, latest: () => latest };
}

async function unmountHook(renderer: ReturnType<typeof create>): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

// ---------------------------------------------------------------------------
// Fixture builders (mirrors react-engine-hooks.test.tsx conventions)
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function task(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    assignee: null,
    createdBy: "pk-1",
    createdAt: 1000,
    updatedAt: 1000,
    updatedBy: "pk-1",
  };
}

// ---------------------------------------------------------------------------
// Counting IngestSource -- like react-engine-hooks.test.tsx's
// createMockIngestSource, but exposes a total-signals-yielded counter
// instead of a call log: AC-OPT-1 needs to prove that dispatchLocal's
// visibility does not depend on ANY signal reaching the engine, which a
// bare "scripted empty" claim doesn't measure directly. `openLive` never
// invokes its `onSignal` callback at all (structurally cannot deliver a
// live signal), and `catchUp`/`fetchBootstrap` only ever yield whatever was
// explicitly scripted -- nothing, in every test below.
// ---------------------------------------------------------------------------

interface CountingIngestSource {
  source: IngestSource;
  scriptCatchUp(signals: IngestSignal[]): void;
  scriptFetchBootstrap(signals: IngestSignal[]): void;
  signalsYieldedCount: () => number;
}

function createCountingIngestSource(): CountingIngestSource {
  let catchUpSignals: IngestSignal[] = [];
  let fetchBootstrapSignals: IngestSignal[] = [];
  let count = 0;

  async function* countedFromArray(
    items: readonly IngestSignal[],
  ): AsyncIterable<IngestSignal> {
    for (const item of items) {
      count += 1;
      yield item;
    }
  }

  const source: IngestSource = {
    catchUp() {
      return countedFromArray(catchUpSignals);
    },
    openLive() {
      return () => {};
    },
    ingestPersisted() {
      return countedFromArray([]);
    },
    fetchBootstrap() {
      return countedFromArray(fetchBootstrapSignals);
    },
    close() {},
  };

  return {
    source,
    scriptCatchUp(signals) {
      catchUpSignals = signals;
    },
    scriptFetchBootstrap(signals) {
      fetchBootstrapSignals = signals;
    },
    signalsYieldedCount: () => count,
  };
}

// ---------------------------------------------------------------------------
// In-memory PersistenceAdapter (same shape as
// react-engine-hooks.test.tsx's createInMemoryPersistenceAdapter) -- none of
// these tests exercise the real S4 store, only dispatchLocal/confirmLocal's
// own bookkeeping plus a real engine's acceptLocal.
// ---------------------------------------------------------------------------

function createInMemoryPersistenceAdapter(): PersistenceAdapter {
  const facts = new Map<string, RawProtocolFact[]>();
  const acceptedEvents = new Map<string, AcceptedDomainEvent[]>();
  const checkpoints = new Map<string, EngineCheckpoint>();
  const deferredIds = new Map<string, string[]>();

  const adapter: PersistenceAdapter = {
    async appendFact(fact) {
      const list = facts.get(fact.groupId) ?? [];
      const found = list.find((f) => f.id === fact.id);
      if (found) return { fact: found, duplicate: true };
      const seq = list.length === 0 ? 1 : list[list.length - 1].seq + 1;
      const newFact: RawProtocolFact = { ...fact, seq };
      facts.set(fact.groupId, [...list, newFact]);
      return { fact: newFact, duplicate: false };
    },
    async loadFacts(groupId) {
      return [...(facts.get(groupId) ?? [])].sort((a, b) => a.seq - b.seq);
    },
    async appendAcceptedEvent(event) {
      const list = acceptedEvents.get(event.groupId) ?? [];
      if (list.some((e) => e.id === event.id)) return;
      acceptedEvents.set(event.groupId, [...list, event]);
    },
    async loadAcceptedEvents(groupId) {
      return [...(acceptedEvents.get(groupId) ?? [])];
    },
    async saveCheckpoint(checkpoint) {
      checkpoints.set(checkpoint.groupId, checkpoint);
    },
    async loadCheckpoint(groupId) {
      return checkpoints.get(groupId) ?? null;
    },
    async saveDeferredIds(groupId, ids) {
      deferredIds.set(groupId, [...ids]);
    },
    async loadDeferredIds(groupId) {
      return [...(deferredIds.get(groupId) ?? [])];
    },
    async acceptDeferredFact(groupId, factId, event) {
      await adapter.appendAcceptedEvent(event);
      const ids = deferredIds.get(groupId) ?? [];
      deferredIds.set(
        groupId,
        ids.filter((id) => id !== factId),
      );
    },
    async clearGroupState(groupId) {
      facts.delete(groupId);
      acceptedEvents.delete(groupId);
      checkpoints.delete(groupId);
      deferredIds.delete(groupId);
    },
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// setupLiveEngine -- mounts the hook against a REAL createReceiveEngine with
// an empty-scripted CountingIngestSource, waits for lifecycle "live", and
// hands back everything a dispatchLocal/confirmLocal test needs.
// ---------------------------------------------------------------------------

async function setupLiveEngine(groupId: string): Promise<{
  renderer: ReturnType<typeof create>;
  latest: () => ReceiveEngineHookState;
  signalsYieldedCount: () => number;
}> {
  const persistence = createInMemoryPersistenceAdapter();
  const ingest = createCountingIngestSource();
  ingest.scriptCatchUp([]);
  ingest.scriptFetchBootstrap([]);

  function createEngine(): ReceiveEngine {
    return createReceiveEngine({
      groupId,
      adapter: ingest.source,
      persistence,
      scheduler: createRealEngineScheduler(),
    });
  }

  const { renderer, latest } = await mountHook({
    groupId,
    persistence,
    createEngine,
    startOptions: { origin: "welcome" },
  });
  await waitUntil(() => latest().engineState.lifecycle === "live");

  return { renderer, latest, signalsYieldedCount: ingest.signalsYieldedCount };
}

// ---------------------------------------------------------------------------
// AC-OPT-1
// ---------------------------------------------------------------------------

describe("AC-OPT-1: dispatchLocal reflects a locally-dispatched task immediately via the hook", () => {
  it("accepts a locally-authored task.created and the next render's projection contains it, with zero ingest signals ever delivered", async () => {
    const groupId = "group-opt1";
    const { renderer, latest, signalsYieldedCount } =
      await setupLiveEngine(groupId);

    expect(latest().projection.size).toBe(0);
    expect(latest().dispatchLocal).toBeDefined();

    const newTask = task("opt1-task");
    const payload: TaskEvent = { type: "task.created", task: newTask };
    let settled = false;

    await act(async () => {
      await latest()
        .dispatchLocal!("rumor-opt1", payload)
        .then(() => {
          settled = true;
        });
    });

    expect(settled).toBe(true);
    expect(latest().projection.has(newTask.id)).toBe(true);
    expect(latest().projection.get(newTask.id)).toEqual(newTask);

    // Immediate visibility does not depend on any ingest/relay input: this
    // counter can only be nonzero if a signal actually flowed through
    // catchUp/fetchBootstrap (both scripted empty) or openLive (structurally
    // never invokes its callback) -- it never does here.
    expect(signalsYieldedCount()).toBe(0);

    await unmountHook(renderer);
  });
});

// ---------------------------------------------------------------------------
// AC-OPT-4
// ---------------------------------------------------------------------------

describe("AC-OPT-4: pendingTaskIds tracks dispatchLocal until the matching confirmLocal (self-clearing)", () => {
  it("marks the task id pending after dispatchLocal and clears it after confirmLocal", async () => {
    const groupId = "group-opt4";
    const { renderer, latest } = await setupLiveEngine(groupId);

    const newTask = task("opt4-task");
    const payload: TaskEvent = { type: "task.created", task: newTask };
    const rumorId = "rumor-opt4";

    await act(async () => {
      await latest().dispatchLocal!(rumorId, payload);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(true);

    await act(async () => {
      latest().confirmLocal!(rumorId);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(false);

    await unmountHook(renderer);
  });

  it("S11B-Fable-1: confirmLocal does not leak pendingByTaskRef/rumorToTaskRef -- a repeat confirmLocal for an already-cleared rumorId is a silent no-op, and the taskId is fully gone from pendingTaskIds", async () => {
    // confirmLocal itself is outcome-agnostic (react-engine-hooks.ts owns no
    // outbox state and does not know WHY a rumorId cleared -- reconciled,
    // failed, or cap-evicted are all indistinguishable from here), so
    // driving it directly exercises the same ref-Map cleanup path
    // publish-outbox.ts's broadened onPendingCleared now triggers on all
    // three terminal outcomes, not only reconciliation.
    const groupId = "group-opt4-noleak";
    const { renderer, latest } = await setupLiveEngine(groupId);

    const newTask = task("opt4-noleak-task");
    const payload: TaskEvent = { type: "task.created", task: newTask };
    const rumorId = "rumor-opt4-noleak";

    await act(async () => {
      await latest().dispatchLocal!(rumorId, payload);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(true);

    await act(async () => {
      latest().confirmLocal!(rumorId);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(false);

    // A second confirmLocal for the SAME (now-cleared) rumorId must not
    // throw and must not resurrect the task id -- if pendingByTaskRef or
    // rumorToTaskRef had retained a stale entry, this could either throw
    // (double-delete on a Set that no longer exists) or leave a dangling
    // membership a LATER dispatchLocal on the same task id could collide
    // with.
    await act(async () => {
      latest().confirmLocal!(rumorId);
      await flush(0);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(false);

    // A FRESH dispatchLocal for the same task id, with a NEW rumorId,
    // proves the prior rumorId left no residue behind: pending membership
    // reflects only the new in-flight edit, and clearing THAT one (and only
    // that one) is what clears the task id again.
    const secondRumorId = "rumor-opt4-noleak-2";
    await act(async () => {
      await latest().dispatchLocal!(secondRumorId, {
        type: "task.updated",
        taskId: newTask.id,
        changes: { title: "second edit" },
        updatedAt: 2000,
        updatedBy: "pk-1",
      });
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(true);

    await act(async () => {
      latest().confirmLocal!(secondRumorId);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(false);

    await unmountHook(renderer);
  });

  it("confirmLocal with an unrelated/unknown rumorId is a silent no-op", async () => {
    const groupId = "group-opt4-noop";
    const { renderer, latest } = await setupLiveEngine(groupId);

    const newTask = task("opt4-noop-task");
    const payload: TaskEvent = { type: "task.created", task: newTask };
    const rumorId = "rumor-opt4-noop";

    await act(async () => {
      await latest().dispatchLocal!(rumorId, payload);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(true);

    // An unknown rumorId must not throw and must not perturb pendingTaskIds
    // -- if this threw, act()'s awaited callback would reject and fail the
    // test, so no try/catch is needed to prove "does not throw".
    await act(async () => {
      latest().confirmLocal!("totally-unrelated-unknown-rumor-id");
      await flush(0);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(true);

    await unmountHook(renderer);
  });
});

// ---------------------------------------------------------------------------
// Multiple in-flight edits to the SAME task
// ---------------------------------------------------------------------------

describe("Multiple in-flight edits to the same task", () => {
  it("pendingTaskIds stays true until BOTH pending rumorIds for that task are confirmed", async () => {
    const groupId = "group-multi";
    const { renderer, latest } = await setupLiveEngine(groupId);

    const newTask = task("multi-task");
    const createPayload: TaskEvent = { type: "task.created", task: newTask };
    const updatePayload: TaskEvent = {
      type: "task.updated",
      taskId: newTask.id,
      changes: { title: "Updated title" },
      updatedAt: 2000,
      updatedBy: "pk-1",
    };
    const rumorCreate = "rumor-multi-create";
    const rumorUpdate = "rumor-multi-update";

    await act(async () => {
      await latest().dispatchLocal!(rumorCreate, createPayload);
    });
    await act(async () => {
      await latest().dispatchLocal!(rumorUpdate, updatePayload);
    });

    expect(latest().pendingTaskIds.has(newTask.id)).toBe(true);
    expect(latest().projection.get(newTask.id)?.title).toBe("Updated title");

    await act(async () => {
      latest().confirmLocal!(rumorCreate);
    });
    // Still pending: the update's rumorId is unconfirmed -- this is the
    // decisive proof that pendingTaskIds is a per-task SET, not a single
    // boolean flag that would have cleared on the first confirmLocal call.
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(true);

    await act(async () => {
      latest().confirmLocal!(rumorUpdate);
    });
    expect(latest().pendingTaskIds.has(newTask.id)).toBe(false);

    await unmountHook(renderer);
  });
});

// ---------------------------------------------------------------------------
// Referential stability
// ---------------------------------------------------------------------------

describe("dispatchLocal/confirmLocal are referentially stable across renders", () => {
  it("returns the SAME function identity before and after a projection-changing render", async () => {
    const groupId = "group-stable-fns";
    const { renderer, latest } = await setupLiveEngine(groupId);

    const dispatchBefore = latest().dispatchLocal;
    const confirmBefore = latest().confirmLocal;
    expect(dispatchBefore).toBeDefined();
    expect(confirmBefore).toBeDefined();

    // Drive a render via dispatchLocal itself (any state update that causes
    // a re-render proves the point equally well; this reuses machinery
    // already under test in this file).
    const newTask = task("stable-fns-task");
    await act(async () => {
      await latest().dispatchLocal!("rumor-stable-fns", {
        type: "task.created",
        task: newTask,
      });
    });
    expect(latest().projection.has(newTask.id)).toBe(true); // proves a render actually happened

    expect(latest().dispatchLocal).toBe(dispatchBefore);
    expect(latest().confirmLocal).toBe(confirmBefore);

    await unmountHook(renderer);
  });
});

// ---------------------------------------------------------------------------
// Safe no-op once the mount's engine is gone
// ---------------------------------------------------------------------------

describe("dispatchLocal is a safe no-op once its mount's engine is gone", () => {
  it("resolves without throwing when called (with a captured reference) after the hook has unmounted", async () => {
    const groupId = "group-postunmount";
    const { renderer, latest } = await setupLiveEngine(groupId);

    const capturedDispatch = latest().dispatchLocal;
    expect(capturedDispatch).toBeDefined();

    await unmountHook(renderer);

    // engineRef.current is now null (cleared in the effect's cleanup) --
    // dispatchLocal must no-op rather than reach a stopped engine.
    await expect(
      capturedDispatch!("rumor-postunmount", {
        type: "task.created",
        task: task("postunmount-task"),
      }),
    ).resolves.toBeUndefined();
  });
});
