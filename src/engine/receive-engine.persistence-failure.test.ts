/**
 * receive-engine.persistence-failure.test.ts
 *
 * AC-PERS-1 (Implementation Constraint 11) conformance suite, plus the two
 * S6 ledger obligations that live in this same failure-handling area:
 * ingest-policy TTL-prune wiring (obligation 1) and retry-budget-exhausted
 * deferred-entry disposition (obligation 2). See this story's
 * architecture.json for the full design ("persistence-retry-*" and
 * "deferred-ttl-*"/"exhausted-entry-*" judgment calls).
 *
 * Mirrors receive-engine.fsm.test.ts's fixture/mock conventions (each S5+
 * test file duplicates its own minimal in-memory IngestSource/
 * PersistenceAdapter rather than importing across test files or across the
 * src/persistence/* boundary AC-BOUND-1 forbids for any src/engine/* file,
 * tests included).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReceiveEngine,
  createRealEngineScheduler,
  PERSISTENCE_RETRY_BASE_DELAY_MS,
  PERSISTENCE_RETRY_BACKOFF_FACTOR,
  PERSISTENCE_RETRY_MAX_ATTEMPTS,
  PERSISTENCE_RETRY_MAX_DELAY_MS,
  REJECTED_REASON_DEFERRED_TTL_EXPIRED,
  REJECTED_REASON_PERSISTENCE_EXHAUSTED,
  REJECTED_REASON_RETRY_EXHAUSTED,
  type EngineScheduler,
  type EngineTimerHandle,
} from "./receive-engine";
import type {
  AcceptedDomainEvent,
  AppendFactResult,
  EngineCheckpoint,
  EngineOutputEvent,
  IngestSignal,
  IngestSource,
  NostrEvent,
  PersistenceAdapter,
  RawProtocolFact,
  RawProtocolFactInput,
} from "./engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

// ---------------------------------------------------------------------------
// Fixture builders (subset of receive-engine.fsm.test.ts's, duplicated per
// this repo's established per-file convention)
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
    receiptSource: "historical",
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

function epochAdvancedSignal(newEpoch: string, prevEpoch: string): IngestSignal {
  return { type: "epoch_advanced", newEpoch, prevEpoch };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// ManualScheduler -- a fully deterministic EngineScheduler whose virtual
// clock only ever moves when a test explicitly calls advanceTo(). Used
// instead of vi.useFakeTimers() for tests that need EXACT backoff-boundary
// bookkeeping: vi.waitFor() silently nudges vitest's fake-timer clock
// forward via its own internal polling interval while it waits, which
// corrupts precise millisecond arithmetic layered on top of
// vi.advanceTimersByTimeAsync(). ManualScheduler has no such interaction --
// its clock is inert except at an explicit advanceTo() call, so vi.waitFor()
// (used here only to flush the resulting microtask/promise chain, never to
// advance time) is safe to mix in freely.
// ---------------------------------------------------------------------------

class ManualScheduler implements EngineScheduler {
  private nowMs = 0;
  private timers: { id: number; fn: () => void; due: number }[] = [];
  private nextId = 1;
  now(): number {
    return this.nowMs;
  }
  setTimeout(fn: () => void, ms: number): EngineTimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, fn, due: this.nowMs + ms });
    return { __brand: "EngineTimerHandle", id } as unknown as EngineTimerHandle;
  }
  clearTimeout(handle: EngineTimerHandle): void {
    const id = (handle as unknown as { id: number }).id;
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  /**
   * Advances the virtual clock to `ms`, firing every timer strictly in
   * DUE-ORDER -- one at a time, setting `nowMs` to THAT timer's own due
   * time (never jumping straight to `ms`) before firing it, then yielding
   * a few microtask ticks before looking for the next one.
   *
   * This ordering is load-bearing, not cosmetic: a fired retry callback's
   * `catch` branch computes its NEXT backoff delay as `scheduler.now() + ms`
   * (see `retryDelay` in receive-engine.ts) -- but that computation only
   * happens after a handful of microtask ticks (the failed attempt's
   * rejection propagating through withPersistenceRetry's `await attempt()`).
   * A naive `nowMs = ms; fire everything due <= ms` (this class's original
   * S6 implementation) sets `nowMs` to the FINAL target BEFORE any of those
   * cascading continuations run, so a chain of several backoff waits that
   * should have been computed relative to their own intermediate firing
   * times all end up anchored to the jumped-to target instead -- silently
   * corrupting every delay after the first cascade. Firing in strict
   * due-order with a real intermediate `nowMs` at each step (mirroring how
   * `vi.advanceTimersByTimeAsync` behaves under real fake timers) avoids
   * this entirely. Async because it must yield to microtasks between fires.
   */
  async advanceTo(ms: number): Promise<void> {
    for (;;) {
      let next: { id: number; fn: () => void; due: number } | null = null;
      for (const t of this.timers) {
        if (t.due <= ms && (next === null || t.due < next.due)) next = t;
      }
      if (next === null) break;
      this.timers = this.timers.filter((t) => t.id !== next!.id);
      this.nowMs = next.due;
      next.fn();
      // Let this fire's cascade (promise resolution -> retry loop
      // continuation -> possibly a NEW scheduler.setTimeout call) fully
      // register before re-scanning for the next due timer.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.nowMs = ms;
  }
}

// ---------------------------------------------------------------------------
// Mock IngestSource
// ---------------------------------------------------------------------------

interface MockIngestSource {
  source: IngestSource;
  scriptCatchUp(signals: IngestSignal[]): void;
  scriptFetchBootstrap(signals: IngestSignal[]): void;
  scriptIngestPersisted(signals: IngestSignal[]): void;
  ingestPersistedCallLog: RawProtocolFact[][];
  pushLive(signal: IngestSignal): void;
  closeCallCount: number;
}

function createMockIngestSource(): MockIngestSource {
  const catchUpScripts: IngestSignal[][] = [];
  const fetchBootstrapScripts: IngestSignal[][] = [];
  const ingestPersistedScripts: IngestSignal[][] = [];
  const ingestPersistedCallLog: RawProtocolFact[][] = [];
  let onSignal: ((signal: IngestSignal) => void) | null = null;
  let closeCallCount = 0;

  const source: IngestSource = {
    catchUp() {
      return fromArray(catchUpScripts.shift() ?? []);
    },
    openLive(cb) {
      onSignal = cb;
      return () => {
        if (onSignal === cb) onSignal = null;
      };
    },
    ingestPersisted(facts) {
      ingestPersistedCallLog.push(facts);
      return fromArray(ingestPersistedScripts.shift() ?? []);
    },
    fetchBootstrap() {
      return fromArray(fetchBootstrapScripts.shift() ?? []);
    },
    close() {
      closeCallCount += 1;
    },
  };

  return {
    source,
    scriptCatchUp(signals) {
      catchUpScripts.push(signals);
    },
    scriptFetchBootstrap(signals) {
      fetchBootstrapScripts.push(signals);
    },
    scriptIngestPersisted(signals) {
      ingestPersistedScripts.push(signals);
    },
    ingestPersistedCallLog,
    pushLive(signal) {
      onSignal?.(signal);
    },
    get closeCallCount() {
      return closeCallCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock PersistenceAdapter with per-method failure injection
// ---------------------------------------------------------------------------

interface MockPersistenceAdapter {
  adapter: PersistenceAdapter;
  appendFactCalls: RawProtocolFactInput[];
  appendAcceptedEventCalls: AcceptedDomainEvent[];
  saveCheckpointCalls: EngineCheckpoint[];
  saveDeferredIdsCalls: { groupId: string; ids: string[] }[];
  acceptDeferredFactCalls: { groupId: string; factId: string; event: AcceptedDomainEvent }[];
  failAppendFactTimes(n: number): void;
  failAppendAcceptedEventTimes(n: number): void;
  failSaveCheckpointTimes(n: number): void;
  failAcceptDeferredFactTimes(n: number): void;
  failSaveDeferredIdsTimes(n: number): void;
}

function createMockPersistenceAdapter(): MockPersistenceAdapter {
  const facts = new Map<string, RawProtocolFact[]>();
  const acceptedEvents = new Map<string, AcceptedDomainEvent[]>();
  const checkpoints = new Map<string, EngineCheckpoint>();
  const deferredIds = new Map<string, string[]>();

  const appendFactCalls: RawProtocolFactInput[] = [];
  const appendAcceptedEventCalls: AcceptedDomainEvent[] = [];
  const saveCheckpointCalls: EngineCheckpoint[] = [];
  const saveDeferredIdsCalls: { groupId: string; ids: string[] }[] = [];
  const acceptDeferredFactCalls: { groupId: string; factId: string; event: AcceptedDomainEvent }[] =
    [];

  let appendFactFailuresRemaining = 0;
  let appendAcceptedEventFailuresRemaining = 0;
  let saveCheckpointFailuresRemaining = 0;
  let acceptDeferredFactFailuresRemaining = 0;
  let saveDeferredIdsFailuresRemaining = 0;

  const adapter: PersistenceAdapter = {
    async appendFact(fact) {
      appendFactCalls.push(fact);
      if (appendFactFailuresRemaining > 0) {
        appendFactFailuresRemaining -= 1;
        throw new Error("mock appendFact failure");
      }
      const list = facts.get(fact.groupId) ?? [];
      const found = list.find((f) => f.id === fact.id);
      if (found) return { fact: found, duplicate: true };
      const seq = list.length === 0 ? 1 : list[list.length - 1].seq + 1;
      const newFact: RawProtocolFact = { ...fact, seq };
      facts.set(fact.groupId, [...list, newFact]);
      return { fact: newFact, duplicate: false } satisfies AppendFactResult;
    },
    async loadFacts(groupId) {
      return [...(facts.get(groupId) ?? [])].sort((a, b) => a.seq - b.seq);
    },
    async appendAcceptedEvent(event) {
      appendAcceptedEventCalls.push(event);
      if (appendAcceptedEventFailuresRemaining > 0) {
        appendAcceptedEventFailuresRemaining -= 1;
        throw new Error("mock appendAcceptedEvent failure");
      }
      const list = acceptedEvents.get(event.groupId) ?? [];
      if (list.some((e) => e.id === event.id)) return;
      acceptedEvents.set(event.groupId, [...list, event]);
    },
    async loadAcceptedEvents(groupId) {
      return [...(acceptedEvents.get(groupId) ?? [])];
    },
    async saveCheckpoint(checkpoint) {
      saveCheckpointCalls.push(checkpoint);
      if (saveCheckpointFailuresRemaining > 0) {
        saveCheckpointFailuresRemaining -= 1;
        throw new Error("mock saveCheckpoint failure");
      }
      checkpoints.set(checkpoint.groupId, checkpoint);
    },
    async loadCheckpoint(groupId) {
      return checkpoints.get(groupId) ?? null;
    },
    async saveDeferredIds(groupId, ids) {
      saveDeferredIdsCalls.push({ groupId, ids: [...ids] });
      if (saveDeferredIdsFailuresRemaining > 0) {
        saveDeferredIdsFailuresRemaining -= 1;
        throw new Error("mock saveDeferredIds failure");
      }
      deferredIds.set(groupId, [...ids]);
    },
    async loadDeferredIds(groupId) {
      return [...(deferredIds.get(groupId) ?? [])];
    },
    async acceptDeferredFact(groupId, factId, event) {
      acceptDeferredFactCalls.push({ groupId, factId, event });
      if (acceptDeferredFactFailuresRemaining > 0) {
        acceptDeferredFactFailuresRemaining -= 1;
        throw new Error("mock acceptDeferredFact failure");
      }
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

  return {
    adapter,
    appendFactCalls,
    appendAcceptedEventCalls,
    saveCheckpointCalls,
    saveDeferredIdsCalls,
    acceptDeferredFactCalls,
    failAppendFactTimes(n) {
      appendFactFailuresRemaining = n;
    },
    failAppendAcceptedEventTimes(n) {
      appendAcceptedEventFailuresRemaining = n;
    },
    failSaveCheckpointTimes(n) {
      saveCheckpointFailuresRemaining = n;
    },
    failAcceptDeferredFactTimes(n) {
      acceptDeferredFactFailuresRemaining = n;
    },
    failSaveDeferredIdsTimes(n) {
      saveDeferredIdsFailuresRemaining = n;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared scaffold
// ---------------------------------------------------------------------------

const GROUP_ID = "group-1";

function buildEngine(overrides?: {
  scheduler?: EngineScheduler;
  checkpointIntervalMs?: number;
  ingestPolicyOptions?: {
    maxDeferredSize: number;
    maxDeferredAgeSec: number;
    maxRetryAttempts: number;
  };
}) {
  const mockAdapter = createMockIngestSource();
  const mockPersistence = createMockPersistenceAdapter();
  const events: EngineOutputEvent[] = [];
  const engine = createReceiveEngine({
    groupId: GROUP_ID,
    adapter: mockAdapter.source,
    persistence: mockPersistence.adapter,
    scheduler: overrides?.scheduler ?? createRealEngineScheduler(),
    checkpointIntervalMs: overrides?.checkpointIntervalMs,
    ingestPolicyOptions: overrides?.ingestPolicyOptions,
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

function rejectedEvents(events: EngineOutputEvent[]) {
  return events.filter(
    (e): e is Extract<EngineOutputEvent, { type: "domain_event_rejected" }> =>
      e.type === "domain_event_rejected",
  );
}

/** Sums the K backoff waits a K-failures-then-success run needs so a test
 *  can advance fake timers through the whole sequence in one shot. */
function totalBackoffMsForFailures(failureCount: number): number {
  let total = 0;
  for (let attempt = 1; attempt <= failureCount; attempt += 1) {
    const raw = PERSISTENCE_RETRY_BASE_DELAY_MS * PERSISTENCE_RETRY_BACKOFF_FACTOR ** (attempt - 1);
    total += Math.min(raw, PERSISTENCE_RETRY_MAX_DELAY_MS);
  }
  return total;
}

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC-PERS-1 core observable (VQ-S6-004 / VQ-S6-007)
// ---------------------------------------------------------------------------

describe("AC-PERS-1: appendFact failure -> degraded + bounded-backoff retry -> nominal", () => {
  it("degrades after the first failure, retries appendFact K+1 times with fake-timer-verified bounded backoff, retains the same fact content throughout, and returns to nominal on the K+1th success", async () => {
    vi.useFakeTimers();
    const K = 3;
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const factId = "fact-under-retry";
    mockAdapter.scriptCatchUp([messageSignal({ factId, taskId: "task-retried" })]);
    mockPersistence.failAppendFactTimes(K);

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});

    // First failure must degrade immediately (no need to wait out any
    // backoff for THIS assertion -- addDegradationReason fires synchronously
    // inside the failed attempt's catch branch).
    await vi.waitFor(() => expect(mockPersistence.appendFactCalls.length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() =>
      expect(stateChanges(events).some((c) => c.health === "degraded")).toBe(true),
    );
    expect(engine.getState().health).toBe("degraded");

    // Drive fake timers through all K backoff waits in one shot.
    await vi.advanceTimersByTimeAsync(totalBackoffMsForFailures(K) + 1);
    await startPromise;

    // Retried >= K+1 times total (K failures + the succeeding call).
    expect(mockPersistence.appendFactCalls.length).toBeGreaterThanOrEqual(K + 1);
    // The SAME fact content on every attempt -- proof the fact was retained
    // (not regenerated/altered) across the whole retry sequence.
    for (const call of mockPersistence.appendFactCalls) {
      expect(call.id).toBe(factId);
      expect(call.groupId).toBe(GROUP_ID);
    }

    // K+1th call succeeded -> health nominal, the domain event eventually
    // accepted.
    expect(engine.getState().health).toBe("nominal");
    expect(acceptedEvents(events)).toHaveLength(1);
    const degradedThenNominal = stateChanges(events)
      .map((c) => c.health)
      .filter((_, i, arr) => i === 0 || arr[i] !== arr[i - 1]);
    expect(degradedThenNominal).toContain("degraded");
    expect(degradedThenNominal.at(-1)).toBe("nominal");
  });

  it("retries scale with a growing (bounded) delay, not a fixed interval", async () => {
    // ManualScheduler (not vi.useFakeTimers()) -- see its doc comment: this
    // test's exact-boundary arithmetic must not be corrupted by vi.waitFor's
    // own internal fake-timer nudging.
    const scheduler = new ManualScheduler();
    const { engine, mockAdapter, mockPersistence } = buildEngine({ scheduler });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([messageSignal({ factId: "f-growing" })]);
    mockPersistence.failAppendFactTimes(3);

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() => expect(mockPersistence.appendFactCalls.length).toBe(1));

    // Advancing by LESS than the first backoff delay must not trigger a
    // second attempt yet.
    await scheduler.advanceTo(PERSISTENCE_RETRY_BASE_DELAY_MS - 1);
    await Promise.resolve();
    expect(mockPersistence.appendFactCalls.length).toBe(1);
    await scheduler.advanceTo(PERSISTENCE_RETRY_BASE_DELAY_MS);
    await vi.waitFor(() => expect(mockPersistence.appendFactCalls.length).toBe(2));

    // The SECOND wait must be longer than the first (growing backoff): not
    // yet due at base_delay*2 - 1 past the FIRST retry's firing point.
    const secondDelay = PERSISTENCE_RETRY_BASE_DELAY_MS * PERSISTENCE_RETRY_BACKOFF_FACTOR;
    await scheduler.advanceTo(PERSISTENCE_RETRY_BASE_DELAY_MS + secondDelay - 1);
    await Promise.resolve();
    expect(mockPersistence.appendFactCalls.length).toBe(2); // not yet -- second delay is bigger
    await scheduler.advanceTo(PERSISTENCE_RETRY_BASE_DELAY_MS + secondDelay);
    await vi.waitFor(() => expect(mockPersistence.appendFactCalls.length).toBe(3));

    mockPersistence.failAppendFactTimes(0); // let the next attempt succeed
    const thirdDelay = PERSISTENCE_RETRY_BASE_DELAY_MS * PERSISTENCE_RETRY_BACKOFF_FACTOR ** 2;
    await scheduler.advanceTo(PERSISTENCE_RETRY_BASE_DELAY_MS + secondDelay + thirdDelay);
    await startPromise;
    expect(mockPersistence.appendFactCalls.length).toBe(4);
  });

  it("exhausts after PERSISTENCE_RETRY_MAX_ATTEMPTS consecutive failures: stops retrying, stays degraded, never discards by pretending the fact was accepted", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([messageSignal({ factId: "f-exhausted" })]);
    mockPersistence.failAppendFactTimes(1000); // never succeeds

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() =>
      expect(mockPersistence.appendFactCalls.length).toBeGreaterThanOrEqual(1),
    );

    // Advance well past every possible backoff wait for MAX_ATTEMPTS tries.
    await vi.advanceTimersByTimeAsync(
      totalBackoffMsForFailures(PERSISTENCE_RETRY_MAX_ATTEMPTS) + 1000,
    );
    await startPromise;

    expect(mockPersistence.appendFactCalls.length).toBe(PERSISTENCE_RETRY_MAX_ATTEMPTS);
    // No further attempts even if more time passes -- retrying is parked
    // until the next engine start(), never abandoned mid-stream forever.
    const callsAtGiveUp = mockPersistence.appendFactCalls.length;
    await vi.advanceTimersByTimeAsync(PERSISTENCE_RETRY_MAX_DELAY_MS * 3);
    expect(mockPersistence.appendFactCalls.length).toBe(callsAtGiveUp);

    // Never discarded: no domain_event_accepted was ever emitted for the
    // fact that could not be durably appended, and the engine remains
    // degraded (not silently nominal) for the rest of this session.
    expect(acceptedEvents(events)).toHaveLength(0);
    expect(engine.getState().health).toBe("degraded");

    // P3-6a (S6 Stage-2 cold review): primary-write exhaustion now surfaces
    // the FOURTH rejection-vocabulary reason so a ledger/S8 consumer can
    // observe the outage, rather than the fact silently vanishing from
    // every emitted event.
    const persistenceExhausted = rejectedEvents(events).find(
      (e) => e.reason === REJECTED_REASON_PERSISTENCE_EXHAUSTED,
    );
    expect(persistenceExhausted?.factId).toBe("f-exhausted");
  });
});

// ---------------------------------------------------------------------------
// appendFact/appendAcceptedEvent HOLD their signal (primary state) without
// deadlocking the serial FIFO chain -- a later, independent signal still
// gets processed once the earlier one resolves (success or give-up).
// ---------------------------------------------------------------------------

describe("AC-PERS-1: primary-state writes hold their own signal's processing without deadlocking the FIFO", () => {
  it("appendAcceptedEvent failure withholds domain_event_accepted until the retry succeeds, then a LATER independent signal still processes normally afterward", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    mockPersistence.failAppendAcceptedEventTimes(2);
    mockAdapter.pushLive(messageSignal({ factId: "f-accept-retry", taskId: "t-1" }));
    await vi.waitFor(() =>
      expect(mockPersistence.appendAcceptedEventCalls.length).toBeGreaterThanOrEqual(1),
    );
    // Not yet accepted -- the write is still failing/retrying.
    expect(acceptedEvents(events)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(totalBackoffMsForFailures(2) + 1);
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));

    // A second, independent signal pushed WHILE the first was still retrying
    // is still processed once its turn in the FIFO arrives -- no deadlock.
    mockAdapter.pushLive(messageSignal({ factId: "f-after", taskId: "t-2" }));
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(2));
  });

  it("saveCheckpoint failure does NOT block a subsequent independent signal -- checkpoint retry runs detached in the background", async () => {
    // ManualScheduler -- see its doc comment (avoids vi.waitFor's fake-timer
    // clock nudging corrupting the ">" boundary check below).
    const scheduler = new ManualScheduler();
    const { engine, mockAdapter, mockPersistence, events } = buildEngine({
      scheduler,
      checkpointIntervalMs: 5000,
    });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    // ONE failure -- the "joining" transition's own synchronous attempt.
    // (Updated for P1-1, S6 Stage-2 cold review "stale checkpoint replay":
    // a stale detached retry now aborts silently -- instead of eventually
    // re-writing -- once a LATER, independent checkpoint save has already
    // committed, which is exactly what the very next transition's own save
    // does moments later during this same startup sequence. Proving the
    // retry mechanism itself still genuinely functions therefore requires
    // an ISOLATED failure with no competing later save in flight, which the
    // periodic-tick check below provides instead.)
    mockPersistence.failSaveCheckpointTimes(1);
    await engine.start({ origin: "welcome" });

    // start() resolved WITHOUT waiting for the failed checkpoint save's
    // backoff retry to complete -- proof the chain was never blocked on it.
    expect(engine.getState().lifecycle).toBe("live");

    // A live signal pushed immediately afterward is processed without
    // having to wait for the checkpoint retry's backoff.
    mockAdapter.pushLive(messageSignal({ factId: "f-post-checkpoint-fail", taskId: "t-3" }));
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));

    // The background retry mechanism is still genuinely real (not silently
    // dropped): fail exactly the NEXT checkpoint save -- the periodic tick,
    // now the only save in flight (no more transitions happen automatically
    // once live) -- so its own detached retry is provably the newest and
    // cannot be superseded. TWO failures (sync attempt + the retry's own
    // first, immediate, no-delay attempt), matching this file's established
    // pattern elsewhere, so the retry's SECOND attempt is the one genuinely
    // gated behind a `retryDelay` backoff wait for the clock-advance below
    // to observe.
    mockPersistence.failSaveCheckpointTimes(2);
    const checkpointCallsBeforeTick = mockPersistence.saveCheckpointCalls.length;
    await scheduler.advanceTo(5000);
    await vi.waitFor(() =>
      expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThan(checkpointCallsBeforeTick),
    );
    const callsBeforeRetry = mockPersistence.saveCheckpointCalls.length;
    await scheduler.advanceTo(5000 + PERSISTENCE_RETRY_BASE_DELAY_MS);
    await vi.waitFor(() =>
      expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThan(callsBeforeRetry),
    );
    void events;
  });

  it("a background saveCheckpoint retry succeeding does NOT prematurely clear health while a concurrent FIFO-blocking appendAcceptedEvent retry for a DIFFERENT signal is still failing (ref-counted shared reason)", async () => {
    const scheduler = new ManualScheduler();
    const { engine, mockAdapter, mockPersistence, events } = buildEngine({
      scheduler,
      checkpointIntervalMs: 5000,
    });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().health).toBe("nominal");

    // Block the FIFO indefinitely: this signal's appendAcceptedEvent keeps
    // failing until explicitly released below.
    mockPersistence.failAppendAcceptedEventTimes(1000);
    mockAdapter.pushLive(messageSignal({ factId: "f-blocked", taskId: "t-blocked" }));
    await vi.waitFor(() =>
      expect(mockPersistence.appendAcceptedEventCalls.length).toBeGreaterThanOrEqual(1),
    );
    expect(engine.getState().health).toBe("degraded");

    // Independently, fail exactly ONE periodic checkpoint tick -- its retry
    // is DETACHED from the FIFO (design note (c)) and can resolve while the
    // FIFO is still stuck on f-blocked.
    mockPersistence.failSaveCheckpointTimes(1);
    const checkpointCallsBefore = mockPersistence.saveCheckpointCalls.length;
    await scheduler.advanceTo(5000); // periodic tick fires (fails), its own retry's first internal attempt succeeds immediately (no further wait needed -- only one failure was configured)
    await vi.waitFor(() =>
      expect(mockPersistence.saveCheckpointCalls.length).toBeGreaterThan(checkpointCallsBefore),
    );

    // The checkpoint write recovered, but health MUST remain degraded -- the
    // appendAcceptedEvent retry for f-blocked is still failing. A plain
    // boolean/Set-membership reason would have incorrectly cleared here.
    expect(engine.getState().health).toBe("degraded");
    expect(acceptedEvents(events)).toHaveLength(0);

    // Release the blocked write; its already-scheduled 4th attempt (due at
    // t=1000+2000+4000=7000 -- three prior failures at t=0,1000,3000) now
    // succeeds, and health finally returns to nominal.
    mockPersistence.failAppendAcceptedEventTimes(0);
    await scheduler.advanceTo(7000);
    await vi.waitFor(() => expect(engine.getState().health).toBe("nominal"));
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));
  });
});

// ---------------------------------------------------------------------------
// Generation-token discipline mid-backoff (design note (a)): stop()/reset()
// abandon a pending retry cleanly -- no further I/O, no resurrection.
// ---------------------------------------------------------------------------

describe("AC-PERS-1: generation-token discipline -- stop()/reset() mid-backoff abandons cleanly", () => {
  it("stop() while an appendFact retry is mid-backoff prevents any further appendFact calls and leaves the engine stopped", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([messageSignal({ factId: "f-stop-mid-backoff" })]);
    mockPersistence.failAppendFactTimes(1000);

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() =>
      expect(mockPersistence.appendFactCalls.length).toBeGreaterThanOrEqual(1),
    );
    const callsAtStop = mockPersistence.appendFactCalls.length;

    await engine.stop();
    expect(engine.getState().lifecycle).toBe("stopped");

    // Advance well past every remaining backoff window -- the abandoned
    // retry must never fire another attempt.
    await vi.advanceTimersByTimeAsync(
      totalBackoffMsForFailures(PERSISTENCE_RETRY_MAX_ATTEMPTS) + 5000,
    );
    expect(mockPersistence.appendFactCalls.length).toBe(callsAtStop);
    expect(engine.getState().lifecycle).toBe("stopped");
    await startPromise;
  });
});

// ---------------------------------------------------------------------------
// Ledger obligation 2: retry-budget-exhausted deferred entries are removed
// + persisted + reported, never left to rot forever.
// ---------------------------------------------------------------------------

describe("S6 ledger obligation 2: retry-budget-exhausted deferred entries are evicted and reported", () => {
  it("an entry that exhausts its ingest-policy retry budget is removed + persisted + reported as retry-exhausted, while a fresh sibling entry stays parked", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine({
      ingestPolicyOptions: { maxDeferredSize: 100, maxDeferredAgeSec: 1_000_000, maxRetryAttempts: 1 },
    });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const exhaustedFactId = "fact-exhausted";
    mockAdapter.pushLive(deferredSignal({ factId: exhaustedFactId }));
    await vi.waitFor(() => expect(events.some((e) => e.type === "envelope_deferred")).toBe(true));

    // First (and, with maxRetryAttempts=1, only) retry pass: the fact comes
    // back still unreadable, so recordAttempt pushes it straight to
    // exhausted (attempts=1 >= maxRetryAttempts=1).
    mockAdapter.scriptIngestPersisted([deferredSignal({ factId: exhaustedFactId })]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() =>
      expect(rejectedEvents(events).some((e) => e.reason === REJECTED_REASON_RETRY_EXHAUSTED)).toBe(
        true,
      ),
    );

    const rejected = rejectedEvents(events).find((e) => e.reason === REJECTED_REASON_RETRY_EXHAUSTED);
    expect(rejected?.factId).toBe(exhaustedFactId);
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).not.toContain(exhaustedFactId);
    const callLogLengthAfterFirstPass = mockAdapter.ingestPersistedCallLog.length;

    // A FRESH sibling entry parked after the exhaustion is unaffected -- it
    // stays parked normally (not swept up by the same cleanup pass).
    const freshFactId = "fact-fresh";
    mockAdapter.pushLive(deferredSignal({ factId: freshFactId }));
    await vi.waitFor(async () =>
      expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).toContain(freshFactId),
    );

    // A LATER epoch_advanced retries the fresh sibling (proving the retry
    // mechanism is genuinely still live) but must NEVER resubmit the
    // already-exhausted-and-removed id.
    mockAdapter.scriptIngestPersisted([
      messageSignal({ factId: freshFactId, taskId: "t-fresh-resolved" }),
    ]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-2", "epoch-1"));
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));

    const callsAfterSecondPass = mockAdapter.ingestPersistedCallLog.slice(
      callLogLengthAfterFirstPass,
    );
    expect(callsAfterSecondPass.length).toBeGreaterThan(0);
    for (const call of callsAfterSecondPass) {
      expect(call.some((f) => f.id === exhaustedFactId)).toBe(false);
    }
    expect(callsAfterSecondPass.some((call) => call.some((f) => f.id === freshFactId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ledger obligation 1: TTL-pruned deferred entries are removed + persisted +
// reported (distinct reason from attempt-exhaustion).
// ---------------------------------------------------------------------------

describe("S6 ledger obligation 1: TTL-expired deferred entries are pruned + persisted + reported on the next epoch_advanced", () => {
  it("an aged-out entry is pruned and reported as deferred-ttl-expired ahead of the retry batch; a fresh entry within the TTL window is retried normally", async () => {
    const scheduler = new ManualScheduler();

    const { engine, mockAdapter, mockPersistence, events } = buildEngine({
      scheduler,
      ingestPolicyOptions: { maxDeferredSize: 100, maxDeferredAgeSec: 10, maxRetryAttempts: 20 },
    });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const oldFactId = "fact-old";
    mockAdapter.pushLive(deferredSignal({ factId: oldFactId }));
    await vi.waitFor(() => expect(events.some((e) => e.type === "envelope_deferred")).toBe(true));

    await scheduler.advanceTo(15_000); // 15s later -- older than the 10s TTL

    const freshFactId = "fact-fresh-within-ttl";
    mockAdapter.pushLive(deferredSignal({ factId: freshFactId }));
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === "envelope_deferred")).toHaveLength(2),
    );

    mockAdapter.scriptIngestPersisted([messageSignal({ factId: freshFactId, taskId: "t-fresh" })]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));

    await vi.waitFor(() =>
      expect(rejectedEvents(events).some((e) => e.reason === REJECTED_REASON_DEFERRED_TTL_EXPIRED)).toBe(
        true,
      ),
    );
    const pruned = rejectedEvents(events).find(
      (e) => e.reason === REJECTED_REASON_DEFERRED_TTL_EXPIRED,
    );
    expect(pruned?.factId).toBe(oldFactId);

    // The pruned id is durably gone; the fresh one was retried and accepted.
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).not.toContain(oldFactId);
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));

    // The retry batch submitted to ingestPersisted must never have included
    // the already-pruned id.
    for (const call of mockAdapter.ingestPersistedCallLog) {
      expect(call.some((f) => f.id === oldFactId)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// P1-1 (SEV-8, S6 Stage-2 cold review): "stale checkpoint replay" -- a
// detached checkpoint retry must never overwrite a NEWER save that has
// already committed, and reset() must never resurrect a checkpoint after
// clearGroupState wiped the store.
// ---------------------------------------------------------------------------

describe("P1-1: stale checkpoint replay -- a superseded detached retry never overwrites a newer committed save", () => {
  it("a stale checkpoint retry from an EARLIER transition's failure never overwrites a LATER transition's already-committed save -- proven via a bootstrapCompleted regression", async () => {
    const scheduler = new ManualScheduler();
    const { engine, mockAdapter, mockPersistence } = buildEngine({ scheduler });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    // Two failures: the "joining" transition's own synchronous attempt
    // (checkpoint content: engineState "joining", bootstrapCompleted false)
    // AND its detached retry's own first, immediate (no-delay) attempt --
    // so that retry is genuinely gated behind a `retryDelay` backoff wait,
    // held open while EVERY later transition (catching_up, buffering_live,
    // live -- all bootstrapCompleted true) succeeds normally in between.
    mockPersistence.failSaveCheckpointTimes(2);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    const committedBeforeStaleRetry = await mockPersistence.adapter.loadCheckpoint(GROUP_ID);
    expect(committedBeforeStaleRetry?.engineState).toBe("live");
    expect(committedBeforeStaleRetry?.bootstrapCompleted).toBe(true);

    // Advance the clock past the stale (joining-originated) retry's backoff.
    // Pre-P1-1, this retry replayed a FROZEN snapshot from the moment it was
    // first spawned (engineState "joining", bootstrapCompleted false) and
    // would have overwritten the store with that stale content once its
    // backoff elapsed -- regressing bootstrapCompleted back to false.
    const callsBeforeStaleFire = mockPersistence.saveCheckpointCalls.length;
    await scheduler.advanceTo(PERSISTENCE_RETRY_BASE_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const committedAfter = await mockPersistence.adapter.loadCheckpoint(GROUP_ID);
    expect(committedAfter?.engineState).toBe("live");
    expect(committedAfter?.bootstrapCompleted).toBe(true);
    // The counter guard specifically (not just the content-rebuild half of
    // P1-1): the stale retry's own attempt recognizes a NEWER save already
    // committed and aborts BEFORE issuing another `saveCheckpoint` call at
    // all -- content-rebuild alone (which always reads CURRENT state, so it
    // would also happen to write correct-but-redundant content here) would
    // NOT prevent this extra call; only the counter check does.
    expect(mockPersistence.saveCheckpointCalls.length).toBe(callsBeforeStaleFire);
  });

  it("reset() abandons a pending checkpoint retry -- no resurrection after clearGroupState wipes the store", async () => {
    const scheduler = new ManualScheduler();
    const { engine, mockAdapter, mockPersistence } = buildEngine({ scheduler });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    mockPersistence.failSaveCheckpointTimes(2); // sync + retry's own first attempt both fail
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    // A checkpoint retry (from the joining transition's original failure)
    // is still pending in the background at this point.
    await engine.reset();
    expect(engine.getState().lifecycle).toBe("uninitialized");
    expect(await mockPersistence.adapter.loadCheckpoint(GROUP_ID)).toBeNull();

    // Advance the clock well past the abandoned retry's backoff window --
    // if generation-abandonment (or the P1-1 counter guard) were broken,
    // this would resurrect a checkpoint after clearGroupState wiped it.
    await scheduler.advanceTo(PERSISTENCE_RETRY_MAX_DELAY_MS * 3);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await mockPersistence.adapter.loadCheckpoint(GROUP_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P1-2 (SEV-8, S6 Stage-2 cold review): "watermark-before-durability" -- the
// seq watermark must stay BEHIND a fact whose accepted-write never durably
// landed, so R3 resubmits it on the next restart instead of the ratchet's
// consumption silently outrunning the accepted-log.
// ---------------------------------------------------------------------------

describe("P1-2: watermark-before-durability -- R3 resubmits a fact whose accepted-write never durably landed", () => {
  it("appendAcceptedEvent exhaustion leaves the watermark BEHIND the fact; a fresh engine restart resubmits it via R3 and the event lands", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    const factId = "fact-accept-exhausted";
    mockPersistence.failAppendAcceptedEventTimes(1000); // never succeeds this session
    mockAdapter.pushLive(messageSignal({ factId, taskId: "task-exhausted" }));
    await vi.waitFor(() =>
      expect(mockPersistence.appendAcceptedEventCalls.length).toBeGreaterThanOrEqual(1),
    );

    // Drive the retry to genuine exhaustion.
    await vi.advanceTimersByTimeAsync(
      totalBackoffMsForFailures(PERSISTENCE_RETRY_MAX_ATTEMPTS) + 1000,
    );

    // Never accepted this session -- proof the write genuinely gave up.
    expect(acceptedEvents(events)).toHaveLength(0);
    expect(
      rejectedEvents(events).some(
        (e) => e.factId === factId && e.reason === REJECTED_REASON_PERSISTENCE_EXHAUSTED,
      ),
    ).toBe(true);

    // The raw fact IS durably in the log (appendFact succeeded), but its
    // seq must NOT be covered by the persisted watermark -- otherwise R3
    // would skip re-submitting it on the next restart even though its
    // accepted-log entry was never written (the SEV-8 bug this fixes).
    const checkpointAfterExhaustion = await mockPersistence.adapter.loadCheckpoint(GROUP_ID);
    const factsInLog = await mockPersistence.adapter.loadFacts(GROUP_ID);
    const exhaustedFact = factsInLog.find((f) => f.id === factId);
    expect(exhaustedFact).toBeDefined();
    expect(checkpointAfterExhaustion!.lastIngestedSeq).toBeLessThan(exhaustedFact!.seq);

    await engine.stop();

    // Fresh engine instance over the SAME persisted stores, "restored"
    // origin -- R3 must resubmit the crash-gap fact (seq > lastIngestedSeq
    // covers it) since the watermark was correctly left behind.
    mockPersistence.failAppendAcceptedEventTimes(0); // persistence recovered
    const mockAdapter2 = createMockIngestSource();
    mockAdapter2.scriptCatchUp([]);
    mockAdapter2.scriptIngestPersisted([
      messageSignal({ factId, taskId: "task-exhausted-resolved" }),
    ]);
    const events2: EngineOutputEvent[] = [];
    const engine2 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter2.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    engine2.subscribe((e) => events2.push(e));
    await engine2.start({ origin: "restored" });

    expect(
      mockAdapter2.ingestPersistedCallLog.some((call) => call.some((f) => f.id === factId)),
    ).toBe(true);
    await vi.waitFor(() => expect(acceptedEvents(events2)).toHaveLength(1));
    expect(acceptedEvents(events2)[0].event.factId).toBe(factId);
  });
});

// ---------------------------------------------------------------------------
// P2-4 (S6 Stage-2 cold review): saveDeferredIds joins the BLOCKING retry
// family -- a transient outage degrades the engine WITHOUT unwinding the
// drain it's part of; the drain completes and cutover proceeds normally.
// ---------------------------------------------------------------------------

describe("P2-4: saveDeferredIds hardening -- a failing save during a catch-up park degrades without unwinding the drain", () => {
  it("a transiently-failing saveDeferredIds during a catch-up park degrades the engine; the historical drain still completes and cutover proceeds; health restores once the write recovers", async () => {
    vi.useFakeTimers();
    const K = 3;
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    const parkedFactId = "fact-park-during-catchup";
    mockAdapter.scriptCatchUp([
      deferredSignal({ factId: parkedFactId }),
      messageSignal({ factId: "fact-after-park", taskId: "task-after-park" }),
    ]);
    mockPersistence.failSaveDeferredIdsTimes(K);

    const startPromise = engine.start({ origin: "welcome" }).catch(() => {});
    await vi.waitFor(() =>
      expect(mockPersistence.saveDeferredIdsCalls.length).toBeGreaterThanOrEqual(1),
    );
    await vi.waitFor(() => expect(engine.getState().health).toBe("degraded"));

    await vi.advanceTimersByTimeAsync(totalBackoffMsForFailures(K) + 1);
    await startPromise;

    // The drain COMPLETED (reached live) despite the parked fact's write
    // having failed and retried -- P2-4: never unwind the drain on
    // saveDeferredIds exhaustion/failure.
    expect(engine.getState().lifecycle).toBe("live");
    // The signal AFTER the parked one was still processed -- proof the
    // drain did not abort mid-stream on the failing write.
    expect(acceptedEvents(events).some((e) => e.event.factId === "fact-after-park")).toBe(true);
    // Health restored once the write recovered (a transient failure, not an
    // exhaustion).
    expect(engine.getState().health).toBe("nominal");
    // The parked fact IS durably recorded in the deferred-store once the
    // retry succeeded.
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).toContain(parkedFactId);
  });
});

// ---------------------------------------------------------------------------
// P3-6c (S6 Stage-2 cold review): attempt-refund -- a retry-pass entry whose
// acceptDeferredFact fails on the PERSISTENCE side (not decrypt) must have
// its ingest-policy attempt charge refunded, so a transient persistence
// outage is never misreported as ingest-policy retry-exhaustion.
// ---------------------------------------------------------------------------

describe("P3-6c: attempt-refund -- a PERSISTENCE-side acceptDeferredFact failure during a retry pass never consumes the entry's decrypt retry budget", () => {
  it("a retry pass that fails on acceptDeferredFact's PERSISTENCE write leaves the entry's attempt budget unconsumed (refunded); a later, persistence-healthy pass resolves the SAME fact normally instead of wrongly evicting it as retry-exhausted", async () => {
    vi.useFakeTimers();
    const { engine, mockAdapter, mockPersistence, events } = buildEngine({
      ingestPolicyOptions: { maxDeferredSize: 100, maxDeferredAgeSec: 1_000_000, maxRetryAttempts: 1 },
    });
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = "fact-persistence-outage-during-retry";
    mockAdapter.pushLive(deferredSignal({ factId }));
    await vi.waitFor(() => expect(events.some((e) => e.type === "envelope_deferred")).toBe(true));

    // First retry pass: the fact now decrypts fine (delivered as a
    // "message" signal, proving decryptability), but acceptDeferredFact's
    // PERSISTENCE write is down for the whole pass.
    mockPersistence.failAcceptDeferredFactTimes(1000); // never succeeds this pass
    mockAdapter.scriptIngestPersisted([messageSignal({ factId, taskId: "task-outage" })]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() =>
      expect(mockPersistence.acceptDeferredFactCalls.length).toBeGreaterThanOrEqual(1),
    );
    await vi.advanceTimersByTimeAsync(
      totalBackoffMsForFailures(PERSISTENCE_RETRY_MAX_ATTEMPTS) + 1000,
    );

    // The outage itself is reported (P3-6a), but with maxRetryAttempts=1 an
    // UNREFUNDED attempt charge here would have made this entry immediately
    // eligible for eviction as retry-exhausted -- it must NOT be (P3-6c):
    // the fact stays parked, never reported retry-exhausted.
    expect(
      rejectedEvents(events).some(
        (e) => e.factId === factId && e.reason === REJECTED_REASON_PERSISTENCE_EXHAUSTED,
      ),
    ).toBe(true);
    expect(rejectedEvents(events).some((e) => e.reason === REJECTED_REASON_RETRY_EXHAUSTED)).toBe(
      false,
    );
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).toContain(factId);

    // Second pass, persistence now healthy -- the SAME fact resolves
    // normally instead of being skipped as already-exhausted.
    mockPersistence.failAcceptDeferredFactTimes(0);
    mockAdapter.scriptIngestPersisted([
      messageSignal({ factId, taskId: "task-outage-resolved" }),
    ]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-2", "epoch-1"));
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));
    expect(acceptedEvents(events)[0].event.factId).toBe(factId);
    expect(rejectedEvents(events).some((e) => e.reason === REJECTED_REASON_RETRY_EXHAUSTED)).toBe(
      false,
    );
  });
});
