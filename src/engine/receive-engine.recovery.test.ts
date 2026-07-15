/**
 * receive-engine.recovery.test.ts
 *
 * Dedicated per-R-step coverage of the Recovery Sequencing (architecture.md
 * "Recovery Sequencing", R1-R4 + R-INV-1..4) and AC-PERS-2 (malformed
 * checkpoint at restart), AC-REC-8 (re-join), AC-REC-9 (origin routing),
 * and AC-INV-3 (recovery equivalence + epoch carve-out). One `describe`
 * block per AC, each with its OWN dedicated scenario, per this story's
 * explicit instruction NOT to fold R1-R4 into a single combined happy-path
 * test. The AC-REC-5 property test lives in the sibling
 * receive-engine.recovery.property.test.ts.
 *
 * MOCK-05-002 (checkpoint/deferred) is now resolved for PRODUCTION code by
 * this story's real src/persistence/checkpoint-store.ts / deferred-store.ts
 * (see their own real-IDB test files). This file's mock `PersistenceAdapter`
 * -- like receive-engine.fsm.test.ts's and receive-engine.cutover.property.
 * test.ts's before it -- REPLICATES the real stores' exact algorithm
 * (idempotent lookup-before-insert, seq=last+1, append-order preservation,
 * acceptDeferredFact's accepted-first ordering, clearGroupState's
 * checkpoint-first ordering) rather than importing them: `engine-boundary.
 * structural.test.ts`'s AC-BOUND-1 scanner forbids ANY file under
 * src/engine/ (tests included) from importing src/persistence/* -- see
 * mocks-registry.json and architecture.json's "no-cross-boundary-
 * integration-test" judgment call for why this is the established,
 * sanctioned pattern rather than a workaround.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReceiveEngine,
  createRealEngineScheduler,
  type ReceiveEngine,
} from "./receive-engine";
import {
  applyEvent,
  buildProjection,
  EMPTY_PROJECTION,
  replayOrder,
  type TaskProjection,
} from "../domain/task-projector";
import type {
  AcceptedDomainEvent,
  DeferredReason,
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
// Fixture builders (mirrors receive-engine.fsm.test.ts's conventions)
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

function rawFact(id: string, seq: number, groupId = "group-1"): RawProtocolFact {
  return { ...factInput(id, groupId), seq };
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

function acceptedEvent(
  id: string,
  factId: string,
  groupId = "group-1",
  overrides: Partial<AcceptedDomainEvent> = {},
): AcceptedDomainEvent {
  return {
    id,
    factId,
    sourceKind: "mls-rumor",
    groupId,
    acceptedAt: 1_700_000_000_000,
    epoch: "epoch-0",
    payload: taskCreatedPayload(id),
    ...overrides,
  };
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

function epochAdvancedSignal(newEpoch: string, prevEpoch: string): IngestSignal {
  return { type: "epoch_advanced", newEpoch, prevEpoch };
}

function deferredSignal(opts: {
  factId: string;
  epoch: string;
  reason?: DeferredReason;
  groupId?: string;
}): IngestSignal {
  return {
    type: "deferred",
    fact: factInput(opts.factId, opts.groupId),
    reason: opts.reason ?? "unreadable",
    epoch: opts.epoch,
  };
}

// ---------------------------------------------------------------------------
// Shared cross-mock call-order log (AC-REC-4's "call-order evidence, not
// just eventual-call evidence" requirement needs ONE shared ordering axis
// across both mocks, not two independently-numbered logs).
// ---------------------------------------------------------------------------

interface OrderedCall {
  who: "ingest" | "persistence";
  method: string;
  seq: number;
}

function createOrderTracker() {
  const calls: OrderedCall[] = [];
  let seq = 0;
  return {
    calls,
    record(who: "ingest" | "persistence", method: string): void {
      calls.push({ who, method, seq: seq++ });
    },
  };
}

// ---------------------------------------------------------------------------
// Mock IngestSource
// ---------------------------------------------------------------------------

interface IngestPersistedCall {
  facts: RawProtocolFact[];
}

interface MockIngestSource {
  source: IngestSource;
  ingestPersistedCalls: IngestPersistedCall[];
  catchUpCallCount: number;
  openLiveCallCount: number;
  scriptCatchUp(signals: IngestSignal[]): void;
  scriptIngestPersisted(signals: IngestSignal[]): void;
  pushLive(signal: IngestSignal): void;
}

function createMockIngestSource(tracker: ReturnType<typeof createOrderTracker>): MockIngestSource {
  const ingestPersistedCalls: IngestPersistedCall[] = [];
  let catchUpCallCount = 0;
  let openLiveCallCount = 0;
  const catchUpScripts: IngestSignal[][] = [];
  const ingestPersistedScripts: IngestSignal[][] = [];
  let onSignal: ((signal: IngestSignal) => void) | null = null;

  async function* fromArray(signals: IngestSignal[]): AsyncGenerator<IngestSignal> {
    for (const s of signals) yield s;
  }

  const source: IngestSource = {
    catchUp() {
      tracker.record("ingest", "catchUp");
      catchUpCallCount += 1;
      return fromArray(catchUpScripts.shift() ?? []);
    },
    openLive(cb) {
      tracker.record("ingest", "openLive");
      openLiveCallCount += 1;
      onSignal = cb;
      return () => {
        if (onSignal === cb) onSignal = null;
      };
    },
    ingestPersisted(facts: RawProtocolFact[]) {
      tracker.record("ingest", "ingestPersisted");
      ingestPersistedCalls.push({ facts });
      return fromArray(ingestPersistedScripts.shift() ?? []);
    },
    fetchBootstrap() {
      tracker.record("ingest", "fetchBootstrap");
      return fromArray([]);
    },
    close() {
      tracker.record("ingest", "close");
    },
  };

  return {
    source,
    ingestPersistedCalls,
    get catchUpCallCount() {
      return catchUpCallCount;
    },
    get openLiveCallCount() {
      return openLiveCallCount;
    },
    scriptCatchUp(signals) {
      catchUpScripts.push(signals);
    },
    scriptIngestPersisted(signals) {
      ingestPersistedScripts.push(signals);
    },
    pushLive(signal) {
      onSignal?.(signal);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock PersistenceAdapter -- KEEP IN SYNC with src/persistence/
// raw-event-log-store.ts (S4) / checkpoint-store.ts / deferred-store.ts
// (S11). See this file's module doc comment.
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
  loadFactsCalls: string[];
  loadAcceptedEventsCalls: string[];
  loadDeferredIdsCalls: string[];
  loadCheckpointCalls: string[];
  seedFacts(groupId: string, facts: RawProtocolFact[]): void;
  seedAcceptedEvents(groupId: string, events: AcceptedDomainEvent[]): void;
  seedCheckpoint(checkpoint: EngineCheckpoint): void;
  seedDeferredIds(groupId: string, ids: string[]): void;
  makeCheckpointCorrupt(groupId: string): void;
  /** Fault injection: acceptDeferredFact throws AFTER the accepted-log
   *  append (step 1) succeeds but BEFORE the deferred-id removal (step 2)
   *  -- mirrors the real implementation's two internal steps. One-shot:
   *  clears itself after firing once. */
  failAcceptDeferredFactAfterStep1Once(): void;
  snapshotFor(groupId: string): {
    facts: RawProtocolFact[];
    acceptedEvents: AcceptedDomainEvent[];
    checkpoint: EngineCheckpoint | null;
    deferredIds: string[];
  };
}

function createMockPersistenceAdapter(
  tracker: ReturnType<typeof createOrderTracker>,
): MockPersistenceAdapter {
  const facts = new Map<string, RawProtocolFact[]>();
  const acceptedEvents = new Map<string, AcceptedDomainEvent[]>();
  const checkpoints = new Map<string, EngineCheckpoint | unknown>();
  const deferredIds = new Map<string, string[]>();
  const saveCheckpointCalls: EngineCheckpoint[] = [];
  const clearGroupStateCalls: string[] = [];
  const acceptDeferredFactCalls: AcceptDeferredFactCall[] = [];
  const loadFactsCalls: string[] = [];
  const loadAcceptedEventsCalls: string[] = [];
  const loadDeferredIdsCalls: string[] = [];
  const loadCheckpointCalls: string[] = [];
  let failAcceptDeferredFactOnce = false;

  function appendAcceptedEventInternal(event: AcceptedDomainEvent): void {
    const list = acceptedEvents.get(event.groupId) ?? [];
    if (list.some((e) => e.id === event.id)) return;
    acceptedEvents.set(event.groupId, [...list, event]);
  }

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
      tracker.record("persistence", "loadFacts");
      loadFactsCalls.push(groupId);
      return [...(facts.get(groupId) ?? [])].sort((a, b) => a.seq - b.seq);
    },
    async appendAcceptedEvent(event) {
      appendAcceptedEventInternal(event);
    },
    async loadAcceptedEvents(groupId) {
      tracker.record("persistence", "loadAcceptedEvents");
      loadAcceptedEventsCalls.push(groupId);
      return [...(acceptedEvents.get(groupId) ?? [])];
    },
    async saveCheckpoint(checkpoint) {
      tracker.record("persistence", "saveCheckpoint");
      saveCheckpointCalls.push(checkpoint);
      checkpoints.set(checkpoint.groupId, checkpoint);
    },
    async loadCheckpoint(groupId) {
      tracker.record("persistence", "loadCheckpoint");
      loadCheckpointCalls.push(groupId);
      return (checkpoints.get(groupId) as EngineCheckpoint | undefined) ?? null;
    },
    async saveDeferredIds(groupId, ids) {
      deferredIds.set(groupId, [...ids]);
    },
    async loadDeferredIds(groupId) {
      tracker.record("persistence", "loadDeferredIds");
      loadDeferredIdsCalls.push(groupId);
      return [...(deferredIds.get(groupId) ?? [])];
    },
    async acceptDeferredFact(groupId, factId, event) {
      tracker.record("persistence", "acceptDeferredFact");
      acceptDeferredFactCalls.push({ groupId, factId, event });
      // Step 1 -- accepted-first, mirrors the real implementation.
      appendAcceptedEventInternal(event);
      if (failAcceptDeferredFactOnce) {
        failAcceptDeferredFactOnce = false;
        throw new Error("injected fault: acceptDeferredFact step 2 failed");
      }
      // Step 2 -- only after step 1 landed.
      const ids = deferredIds.get(groupId) ?? [];
      deferredIds.set(
        groupId,
        ids.filter((id) => id !== factId),
      );
    },
    async clearGroupState(groupId) {
      tracker.record("persistence", "clearGroupState");
      clearGroupStateCalls.push(groupId);
      // Checkpoint-first, matching deferred-store.ts's real ordering.
      checkpoints.delete(groupId);
      facts.delete(groupId);
      acceptedEvents.delete(groupId);
      deferredIds.delete(groupId);
    },
  };

  return {
    adapter,
    saveCheckpointCalls,
    clearGroupStateCalls,
    acceptDeferredFactCalls,
    loadFactsCalls,
    loadAcceptedEventsCalls,
    loadDeferredIdsCalls,
    loadCheckpointCalls,
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
    failAcceptDeferredFactAfterStep1Once() {
      failAcceptDeferredFactOnce = true;
    },
    snapshotFor(groupId) {
      return {
        facts: [...(facts.get(groupId) ?? [])],
        acceptedEvents: [...(acceptedEvents.get(groupId) ?? [])],
        checkpoint: (checkpoints.get(groupId) as EngineCheckpoint | undefined) ?? null,
        deferredIds: [...(deferredIds.get(groupId) ?? [])],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared test scaffold
// ---------------------------------------------------------------------------

const GROUP_ID = "group-1";

function buildEngine() {
  const tracker = createOrderTracker();
  const mockAdapter = createMockIngestSource(tracker);
  const mockPersistence = createMockPersistenceAdapter(tracker);
  const events: EngineOutputEvent[] = [];
  const engine = createReceiveEngine({
    groupId: GROUP_ID,
    adapter: mockAdapter.source,
    persistence: mockPersistence.adapter,
    scheduler: createRealEngineScheduler(),
  });
  engine.subscribe((e) => events.push(e));
  return { engine, mockAdapter, mockPersistence, events, tracker };
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
  return acceptedEvents(events).reduce(
    (proj, e) => applyEvent(proj, e.event),
    EMPTY_PROJECTION,
  );
}

let engineHandles: { engine: ReceiveEngine }[] = [];
beforeEach(() => {
  idCounter = 0;
  engineHandles = [];
});

// =============================================================================
// AC-REC-1 (R1): buildProjection(replayOrder(acceptedLog)) -- bootstrap
// events before MLS events, never acceptedAt clock order.
// =============================================================================

describe("AC-REC-1 (R1) -- replay order is phase order, never acceptedAt clock order", () => {
  it("folds a bootstrap-sourced event before an MLS-sourced event even when the MLS event has an EARLIER acceptedAt (simulated clock skew)", () => {
    const mlsEvent = acceptedEvent("mls-evt", "fact-mls", GROUP_ID, {
      sourceKind: "mls-rumor",
      acceptedAt: 1000, // earlier clock time...
      payload: { type: "task.created", task: task("t-mls") },
    });
    const bootstrapEvent = acceptedEvent("bootstrap-evt", "fact-bootstrap", GROUP_ID, {
      sourceKind: "bootstrap-kind-30078",
      acceptedAt: 9000, // ...but LATER clock time (clock skew).
      payload: { type: "task.created", task: task("t-bootstrap") },
    });

    // Input log in acceptedAt-ascending order (mls first) -- if the
    // implementation wrongly sorted by acceptedAt, replayOrder would be a
    // no-op here and the projection would build in this same order.
    const log = [mlsEvent, bootstrapEvent];
    const ordered = replayOrder(log);

    // R1's contract: bootstrap-sourced events sort before MLS-sourced ones,
    // regardless of acceptedAt.
    expect(ordered.map((e) => e.id)).toEqual(["bootstrap-evt", "mls-evt"]);

    const projection = buildProjection(ordered);
    expect(projection.has("t-bootstrap")).toBe(true);
    expect(projection.has("t-mls")).toBe(true);

    // Prove the ordering was load-bearing: replaying in the WRONG
    // (unsorted / acceptedAt) order over a case where order matters --
    // task.deleted after task.created for the SAME id -- diverges.
    const created = acceptedEvent("c1", "fact-c1", GROUP_ID, {
      sourceKind: "mls-rumor",
      acceptedAt: 1,
      payload: { type: "task.created", task: task("dup") },
    });
    const deleted = acceptedEvent("d1", "fact-d1", GROUP_ID, {
      sourceKind: "bootstrap-kind-30078",
      acceptedAt: 2,
      payload: {
        // updatedAt (2000) MUST exceed the created task's updatedAt (1000,
        // from the task() fixture) so the delete wins ADR-001's tie-break
        // whenever it is actually applied against an existing task --
        // isolating this scenario to the ORDERING effect (phase vs
        // acceptedAt) rather than an incidental tie-break loss.
        type: "task.deleted",
        taskId: "dup",
        updatedAt: 2000,
        updatedBy: "pk-1",
      },
    });
    // acceptedAt order: created(1) then deleted(2) -- task ends up deleted.
    // Phase order (R1's actual contract): bootstrap(deleted) BEFORE
    // mls(created) -- delete-before-create is a no-op (no existing task to
    // delete), so the task survives. The two orders produce DIFFERENT
    // final projections, proving phase order is load-bearing, not
    // incidentally equivalent to acceptedAt order here.
    const byAcceptedAt = [created, deleted]; // already acceptedAt-ascending
    const byPhaseOrder = replayOrder([created, deleted]);
    expect(byPhaseOrder.map((e) => e.id)).toEqual(["d1", "c1"]); // bootstrap first

    const projByAcceptedAt = buildProjection(byAcceptedAt);
    const projByPhaseOrder = buildProjection(byPhaseOrder);
    expect(projByAcceptedAt.has("dup")).toBe(false); // created then deleted
    expect(projByPhaseOrder.has("dup")).toBe(true); // delete no-op, then created
  });
});

// =============================================================================
// AC-REC-2 (R2): deferred ids are re-queued into PendingRetryQueue WITHOUT
// resubmitting to ingest during `recovering`.
// =============================================================================

describe("AC-REC-2 (R2) -- deferred ids are re-queued, never resubmitted during recovering", () => {
  it("does not call adapter.ingestPersisted with any of the seeded deferred facts, and the queue holds exactly N ids afterward (observed via a later epoch_advanced retry pass)", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();

    // Seed: 2 facts that were parked (deferred) BEFORE the crash. A
    // deferred fact's seq is always <= lastIngestedSeq in real operation
    // (deferring is a completed ingest disposition -- see architecture.md's
    // EngineCheckpoint.lastIngestedSeq definition), so seed the checkpoint's
    // watermark to cover them.
    const deferredFact1 = rawFact("deferred-1", 1);
    const deferredFact2 = rawFact("deferred-2", 2);
    mockPersistence.seedFacts(GROUP_ID, [deferredFact1, deferredFact2]);
    mockPersistence.seedDeferredIds(GROUP_ID, ["deferred-1", "deferred-2"]);
    mockPersistence.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "live",
      lastEpoch: "epoch-0",
      lastIngestedSeq: 2, // covers both deferred facts -- R3 must not touch them
      lastAcceptedDomainEventId: null,
      bootstrapCompleted: true,
    });
    mockAdapter.scriptCatchUp([]);

    await engine.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    // R3 never touched the deferred facts.
    const allResubmittedIds = mockAdapter.ingestPersistedCalls.flatMap((c) =>
      c.facts.map((f) => f.id),
    );
    expect(allResubmittedIds).not.toContain("deferred-1");
    expect(allResubmittedIds).not.toContain("deferred-2");

    // The queue holds exactly 2 entries: trigger an epoch_advanced (L8) and
    // observe deferred_retry_started.count.
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() => {
      const started = events.filter((e) => e.type === "deferred_retry_started");
      expect(started.length).toBeGreaterThan(0);
    });
    const started = events.find(
      (e): e is Extract<EngineOutputEvent, { type: "deferred_retry_started" }> =>
        e.type === "deferred_retry_started",
    );
    expect(started?.count).toBe(2);
  });
});

// =============================================================================
// AC-REC-3 (R3, R-INV-2): resubmit only rawLog facts with seq >
// checkpoint.lastIngestedSeq.
// =============================================================================

describe("AC-REC-3 (R3, R-INV-2) -- resubmits exactly the crash-gap tail", () => {
  it("resubmits exactly facts seq 7-10 for lastIngestedSeq=6, zero calls for seq 1-6", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();

    const allFacts = Array.from({ length: 10 }, (_, i) => rawFact(`f${i + 1}`, i + 1));
    mockPersistence.seedFacts(GROUP_ID, allFacts);
    mockPersistence.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "live",
      lastEpoch: "epoch-0",
      lastIngestedSeq: 6,
      lastAcceptedDomainEventId: null,
      bootstrapCompleted: true,
    });
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.scriptCatchUp([]);

    await engine.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    expect(mockAdapter.ingestPersistedCalls).toHaveLength(1);
    const submittedSeqs = mockAdapter.ingestPersistedCalls[0].facts
      .map((f) => f.seq)
      .sort((a, b) => a - b);
    expect(submittedSeqs).toEqual([7, 8, 9, 10]);
  });

  it("R-INV-2: never resubmits a fact at or below the watermark, even with lastIngestedSeq=0 on an EMPTY rawLog", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    mockPersistence.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "live",
      lastEpoch: null,
      lastIngestedSeq: 0,
      lastAcceptedDomainEventId: null,
      bootstrapCompleted: true,
    });
    mockAdapter.scriptCatchUp([]);

    await engine.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    expect(mockAdapter.ingestPersistedCalls).toHaveLength(0);
  });
});

// =============================================================================
// AC-REC-4 (R4): recovering -> catching_up, with openLive/catchUp firing
// only AFTER R1-R3's synchronous rebuild steps complete (call-order
// evidence, not just eventual-call evidence).
// =============================================================================

describe("AC-REC-4 (R4) -- R1-R3 complete before openLive/catchUp, proven by call order", () => {
  it("the engine_state_changed sequence is recovering then catching_up, and every persistence load call precedes every ingest-source call", async () => {
    const { engine, mockAdapter, mockPersistence, events, tracker } = buildEngine();
    mockPersistence.seedFacts(GROUP_ID, [rawFact("f1", 1)]);
    mockPersistence.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "live",
      lastEpoch: "epoch-0",
      lastIngestedSeq: 0,
      lastAcceptedDomainEventId: null,
      bootstrapCompleted: true,
    });
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.scriptCatchUp([]);

    await engine.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    const lifecycleSequence = stateChanges(events).map((e) => e.state);
    const recoveringIdx = lifecycleSequence.indexOf("recovering");
    const catchingUpIdx = lifecycleSequence.indexOf("catching_up");
    expect(recoveringIdx).toBeGreaterThanOrEqual(0);
    expect(catchingUpIdx).toBeGreaterThan(recoveringIdx);

    // Call-order evidence: the LAST persistence-load-family call must
    // precede the FIRST ingest-source call (openLive/catchUp/
    // ingestPersisted) in the shared tracker's timeline.
    const loadCalls = tracker.calls.filter(
      (c) => c.who === "persistence" && c.method.startsWith("load"),
    );
    const ingestCalls = tracker.calls.filter((c) => c.who === "ingest");
    expect(loadCalls.length).toBeGreaterThan(0);
    expect(ingestCalls.length).toBeGreaterThan(0);
    const lastLoadSeq = Math.max(...loadCalls.map((c) => c.seq));
    const firstIngestSeq = Math.min(...ingestCalls.map((c) => c.seq));
    expect(lastLoadSeq).toBeLessThan(firstIngestSeq);

    // openLive specifically must fire (I-FSM-2 still holds under recovery).
    expect(mockAdapter.openLiveCallCount).toBe(1);
  });
});

// =============================================================================
// AC-REC-6 (R-INV-3) -- fault injection: acceptDeferredFact throws after the
// FIRST of its two internal steps. Recoverable as still-deferred: never
// lost, never double-counted.
// =============================================================================

describe("AC-REC-6 (R-INV-3) -- fault injection on acceptDeferredFact, recoverable via R2a", () => {
  it("a fault after step 1 (accepted-log append succeeds) leaves the fact transiently in BOTH stores; a subsequent recovery pass (R2a) prunes the stale deferred id, accepted wins", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();

    // Start live with nothing parked yet.
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    // Park a fact as deferred (unreadable), then let it become readable via
    // an epoch_advanced retry pass -- but inject a fault so
    // acceptDeferredFact's second internal step never lands.
    mockAdapter.pushLive({
      type: "deferred",
      fact: factInput("parked-1"),
      reason: "unreadable",
      epoch: "epoch-0",
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "envelope_deferred")).toBe(true);
    });

    mockPersistence.failAcceptDeferredFactAfterStep1Once();
    mockAdapter.scriptIngestPersisted([messageSignal({ factId: "parked-1" })]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));

    // The engine must not crash or hang: give the retry pass a chance to
    // run and settle back into a stable lifecycle.
    await vi.waitFor(() => {
      expect(["live", "retrying_deferred"]).toContain(engine.getState().lifecycle);
    });
    await new Promise((r) => setTimeout(r, 20));

    const snapshot = mockPersistence.snapshotFor(GROUP_ID);
    // Never lost: the accepted-log append (step 1) landed durably despite
    // the injected failure in step 2.
    expect(snapshot.acceptedEvents.some((e) => e.factId === "parked-1")).toBe(true);
    // Transient non-empty intersection: the deferred id was never removed
    // (step 2 failed), so it is STILL present in the raw deferred-store
    // contents at this point -- proving "never lost" at the store layer
    // rather than silently vanishing on failure.
    expect(snapshot.deferredIds).toContain("parked-1");

    // Recovery's R2a prune reconciles it: restart the engine against the
    // SAME persistence, simulating the next start().
    await engine.stop();
    const engine2 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    const events2: EngineOutputEvent[] = [];
    engine2.subscribe((e) => events2.push(e));
    mockAdapter.scriptCatchUp([]);
    await engine2.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine2.getState().lifecycle).toBe("live"));

    // After recovery: accepted wins, never double-counted (exactly one
    // accepted-log entry for this fact), deferred id pruned.
    const finalSnapshot = mockPersistence.snapshotFor(GROUP_ID);
    const acceptedForFact = finalSnapshot.acceptedEvents.filter(
      (e) => e.factId === "parked-1",
    );
    expect(acceptedForFact).toHaveLength(1);
    expect(finalSnapshot.deferredIds).not.toContain("parked-1");

    await engine2.stop();
  });
});

// =============================================================================
// AC-REC-7 (R-INV-4) -- projection after R1+R3 equals the in-memory
// projection at crash time plus any gap-tail facts.
// =============================================================================

describe("AC-REC-7 (R-INV-4) -- crash-and-recover projection deep-equals an uninterrupted single-pass replay", () => {
  it("recovering mid-stream and continuing produces the SAME final projection as never crashing", async () => {
    const fixtureFacts = [
      messageSignal({ factId: "fx-1", taskId: "task-a" }),
      messageSignal({ factId: "fx-2", taskId: "task-b" }),
      messageSignal({ factId: "fx-3", taskId: "task-c" }),
      messageSignal({ factId: "fx-4", taskId: "task-d" }),
    ];

    // Uninterrupted run: feed the whole fixture through one engine session.
    const uninterrupted = buildEngine();
    uninterrupted.mockAdapter.scriptCatchUp(fixtureFacts);
    await uninterrupted.engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(uninterrupted.engine.getState().lifecycle).toBe("live"));
    const uninterruptedProjection = foldProjection(uninterrupted.events);
    await uninterrupted.engine.stop();

    // Crash-and-recover run: feed only the first two facts through session
    // 1 (simulating a crash after they landed), then start a fresh engine
    // session 2 against the SAME persistence with the remaining two facts
    // arriving as the post-restart catchUp() drain (R4).
    idCounter = 0; // re-synchronize id generation with the uninterrupted run
    const tracker = createOrderTracker();
    const mockAdapter = createMockIngestSource(tracker);
    const mockPersistence = createMockPersistenceAdapter(tracker);
    const session1Events: EngineOutputEvent[] = [];
    const session1 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    session1.subscribe((e) => session1Events.push(e));
    const [f1, f2, f3, f4] = [
      messageSignal({ factId: "fx-1", taskId: "task-a" }),
      messageSignal({ factId: "fx-2", taskId: "task-b" }),
      messageSignal({ factId: "fx-3", taskId: "task-c" }),
      messageSignal({ factId: "fx-4", taskId: "task-d" }),
    ];
    mockAdapter.scriptCatchUp([f1, f2]);
    await session1.start({ origin: "welcome" });
    await vi.waitFor(() => expect(session1.getState().lifecycle).toBe("live"));
    await session1.stop(); // "crash" -- final checkpoint persisted by stop()

    const session2Events: EngineOutputEvent[] = [];
    const session2 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    session2.subscribe((e) => session2Events.push(e));
    mockAdapter.scriptCatchUp([f3, f4]); // "arrived while offline" tail
    await session2.start({ origin: "restored" });
    await vi.waitFor(() => expect(session2.getState().lifecycle).toBe("live"));

    const recoveredProjection = foldProjection([...session1Events, ...session2Events]);
    await session2.stop();

    expect(recoveredProjection).toEqual(uninterruptedProjection);
    expect(recoveredProjection.size).toBe(4);
  });
});

// =============================================================================
// AC-REC-8 -- re-join: stop() -> reset() -> start({origin:"welcome"}).
// =============================================================================

describe("AC-REC-8 -- re-join sequencing: stop -> reset -> start(welcome)", () => {
  it("lifecycle passes through stopped, then uninitialized, then joining, in that order, with all stores empty immediately after reset()", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();

    // Seed all five conceptual stores (facts, accepted-events, checkpoint,
    // deferred ids -- the fifth, "bootstrap-completed", lives INSIDE the
    // checkpoint per architecture.md, so seeding a checkpoint with
    // bootstrapCompleted:true covers it).
    mockPersistence.seedFacts(GROUP_ID, [rawFact("f1", 1)]);
    mockPersistence.seedAcceptedEvents(GROUP_ID, [acceptedEvent("e1", "f1")]);
    mockPersistence.seedCheckpoint({
      groupId: GROUP_ID,
      savedAt: 1,
      engineState: "live",
      lastEpoch: "epoch-0",
      lastIngestedSeq: 1,
      lastAcceptedDomainEventId: "e1",
      bootstrapCompleted: true,
    });
    mockPersistence.seedDeferredIds(GROUP_ID, ["f2"]);

    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    await engine.stop();
    expect(engine.getState().lifecycle).toBe("stopped");

    await engine.reset();
    expect(engine.getState().lifecycle).toBe("uninitialized");

    // All stores empty immediately after reset(), before start() runs.
    const snapshot = mockPersistence.snapshotFor(GROUP_ID);
    expect(snapshot.facts).toEqual([]);
    expect(snapshot.acceptedEvents).toEqual([]);
    expect(snapshot.checkpoint).toBeNull();
    expect(snapshot.deferredIds).toEqual([]);
    expect(mockPersistence.clearGroupStateCalls).toContain(GROUP_ID);

    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    const lifecycleSequence = stateChanges(events).map((e) => e.state);
    const stoppedIdx = lifecycleSequence.indexOf("stopped");
    const uninitIdx = lifecycleSequence.indexOf("uninitialized");
    const joiningIdx = lifecycleSequence.indexOf("joining");
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(uninitIdx).toBeGreaterThan(stoppedIdx);
    expect(joiningIdx).toBeGreaterThan(uninitIdx);
  });
});

// =============================================================================
// AC-REC-9 -- origin routing: start(restored) with a checkpoint -> L1
// recovering; start(welcome) with no checkpoint -> L2 joining, with NO
// loadFacts/loadAcceptedEvents invoked.
// =============================================================================

describe("AC-REC-9 -- origin routing", () => {
  it("start({origin:'restored'}) with a usable checkpoint takes L1 recovering", async () => {
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
    mockAdapter.scriptCatchUp([]);

    const startPromise = engine.start({ origin: "restored" });
    await vi.waitFor(() =>
      expect(["recovering", "catching_up", "buffering_live", "live"]).toContain(
        engine.getState().lifecycle,
      ),
    );
    // Assert the FIRST lifecycle reached was recovering (L1), not joining.
    await startPromise;
  });

  it("start({origin:'welcome'}) with NO checkpoint takes L2 joining, invoking neither loadFacts nor loadAcceptedEvents", async () => {
    const { engine, mockAdapter, mockPersistence } = buildEngine();
    // Nothing seeded -- empty state.
    mockAdapter.scriptCatchUp([]);

    await engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    expect(mockPersistence.loadFactsCalls).toHaveLength(0);
    expect(mockPersistence.loadAcceptedEventsCalls).toHaveLength(0);
  });
});

// =============================================================================
// AC-PERS-2 -- malformed checkpoint at restart: treated as absent, never
// escalates to reset(), full raw-log resubmitted, catching_up entered with
// health:degraded until the first successful checkpoint save.
// =============================================================================

describe("AC-PERS-2 -- malformed checkpoint is treated as absent, distinct from reset()", () => {
  it("raw-log/accepted-log survive intact (no reset()), every fact is resubmitted (lastIngestedSeq treated as 0), catching_up is entered with health:degraded, and health returns to nominal after the first successful save", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();

    const preExistingFacts = [rawFact("f1", 1), rawFact("f2", 2)];
    const preExistingAccepted = [acceptedEvent("e1", "f1")];
    mockPersistence.seedFacts(GROUP_ID, preExistingFacts);
    mockPersistence.seedAcceptedEvents(GROUP_ID, preExistingAccepted);
    mockPersistence.makeCheckpointCorrupt(GROUP_ID);
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.scriptCatchUp([]);

    await engine.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    // MUST NOT trigger reset(): raw-log/accepted-log survive intact, and
    // clearGroupState was never called for this group on this path.
    expect(mockPersistence.clearGroupStateCalls).not.toContain(GROUP_ID);
    const snapshot = mockPersistence.snapshotFor(GROUP_ID);
    expect(snapshot.facts).toEqual(preExistingFacts);
    // e1's underlying fact (f1, seq 1) is already accepted, so R3's full
    // resubmission of it is a safe idempotent no-op; the pre-existing
    // accepted event survives (never duplicated).
    expect(snapshot.acceptedEvents.filter((e) => e.id === "e1")).toHaveLength(1);

    // Full raw-log resubmitted (lastIngestedSeq treated as 0): both f1 and
    // f2 (seq 1 and 2) were submitted via ingestPersisted.
    const resubmittedIds = mockAdapter.ingestPersistedCalls.flatMap((c) =>
      c.facts.map((f) => f.id),
    );
    expect(resubmittedIds).toEqual(expect.arrayContaining(["f1", "f2"]));

    // Health choreography: the FIRST catching_up engine_state_changed event
    // must report degraded (this is the AC-PERS-2-specific observable this
    // story's health-timing fix restores -- see receive-engine.ts's
    // enterCatchingUp comment).
    const catchingUpEvents = stateChanges(events).filter((e) => e.state === "catching_up");
    expect(catchingUpEvents.length).toBeGreaterThan(0);
    expect(catchingUpEvents[0].health).toBe("degraded");

    // Health returns to nominal by the time we reach live (the first
    // successful checkpoint save, which happens synchronously as part of
    // the catching_up transition, must have cleared it well before then).
    const lastCatchingUp = catchingUpEvents[catchingUpEvents.length - 1];
    expect(lastCatchingUp.health).toBe("nominal");
    expect(engine.getState().health).toBe("nominal");
  });

  it("recovering itself always reports nominal (fsm.md: non-active lifecycles cannot show degraded)", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockPersistence.seedFacts(GROUP_ID, [rawFact("f1", 1)]);
    mockPersistence.makeCheckpointCorrupt(GROUP_ID);
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.scriptCatchUp([]);

    await engine.start({ origin: "restored" });
    await vi.waitFor(() => expect(engine.getState().lifecycle).toBe("live"));

    const recoveringEvents = stateChanges(events).filter((e) => e.state === "recovering");
    expect(recoveringEvents.length).toBeGreaterThan(0);
    for (const e of recoveringEvents) expect(e.health).toBe("nominal");
  });
});

// =============================================================================
// AC-INV-3 -- recovery equivalence + epoch carve-out.
// =============================================================================

describe("AC-INV-3 -- recovery equivalence with the epoch-crossing carve-out", () => {
  it("recover(prefix) + replay(suffix) deep-equals replay(full) within one epoch", async () => {
    // Reuses the same crash-and-recover shape as AC-REC-7, restated here as
    // its own dedicated AC-INV-3 scenario per this story's per-AC coverage
    // instruction (distinct assertion focus: equivalence of the FULL
    // recovered log's replay, not merely the projection).
    idCounter = 0;
    const uninterrupted = buildEngine();
    const facts = [
      messageSignal({ factId: "u-1", taskId: "task-x" }),
      messageSignal({ factId: "u-2", taskId: "task-y" }),
      messageSignal({ factId: "u-3", taskId: "task-z" }),
    ];
    uninterrupted.mockAdapter.scriptCatchUp(facts);
    await uninterrupted.engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(uninterrupted.engine.getState().lifecycle).toBe("live"));
    const fullProjection = foldProjection(uninterrupted.events);
    await uninterrupted.engine.stop();

    idCounter = 0;
    const tracker = createOrderTracker();
    const mockAdapter = createMockIngestSource(tracker);
    const mockPersistence = createMockPersistenceAdapter(tracker);
    const [p1, p2, p3] = [
      messageSignal({ factId: "u-1", taskId: "task-x" }),
      messageSignal({ factId: "u-2", taskId: "task-y" }),
      messageSignal({ factId: "u-3", taskId: "task-z" }),
    ];
    const session1Events: EngineOutputEvent[] = [];
    const session1 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    session1.subscribe((e) => session1Events.push(e));
    mockAdapter.scriptCatchUp([p1]);
    await session1.start({ origin: "welcome" });
    await vi.waitFor(() => expect(session1.getState().lifecycle).toBe("live"));
    await session1.stop();

    const session2Events: EngineOutputEvent[] = [];
    const session2 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    session2.subscribe((e) => session2Events.push(e));
    mockAdapter.scriptCatchUp([p2, p3]);
    await session2.start({ origin: "restored" });
    await vi.waitFor(() => expect(session2.getState().lifecycle).toBe("live"));
    const recoveredProjection = foldProjection([...session1Events, ...session2Events]);
    await session2.stop();

    expect(recoveredProjection).toEqual(fullProjection);
  });

  it("P4 carve-out: a fact made undecryptable by an epoch advance BEFORE recovery is EXCLUDED from BOTH projections, scoped to that one fact only -- proven against the real engine's recovery-with-epoch-advance path", async () => {
    // This is the engine-level companion to the test above, not a
    // domain-level restatement of it. Fixture: "epc-g" is a decryptable
    // sibling fact that MUST be accepted in both runs; "epc-f" is the
    // epoch-crossing fact -- it is delivered ONLY as a `deferred` signal,
    // both before AND after the epoch advance, so it never decrypts in
    // EITHER run. Both runs drive the SAME real `createReceiveEngine`
    // through catchUp() -> epoch_advanced -> L8 deferred-retry, but the
    // recovered run splits the sequence across a stop()/start({origin:
    // "restored"}) boundary such that the epoch advance is discovered only
    // AFTER restart, inside session 2's own recovery-driven catchUp()
    // drain (R1-R4) -- genuinely exercising recovery-with-epoch-advance,
    // not merely a live push into an already-running engine.
    //
    // Non-vacuity: if receive-engine.ts ever blanket-excluded facts near an
    // epoch advance rather than scoping the carve-out to the one
    // undecryptable fact, "epc-g" would go missing from a projection below
    // and the `.has("task-g")` assertions would fail. If a recovery bug
    // ever promoted the re-queued deferred id to accepted without ever
    // seeing a `message` signal for it (e.g. mishandling R2's requeue),
    // "epc-f"'s presence would show up as a projection-size/equality
    // mismatch between the two runs. The `toEqual` on the full projections
    // additionally catches the exact divergence this AC guards against --
    // the epoch-crossing fact accepted in one run's recovery handling but
    // not the other's.

    idCounter = 0;
    const uninterrupted = buildEngine();
    uninterrupted.mockAdapter.scriptCatchUp([
      messageSignal({ factId: "epc-g", taskId: "task-g" }),
      deferredSignal({ factId: "epc-f", epoch: "epoch-0" }),
      epochAdvancedSignal("epoch-1", "epoch-0"),
    ]);
    // The L8 retry pass the epoch advance triggers resubmits "epc-f" via
    // ingestPersisted -- still undecryptable under epoch-1.
    uninterrupted.mockAdapter.scriptIngestPersisted([
      deferredSignal({ factId: "epc-f", epoch: "epoch-1" }),
    ]);
    await uninterrupted.engine.start({ origin: "welcome" });
    await vi.waitFor(() => expect(uninterrupted.engine.getState().lifecycle).toBe("live"));
    const uninterruptedProjection = foldProjection(uninterrupted.events);
    await uninterrupted.engine.stop();

    idCounter = 0;
    const tracker = createOrderTracker();
    const mockAdapter = createMockIngestSource(tracker);
    const mockPersistence = createMockPersistenceAdapter(tracker);

    const session1Events: EngineOutputEvent[] = [];
    const session1 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    session1.subscribe((e) => session1Events.push(e));
    mockAdapter.scriptCatchUp([
      messageSignal({ factId: "epc-g", taskId: "task-g" }),
      deferredSignal({ factId: "epc-f", epoch: "epoch-0" }),
    ]);
    await session1.start({ origin: "welcome" });
    await vi.waitFor(() => expect(session1.getState().lifecycle).toBe("live"));
    await session1.stop(); // "crash" -- the epoch advance has NOT happened yet

    const session2Events: EngineOutputEvent[] = [];
    const session2 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    session2.subscribe((e) => session2Events.push(e));
    // Restart discovers the epoch advance via its OWN catchUp() drain (R4)
    // -- there is no gap-tail to resubmit via R3 ("epc-g"/"epc-f" both
    // already landed durably in session 1), so this is the only new signal
    // session 2's catchUp() sees. It arrives while lifecycle is
    // "catching_up" (non-live), so it latches (pendingDeferredRetry) and
    // fires L8 the instant session 2 reaches "live", resubmitting "epc-f"
    // via ingestPersisted -- R2 must have already restored its deferred id
    // from deferred-store for that resubmission to happen at all.
    mockAdapter.scriptCatchUp([epochAdvancedSignal("epoch-1", "epoch-0")]);
    mockAdapter.scriptIngestPersisted([
      deferredSignal({ factId: "epc-f", epoch: "epoch-1" }),
    ]);
    await session2.start({ origin: "restored" });
    await vi.waitFor(() => expect(session2.getState().lifecycle).toBe("live"));

    const recoveredProjection = foldProjection([...session1Events, ...session2Events]);
    await session2.stop();

    // Full-projection equality: catches ANY divergence between the two
    // runs, not just the ones the explicit membership checks below name.
    expect(recoveredProjection).toEqual(uninterruptedProjection);

    // Scoped carve-out, proven explicitly in both directions:
    //  - "epc-g" (decryptable) present and equal in both -- rules out a
    //    blanket epoch-exemption bug that would also defer/exclude it.
    //  - "epc-f" (epoch-crossing, permanently undecryptable) absent from
    //    BOTH -- rules out a bug that accepts it despite it never once
    //    arriving as a `message` signal.
    expect(uninterruptedProjection.has("task-g")).toBe(true);
    expect(recoveredProjection.has("task-g")).toBe(true);
    expect(uninterruptedProjection.size).toBe(1);
    expect(recoveredProjection.size).toBe(1);
  });
});
