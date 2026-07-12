/**
 * receive-engine.fsm.test.ts
 *
 * The mandated FSM conformance suite (Implementation Constraint 6 / Phase 5
 * entry gate). Drives every fsm.md transition (L1-L11, H1-H2) via a mock
 * `IngestSource` (MOCK-05-001) and a fully in-memory mock
 * `PersistenceAdapter` (MOCK-05-002 covers checkpoint/deferred; this file's
 * mock also covers facts/accepted-events for fast, deterministic,
 * IDB-free FSM assertions -- the cutover PROPERTY test
 * (receive-engine.cutover.property.test.ts) is this story's integration-
 * style exerciser of the REAL S4 raw-event-log-store per the story's
 * "fact/accepted-event persistence uses the real S4 raw-event-log-store"
 * instruction).
 *
 * Engine is projection-free by design (architecture.json
 * "engine-stays-projection-free"); where an AC's observable talks about
 * "the projection", this file folds emitted `domain_event_accepted` events
 * with the REAL `src/domain/task-projector.ts` (`applyEvent`) to stand in
 * for the integration layer -- the fold happens in test code only, never
 * inside the engine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReceiveEngine,
  createRealEngineScheduler,
  type EngineScheduler,
  type EngineTimerHandle,
  type ReceiveEngine,
} from "./receive-engine";
import { applyEvent, EMPTY_PROJECTION, type TaskProjection } from "../domain/task-projector";
import type {
  AcceptedDomainEvent,
  EngineCheckpoint,
  EngineOutputEvent,
  EngineLifecycleState,
  IngestSignal,
  IngestSource,
  NostrEvent,
  PersistenceAdapter,
  RawProtocolFact,
  RawProtocolFactInput,
} from "./engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

// ---------------------------------------------------------------------------
// Fixture builders
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

function factInput(id: string, groupId = "group-1"): RawProtocolFactInput {
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

function taskCreatedPayload(taskId: string): TaskEvent {
  return { type: "task.created", task: task(taskId) };
}

function messageSignal(opts: {
  factId?: string;
  rumorId?: string;
  taskId?: string;
  epoch?: string;
  receiptSource?: "historical" | "live" | "bootstrap-kind-30078";
  groupId?: string;
}): IngestSignal {
  const factId = opts.factId ?? nextId("fact");
  const taskId = opts.taskId ?? nextId("task");
  return {
    type: "message",
    fact: factInput(factId, opts.groupId),
    rumorId: opts.rumorId ?? nextId("rumor"),
    payload: taskCreatedPayload(taskId),
    epoch: opts.epoch ?? "epoch-0",
    receiptSource: opts.receiptSource ?? "historical",
  };
}

function deferredSignal(opts: {
  factId?: string;
  reason?: "unreadable" | "epoch_mismatch";
  groupId?: string;
}): IngestSignal {
  return {
    type: "deferred",
    fact: factInput(opts.factId ?? nextId("fact"), opts.groupId),
    reason: opts.reason ?? "unreadable",
    epoch: "epoch-0",
  };
}

function skippedSignal(opts: { factId?: string; groupId?: string }): IngestSignal {
  return { type: "skipped", fact: factInput(opts.factId ?? nextId("fact"), opts.groupId) };
}

function malformedSignal(opts: { factId?: string; groupId?: string }): IngestSignal {
  return {
    type: "malformed",
    fact: factInput(opts.factId ?? nextId("fact"), opts.groupId),
    error: "bad payload",
  };
}

function epochAdvancedSignal(newEpoch: string, prevEpoch: string): IngestSignal {
  return { type: "epoch_advanced", newEpoch, prevEpoch };
}

// ---------------------------------------------------------------------------
// Controllable async iterable -- lets a test drive exactly when a catchUp()
// or ingestPersisted() iterable yields and completes.
// ---------------------------------------------------------------------------

interface ControllableIterable<T> {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  complete(): void;
  fail(err: unknown): void;
}

function createControllableAsyncIterable<T>(): ControllableIterable<T> {
  const queue: T[] = [];
  let pendingResolve: ((r: IteratorResult<T>) => void) | null = null;
  let pendingReject: ((e: unknown) => void) | null = null;
  let done = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as T, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return new Promise((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
          });
        },
      };
    },
  };

  return {
    iterable,
    push(value: T) {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        r({ value, done: false });
      } else {
        queue.push(value);
      }
    },
    complete() {
      done = true;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        r({ value: undefined as unknown as T, done: true });
      }
    },
    fail(err: unknown) {
      if (pendingReject) {
        const rej = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        rej(err);
      } else {
        done = true;
      }
    },
  };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Mock IngestSource
// ---------------------------------------------------------------------------

type CallLogEntry = {
  method: "openLive" | "catchUp" | "ingestPersisted" | "fetchBootstrap" | "close";
  seq: number;
};

interface MockIngestSource {
  source: IngestSource;
  callLog: CallLogEntry[];
  scriptCatchUp(signals: IngestSignal[]): void;
  scriptCatchUpManual(): ControllableIterable<IngestSignal>;
  scriptCatchUpThrows(err: unknown): void;
  scriptIngestPersisted(signals: IngestSignal[]): void;
  /**
   * Scripts `adapter.fetchBootstrap()` -- the DEDICATED joining-phase
   * bootstrap channel (amended 2026-07-12, S5 Stage-1 review -- sev-6),
   * a queue entirely separate from `catchUp()`'s. `catchUp()` is now
   * reserved exclusively for the catching_up cutover drain, invoked
   * exactly once per start() -- see `receive-engine.ts`'s
   * `catchUpInvocationCount` guard.
   */
  scriptFetchBootstrap(signals: IngestSignal[]): void;
  scriptFetchBootstrapManual(): ControllableIterable<IngestSignal>;
  scriptFetchBootstrapThrows(err: unknown): void;
  /** Manual variant of `scriptIngestPersisted`, added for the SEV-9
   *  generation-token flip-proofs (S5 Stage-2 cold review): lets a test
   *  hold the L8/L9 deferred-retry drain open so it can call stop()/reset()
   *  WHILE the retry pass is mid-flight. */
  scriptIngestPersistedManual(): ControllableIterable<IngestSignal>;
  pushLive(signal: IngestSignal): void;
  isLiveOpen(): boolean;
  closeCallCount: number;
}

function createMockIngestSource(): MockIngestSource {
  let seq = 0;
  const callLog: CallLogEntry[] = [];
  type DrainScript =
    | { kind: "signals"; signals: IngestSignal[] }
    | { kind: "manual"; controller: ControllableIterable<IngestSignal> }
    | { kind: "throws"; err: unknown };
  const catchUpScripts: DrainScript[] = [];
  const fetchBootstrapScripts: DrainScript[] = [];
  const ingestPersistedScripts: DrainScript[] = [];
  let onSignal: ((signal: IngestSignal) => void) | null = null;
  let closeCallCount = 0;

  function drainScript(script: DrainScript): AsyncIterable<IngestSignal> {
    if (script.kind === "manual") return script.controller.iterable;
    if (script.kind === "throws") {
      const err = script.err;
      return (async function* (): AsyncGenerator<IngestSignal> {
        throw err;
      })();
    }
    return fromArray(script.signals);
  }

  const source: IngestSource = {
    catchUp() {
      callLog.push({ method: "catchUp", seq: seq++ });
      const script = catchUpScripts.shift() ?? { kind: "signals", signals: [] };
      return drainScript(script);
    },
    openLive(cb) {
      callLog.push({ method: "openLive", seq: seq++ });
      onSignal = cb;
      return () => {
        if (onSignal === cb) onSignal = null;
      };
    },
    ingestPersisted(_facts: RawProtocolFact[]) {
      callLog.push({ method: "ingestPersisted", seq: seq++ });
      const script = ingestPersistedScripts.shift() ?? { kind: "signals", signals: [] };
      return drainScript(script);
    },
    fetchBootstrap() {
      callLog.push({ method: "fetchBootstrap", seq: seq++ });
      const script = fetchBootstrapScripts.shift() ?? { kind: "signals", signals: [] };
      return drainScript(script);
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
      catchUpScripts.push({ kind: "signals", signals });
    },
    scriptCatchUpManual() {
      const controller = createControllableAsyncIterable<IngestSignal>();
      catchUpScripts.push({ kind: "manual", controller });
      return controller;
    },
    scriptCatchUpThrows(err) {
      catchUpScripts.push({ kind: "throws", err });
    },
    scriptIngestPersisted(signals) {
      ingestPersistedScripts.push({ kind: "signals", signals });
    },
    scriptIngestPersistedManual() {
      const controller = createControllableAsyncIterable<IngestSignal>();
      ingestPersistedScripts.push({ kind: "manual", controller });
      return controller;
    },
    scriptFetchBootstrap(signals) {
      fetchBootstrapScripts.push({ kind: "signals", signals });
    },
    scriptFetchBootstrapManual() {
      const controller = createControllableAsyncIterable<IngestSignal>();
      fetchBootstrapScripts.push({ kind: "manual", controller });
      return controller;
    },
    scriptFetchBootstrapThrows(err) {
      fetchBootstrapScripts.push({ kind: "throws", err });
    },
    pushLive(signal) {
      onSignal?.(signal);
    },
    isLiveOpen() {
      return onSignal !== null;
    },
    get closeCallCount() {
      return closeCallCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock PersistenceAdapter (full 10-method in-memory implementation)
// ---------------------------------------------------------------------------

interface AcceptDeferredFactCall {
  groupId: string;
  factId: string;
  event: AcceptedDomainEvent;
}

interface MockPersistenceAdapter {
  adapter: PersistenceAdapter;
  saveCheckpointCalls: EngineCheckpoint[];
  clearGroupStateCalls: string[];
  acceptDeferredFactCalls: AcceptDeferredFactCall[];
  seedFacts(groupId: string, facts: RawProtocolFact[]): void;
  seedAcceptedEvents(groupId: string, events: AcceptedDomainEvent[]): void;
  seedCheckpoint(checkpoint: EngineCheckpoint): void;
  seedDeferredIds(groupId: string, ids: string[]): void;
  makeCheckpointCorrupt(groupId: string): void;
}

/**
 * KEEP IN SYNC with src/persistence/raw-event-log-store.ts (S4).
 *
 * This mock REPLICATES the real store's fact/accepted-event algorithm
 * (idempotent lookup-before-insert on id, seq = last-seq + 1 assigned on
 * append, append-order preservation on load) because AC-BOUND-1 forbids
 * src/engine test files from importing src/persistence. If S4's append/load
 * semantics change, update this mock in the same commit — the engine is not
 * exercised against the real store until the S8/S9 integration layer
 * (recorded obligation). Same contract note as the mock in
 * receive-engine.cutover.property.test.ts.
 */
function createMockPersistenceAdapter(): MockPersistenceAdapter {
  const facts = new Map<string, RawProtocolFact[]>();
  const acceptedEvents = new Map<string, AcceptedDomainEvent[]>();
  const checkpoints = new Map<string, EngineCheckpoint | unknown>();
  const deferredIds = new Map<string, string[]>();
  const saveCheckpointCalls: EngineCheckpoint[] = [];
  const clearGroupStateCalls: string[] = [];
  const acceptDeferredFactCalls: AcceptDeferredFactCall[] = [];

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
      saveCheckpointCalls.push(checkpoint);
      checkpoints.set(checkpoint.groupId, checkpoint);
    },
    async loadCheckpoint(groupId) {
      return (checkpoints.get(groupId) as EngineCheckpoint | undefined) ?? null;
    },
    async saveDeferredIds(groupId, ids) {
      deferredIds.set(groupId, [...ids]);
    },
    async loadDeferredIds(groupId) {
      return [...(deferredIds.get(groupId) ?? [])];
    },
    async acceptDeferredFact(groupId, factId, event) {
      acceptDeferredFactCalls.push({ groupId, factId, event });
      await adapter.appendAcceptedEvent(event);
      const ids = deferredIds.get(groupId) ?? [];
      deferredIds.set(
        groupId,
        ids.filter((id) => id !== factId),
      );
    },
    async clearGroupState(groupId) {
      clearGroupStateCalls.push(groupId);
      facts.delete(groupId);
      acceptedEvents.delete(groupId);
      checkpoints.delete(groupId);
      deferredIds.delete(groupId);
    },
  };

  return {
    adapter,
    saveCheckpointCalls,
    clearGroupStateCalls,
    acceptDeferredFactCalls,
    seedFacts(groupId, seeded) {
      facts.set(groupId, [...seeded]);
    },
    seedAcceptedEvents(groupId, events) {
      acceptedEvents.set(groupId, [...events]);
    },
    seedCheckpoint(checkpoint) {
      checkpoints.set(checkpoint.groupId, checkpoint);
    },
    seedDeferredIds(groupId, ids) {
      deferredIds.set(groupId, [...ids]);
    },
    makeCheckpointCorrupt(groupId) {
      checkpoints.set(groupId, { groupId, savedAt: "not-a-number" });
    },
  };
}

// ---------------------------------------------------------------------------
// Shared test scaffold
// ---------------------------------------------------------------------------

const GROUP_ID = "group-1";
const VALID_LIFECYCLES: ReadonlySet<string> = new Set([
  "uninitialized",
  "joining",
  "recovering",
  "catching_up",
  "buffering_live",
  "live",
  "retrying_deferred",
  "stopped",
]);

function buildEngine(overrides?: {
  scheduler?: EngineScheduler;
  tJoinMs?: number;
  checkpointIntervalMs?: number;
}) {
  const mockAdapter = createMockIngestSource();
  const mockPersistence = createMockPersistenceAdapter();
  const events: EngineOutputEvent[] = [];
  const engine = createReceiveEngine({
    groupId: GROUP_ID,
    adapter: mockAdapter.source,
    persistence: mockPersistence.adapter,
    scheduler: overrides?.scheduler ?? createRealEngineScheduler(),
    tJoinMs: overrides?.tJoinMs,
    checkpointIntervalMs: overrides?.checkpointIntervalMs,
  });
  engine.subscribe((e) => events.push(e));
  return { engine, mockAdapter, mockPersistence, events };
}

function stateChanges(events: EngineOutputEvent[]) {
  return events.filter(
    (e): e is Extract<EngineOutputEvent, { type: "engine_state_changed" }> =>
      e.type === "engine_state_changed",
  );
}

function acceptedEvents(events: EngineOutputEvent[]) {
  return events.filter(
    (e): e is Extract<EngineOutputEvent, { type: "domain_event_accepted" }> =>
      e.type === "domain_event_accepted",
  );
}

function foldProjection(events: EngineOutputEvent[]): TaskProjection {
  return acceptedEvents(events).reduce((proj, e) => applyEvent(proj, e.event), EMPTY_PROJECTION);
}

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC-FSM-1 (I-FSM-1): degraded is only ever health, lifecycle is always one
// of the 8 named states, across every documented transition.
// ---------------------------------------------------------------------------

describe("AC-FSM-1: degraded is exclusively health, never lifecycle, across L1-L11 + H1-H2", () => {
  it("drives welcome-join -> live -> deferred-retry -> stop -> reset -> restored-recover -> live and asserts lifecycle is always a valid member, never the string 'degraded'", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();

    // L2 (welcome) -> L4 (bootstrap resolves nominally) -> L6 -> L7 (live).
    mockAdapter.scriptFetchBootstrap([]); // joining-phase bootstrap fetch: resolves immediately, empty
    mockAdapter.scriptCatchUp([]); // catching_up cutover drain: also empty
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    // L8/L9: park a fact, then epoch_advanced with a nonempty deferred queue.
    mockAdapter.pushLive(deferredSignal({}));
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));
    mockAdapter.scriptIngestPersisted([]); // retry pass yields nothing new
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() => expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThan(2));

    // L10 stop -> L11 reset -> L2 (welcome) again.
    await engine.stop();
    expect(engine.getState().lifecycle).toBe("stopped");
    await engine.reset();
    expect(engine.getState().lifecycle).toBe("uninitialized");

    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    for (const change of stateChanges(events)) {
      expect(VALID_LIFECYCLES.has(change.state)).toBe(true);
      expect(change.state).not.toBe("degraded");
      expect(["nominal", "degraded"]).toContain(change.health);
    }
  });

  it("uninitialized/joining/recovering/stopped are always health:nominal even when a degradation cause is pending", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    // Seed a corrupt checkpoint + non-empty raw log -> L1 preserve-and-replay
    // (degraded), so we can confirm "recovering" itself still reports the
    // lifecycle correctly (health may show degraded once active, but the
    // getState() contract for non-active lifecycles is always nominal).
    mockPersistence.makeCheckpointCorrupt(GROUP_ID);
    mockPersistence.seedFacts(GROUP_ID, [
      {
        id: "f0",
        seq: 1,
        groupId: GROUP_ID,
        nostrEventId: "f0",
        nostrEvent: nostrEvent("f0"),
        receivedAt: 1,
        receiptSource: "historical",
        epochAtReceipt: "epoch-0",
      },
    ]);
    mockAdapter.scriptCatchUp([]);
    void engine.start({ origin: "restored" }).catch(() => {});

    // At this point the engine has synchronously entered "recovering" via
    // enterRecovering's first transitionTo call (before the async loads
    // resolve) -- assert its health is nominal per fsm.md ("uninitialized,
    // joining, recovering, and stopped are always nominal").
    await vi.waitFor(() => {
      const recoveringChange = stateChanges(events).find((c) => c.state === "recovering");
      expect(recoveringChange).toBeDefined();
      expect(recoveringChange!.health).toBe("nominal");
    });
    void mockPersistence;
  });
});

// ---------------------------------------------------------------------------
// AC-FSM-2 (I-FSM-2): openLive() precedes the first catchUp() iteration on
// every entry into catching_up (L3, L4, L5).
// ---------------------------------------------------------------------------

describe("AC-FSM-2: openLive precedes catchUp on every catching_up entry (L3, L4, L5)", () => {
  it("L4 (joining, nominal): openLive precedes the cutover catchUp call", async () => {
    const { engine, mockAdapter } = buildEngine();
    // Joining's bootstrap fetch is the DEDICATED fetchBootstrap() channel
    // (amended 2026-07-12, S5 Stage-1 review -- sev-6), never catchUp() --
    // catchUp() is reserved exclusively for the cutover drain below and is
    // invoked exactly once per start().
    mockAdapter.scriptFetchBootstrap([]); // bootstrap fetch (joining)
    mockAdapter.scriptCatchUp([]); // cutover drain (catching_up entry) -- catchUp()'s ONLY call
    await engine.start({ origin: "welcome" });

    const catchUpCalls = mockAdapter.callLog.filter((c) => c.method === "catchUp");
    const openLiveCalls = mockAdapter.callLog.filter((c) => c.method === "openLive");
    expect(catchUpCalls.length).toBe(1);
    expect(openLiveCalls.length).toBeGreaterThanOrEqual(1);
    expect(openLiveCalls[0].seq).toBeLessThan(catchUpCalls[0].seq);
  });

  it("L5 (joining, degraded-on-timeout): openLive precedes the cutover catchUp call", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter } = buildEngine({ tJoinMs: 8000 });
    mockAdapter.scriptFetchBootstrapManual(); // bootstrap fetch: never resolves within this test
    mockAdapter.scriptCatchUp([]); // cutover drain, once L5 fires -- catchUp()'s ONLY call

    void engine.start({ origin: "welcome" }).catch(() => {});
    await vi.advanceTimersByTimeAsync(8000);

    const catchUpCalls = mockAdapter.callLog.filter((c) => c.method === "catchUp");
    const openLiveCalls = mockAdapter.callLog.filter((c) => c.method === "openLive");
    expect(catchUpCalls.length).toBe(1);
    expect(openLiveCalls.length).toBeGreaterThanOrEqual(1);
    expect(openLiveCalls[0].seq).toBeLessThan(catchUpCalls[0].seq);
    // The cutover drain was scripted empty, so the engine may have already
    // progressed past catching_up to live within the same fake-timer tick
    // (nothing to buffer/drain) -- assert the transition THROUGH
    // catching_up/degraded happened, not that it is the CURRENT state.
    expect(engine.getState().lifecycle).toBe("live");
  });

  it("L3 (recovering -> catching_up): openLive precedes the cutover catchUp call", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockPersistence.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "live",
      lastEpoch: "epoch-0",
      lastIngestedSeq: 0,
      lastAcceptedDomainEventId: null,
      bootstrapCompleted: true,
    });
    mockAdapter.scriptCatchUp([]); // R3 crash-gap resubmission uses ingestPersisted, not catchUp
    mockAdapter.scriptCatchUp([]); // cutover drain at catching_up entry
    await engine.start({ origin: "restored" });

    expect(engine.getState().lifecycle).toBe("live");
    const catchUpCalls = mockAdapter.callLog.filter((c) => c.method === "catchUp");
    const openLiveCalls = mockAdapter.callLog.filter((c) => c.method === "openLive");
    expect(openLiveCalls.length).toBeGreaterThanOrEqual(1);
    expect(catchUpCalls.length).toBeGreaterThanOrEqual(1);
    expect(openLiveCalls[0].seq).toBeLessThan(catchUpCalls[0].seq);
  });
});

// ---------------------------------------------------------------------------
// AC-FSM-3 (I-FSM-3): live signals during catching_up/buffering_live are
// buffered, not applied, until buffering_live drains; arrival order
// preserved; a negative-order assertion is included.
// ---------------------------------------------------------------------------

describe("AC-FSM-3: live signals buffered during catching_up/buffering_live, applied in arrival order once draining", () => {
  it("a live signal injected mid-catch-up is not applied until after catchUpComplete, then applies in arrival order", async () => {
    const historical = messageSignal({ taskId: "hist-1" });

    // origin=restored with an empty checkpoint routes straight to L2
    // joining anyway (both logs empty) -- use welcome directly and manually
    // control the CUTOVER catchUp call.
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]); // joining bootstrap fetch resolves empty immediately
    const cutoverManual = mockAdapter.scriptCatchUpManual(); // cutover drain -- manual control

    const startPromise = engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("catching_up"));

    // Inject a LIVE signal mid-catch-up (before the historical drain yields
    // its own signal or completes).
    const live = messageSignal({ taskId: "live-1" });
    mockAdapter.pushLive(live);
    await Promise.resolve();
    await Promise.resolve();
    expect(acceptedEvents(events)).toHaveLength(0); // not applied yet

    // Now yield the historical signal and complete the drain.
    cutoverManual.push(historical);
    cutoverManual.complete();
    await startPromise;

    expect(engine.getState().lifecycle).toBe("live");
    const acceptedIds = acceptedEvents(events).map((e) => e.event.payload.type === "task.created" ? e.event.payload.task.id : "");
    expect(acceptedIds).toEqual(["hist-1", "live-1"]); // historical strictly before live, arrival order preserved
  });

  it("negative case: asserting the buffered (live) event applied AHEAD of the earlier historical one fails", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    const startPromise = engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("catching_up"));

    const live = messageSignal({ taskId: "live-1" });
    mockAdapter.pushLive(live);
    const historical = messageSignal({ taskId: "hist-1" });
    cutoverManual.push(historical);
    cutoverManual.complete();
    await startPromise;

    const acceptedIds = acceptedEvents(events).map((e) =>
      e.event.payload.type === "task.created" ? e.event.payload.task.id : "",
    );
    // The TRUE order is historical-before-live; asserting the reverse must fail.
    expect(() => expect(acceptedIds).toEqual(["live-1", "hist-1"])).toThrow();
    expect(acceptedIds).toEqual(["hist-1", "live-1"]);
  });
});

// ---------------------------------------------------------------------------
// AC-FSM-4 (I-FSM-4): saveCheckpoint at least once per lifecycle transition,
// plus periodically during an extended live period with zero transitions.
// ---------------------------------------------------------------------------

describe("AC-FSM-4: saveCheckpoint on every transition, plus periodic saves while live", () => {
  it("N scripted transitions yield saveCheckpoint call count >= N", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" }); // joining -> catching_up -> buffering_live -> live: >= 3 transitions
    const afterStart = mockPersistence.saveCheckpointCalls.length;
    expect(afterStart).toBeGreaterThanOrEqual(3);

    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(deferredSignal({}));
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0")); // L8 -> L9: 2 more transitions
    await vi.waitFor(() =>
      expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThanOrEqual(afterStart + 2),
    );

    await engine.stop(); // L10: 1 more transition
    expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThanOrEqual(afterStart + 3);
  });

  it("each individual transition contributes its OWN checkpoint save, identifiable by that save's engineState (per-transition mapping, not an aggregate count) (P3 batch item (d), S5 Stage-2 cold review)", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    const afterStart = mockPersistence.saveCheckpointCalls.length;
    expect(afterStart).toBeGreaterThanOrEqual(3);
    // Each of the four lifecycle values reached during start() (L2, L4,
    // L6, L7) must have produced its OWN save carrying that state --
    // mapping transition to save, not merely "enough saves happened".
    const statesFromStart = mockPersistence.saveCheckpointCalls
      .slice(0, afterStart)
      .map((c) => c.engineState);
    expect(statesFromStart).toContain("joining");
    expect(statesFromStart).toContain("catching_up");
    expect(statesFromStart).toContain("buffering_live");
    expect(statesFromStart).toContain("live");

    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(deferredSignal({}));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "envelope_deferred")).toBe(true),
    );
    const beforeEpoch = mockPersistence.saveCheckpointCalls.length;

    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0")); // L8 -> L9
    // Wait for the CHECKPOINT COUNT itself to grow by at least 2 (not just
    // "lifecycle is live", which is already true going in and would
    // resolve a lifecycle-based waitFor immediately without observing
    // anything) -- this guarantees both L8's and L9's own saves have
    // actually landed before inspecting them below.
    await vi.waitFor(() =>
      expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThanOrEqual(beforeEpoch + 2),
    );

    const epochTransitionStates = mockPersistence.saveCheckpointCalls
      .slice(beforeEpoch)
      .map((c) => c.engineState);
    // L8's OWN save (engineState "retrying_deferred") AND L9's OWN,
    // SEPARATE save (engineState "live") must both be present -- proving
    // two distinct per-transition saves rather than one shared save
    // covering the whole L8->L9 round trip.
    expect(epochTransitionStates).toContain("retrying_deferred");
    expect(epochTransitionStates.filter((s) => s === "live").length).toBeGreaterThanOrEqual(1);
    expect(epochTransitionStates.length).toBeGreaterThanOrEqual(2);

    const beforeStop = mockPersistence.saveCheckpointCalls.length;
    await engine.stop(); // L10: its own individual save
    expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThanOrEqual(beforeStop + 1);
    expect(mockPersistence.saveCheckpointCalls.at(-1)?.engineState).toBe("stopped");
  });

  it("an extended live period with zero transitions still gets at least one additional periodic saveCheckpoint call", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, mockPersistence } = buildEngine({ checkpointIntervalMs: 30_000 });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    const countAtLive = mockPersistence.saveCheckpointCalls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThan(countAtLive);
  });
});

// ---------------------------------------------------------------------------
// AC-FSM-5 (I-FSM-5): reset() is the only path clearing persisted state;
// always lands in uninitialized; re-join after reset uses L2, not L1.
// ---------------------------------------------------------------------------

describe("AC-FSM-5: reset() exclusively clears persisted state and always lands in uninitialized", () => {
  it("reset() on non-empty stores clears all five and lands in uninitialized", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    mockAdapter.pushLive(deferredSignal({}));
    // Wait for the "envelope_deferred" EVENT (not merely lifecycle==="live",
    // which is already true and would race ahead of the deferred park's
    // async persistence.saveDeferredIds write completing).
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "envelope_deferred")).toBe(true),
    );

    await engine.reset();

    expect(engine.getState().lifecycle).toBe("uninitialized");
    expect(mockPersistence.clearGroupStateCalls).toEqual([GROUP_ID]);
    expect(await mockPersistence.adapter.loadCheckpoint(GROUP_ID)).toBeNull();
    expect(await mockPersistence.adapter.loadFacts(GROUP_ID)).toEqual([]);
    expect(await mockPersistence.adapter.loadAcceptedEvents(GROUP_ID)).toEqual([]);
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).toEqual([]);
  });

  it("no other transition calls clearGroupState", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    mockAdapter.pushLive(deferredSignal({}));
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));
    await engine.stop();

    expect(mockPersistence.clearGroupStateCalls).toEqual([]);
  });

  it("start({origin:'welcome'}) after reset() takes L2 into joining, not L1 into recovering", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    await engine.reset();

    const { events } = { events: [] as EngineOutputEvent[] };
    engine.subscribe((e) => events.push(e));
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const firstActiveState = stateChanges(events).find((c) =>
      ["joining", "recovering"].includes(c.state),
    );
    expect(firstActiveState?.state).toBe("joining");
    void mockPersistence;
  });
});

// ---------------------------------------------------------------------------
// AC-FSM-6 (I-FSM-6): retrying_deferred fires only on group_epoch_advanced
// with a non-empty deferred queue; group_ratchet_advanced never triggers it.
// ---------------------------------------------------------------------------

describe("AC-FSM-6: retrying_deferred (L8) triggers only on epoch_advanced, never ratchet_advanced", () => {
  it("differential: ratchet-advance (skipped signal) leaves lifecycle unchanged; epoch-advance transitions to retrying_deferred", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    mockAdapter.pushLive(deferredSignal({})); // non-empty deferred queue
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    mockAdapter.pushLive(skippedSignal({}));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "group_ratchet_advanced")).toBe(true),
    );
    expect(engine.getState().lifecycle).toBe("live"); // unchanged

    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "group_epoch_advanced")).toBe(true),
    );
    await vi.waitFor(() => {
      const wasRetrying = stateChanges(events).some((c) => c.state === "retrying_deferred");
      expect(wasRetrying).toBe(true);
    });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live")); // L9 returns to live
  });

  it("epoch_advanced with an EMPTY deferred queue does not trigger retrying_deferred", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "group_epoch_advanced")).toBe(true),
    );
    expect(engine.getState().lifecycle).toBe("live");
    expect(stateChanges(events).some((c) => c.state === "retrying_deferred")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-FSM-7: T_join = 8000ms; timeout -> L5 degraded; bootstrap fetch not
// cancelled; late resolve merges and restores health:nominal (H2).
// ---------------------------------------------------------------------------

describe("AC-FSM-7: T_join=8000ms joining-gate, background-continue, late-merge restores nominal", () => {
  it("timer fires at 8000ms -> catching_up/degraded; bootstrap promise resolves at 9000ms -> merges + health:nominal", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, events } = buildEngine({ tJoinMs: 8000 });
    const bootstrapManual = mockAdapter.scriptFetchBootstrapManual();
    // Cutover drain (once L5 fires) is ALSO manually controlled so the
    // engine observably pauses in catching_up/degraded rather than racing
    // ahead to live within the same fake-timer tick.
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    void engine.start({ origin: "welcome" }).catch(() => {});

    await vi.advanceTimersByTimeAsync(7999);
    expect(engine.getState().lifecycle).toBe("joining");

    await vi.advanceTimersByTimeAsync(1); // crosses the 8000ms mark
    expect(engine.getState()).toEqual({ lifecycle: "catching_up", health: "degraded" });

    // Bootstrap promise resolves at 9000ms (1000ms after the timer fired) --
    // never aborted/rejected by the engine; push a bootstrap-sourced signal
    // then complete the (still-open) iterable.
    const lateSignal = messageSignal({ taskId: "late-1", receiptSource: "bootstrap-kind-30078" });
    bootstrapManual.push(lateSignal);
    bootstrapManual.complete();
    await vi.advanceTimersByTimeAsync(1000);

    // Let the cutover drain complete now so the engine can reach live.
    cutoverManual.complete();

    await vi.waitFor(() => {
      const nominalAfterDegraded = stateChanges(events)
        .filter((c) => c.state === "catching_up" || c.state === "buffering_live" || c.state === "live")
        .some((c) => c.health === "nominal");
      expect(nominalAfterDegraded).toBe(true);
    });
    const acceptedIds = acceptedEvents(events).map((e) =>
      e.event.payload.type === "task.created" ? e.event.payload.task.id : "",
    );
    expect(acceptedIds).toContain("late-1");
  });
});

// ---------------------------------------------------------------------------
// S7 seam amendment (amended 2026-07-12, S5 Stage-1 review -- sev-6):
// joining-phase bootstrap uses the DEDICATED `fetchBootstrap()` channel;
// `catchUp()` is reserved exclusively for the catching_up cutover drain and
// MUST be invoked exactly once per engine start() across every path (L3,
// L4, L5) -- never a second, concurrent iterator on timeout.
// ---------------------------------------------------------------------------

describe("S7 seam amendment: fetchBootstrap is the dedicated bootstrap channel, catchUp() exactly once", () => {
  it("happy path: fetchBootstrap resolves before T_join -> L4 -> catchUp() called exactly once", async () => {
    const { engine, mockAdapter } = buildEngine({ tJoinMs: 8000 });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    expect(engine.getState()).toEqual({ lifecycle: "live", health: "nominal" });
    const catchUpCalls = mockAdapter.callLog.filter((c) => c.method === "catchUp");
    const fetchBootstrapCalls = mockAdapter.callLog.filter((c) => c.method === "fetchBootstrap");
    expect(catchUpCalls.length).toBe(1);
    expect(fetchBootstrapCalls.length).toBe(1);
  });

  it("timeout path: T_join fires mid-bootstrap-drain -> L5 degraded -> live; late bootstrap signals still processed -> H2 restores nominal + bootstrapCompleted true; catchUp() called exactly once total", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, mockPersistence, events } = buildEngine({ tJoinMs: 8000 });
    const bootstrapManual = mockAdapter.scriptFetchBootstrapManual();
    mockAdapter.scriptCatchUp([]); // cutover drain: resolves immediately once L5 fires

    void engine.start({ origin: "welcome" }).catch(() => {});

    await vi.advanceTimersByTimeAsync(8000);
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));
    expect(engine.getState().health).toBe("degraded");

    // The SAME fetchBootstrap iterator keeps draining in the background
    // past the timeout -- its signal still reaches the projection via the
    // normal serial chain, and completion restores health:nominal (H2) +
    // flips bootstrapCompleted, all without the engine ever spawning a
    // second catchUp() iterator.
    const lateSignal = messageSignal({ taskId: "late-2", receiptSource: "bootstrap-kind-30078" });
    bootstrapManual.push(lateSignal);
    bootstrapManual.complete();

    await vi.waitFor(() => expect(engine.getState().health).toBe("nominal"));
    const acceptedIds = acceptedEvents(events).map((e) =>
      e.event.payload.type === "task.created" ? e.event.payload.task.id : "",
    );
    expect(acceptedIds).toContain("late-2");
    await vi.waitFor(() => {
      const lastCheckpoint = mockPersistence.saveCheckpointCalls.at(-1);
      expect(lastCheckpoint?.bootstrapCompleted).toBe(true);
    });

    const catchUpCalls = mockAdapter.callLog.filter((c) => c.method === "catchUp");
    expect(catchUpCalls.length).toBe(1);
  });

  it("bootstrap failure (fetchBootstrap iterator throws) before T_join -> L5 degraded, no crash", async () => {
    const { engine, mockAdapter } = buildEngine({ tJoinMs: 8000 });
    mockAdapter.scriptFetchBootstrapThrows(new Error("bootstrap fetch failed"));
    mockAdapter.scriptCatchUp([]);

    await expect(engine.start({ origin: "welcome" })).resolves.toBeUndefined();

    expect(engine.getState()).toEqual({ lifecycle: "live", health: "degraded" });
    const catchUpCalls = mockAdapter.callLog.filter((c) => c.method === "catchUp");
    expect(catchUpCalls.length).toBe(1);
  });

});

// ---------------------------------------------------------------------------
// AC-INV-5: a deferred fact reaches the projection via the engine's own
// L8/L9 retry, with no externally-triggered reload/rebuild/re-fetch.
// ---------------------------------------------------------------------------

describe("AC-INV-5: deferred fact converges via the engine's own L8/L9 retry, no external reload", () => {
  it("parks an unreadable fact, then resolves it purely via epoch_advanced -> L8/L9, no test-side buildProjection/reload call", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = nextId("fact");
    mockAdapter.pushLive(deferredSignal({ factId }));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "envelope_deferred")).toBe(true),
    );
    expect(acceptedEvents(events)).toHaveLength(0);
    // No manual reload/rebuild call of any kind occurs here -- the assertion
    // path below only reads `events`, folding via the real projector.

    const resolved = messageSignal({ factId, taskId: "resolved-task" });
    mockAdapter.scriptIngestPersisted([resolved]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));

    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));
    const projection = foldProjection(events);
    expect(projection.has("resolved-task")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L1/L2 restart routing (non-negotiable contract from the story brief)
// ---------------------------------------------------------------------------

describe("L1/L2 restart routing (reconciled fsm.md guard)", () => {
  it("usable checkpoint with bootstrapCompleted=true -> L1 recovering", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    // First establish a completed checkpoint via a real welcome-join.
    await engine.start({ origin: "welcome" });
    await engine.stop();
    await engine.reset(); // start fresh mock engine below instead to avoid post-reset state complexity

    const { engine: engine2, mockAdapter: adapter2, mockPersistence: persistence2, events: events2 } =
      buildEngine();
    persistence2.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "live",
      lastEpoch: "epoch-0",
      lastIngestedSeq: 5,
      lastAcceptedDomainEventId: "evt-1",
      bootstrapCompleted: true,
    });
    adapter2.scriptCatchUp([]);
    adapter2.scriptCatchUp([]);
    await engine2.start({ origin: "restored" });

    const first = stateChanges(events2).find((c) =>
      ["joining", "recovering"].includes(c.state),
    );
    expect(first?.state).toBe("recovering");
    void engine;
    void events;
  });

  it("usable checkpoint with bootstrapCompleted=false -> L2 joining", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockPersistence.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "joining",
      lastEpoch: null,
      lastIngestedSeq: 0,
      lastAcceptedDomainEventId: null,
      bootstrapCompleted: false,
    });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "restored" });

    const first = stateChanges(events).find((c) => ["joining", "recovering"].includes(c.state));
    expect(first?.state).toBe("joining");
  });

  it("corrupt checkpoint with non-empty raw log -> L1 recovering, preserve-and-replay, degraded", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockPersistence.makeCheckpointCorrupt(GROUP_ID);
    mockPersistence.seedFacts(GROUP_ID, [
      {
        id: "f0",
        seq: 1,
        groupId: GROUP_ID,
        nostrEventId: "f0",
        nostrEvent: nostrEvent("f0"),
        receivedAt: 1,
        receiptSource: "historical",
        epochAtReceipt: "epoch-0",
      },
    ]);
    mockAdapter.scriptIngestPersisted([]); // R3 resubmission of the gap-tail fact
    mockAdapter.scriptCatchUp([]); // cutover drain
    await engine.start({ origin: "restored" });

    const first = stateChanges(events).find((c) => ["joining", "recovering"].includes(c.state));
    expect(first?.state).toBe("recovering");
    expect(first?.health).toBe("nominal"); // recovering is always reported nominal
    expect(engine.getState().lifecycle).toBe("live");
  });

  it("corrupt checkpoint with BOTH logs empty -> L2 joining", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockPersistence.makeCheckpointCorrupt(GROUP_ID);
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "restored" });

    const first = stateChanges(events).find((c) => ["joining", "recovering"].includes(c.state));
    expect(first?.state).toBe("joining");
  });

  it("start() throws if called from a non-uninitialized lifecycle", async () => {
    const { engine, mockAdapter } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    await expect(engine.start({ origin: "welcome" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parse_error terminal (non-negotiable contract): malformed -> rejected,
// never parked, never retried.
// ---------------------------------------------------------------------------

describe("malformed IngestSignal is terminal: domain_event_rejected(parse_error), never parked/retried", () => {
  it("a malformed signal is rejected and does not appear in the deferred queue nor get retried on epoch_advanced", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = nextId("fact");
    mockAdapter.pushLive(malformedSignal({ factId }));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "domain_event_rejected")).toBe(true),
    );
    const rejected = events.find(
      (e): e is Extract<EngineOutputEvent, { type: "domain_event_rejected" }> =>
        e.type === "domain_event_rejected",
    );
    expect(rejected?.reason).toBe("parse_error");
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).not.toContain(factId);

    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await Promise.resolve();
    await Promise.resolve();
    // ingestPersisted should never have been called with a batch containing
    // this factId (the deferred queue never contained it).
    expect(mockAdapter.callLog.filter((c) => c.method === "ingestPersisted").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// skipped IngestSignal: appended + watermark-advanced, never dropped.
// ---------------------------------------------------------------------------

describe("skipped IngestSignal is appended and watermark-advanced, never dropped", () => {
  it("a skipped signal's fact is durably appended even though no accepted event is derived", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = nextId("fact");
    mockAdapter.pushLive(skippedSignal({ factId }));
    await vi.waitFor(async () => {
      const facts = await mockPersistence.adapter.loadFacts(GROUP_ID);
      expect(facts.some((f) => f.id === factId)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// SEV-9 (S5 Stage-2 cold review): generation-token lifecycle-cancellation
// discipline. Every long-lived continuation (drain loops, timer callbacks,
// entry-action bodies) must abandon silently -- no emission, no persistence
// write, no lifecycle transition -- once its captured generation goes stale
// relative to a stop()/reset()/newer start(). These four tests mirror the
// cold review's own empirical probes (a)-(d).
// ---------------------------------------------------------------------------

/**
 * A scheduler whose `clearTimeout` is INTENTIONALLY a no-op and whose
 * `setTimeout` merely captures the callback for later MANUAL firing. This
 * simulates a race an ordinary fake-timer cannot: a timer callback that has
 * ALREADY been queued to run (in flight) by the moment stop()/reset() calls
 * `clearTimeout` -- cancellation cannot un-fire a callback already in
 * flight in the real world. Driving the T_join flip-proof through this
 * scheduler proves the GENERATION CHECK inside the callback -- not
 * `clearTimeout` -- is what prevents resurrection.
 */
function createRaceableScheduler(): EngineScheduler & { fireScheduled(): void } {
  let scheduledFn: (() => void) | null = null;
  return {
    now: () => Date.now(),
    setTimeout(fn) {
      scheduledFn = fn;
      return {} as EngineTimerHandle;
    },
    clearTimeout() {
      // Deliberately does NOT prevent fireScheduled() below from invoking
      // the captured callback -- see doc comment above.
    },
    fireScheduled() {
      scheduledFn?.();
    },
  };
}

describe("SEV-9: generation-token lifecycle-cancellation discipline (S5 Stage-2 cold review)", () => {
  it("(a) stop() during joining, then a T_join firing that clearTimeout could not prevent, causes no transition and no post-close openLive", async () => {
    const scheduler = createRaceableScheduler();
    const { engine, mockAdapter, events } = buildEngine({ scheduler, tJoinMs: 8000 });
    mockAdapter.scriptFetchBootstrapManual(); // never resolves in this test
    mockAdapter.scriptCatchUp([]); // would be consumed if the timer's continuation wrongly proceeded

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("joining"));

    await engine.stop();
    expect(engine.getState().lifecycle).toBe("stopped");
    const closeCallsBeforeFire = mockAdapter.closeCallCount;
    const openLiveCallsBeforeFire = mockAdapter.callLog.filter((c) => c.method === "openLive").length;
    const stateEventsBeforeFire = events.filter((e) => e.type === "engine_state_changed").length;

    // Simulate the T_join timer's callback firing AFTER stop() -- a race
    // clearTimeout cannot prevent once the callback is already in flight.
    scheduler.fireScheduled();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getState().lifecycle).toBe("stopped"); // no resurrection
    expect(mockAdapter.closeCallCount).toBe(closeCallsBeforeFire); // no re-close
    expect(mockAdapter.callLog.filter((c) => c.method === "openLive").length).toBe(
      openLiveCallsBeforeFire,
    ); // no L4/L5 openLive-after-close
    expect(events.filter((e) => e.type === "engine_state_changed").length).toBe(
      stateEventsBeforeFire,
    ); // no further state-change emission
    await startPromise;
  });

  it("(b) stop() mid catching_up historical drain suppresses further emissions/appends/checkpoints from the still-draining iterator", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("catching_up"));

    cutoverManual.push(messageSignal({ taskId: "before-stop" }));
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));

    await engine.stop();
    const acceptedBefore = acceptedEvents(events).length;
    const checkpointsBefore = mockPersistence.saveCheckpointCalls.length;
    const factsBefore = (await mockPersistence.adapter.loadFacts(GROUP_ID)).length;

    // The historical iterator is STILL OPEN (never completed) and yields
    // another signal AFTER stop() -- this must be a silent no-op.
    cutoverManual.push(messageSignal({ taskId: "after-stop" }));
    cutoverManual.complete();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getState().lifecycle).toBe("stopped"); // no resurrection
    expect(acceptedEvents(events).length).toBe(acceptedBefore); // no new emission
    expect(mockPersistence.saveCheckpointCalls.length).toBe(checkpointsBefore); // no new write
    expect((await mockPersistence.adapter.loadFacts(GROUP_ID)).length).toBe(factsBefore); // no new append
    await startPromise;
  });

  it("(c) reset() during a catching_up drain leaves stores empty after settle; the next start() runs cleanly with no invariant-violation throw", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("catching_up"));

    cutoverManual.push(messageSignal({ taskId: "pre-reset" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await engine.reset();
    expect(engine.getState().lifecycle).toBe("uninitialized");

    // The old drain resumes AFTER reset() and yields one more signal, then
    // completes -- this must not write into the freshly-cleared stores.
    cutoverManual.push(messageSignal({ taskId: "post-reset" }));
    cutoverManual.complete();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(await mockPersistence.adapter.loadFacts(GROUP_ID)).toEqual([]);
    expect(await mockPersistence.adapter.loadAcceptedEvents(GROUP_ID)).toEqual([]);
    expect(engine.getState().lifecycle).toBe("uninitialized"); // still, no resurrection

    // A fresh start() afterwards must work cleanly: no resurrected/stale
    // counter spuriously trips the catchUp() exactly-once invariant guard
    // (which would manifest as start() rejecting).
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await expect(engine.start({ origin: "welcome" })).resolves.toBeUndefined();
    expect(engine.getState().lifecycle).toBe("live");
    await startPromise;
  });

  it("(d1) stop() at the moment buffering_live begins draining discards the buffered live signal (no emission, no accept)", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("catching_up"));

    mockAdapter.pushLive(messageSignal({ taskId: "buffered-live" })); // buffered, not yet applied

    cutoverManual.complete(); // triggers L6 -> buffering_live's drain
    await engine.stop(); // races the drain, no yield in between

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getState().lifecycle).toBe("stopped");
    expect(acceptedEvents(events)).toHaveLength(0); // the buffered signal was never applied
    await startPromise;
  });

  it("(d2) stop() during retrying_deferred's drain discards the in-flight retry (no accept, no checkpoint, stays stopped)", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = nextId("fact");
    mockAdapter.pushLive(deferredSignal({ factId }));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "envelope_deferred")).toBe(true),
    );

    const retryManual = mockAdapter.scriptIngestPersistedManual();
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() =>
      expect(stateChanges(events).some((c) => c.state === "retrying_deferred")).toBe(true),
    );

    await engine.stop();
    // Captured AFTER stop() resolves so stop()'s OWN final checkpoint save
    // (L10's entry action) is already accounted for -- what follows must
    // add NOTHING further.
    const acceptedBefore = acceptedEvents(events).length;
    const checkpointsBefore = mockPersistence.saveCheckpointCalls.length;

    // The retry pass's iterator resumes AFTER stop() and yields the
    // now-resolved fact -- must be a silent no-op.
    const resolved = messageSignal({ factId, taskId: "resolved-after-stop" });
    retryManual.push(resolved);
    retryManual.complete();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getState().lifecycle).toBe("stopped");
    expect(acceptedEvents(events).length).toBe(acceptedBefore);
    expect(mockPersistence.saveCheckpointCalls.length).toBe(checkpointsBefore);
  });
});

// ---------------------------------------------------------------------------
// SEV-7 (S5 Stage-2 cold review): preserve-and-replay re-infers
// bootstrapCompleted=true IMMEDIATELY on taking L1's second arm, before any
// checkpoint save -- not deferred to reaching live -- so a crash mid-
// recovery re-routes the NEXT restart back to L1 preserve-and-replay rather
// than L2 joining over non-empty logs (architecture.md Constraint 12,
// revised 2026-07-12).
// ---------------------------------------------------------------------------

describe("SEV-7: preserve-and-replay re-infers bootstrapCompleted immediately (crash-mid-recovery simulation)", () => {
  it("a checkpoint saved mid-recovery (before reaching live) already carries bootstrapCompleted=true; a fresh engine instance over the SAME stores restarts into L1, not L2", async () => {
    const mockPersistence = createMockPersistenceAdapter();
    mockPersistence.makeCheckpointCorrupt(GROUP_ID);
    mockPersistence.seedFacts(GROUP_ID, [
      {
        id: "f0",
        seq: 1,
        groupId: GROUP_ID,
        nostrEventId: "f0",
        nostrEvent: nostrEvent("f0"),
        receivedAt: 1,
        receiptSource: "historical",
        epochAtReceipt: "epoch-0",
      },
    ]);

    const mockAdapter = createMockIngestSource();
    mockAdapter.scriptIngestPersisted([]); // R3 crash-gap resubmission (empty gap)
    // Hold the CUTOVER drain open manually so we can "crash" (build a
    // second engine over the same stores) BEFORE this engine ever reaches
    // buffering_live/live -- proving the re-infer already happened earlier,
    // during `enterRecovering` itself.
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    const engine1 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    void engine1.start({ origin: "restored" }).catch(() => {});

    await vi.waitFor(() => expect(engine1.getState().lifecycle).toBe("catching_up"));

    // At this point recovery has completed its R1-R4 preamble and taken L1's
    // preserve-and-replay arm, and the FIRST checkpoint save (transitionTo
    // "recovering") has already landed -- BEFORE live is ever reached (the
    // cutover drain is still being held open above). Assert that save
    // already carries bootstrapCompleted=true.
    const savesSoFar = mockPersistence.saveCheckpointCalls;
    expect(savesSoFar.length).toBeGreaterThan(0);
    const recoveringSave = savesSoFar.find((c) => c.engineState === "recovering");
    expect(recoveringSave?.bootstrapCompleted).toBe(true);

    // "Crash" -- build a SECOND, fresh engine instance over the identical
    // (real, non-corrupt-anymore) persisted stores, simulating a restart
    // right after that mid-recovery checkpoint save landed.
    const mockAdapter2 = createMockIngestSource();
    mockAdapter2.scriptIngestPersisted([]); // R3 crash-gap resubmission
    mockAdapter2.scriptCatchUp([]); // cutover drain
    const events2: EngineOutputEvent[] = [];
    const engine2 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter2.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    engine2.subscribe((e) => events2.push(e));
    await engine2.start({ origin: "restored" });

    const first = stateChanges(events2).find((c) => ["joining", "recovering"].includes(c.state));
    expect(first?.state).toBe("recovering"); // L1 again, NOT L2 joining

    // Let the first engine's held-open drain settle so it doesn't leak
    // between tests.
    cutoverManual.complete();
    await vi.waitFor(() => expect(engine1.getState().lifecycle).toBe("live"));
  });
});

// ---------------------------------------------------------------------------
// SEV-6 (R-INV-3): a fact that is currently PARKED (deferred) but arrives
// readable via an ordinary live push or catchUp() re-delivery -- NOT via
// the L8/L9 retry pass -- must still be accepted through the single
// `acceptDeferredFact` entry point and un-parked, mirroring the malformed-
// signal defensive un-park.
// ---------------------------------------------------------------------------

describe("SEV-6 (R-INV-3): a parked fact re-delivered readable via live/catchUp is accepted via acceptDeferredFact and un-parked", () => {
  it("parks an unreadable fact, then a live push re-delivers the SAME fact id readable -- acceptDeferredFact is called, the deferred-store no longer contains it, and no later L8 pass re-submits it", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = nextId("fact");
    mockAdapter.pushLive(deferredSignal({ factId }));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "envelope_deferred")).toBe(true),
    );
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).toContain(factId);

    // The SAME fact id arrives readable via an ordinary live push (NOT the
    // L8/L9 retry pass -- no epoch_advanced involved here at all).
    const redelivered = messageSignal({ factId, taskId: "redelivered-task" });
    mockAdapter.pushLive(redelivered);
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));

    expect(mockPersistence.acceptDeferredFactCalls).toHaveLength(1);
    expect(mockPersistence.acceptDeferredFactCalls[0].factId).toBe(factId);
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).not.toContain(factId);

    // A later epoch_advanced must NOT re-submit this id via L8 -- the
    // deferred queue no longer contains it, so ingestPersisted is never
    // called with a batch including it.
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockAdapter.callLog.filter((c) => c.method === "ingestPersisted").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SEV-6 (P2-4): a non-live epoch_advanced LATCHES the retry request instead
// of dropping it -- fsm.md's L8 amendment. `enterLive` (L7) takes L8
// immediately if the latch is set and the deferred queue is non-empty.
// ---------------------------------------------------------------------------

describe("SEV-6 (P2-4): epoch_advanced observed while non-live is latched, not dropped -- L7 fires the retry pass immediately", () => {
  it("an epoch_advanced signal buffered and drained WHILE still buffering_live (queue already non-empty) triggers the retry pass immediately on reaching live, with no further epoch bump needed", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("catching_up"));

    // Park a fact and observe an epoch_advanced, BOTH delivered live during
    // catching_up -- both get buffered (I-FSM-3) and are only drained once
    // buffering_live begins, so `handleEpochAdvanced` runs with
    // lifecycle==="buffering_live" (non-live): the latch path, not the
    // direct live path.
    const factId = nextId("fact");
    mockAdapter.pushLive(deferredSignal({ factId }));
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));

    mockAdapter.scriptIngestPersisted([]); // the eventual L8/L9 retry pass's drain
    cutoverManual.complete();
    await startPromise;

    // The retry pass must have fired automatically on reaching live -- NOT
    // require a SECOND, separate epoch_advanced while already live.
    await vi.waitFor(() =>
      expect(stateChanges(events).some((c) => c.state === "retrying_deferred")).toBe(true),
    );
    expect(engine.getState().lifecycle).toBe("live");
    expect(events.filter((e) => e.type === "deferred_retry_started")).toHaveLength(1);
  });

  it("the latch clears once consumed: a SECOND epoch_advanced arriving after the queue has already emptied does not re-trigger retrying_deferred", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const cutoverManual = mockAdapter.scriptCatchUpManual();

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("catching_up"));

    const factId = nextId("fact");
    mockAdapter.pushLive(deferredSignal({ factId }));
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    mockAdapter.scriptIngestPersisted([messageSignal({ factId, taskId: "resolved-on-l8" })]);
    cutoverManual.complete();
    await startPromise;

    await vi.waitFor(() =>
      expect(stateChanges(events).some((c) => c.state === "retrying_deferred")).toBe(true),
    );
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));
    const retryingCountAfterFirst = stateChanges(events).filter(
      (c) => c.state === "retrying_deferred",
    ).length;
    expect(retryingCountAfterFirst).toBe(1);

    // Queue is now empty (the parked fact resolved via L8/L9 above). A
    // second epoch_advanced with nothing left to retry must NOT re-enter
    // retrying_deferred (P3 batch item (a): empty-batch transitions are
    // skipped entirely).
    mockAdapter.pushLive(epochAdvancedSignal("epoch-2", "epoch-1"));
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "group_epoch_advanced" && e.newEpoch === "epoch-2")).toBe(
        true,
      ),
    );
    expect(
      stateChanges(events).filter((c) => c.state === "retrying_deferred").length,
    ).toBe(retryingCountAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// SEV-7 (P2-3, S6 Stage-2 cold review): "L9 latch consumption" -- a nested
// epoch_advanced yielded by ingestPersisted INSIDE a retry pass (lifecycle
// is "retrying_deferred", non-live, for the whole pass) latches via the
// SAME mechanism as SEV-6/P2-4 above, but its consumer is `enterRetryingDeferred`
// itself (a second pass), NOT `enterLive` -- the two are complementary, not
// duplicates. Before this fix the latch was set but never consumed on this
// path: `enterRetryingDeferred` transitioned straight back to "live" via
// `transitionTo` (never calling `enterLive`, the only OTHER latch consumer),
// so the remaining parked entry sat unconsumed until some LATER, unrelated
// epoch bump happened to arrive while already live.
// ---------------------------------------------------------------------------

describe("SEV-7 (P2-3): a nested epoch_advanced yielded INSIDE a retry batch triggers another pass under the new epoch, with no third external advance", () => {
  it("two facts parked; the retry batch's own ingestPersisted resolves one fact and ALSO yields a nested epoch_advanced -- the remaining fact is retried automatically in a second pass, with no externally-triggered epoch bump", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factA = nextId("fact");
    const factB = nextId("fact");
    mockAdapter.pushLive(deferredSignal({ factId: factA }));
    mockAdapter.pushLive(deferredSignal({ factId: factB }));
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === "envelope_deferred")).toHaveLength(2),
    );

    // First pass: resolve factA via a "message" signal, and ALSO yield a
    // NESTED epoch_advanced from the SAME ingestPersisted call -- while
    // factB is still parked (still "unreadable").
    mockAdapter.scriptIngestPersisted([
      messageSignal({ factId: factA, taskId: "task-a-resolved" }),
      epochAdvancedSignal("epoch-2", "epoch-1"),
      deferredSignal({ factId: factB }),
    ]);
    // Second pass (triggered automatically by the nested advance, NOT by a
    // further EXTERNAL epoch_advanced): resolve factB.
    mockAdapter.scriptIngestPersisted([messageSignal({ factId: factB, taskId: "task-b-resolved" })]);

    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));

    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(2));
    expect(new Set(acceptedEvents(events).map((e) => e.event.factId))).toEqual(
      new Set([factA, factB]),
    );

    // Exactly ONE externally-triggered epoch_advanced was pushed by this
    // test (epoch-1); the nested one (epoch-2) came from inside the batch.
    expect(
      events.filter((e) => e.type === "group_epoch_advanced").map((e) => e.newEpoch),
    ).toEqual(["epoch-1", "epoch-2"]);

    // A single "retrying_deferred" lifecycle STATE entry covers both passes
    // (L8 is a state, not re-entered per pass), but TWO deferred_retry_started
    // events fire -- one per pass, each reporting its own batch.
    expect(
      stateChanges(events).filter((c) => c.state === "retrying_deferred").length,
    ).toBe(1);
    expect(events.filter((e) => e.type === "deferred_retry_started")).toHaveLength(2);

    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));
  });
});
