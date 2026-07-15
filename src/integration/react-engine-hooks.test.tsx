/**
 * react-engine-hooks.test.tsx
 *
 * Coverage:
 *  - AC-INV-4 (the primary integration proof): drives the REAL
 *    `createReceiveEngine` (S5/S6) through a mock `IngestSource` to produce
 *    REAL `domain_event_accepted` outputs, persists them through the REAL S4
 *    `src/persistence/raw-event-log-store.ts` (fake-indexeddb-backed), and
 *    asserts the hook's incrementally-folded projection deep-equals an
 *    independently-computed `buildProjection(replayOrder(loadAcceptedEvents()))`.
 *    A `loadAcceptedEvents` call-count assertion is the "evidence" that the
 *    incremental path actually ran `applyEvent` per event rather than a
 *    hidden full-rebuild masquerading as incremental (a per-event rebuild
 *    would make the call count scale with the event count; the real
 *    implementation's hook-attributed count stays fixed at 1 regardless).
 *    This is also this story's recorded drift-guard obligation for the
 *    S5/S6 test-mock
 *    replicas (receive-engine.fsm.test.ts / receive-engine.cutover.property.test.ts
 *    both say "the engine is not exercised against the real store until the
 *    S8/S9 integration layer" — this is that promised exercise).
 *  - AC-BOUND-5 (the runtime half — the grep half lives in
 *    adapter-lifecycle.structural.test.ts): unmounts the hook and asserts
 *    `engine.stop` was called exactly once, with the mock adapter's `close`
 *    call the LAST entry in its call log (call-order assertion), proving
 *    Boundary Rule 10's "adapter.close() as stop()'s final adapter-observable
 *    action" from the outside.
 *  - VQ-S8-006 (pre-impl commitment): two independent mount/unmount cycles
 *    each call `engine.stop()` exactly once — never zero, never doubled.
 *  - Hook-logic tests using a lightweight fake `ReceiveEngine` test double
 *    (receive-engine.ts's own FSM correctness is S5/S6's job, not
 *    re-litigated here): `engine_state_changed` mapped verbatim, the
 *    mount-time "restart" persistence seed, `projection_invalidated`
 *    triggering a fresh rebuild, and graceful handling of every
 *    `domain_event_rejected` reason (the ledger's "S8 UI must handle all
 *    four + unknown gracefully" handoff) plus every other
 *    `EngineOutputEvent` variant without crashing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { IDBFactory } from "fake-indexeddb";

import {
  classifyRejectionReason,
  useReceiveEngine,
  type ReceiveEngineHookState,
  type RejectionReasonKind,
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
  EngineOutputEvent,
  IngestSignal,
  IngestSource,
  NostrEvent,
  PersistenceAdapter,
  RawProtocolFact,
  RawProtocolFactInput,
} from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";
import {
  buildProjection,
  replayOrder,
  type TaskProjection,
} from "../domain/task-projector";

// storage.ts (imported transitively by raw-event-log-store.ts) imports
// generateKeyPackageSlot from marmot-ts; stub it so the module resolves in
// the node test env without pulling the real fork -- same idiom as
// src/persistence/raw-event-log-store.test.ts.
vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, create } = TestRenderer;

// ---------------------------------------------------------------------------
// react-test-renderer + async-effect polling helpers
// ---------------------------------------------------------------------------
//
// react-test-renderer defers a hook-bearing component's initial render past
// the synchronous portion of even an async `act()` callback (verified
// empirically while building this test file) -- state updates driven by
// this hook's asynchronous engine subscription only become observable after
// `act()` has had a chance to flush a subsequent microtask/timer tick.
// `waitUntil` repeatedly re-enters `act()` with a short real-timer flush
// until `predicate` passes, which is the pattern proven to work without
// spurious "not wrapped in act(...)" warnings.

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

/** Same as `mountHook`, wrapped in `<React.StrictMode>` -- F4 (Stage-1 cold
 *  review): pins the actual dev double-invoke scenario VQ-S8-006 names
 *  (mount -> cleanup -> mount), rather than only approximating it via two
 *  independent sequential mount/unmount cycles. */
async function mountHookStrict(params: UseReceiveEngineParams): Promise<{
  renderer: ReturnType<typeof create>;
  latest: () => ReceiveEngineHookState;
}> {
  let latest!: ReceiveEngineHookState;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <React.StrictMode>
        <Harness
          {...params}
          onRender={(s) => {
            latest = s;
          }}
        />
      </React.StrictMode>,
    );
  });
  return { renderer, latest: () => latest };
}

// ---------------------------------------------------------------------------
// Fixture builders (mirrors src/engine/receive-engine.fsm.test.ts conventions)
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function nostrEvent(id: string): NostrEvent {
  return {
    id,
    pubkey: "pk-1",
    created_at: 1_700_000_000,
    kind: 445,
    tags: [],
    content: "ciphertext",
    sig: "sig",
  };
}

function factInput(id: string, groupId: string): RawProtocolFactInput {
  return {
    id,
    groupId,
    nostrEventId: id,
    nostrEvent: nostrEvent(id),
    receivedAt: 1_700_000_000_000,
    receiptSource: "historical",
    epochAtReceipt: "epoch-0",
  };
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

function messageSignal(opts: { groupId: string; taskId?: string }): IngestSignal {
  const taskId = opts.taskId ?? nextId("task");
  const factId = nextId("fact");
  const payload: TaskEvent = { type: "task.created", task: task(taskId) };
  return {
    type: "message",
    fact: factInput(factId, opts.groupId),
    rumorId: nextId("rumor"),
    payload,
    epoch: "epoch-0",
    receiptSource: "historical",
  };
}

/** Like `messageSignal`, but carries an arbitrary `TaskEvent` payload --
 *  `messageSignal` only ever produces `task.created` -- so callers can build
 *  an order-sensitive mixed log (F5: created/updated/deleted). */
function messageSignalWithPayload(groupId: string, payload: TaskEvent): IngestSignal {
  const factId = nextId("fact");
  return {
    type: "message",
    fact: factInput(factId, groupId),
    rumorId: nextId("rumor"),
    payload,
    epoch: "epoch-0",
    receiptSource: "historical",
  };
}

async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Mock IngestSource -- trimmed from receive-engine.fsm.test.ts's fuller
// scriptable version to only what this file's tests need.
// ---------------------------------------------------------------------------

type CallLogEntry = {
  method: "openLive" | "catchUp" | "ingestPersisted" | "fetchBootstrap" | "close";
  seq: number;
};

interface MockIngestSource {
  source: IngestSource;
  callLog: CallLogEntry[];
  scriptCatchUp(signals: IngestSignal[]): void;
  scriptFetchBootstrap(signals: IngestSignal[]): void;
  closeCallCount(): number;
}

function createMockIngestSource(): MockIngestSource {
  let seq = 0;
  const callLog: CallLogEntry[] = [];
  let catchUpSignals: IngestSignal[] = [];
  let fetchBootstrapSignals: IngestSignal[] = [];
  let closeCallCount = 0;

  const source: IngestSource = {
    catchUp() {
      callLog.push({ method: "catchUp", seq: seq++ });
      return fromArray(catchUpSignals);
    },
    openLive() {
      callLog.push({ method: "openLive", seq: seq++ });
      // openLive() itself IS logged above. Only the unsubscribe callback it
      // returns is deliberately NOT logged (mirrors
      // receive-engine.fsm.test.ts's mock) -- this makes "close" provably
      // the LAST *logged* adapter call whenever stop() runs, which is
      // exactly AC-BOUND-5's call-order observable.
      return () => {};
    },
    ingestPersisted() {
      callLog.push({ method: "ingestPersisted", seq: seq++ });
      return fromArray([]);
    },
    fetchBootstrap() {
      callLog.push({ method: "fetchBootstrap", seq: seq++ });
      return fromArray(fetchBootstrapSignals);
    },
    close() {
      callLog.push({ method: "close", seq: seq++ });
      closeCallCount += 1;
    },
  };

  return {
    source,
    callLog,
    scriptCatchUp(signals) {
      catchUpSignals = signals;
    },
    scriptFetchBootstrap(signals) {
      fetchBootstrapSignals = signals;
    },
    closeCallCount: () => closeCallCount,
  };
}

// ---------------------------------------------------------------------------
// Lightweight in-memory PersistenceAdapter -- for tests that don't need the
// real S4 store (AC-BOUND-5's unmount-ordering test is not about
// projection correctness).
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
// Fake ReceiveEngine test double -- receive-engine.ts's own FSM conformance
// is exhaustively covered by S5/S6 (receive-engine.fsm.test.ts et al.); the
// tests below exercise ONLY this hook's own subscribe/fold/expose logic
// against a controllable double.
// ---------------------------------------------------------------------------

interface FakeEngine {
  engine: ReceiveEngine;
  emit(event: EngineOutputEvent): void;
  startCallCount(): number;
  stopCallCount(): number;
}

function createFakeEngine(): FakeEngine {
  const listeners = new Set<(e: EngineOutputEvent) => void>();
  let lifecycle: "uninitialized" | "live" | "stopped" = "uninitialized";
  let startCallCount = 0;
  let stopCallCount = 0;

  const engine: ReceiveEngine = {
    async start() {
      if (lifecycle !== "uninitialized") {
        throw new Error("fake engine: start() only callable from uninitialized");
      }
      startCallCount += 1;
      lifecycle = "live";
    },
    async stop() {
      stopCallCount += 1;
      lifecycle = "stopped";
    },
    async reset() {
      lifecycle = "uninitialized";
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() {
      return {
        lifecycle: lifecycle === "live" ? "live" : lifecycle === "stopped" ? "stopped" : "uninitialized",
        health: "nominal",
      };
    },
    // S11B: not exercised by this file's fold/expose-focused suite (see
    // react-engine-hooks.optimistic-local-echo.test.tsx for acceptLocal
    // coverage against the REAL engine) -- a no-op satisfies the interface.
    async acceptLocal() {},
  };

  return {
    engine,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    startCallCount: () => startCallCount,
    stopCallCount: () => stopCallCount,
  };
}

function acceptedEvent(
  groupId: string,
  taskId: string,
  overrides: Partial<AcceptedDomainEvent> = {},
): AcceptedDomainEvent {
  const factId = nextId("fact");
  return {
    id: nextId("accepted"),
    factId,
    sourceKind: "mls-rumor",
    groupId,
    acceptedAt: 1000,
    epoch: "epoch-0",
    payload: { type: "task.created", task: task(taskId) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyRejectionReason (pure function)
// ---------------------------------------------------------------------------

describe("classifyRejectionReason", () => {
  const cases: Array<[string, RejectionReasonKind]> = [
    ["parse_error", "parse_error"],
    ["retry-exhausted", "retry-exhausted"],
    ["deferred-ttl-expired", "deferred-ttl-expired"],
    ["persistence-exhausted", "persistence-exhausted"],
    ["some-future-reason-nobody-has-invented-yet", "unknown"],
    ["", "unknown"],
  ];

  for (const [reason, expected] of cases) {
    it(`classifies ${JSON.stringify(reason)} as ${expected}`, () => {
      expect(classifyRejectionReason(reason)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Hook-logic tests against the fake engine
// ---------------------------------------------------------------------------

describe("useReceiveEngine (fake engine): lifecycle/health exposure", () => {
  it("engineState is set verbatim from engine_state_changed (VQ-S8-005)", async () => {
    const groupId = "group-state";
    const persistence = createInMemoryPersistenceAdapter();
    const fake = createFakeEngine();

    const { renderer, latest } = await mountHook({
      groupId,
      persistence,
      createEngine: () => fake.engine,
      startOptions: { origin: "welcome" },
    });

    await waitUntil(() => fake.startCallCount() === 1);
    expect(latest().engineState).toEqual({ lifecycle: "uninitialized", health: "nominal" });

    await act(async () => {
      fake.emit({
        type: "engine_state_changed",
        groupId,
        state: "buffering_live",
        health: "degraded",
      });
    });
    expect(latest().engineState).toEqual({ lifecycle: "buffering_live", health: "degraded" });

    await unmountHook(renderer);
  });
});

describe("useReceiveEngine (fake engine): domain_event_rejected surfaces gracefully for every known reason plus unknown", () => {
  const reasons: string[] = [
    "parse_error",
    "retry-exhausted",
    "deferred-ttl-expired",
    "persistence-exhausted",
    "a-totally-novel-reason",
  ];

  for (const reason of reasons) {
    it(`renders without crashing and exposes lastRejection for reason=${reason}`, async () => {
      const groupId = "group-reject";
      const persistence = createInMemoryPersistenceAdapter();
      const fake = createFakeEngine();

      const { renderer, latest } = await mountHook({
        groupId,
        persistence,
        createEngine: () => fake.engine,
        startOptions: { origin: "welcome" },
      });
      await waitUntil(() => fake.startCallCount() === 1);

      await act(async () => {
        fake.emit({
          type: "domain_event_rejected",
          factId: "fact-x",
          groupId,
          reason,
        });
      });

      expect(latest().lastRejection).toEqual({
        factId: "fact-x",
        groupId,
        reason,
        reasonKind: classifyRejectionReason(reason),
      });

      await unmountHook(renderer);
    });
  }

  it("never throws across all ten EngineOutputEvent variants in sequence", async () => {
    const groupId = "group-exhaustive";
    const persistence = createInMemoryPersistenceAdapter();
    const fake = createFakeEngine();

    const { renderer } = await mountHook({
      groupId,
      persistence,
      createEngine: () => fake.engine,
      startOptions: { origin: "welcome" },
    });
    await waitUntil(() => fake.startCallCount() === 1);

    const allVariants: EngineOutputEvent[] = [
      { type: "envelope_received", factId: "f1", groupId },
      { type: "envelope_deferred", factId: "f1", groupId, reason: "unreadable" },
      { type: "domain_event_accepted", event: acceptedEvent(groupId, "t1") },
      { type: "domain_event_rejected", factId: "f2", groupId, reason: "parse_error" },
      { type: "projection_invalidated", groupId },
      { type: "group_epoch_advanced", groupId, newEpoch: "epoch-1", prevEpoch: "epoch-0" },
      { type: "group_ratchet_advanced", groupId },
      { type: "engine_state_changed", groupId, state: "live", health: "nominal" },
      { type: "deferred_retry_started", groupId, count: 1 },
      { type: "recovered", groupId },
    ];

    for (const event of allVariants) {
      await act(async () => {
        fake.emit(event);
        await flush(0);
      });
    }

    await unmountHook(renderer);
  });
});

describe("useReceiveEngine (fake engine): restart seed and projection_invalidated rebuild", () => {
  it("seeds the projection from persistence.loadAcceptedEvents at mount (the 'restart' case)", async () => {
    const groupId = "group-restart";
    const persistence = createInMemoryPersistenceAdapter();
    // Simulate a previous session's already-durable accepted-event log.
    await persistence.appendAcceptedEvent(acceptedEvent(groupId, "pre-existing-1"));
    await persistence.appendAcceptedEvent(acceptedEvent(groupId, "pre-existing-2"));

    const fake = createFakeEngine();
    const { renderer, latest } = await mountHook({
      groupId,
      persistence,
      createEngine: () => fake.engine,
      startOptions: { origin: "restored" },
    });

    await waitUntil(() => latest().projection.size === 2);
    expect([...latest().projection.keys()].sort()).toEqual([
      "pre-existing-1",
      "pre-existing-2",
    ]);

    await unmountHook(renderer);
  });

  it("projection_invalidated triggers a fresh persistence-backed rebuild (buildProjection, not applyEvent)", async () => {
    const groupId = "group-invalidate";
    const persistence = createInMemoryPersistenceAdapter();
    const fake = createFakeEngine();

    const { renderer, latest } = await mountHook({
      groupId,
      persistence,
      createEngine: () => fake.engine,
      startOptions: { origin: "welcome" },
    });
    await waitUntil(() => fake.startCallCount() === 1);
    expect(latest().projection.size).toBe(0);

    // Persist new events OUT OF BAND (as if another path wrote them), then
    // invalidate -- only a full rebuild from persistence can pick these up,
    // since no domain_event_accepted was ever emitted for them.
    await persistence.appendAcceptedEvent(acceptedEvent(groupId, "invalidated-1"));
    await persistence.appendAcceptedEvent(acceptedEvent(groupId, "invalidated-2"));

    await act(async () => {
      fake.emit({ type: "projection_invalidated", groupId });
    });

    await waitUntil(() => latest().projection.size === 2);
    expect([...latest().projection.keys()].sort()).toEqual([
      "invalidated-1",
      "invalidated-2",
    ]);

    await unmountHook(renderer);
  });
});

// ---------------------------------------------------------------------------
// F1 (Stage-1 cold review, sev-6): a domain_event_accepted racing an
// in-flight projection_invalidated rebuild must not be dropped by the
// rebuild's own (later-resolving) commit. This is the S11 recovery / R3
// crash-gap-replay shape: projection_invalidated followed by
// domain_event_accepted for the gap-tail facts.
// ---------------------------------------------------------------------------

describe("F1 regression: domain_event_accepted racing an in-flight projection_invalidated rebuild", () => {
  it("is not dropped when it arrives before the rebuild's persistence load resolves", async () => {
    const groupId = "group-race";
    const basePersistence = createInMemoryPersistenceAdapter();

    let releaseLoad: (() => void) | undefined;
    let loadAcceptedEventsCallCount = 0;
    const persistence: PersistenceAdapter = {
      ...basePersistence,
      async loadAcceptedEvents(gid) {
        loadAcceptedEventsCallCount += 1;
        // Only gate the SECOND call (the projection_invalidated rebuild
        // triggered below) -- the mount-time restart seed (first call) must
        // resolve immediately so the hook settles before the race begins.
        if (loadAcceptedEventsCallCount === 2) {
          await new Promise<void>((resolve) => {
            releaseLoad = resolve;
          });
        }
        return basePersistence.loadAcceptedEvents(gid);
      },
    };

    const fake = createFakeEngine();
    const { renderer, latest } = await mountHook({
      groupId,
      persistence,
      createEngine: () => fake.engine,
      startOptions: { origin: "welcome" },
    });
    await waitUntil(() => fake.startCallCount() === 1);
    expect(loadAcceptedEventsCallCount).toBe(1); // mount-time restart seed only, so far

    // Trigger the rebuild -- its loadAcceptedEvents call is now in flight
    // and gated on `releaseLoad`.
    await act(async () => {
      fake.emit({ type: "projection_invalidated", groupId });
      await flush(0);
    });
    expect(loadAcceptedEventsCallCount).toBe(2);
    expect(releaseLoad).toBeDefined();

    // While the rebuild's load is still in flight, an ordinary
    // domain_event_accepted arrives via the incremental fold path (the R3
    // gap-tail-fact shape).
    const racingEvent = acceptedEvent(groupId, "race-task");
    await act(async () => {
      fake.emit({ type: "domain_event_accepted", event: racingEvent });
    });
    expect(latest().projection.has("race-task")).toBe(true);

    // Now let the rebuild's load resolve. Persistence has NOTHING durable
    // for this group (basePersistence was never written to) -- a naive
    // unconditional overwrite (the pre-fix behavior) would wipe the racing
    // event out of the projection entirely. It must survive.
    await act(async () => {
      releaseLoad?.();
      await flush(0);
    });

    expect(latest().projection.has("race-task")).toBe(true);
    expect(latest().projection.size).toBe(1);

    await unmountHook(renderer);
  });
});

// ---------------------------------------------------------------------------
// F1 (Stage-2 cold review, sev-5 BLOCKER): persistence-READ failures must be
// handled, not leaked as unhandled rejections. Distinct from the F1 above
// (Stage-1 round, sev-6, rebuild-vs-accept race) -- this is a later review
// round's finding that happens to reuse the "F1" label.
// ---------------------------------------------------------------------------

describe("F1 (Stage-2 cold review, sev-5 BLOCKER): persistence read failures are handled gracefully", () => {
  it("a rejecting mount-time seed still lets engine.start() run (the hook is not permanently dead)", async () => {
    const groupId = "group-f1-mount-seed-fail";
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const persistence: PersistenceAdapter = {
      ...createInMemoryPersistenceAdapter(),
      async loadAcceptedEvents(): Promise<AcceptedDomainEvent[]> {
        throw new Error("simulated IDB read failure (mount seed)");
      },
    };
    const fake = createFakeEngine();

    const { renderer, latest } = await mountHook({
      groupId,
      persistence,
      createEngine: () => fake.engine,
      startOptions: { origin: "welcome" },
    });

    // Before the F1 fix, the seed's rejection was an unhandled rejection
    // that never resolved `boot()`'s await -- `engine.start()` was never
    // reached and the hook stayed stuck at EMPTY_PROJECTION /
    // lifecycle "uninitialized" forever.
    await waitUntil(() => fake.startCallCount() === 1);
    expect(fake.startCallCount()).toBe(1);
    expect(latest().projection.size).toBe(0); // seed failed: no crash, empty projection
    expect(consoleErrorSpy).toHaveBeenCalled();

    await unmountHook(renderer);
    consoleErrorSpy.mockRestore();
  });

  it("a projection_invalidated rebuild whose load rejects clears activeRebuildGeneration so a subsequent domain_event_accepted still folds normally", async () => {
    const groupId = "group-f1-rebuild-fail";
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const basePersistence = createInMemoryPersistenceAdapter();
    let loadCallCount = 0;
    const persistence: PersistenceAdapter = {
      ...basePersistence,
      async loadAcceptedEvents(gid) {
        loadCallCount += 1;
        // Call 1 is the mount-time seed (must succeed so the hook settles
        // before the race under test begins). Call 2 is the
        // projection_invalidated rebuild under test -- it rejects.
        if (loadCallCount === 2) {
          throw new Error("simulated IDB read failure (rebuild)");
        }
        return basePersistence.loadAcceptedEvents(gid);
      },
    };
    const fake = createFakeEngine();

    const { renderer, latest } = await mountHook({
      groupId,
      persistence,
      createEngine: () => fake.engine,
      startOptions: { origin: "welcome" },
    });
    await waitUntil(() => fake.startCallCount() === 1);
    expect(latest().projection.size).toBe(0);

    await act(async () => {
      fake.emit({ type: "projection_invalidated", groupId });
      await flush(0);
    });
    // The rebuild's load rejected -- currentProjection must be left
    // untouched (no crash, no wipe) rather than overwritten with a partial
    // or garbage result.
    expect(latest().projection.size).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();

    // Decisive proof that `activeRebuildGeneration` was cleared (not left
    // stuck non-null "forever", which -- pre-fix -- would still commit this
    // fold via `foldAccepted`'s unconditional `commitProjection` call but
    // would ALSO silently queue every subsequent domain_event_accepted into
    // an ever-growing `eventsSinceRebuildStart` for the rest of the mount
    // instead of ever being cleared/replayed again). The externally
    // observable half of that contract -- the incremental fold path keeps
    // working exactly as if no rebuild had ever been attempted -- is
    // asserted below; the queue-reset itself is the direct, reviewed effect
    // of clearing `activeRebuildGeneration` in the same branch (see the
    // implementation's read-failure catch block).
    const event = acceptedEvent(groupId, "post-failure-task");
    await act(async () => {
      fake.emit({ type: "domain_event_accepted", event });
    });
    expect(latest().projection.has("post-failure-task")).toBe(true);
    expect(latest().projection.size).toBe(1);

    await unmountHook(renderer);
    consoleErrorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC-BOUND-5 (runtime half): unmount -> engine.stop() exactly once, with
// adapter.close() the last logged adapter call.
// ---------------------------------------------------------------------------

describe("AC-BOUND-5 (runtime): unmount calls engine.stop() exactly once, adapter.close() last", () => {
  it("unmounts the hook and asserts stop()/close() call-order on a mock adapter", async () => {
    const groupId = "group-bound5";
    const mockAdapter = createMockIngestSource();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    const persistence = createInMemoryPersistenceAdapter();

    let capturedEngine: ReceiveEngine | undefined;
    let stopCallCount = 0;
    function createEngine(): ReceiveEngine {
      const engine = createReceiveEngine({
        groupId,
        adapter: mockAdapter.source,
        persistence,
        scheduler: createRealEngineScheduler(),
      });
      const realStop = engine.stop.bind(engine);
      engine.stop = async () => {
        stopCallCount += 1;
        return realStop();
      };
      capturedEngine = engine;
      return engine;
    }

    const { renderer, latest } = await mountHook({
      groupId,
      persistence,
      createEngine,
      startOptions: { origin: "welcome" },
    });

    await waitUntil(() => latest().engineState.lifecycle === "live");
    expect(capturedEngine).toBeDefined();
    expect(stopCallCount).toBe(0);

    await unmountHook(renderer);

    expect(stopCallCount).toBe(1);
    expect(mockAdapter.closeCallCount()).toBe(1);
    expect(mockAdapter.callLog.length).toBeGreaterThan(0);
    expect(mockAdapter.callLog[mockAdapter.callLog.length - 1].method).toBe("close");
  });
});

// ---------------------------------------------------------------------------
// VQ-S8-006: exactly one engine.stop() per mount/unmount cycle -- never
// zero, never doubled, across repeated cycles.
// ---------------------------------------------------------------------------

describe("VQ-S8-006: engine.stop() call discipline across repeated mount/unmount cycles", () => {
  it("two independent cycles each call stop exactly once (cumulative count == cycle count)", async () => {
    const groupId = "group-vq6";
    const persistence = createInMemoryPersistenceAdapter();
    let stopCallCount = 0;
    let startCallCount = 0;

    function createEngine(): ReceiveEngine {
      // Fresh mock adapter + fresh engine EVERY call -- this is the
      // fresh-engine-per-mount contract this hook relies on (judgment_calls
      // "fresh-engine-per-mount-via-factory") to stay safe under repeated
      // mount/unmount without hitting receive-engine.ts's
      // start()-only-from-uninitialized guard.
      const mockAdapter = createMockIngestSource();
      mockAdapter.scriptFetchBootstrap([]);
      mockAdapter.scriptCatchUp([]);
      const engine = createReceiveEngine({
        groupId,
        adapter: mockAdapter.source,
        persistence,
        scheduler: createRealEngineScheduler(),
      });
      const realStart = engine.start.bind(engine);
      const realStop = engine.stop.bind(engine);
      engine.start = async (options) => {
        startCallCount += 1;
        return realStart(options);
      };
      engine.stop = async () => {
        stopCallCount += 1;
        return realStop();
      };
      return engine;
    }

    for (let cycle = 1; cycle <= 2; cycle++) {
      const { renderer, latest } = await mountHook({
        groupId,
        persistence,
        createEngine,
        startOptions: { origin: "welcome" },
      });
      await waitUntil(() => latest().engineState.lifecycle === "live");
      expect(startCallCount).toBe(cycle);
      expect(stopCallCount).toBe(cycle - 1);

      await unmountHook(renderer);
      expect(stopCallCount).toBe(cycle);
    }
  });
});

// ---------------------------------------------------------------------------
// F4 (Stage-1 cold review): the actual React 18/19 dev-mode StrictMode
// double-invoke scenario (mount -> cleanup -> mount) VQ-S8-006 names, rather
// than only the sequential-mount/unmount proxy above.
// ---------------------------------------------------------------------------

describe("StrictMode: dev double-invoke (mount -> cleanup -> mount) is handled safely (VQ-S8-006)", () => {
  it("renders without throwing and calls engine.stop() exactly once per constructed engine instance", async () => {
    const groupId = "group-strict";
    const persistence = createInMemoryPersistenceAdapter();
    const engineLog: Array<{ startCount: number; stopCount: number }> = [];

    function createEngine(): ReceiveEngine {
      // Fresh mock adapter + fresh engine EVERY call -- fresh-engine-per-
      // mount-via-factory (judgment_calls) is exactly what makes the
      // StrictMode double-invoke safe: the throwaway first engine and the
      // surviving second engine are each always constructed uninitialized.
      const mockAdapter = createMockIngestSource();
      mockAdapter.scriptFetchBootstrap([]);
      mockAdapter.scriptCatchUp([]);
      const engine = createReceiveEngine({
        groupId,
        adapter: mockAdapter.source,
        persistence,
        scheduler: createRealEngineScheduler(),
      });
      const record = { startCount: 0, stopCount: 0 };
      engineLog.push(record);
      const realStart = engine.start.bind(engine);
      const realStop = engine.stop.bind(engine);
      engine.start = async (options) => {
        record.startCount += 1;
        return realStart(options);
      };
      engine.stop = async () => {
        record.stopCount += 1;
        return realStop();
      };
      return engine;
    }

    const { renderer, latest } = await mountHookStrict({
      groupId,
      persistence,
      createEngine,
      startOptions: { origin: "welcome" },
    });

    await waitUntil(() => latest().engineState.lifecycle === "live");

    // Two engine instances must have been constructed: the throwaway one
    // from StrictMode's synthetic mount -> cleanup, and the surviving one
    // from the subsequent real mount.
    //
    // The throwaway's cleanup fires SYNCHRONOUSLY, immediately after its own
    // effect setup, before its async `boot()` has resolved even its first
    // persistence `await` -- so `engine.start()` is never reached at all for
    // that instance (the `cancelled` guard aborts `boot()` cleanly once its
    // pending `rebuildFromPersistence()` microtask resolves). `engine.stop()`
    // still runs exactly once for it as a no-op, per receive-engine.ts's own
    // idempotency contract (stop() from "uninitialized" is a no-op) -- never
    // zero (a leaked engine), never doubled (a double-stop crash risk). The
    // surviving instance completes its boot normally and has not been
    // stopped yet.
    expect(engineLog.length).toBe(2);
    expect(engineLog[0]).toEqual({ startCount: 0, stopCount: 1 });
    expect(engineLog[1]).toEqual({ startCount: 1, stopCount: 0 });

    await unmountHook(renderer);

    // The real unmount stops the surviving instance exactly once; the
    // already-stopped throwaway instance is untouched (no double-stop).
    expect(engineLog[0]).toEqual({ startCount: 0, stopCount: 1 });
    expect(engineLog[1]).toEqual({ startCount: 1, stopCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// F2 (Stage-1 cold review, sev-3): the effect's real dependency is `groupId`
// ONLY -- an unstable `createEngine`/`startOptions` identity across renders
// (e.g. an inline `startOptions={{origin:'welcome'}}` literal an S9 caller
// will naturally write) must NOT tear down and reconstruct the engine.
// ---------------------------------------------------------------------------

describe("F2 regression: stable effect dependencies (only groupId re-runs the effect)", () => {
  it("re-rendering with a NEW inline startOptions/createEngine identity (same groupId) does not tear down and recreate the engine", async () => {
    const groupId = "group-stable-deps";
    const persistence = createInMemoryPersistenceAdapter();
    let createEngineCallCount = 0;
    let stopCallCount = 0;

    function makeEngine(): ReceiveEngine {
      createEngineCallCount += 1;
      const mockAdapter = createMockIngestSource();
      mockAdapter.scriptFetchBootstrap([]);
      mockAdapter.scriptCatchUp([]);
      const engine = createReceiveEngine({
        groupId,
        adapter: mockAdapter.source,
        persistence,
        scheduler: createRealEngineScheduler(),
      });
      const realStop = engine.stop.bind(engine);
      engine.stop = async () => {
        stopCallCount += 1;
        return realStop();
      };
      return engine;
    }

    let latest!: ReceiveEngineHookState;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <Harness
          groupId={groupId}
          persistence={persistence}
          createEngine={() => makeEngine()}
          startOptions={{ origin: "welcome" }}
          onRender={(s) => {
            latest = s;
          }}
        />,
      );
    });
    await waitUntil(() => latest.engineState.lifecycle === "live");
    expect(createEngineCallCount).toBe(1);
    expect(stopCallCount).toBe(0);

    // Re-render with BRAND NEW inline `createEngine`/`startOptions` object
    // identities (same groupId) -- prior to the F2 fix this was an effect
    // dependency change and would have torn down and reconstructed the
    // engine.
    await act(async () => {
      renderer.update(
        <Harness
          groupId={groupId}
          persistence={persistence}
          createEngine={() => makeEngine()}
          startOptions={{ origin: "welcome" }}
          onRender={(s) => {
            latest = s;
          }}
        />,
      );
    });

    expect(createEngineCallCount).toBe(1); // no new engine constructed
    expect(stopCallCount).toBe(0); // no teardown
    expect(latest.engineState.lifecycle).toBe("live"); // unaffected

    await act(async () => {
      renderer.unmount();
    });
    expect(stopCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-INV-4: the real engine + real S4 store integration proof.
// ---------------------------------------------------------------------------

describe("AC-INV-4: incremental fold (applyEvent) vs. independent buildProjection over the REAL S4 store", () => {
  const PUBKEY = "a".repeat(64);
  let rawStore: typeof import("../persistence/raw-event-log-store");
  let storage: typeof import("../marmot/storage");

  beforeEach(async () => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    storage = await import("../marmot/storage");
    rawStore = await import("../persistence/raw-event-log-store");
    storage.bindStores(PUBKEY);
  });

  function toSortedEntries(projection: TaskProjection): Array<[string, Task]> {
    return [...projection.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  it(
    "folds N real domain_event_accepted outputs incrementally, matching " +
      "buildProjection(replayOrder(loadAcceptedEvents())) exactly, with " +
      "loadAcceptedEvents called only for the mount seed + this test's own " +
      "independent verification (not once per accepted event)",
    async () => {
      const groupId = "group-inv4";
      const TASK_COUNT = 5;

      let loadAcceptedEventsCallCount = 0;
      const persistence: PersistenceAdapter = {
        appendFact: (fact) => rawStore.appendFact(fact),
        loadFacts: (gid) => rawStore.loadFacts(gid),
        appendAcceptedEvent: (event) => rawStore.appendAcceptedEvent(event),
        async loadAcceptedEvents(gid) {
          loadAcceptedEventsCallCount += 1;
          return rawStore.loadAcceptedEvents(gid);
        },
        // Checkpoint/deferred/acceptDeferredFact/clearGroupState are S11's
        // concern (recovery-sequencing, not yet landed) -- lightweight
        // in-memory stand-ins so the engine's own lifecycle bookkeeping has
        // somewhere to write, matching the MOCK-05-002 pattern established
        // in receive-engine.fsm.test.ts.
        async saveCheckpoint() {},
        async loadCheckpoint() {
          return null;
        },
        async saveDeferredIds() {},
        async loadDeferredIds() {
          return [];
        },
        async acceptDeferredFact(_gid, _factId, event) {
          await rawStore.appendAcceptedEvent(event);
        },
        async clearGroupState(gid) {
          await rawStore.clearRawAndAcceptedLogs(gid);
        },
      };

      const signals = Array.from({ length: TASK_COUNT }, () =>
        messageSignal({ groupId }),
      );
      const mockAdapter = createMockIngestSource();
      mockAdapter.scriptFetchBootstrap([]);
      mockAdapter.scriptCatchUp(signals);

      function createEngine(): ReceiveEngine {
        return createReceiveEngine({
          groupId,
          adapter: mockAdapter.source,
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
      // Every catchUp signal is drained before start() settles into "live"
      // (the FSM's cutover protocol), so by now every domain_event_accepted
      // has already been folded via applyEvent.
      expect(latest().projection.size).toBe(TASK_COUNT);

      // This test's ONLY loadAcceptedEvents call so far is the mount-time
      // restart seed -- regardless of TASK_COUNT. A hidden per-event
      // buildProjection(await loadAcceptedEvents()) implementation would
      // have made this scale with TASK_COUNT instead.
      expect(loadAcceptedEventsCallCount).toBe(1);

      // Deliberately bypasses the wrapped `persistence` object -- this is
      // an INDEPENDENT load straight through the real store module, not a
      // second call attributed to the hook.
      const independentEvents = await rawStore.loadAcceptedEvents(groupId);
      expect(independentEvents.length).toBe(TASK_COUNT);
      const independentProjection = buildProjection(replayOrder(independentEvents));

      expect(toSortedEntries(latest().projection)).toEqual(
        toSortedEntries(independentProjection),
      );

      // Re-assert after the independent verification load above: the
      // hook-attributed loadAcceptedEvents count is STILL 1, regardless of
      // TASK_COUNT and regardless of this test's own extra (unattributed)
      // verification read -- the decisive disproof of a hidden
      // full-rebuild-per-event implementation, which would have pushed this
      // to TASK_COUNT instead.
      expect(loadAcceptedEventsCallCount).toBe(1);

      await unmountHook(renderer);
    },
  );

  it(
    "F5: folds a mixed task.created/task.updated/task.deleted log (order-sensitive) " +
      "incrementally, matching buildProjection(replayOrder(loadAcceptedEvents())) exactly -- " +
      "a homogeneous task.created-only log (the test above) cannot detect order-sensitivity " +
      "or tie-break asymmetry the way a mixed log can",
    async () => {
      const groupId = "group-inv4-mixed";

      const persistence: PersistenceAdapter = {
        appendFact: (fact) => rawStore.appendFact(fact),
        loadFacts: (gid) => rawStore.loadFacts(gid),
        appendAcceptedEvent: (event) => rawStore.appendAcceptedEvent(event),
        loadAcceptedEvents: (gid) => rawStore.loadAcceptedEvents(gid),
        async saveCheckpoint() {},
        async loadCheckpoint() {
          return null;
        },
        async saveDeferredIds() {},
        async loadDeferredIds() {
          return [];
        },
        async acceptDeferredFact(_gid, _factId, event) {
          await rawStore.appendAcceptedEvent(event);
        },
        async clearGroupState(gid) {
          await rawStore.clearRawAndAcceptedLogs(gid);
        },
      };

      const taskA = task("mixed-a");
      const taskB = task("mixed-b");
      const taskC = task("mixed-c");

      // Order-sensitive: each mutation must be replayed AFTER its target's
      // task.created, and in the same relative order the log was written in
      // (task-crdt.ts's tie-break is exercised via strictly increasing
      // updatedAt values, not left to accidental input order).
      const signals: IngestSignal[] = [
        messageSignalWithPayload(groupId, { type: "task.created", task: taskA }),
        messageSignalWithPayload(groupId, { type: "task.created", task: taskB }),
        messageSignalWithPayload(groupId, { type: "task.created", task: taskC }),
        messageSignalWithPayload(groupId, {
          type: "task.updated",
          taskId: taskA.id,
          changes: { title: "Updated title A" },
          updatedAt: 2000,
          updatedBy: "pk-1",
        }),
        messageSignalWithPayload(groupId, {
          type: "task.deleted",
          taskId: taskB.id,
          updatedAt: 2000,
          updatedBy: "pk-1",
        }),
      ];

      const mockAdapter = createMockIngestSource();
      mockAdapter.scriptFetchBootstrap([]);
      mockAdapter.scriptCatchUp(signals);

      function createEngine(): ReceiveEngine {
        return createReceiveEngine({
          groupId,
          adapter: mockAdapter.source,
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

      // A survives with its update applied, B is deleted, C is untouched.
      expect(latest().projection.size).toBe(2);
      expect(latest().projection.get(taskA.id)?.title).toBe("Updated title A");
      expect(latest().projection.has(taskB.id)).toBe(false);
      expect(latest().projection.has(taskC.id)).toBe(true);

      const independentEvents = await rawStore.loadAcceptedEvents(groupId);
      expect(independentEvents.length).toBe(5);
      const independentProjection = buildProjection(replayOrder(independentEvents));

      expect(toSortedEntries(latest().projection)).toEqual(
        toSortedEntries(independentProjection),
      );

      await unmountHook(renderer);
    },
  );
});
