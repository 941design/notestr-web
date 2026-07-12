/**
 * receive-engine.malformed-signal.test.ts
 *
 * AC-PERS-3 (Implementation Constraint 13) DIFFERENTIAL conformance suite.
 * S5's handleMalformed() already satisfies the letter of Constraint 13 (see
 * this story's architecture.json "malformed-signal-hardening-is-
 * differential-test-only") -- this file's job is the differential proof the
 * story explicitly asks for: a malformed IngestSignal is NEVER enqueued
 * into the deferred queue and NEVER retried on a subsequent
 * `epoch_advanced`, while a SIBLING unreadable/epoch_mismatch fact present
 * in the very same scenario IS retried, proving the two paths genuinely
 * diverge rather than both silently succeeding or both silently failing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReceiveEngine, createRealEngineScheduler } from "./receive-engine";
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
// Fixture builders (duplicated subset, matching this story's other new test
// file and the S5 precedent of per-file fixture duplication)
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

function messageSignal(opts: { factId?: string; taskId?: string; groupId?: string }): IngestSignal {
  const factId = opts.factId ?? nextId("fact");
  const taskId = opts.taskId ?? nextId("task");
  return {
    type: "message",
    fact: factInput(factId, opts.groupId),
    rumorId: nextId("rumor"),
    payload: taskCreatedPayload(taskId),
    epoch: "epoch-0",
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

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
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
}

function createMockIngestSource(): MockIngestSource {
  const catchUpScripts: IngestSignal[][] = [];
  const fetchBootstrapScripts: IngestSignal[][] = [];
  const ingestPersistedScripts: IngestSignal[][] = [];
  const ingestPersistedCallLog: RawProtocolFact[][] = [];
  let onSignal: ((signal: IngestSignal) => void) | null = null;

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
    close() {},
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
  };
}

// ---------------------------------------------------------------------------
// Mock PersistenceAdapter (always-succeeds -- this file tests signal
// classification/routing, not persistence-failure handling)
// ---------------------------------------------------------------------------

interface MockPersistenceAdapter {
  adapter: PersistenceAdapter;
  saveDeferredIdsCalls: { groupId: string; ids: string[] }[];
}

function createMockPersistenceAdapter(): MockPersistenceAdapter {
  const facts = new Map<string, RawProtocolFact[]>();
  const acceptedEvents = new Map<string, AcceptedDomainEvent[]>();
  const checkpoints = new Map<string, EngineCheckpoint>();
  const deferredIds = new Map<string, string[]>();
  const saveDeferredIdsCalls: { groupId: string; ids: string[] }[] = [];

  const adapter: PersistenceAdapter = {
    async appendFact(fact) {
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
      saveDeferredIdsCalls.push({ groupId, ids: [...ids] });
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

  return { adapter, saveDeferredIdsCalls };
}

// ---------------------------------------------------------------------------
// Shared scaffold
// ---------------------------------------------------------------------------

const GROUP_ID = "group-1";

function buildEngine() {
  const mockAdapter = createMockIngestSource();
  const mockPersistence = createMockPersistenceAdapter();
  const events: EngineOutputEvent[] = [];
  const engine = createReceiveEngine({
    groupId: GROUP_ID,
    adapter: mockAdapter.source,
    persistence: mockPersistence.adapter,
    scheduler: createRealEngineScheduler(),
  });
  engine.subscribe((e) => events.push(e));
  return { engine, mockAdapter, mockPersistence, events };
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

function deferredEvents(events: EngineOutputEvent[]) {
  return events.filter(
    (e): e is Extract<EngineOutputEvent, { type: "envelope_deferred" }> =>
      e.type === "envelope_deferred",
  );
}

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC-PERS-3 differential (VQ-S6-005 / VQ-S6-008)
// ---------------------------------------------------------------------------

describe("AC-PERS-3: malformed is terminal (never enqueued, never retried) -- differential against a sibling unreadable fact", () => {
  it("a malformed signal is rejected with parse_error and leaves the deferred queue count unchanged, while a sibling unreadable fact in the SAME scenario IS parked and later retried on epoch_advanced", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });
    expect(engine.getState().lifecycle).toBe("live");

    const malformedFactId = "fact-malformed";
    const siblingFactId = "fact-sibling-unreadable";

    // Sibling unreadable fact parked first -- deferred queue count becomes 1.
    mockAdapter.pushLive(deferredSignal({ factId: siblingFactId }));
    await vi.waitFor(() => expect(deferredEvents(events)).toHaveLength(1));
    const deferredCountAfterSibling = await mockPersistence.adapter.loadDeferredIds(GROUP_ID);
    expect(deferredCountAfterSibling).toEqual([siblingFactId]);

    // Malformed signal for a DIFFERENT fact: rejected with parse_error, and
    // the deferred queue count is UNCHANGED (still just the sibling).
    mockAdapter.pushLive(malformedSignal({ factId: malformedFactId }));
    await vi.waitFor(() =>
      expect(rejectedEvents(events).some((e) => e.factId === malformedFactId)).toBe(true),
    );
    const rejected = rejectedEvents(events).find((e) => e.factId === malformedFactId);
    expect(rejected?.reason).toBe("parse_error");
    const deferredCountAfterMalformed = await mockPersistence.adapter.loadDeferredIds(GROUP_ID);
    expect(deferredCountAfterMalformed).toEqual([siblingFactId]); // unchanged -- malformed never enqueued

    // epoch_advanced triggers the L8/L9 retry pass: the sibling IS
    // resubmitted via ingestPersisted; the malformed fact's id is NEVER
    // included in ANY ingestPersisted call, proving it was never parked and
    // is therefore never eligible for retry.
    mockAdapter.scriptIngestPersisted([
      messageSignal({ factId: siblingFactId, taskId: "sibling-resolved" }),
    ]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await vi.waitFor(() => expect(acceptedEvents(events)).toHaveLength(1));
    expect(acceptedEvents(events)[0].event.factId).toBe(siblingFactId);

    for (const call of mockAdapter.ingestPersistedCallLog) {
      expect(call.some((f) => f.id === malformedFactId)).toBe(false);
    }
    // The sibling WAS included in exactly one ingestPersisted call -- proof
    // the differential is real (both paths are exercised, not just the
    // malformed one silently doing nothing).
    expect(
      mockAdapter.ingestPersistedCallLog.some((call) => call.some((f) => f.id === siblingFactId)),
    ).toBe(true);

    // A SECOND epoch_advanced (queue now empty) still never resubmits the
    // malformed fact's id.
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-2", "epoch-1"));
    await Promise.resolve();
    await Promise.resolve();
    for (const call of mockAdapter.ingestPersistedCallLog) {
      expect(call.some((f) => f.id === malformedFactId)).toBe(false);
    }
  });

  it("a fact previously parked as unreadable that later re-delivers as malformed is defensively un-parked (removed from the deferred queue) and reported via parse_error, never resurfacing on a later epoch_advanced", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = "fact-park-then-malformed";
    mockAdapter.pushLive(deferredSignal({ factId }));
    await vi.waitFor(() => expect(deferredEvents(events)).toHaveLength(1));
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).toContain(factId);

    // Same fact id re-delivers, this time decrypting but failing to decode
    // -- classified malformed instead of deferred (e.g. a later epoch
    // finally decrypts it, but the payload itself is unreadable/invalid).
    mockAdapter.pushLive(malformedSignal({ factId }));
    await vi.waitFor(() =>
      expect(rejectedEvents(events).some((e) => e.factId === factId)).toBe(true),
    );
    expect(await mockPersistence.adapter.loadDeferredIds(GROUP_ID)).not.toContain(factId);

    // A later epoch_advanced must never attempt to retry it -- the deferred
    // queue no longer contains it.
    mockAdapter.scriptIngestPersisted([]);
    mockAdapter.pushLive(epochAdvancedSignal("epoch-1", "epoch-0"));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockAdapter.ingestPersistedCallLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P1-2 asymmetry (SEV-8, S6 Stage-2 cold review "watermark-before-
// durability"): a malformed fact has NO separate durable outcome beyond the
// raw-log append itself -- terminal, never parked, never retried -- so its
// seq is safely covered by the persisted watermark immediately (unlike a
// fresh "message" accept, whose watermark now waits for the accepted-log
// write). Proven by restart: R3 must never resubmit an already-malformed
// fact.
// ---------------------------------------------------------------------------

describe("P1-2 asymmetry: a malformed fact's watermark advances immediately -- a restart's R3 never resubmits it", () => {
  it("a malformed fact's raw-log seq is covered by the persisted watermark right away; a fresh engine restart over the same stores does not resubmit it via R3", async () => {
    const { engine, mockAdapter, mockPersistence, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);
    await engine.start({ origin: "welcome" });

    const factId = "fact-malformed-watermark";
    mockAdapter.pushLive(malformedSignal({ factId }));
    await vi.waitFor(() =>
      expect(rejectedEvents(events).some((e) => e.factId === factId)).toBe(true),
    );

    const facts = await mockPersistence.adapter.loadFacts(GROUP_ID);
    const malformedFact = facts.find((f) => f.id === factId);
    expect(malformedFact).toBeDefined();

    // stop() (L10) saves a final checkpoint reflecting the in-memory
    // watermark accumulated since the last transition-triggered save --
    // this is what proves the malformed signal's watermark advance already
    // happened (not deferred behind any pending write).
    await engine.stop();
    const checkpoint = await mockPersistence.adapter.loadCheckpoint(GROUP_ID);
    expect(checkpoint!.lastIngestedSeq).toBeGreaterThanOrEqual(malformedFact!.seq);

    // Fresh engine instance over the SAME persisted stores -- R3 must NOT
    // resubmit this fact (seq <= lastIngestedSeq covers it already).
    const mockAdapter2 = createMockIngestSource();
    mockAdapter2.scriptCatchUp([]);
    mockAdapter2.scriptIngestPersisted([]);
    const engine2 = createReceiveEngine({
      groupId: GROUP_ID,
      adapter: mockAdapter2.source,
      persistence: mockPersistence.adapter,
      scheduler: createRealEngineScheduler(),
    });
    await engine2.start({ origin: "restored" });

    for (const call of mockAdapter2.ingestPersistedCallLog) {
      expect(call.some((f) => f.id === factId)).toBe(false);
    }
  });
});
