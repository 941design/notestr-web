/**
 * receive-engine.optimistic-local-echo.test.ts
 *
 * S11B "optimistic-local-echo" conformance suite. Covers
 * `ReceiveEngine.acceptLocal(rumorId, payload)` -- see that method's doc
 * comment in receive-engine.ts and its implementation just above
 * `return { start, stop, reset, subscribe, getState, acceptLocal }`.
 *
 * Every test drives the REAL `createReceiveEngine`; nothing here
 * reimplements `acceptLocal`'s dedupe/persistence/emission logic by hand.
 *
 * Mock idioms (MockIngestSource / MockPersistenceAdapter / buildEngine /
 * foldProjection) mirror receive-engine.fsm.test.ts's established shapes --
 * kept as a local, file-scoped copy per that file's own "KEEP IN SYNC"
 * convention (src/engine test files don't import src/persistence, and don't
 * import each other's unexported helpers either).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createReceiveEngine,
  createRealEngineScheduler,
  type ReceiveEngine,
} from "./receive-engine";
import { applyEvent, EMPTY_PROJECTION, type TaskProjection } from "../domain/task-projector";
import { deriveMlsAcceptedEventId } from "../domain/domain-events";
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
} from "./engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

// ---------------------------------------------------------------------------
// Fixture builders (mirrors receive-engine.fsm.test.ts)
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
  rumorId: string;
  payload: TaskEvent;
  groupId?: string;
}): IngestSignal {
  return {
    type: "message",
    fact: factInput(opts.factId ?? nextId("fact"), opts.groupId),
    rumorId: opts.rumorId,
    payload: opts.payload,
    epoch: "epoch-0",
    receiptSource: "historical",
  };
}

function skippedSignal(opts: { factId?: string; groupId?: string }): IngestSignal {
  return { type: "skipped", fact: factInput(opts.factId ?? nextId("fact"), opts.groupId) };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Mock IngestSource -- deliberately minimal: this suite only needs a
// "welcome"/"restored" engine to reach `live` with an EMPTY bootstrap/
// catchUp/live surface, plus the ability to push one live signal (AC-OPT-3b)
// or script one catchUp message signal (AC-OPT-3c's pure-remote comparison
// engine).
// ---------------------------------------------------------------------------

interface MockIngestSource {
  source: IngestSource;
  scriptCatchUp(signals: IngestSignal[]): void;
  scriptFetchBootstrap(signals: IngestSignal[]): void;
  pushLive(signal: IngestSignal): void;
}

function createMockIngestSource(): MockIngestSource {
  const catchUpScripts: IngestSignal[][] = [];
  const fetchBootstrapScripts: IngestSignal[][] = [];
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
    ingestPersisted() {
      return fromArray([]);
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
    pushLive(signal) {
      onSignal?.(signal);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock PersistenceAdapter -- full 10-method in-memory implementation, kept in
// sync with the real src/persistence/raw-event-log-store.ts algorithm per
// receive-engine.fsm.test.ts's identical mock (AC-BOUND-1 forbids src/engine
// test files from importing src/persistence).
// ---------------------------------------------------------------------------

function createMockPersistenceAdapter(): PersistenceAdapter {
  const facts = new Map<string, RawProtocolFact[]>();
  const acceptedEvents = new Map<string, AcceptedDomainEvent[]>();
  const checkpoints = new Map<string, EngineCheckpoint | unknown>();
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
      return (checkpoints.get(groupId) as EngineCheckpoint | undefined) ?? null;
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
// Shared test scaffold
// ---------------------------------------------------------------------------

const GROUP_ID = "group-1";

function buildEngine(overrides?: { persistence?: PersistenceAdapter }): {
  engine: ReceiveEngine;
  mockAdapter: MockIngestSource;
  events: EngineOutputEvent[];
} {
  const mockAdapter = createMockIngestSource();
  const events: EngineOutputEvent[] = [];
  const engine = createReceiveEngine({
    groupId: GROUP_ID,
    adapter: mockAdapter.source,
    persistence: overrides?.persistence ?? createMockPersistenceAdapter(),
    scheduler: createRealEngineScheduler(),
  });
  engine.subscribe((e) => events.push(e));
  return { engine, mockAdapter, events };
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

/** Starts a "welcome"-origin engine through an empty bootstrap/catchUp
 *  surface to `live`, with no signal ever delivered through the adapter --
 *  the shared entry point for AC-OPT-1/3's "no remote input" scaffolding. */
async function startWelcomeToLive(engine: ReceiveEngine, mockAdapter: MockIngestSource): Promise<void> {
  mockAdapter.scriptFetchBootstrap([]);
  mockAdapter.scriptCatchUp([]);
  await engine.start({ origin: "welcome" });
  expect(engine.getState().lifecycle).toBe("live");
}

beforeEach(() => {
  idCounter = 0;
});

// ---------------------------------------------------------------------------
// AC-OPT-1
// ---------------------------------------------------------------------------

describe("AC-OPT-1: acceptLocal reflects a locally-dispatched task immediately, no remote input", () => {
  it("emits domain_event_accepted with event.id === rumorId and the exact dispatched payload, with no signal ever delivered through the adapter", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    await startWelcomeToLive(engine, mockAdapter);

    const rumorId = "rumor-local-1";
    const payload = taskCreatedPayload("task-local-1");
    await engine.acceptLocal(rumorId, payload);

    const accepted = acceptedEvents(events);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].event.id).toBe(rumorId);
    expect(accepted[0].event.payload).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// AC-OPT-2
// ---------------------------------------------------------------------------

describe("AC-OPT-2: acceptLocal's accepted-log write survives a restart", () => {
  it("engine B, restored against the SAME persistence instance, recovers the locally-accepted event", async () => {
    const sharedPersistence = createMockPersistenceAdapter();

    const a = buildEngine({ persistence: sharedPersistence });
    await startWelcomeToLive(a.engine, a.mockAdapter);

    const rumorId = "rumor-restart-1";
    const payload = taskCreatedPayload("task-restart-1");
    await a.engine.acceptLocal(rumorId, payload);
    await a.engine.stop();
    expect(a.engine.getState().lifecycle).toBe("stopped");

    // Directly observe the durable write survived, independent of engine B.
    const persistedDirectly = await sharedPersistence.loadAcceptedEvents(GROUP_ID);
    expect(persistedDirectly).toHaveLength(1);
    expect(persistedDirectly[0].id).toBe(rumorId);
    expect(persistedDirectly[0].payload).toEqual(payload);

    // engine B: fresh IngestSource, SAME persistence -- "restored" origin
    // recovers via checkpoint.bootstrapCompleted -> enterRecovering (R1),
    // which loads the accepted-log and re-marks it processed.
    const b = buildEngine({ persistence: sharedPersistence });
    b.mockAdapter.scriptCatchUp([]); // R4's post-recovery cutover drain
    await b.engine.start({ origin: "restored" });
    expect(b.engine.getState().lifecycle).toBe("live");

    const recoveredEvents = await sharedPersistence.loadAcceptedEvents(GROUP_ID);
    expect(recoveredEvents).toHaveLength(1);
    expect(recoveredEvents[0].id).toBe(rumorId);
    expect(recoveredEvents[0].payload).toEqual(payload);

    // Recovery (R1) marks this id processed BEFORE engine B ever reaches
    // live -- a duplicate acceptLocal on engine B for the same rumorId must
    // therefore be a no-op, not a second accepted-log entry.
    await b.engine.acceptLocal(rumorId, payload);
    const afterDuplicate = await sharedPersistence.loadAcceptedEvents(GROUP_ID);
    expect(afterDuplicate).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-OPT-3
// ---------------------------------------------------------------------------

describe("AC-OPT-3: acceptLocal dedupe and remote-echo convergence", () => {
  it("(a) two acceptLocal calls with the identical rumorId/payload emit domain_event_accepted exactly once", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    await startWelcomeToLive(engine, mockAdapter);

    const rumorId = "rumor-dedupe-1";
    const payload = taskCreatedPayload("task-dedupe-1");
    await engine.acceptLocal(rumorId, payload);
    await engine.acceptLocal(rumorId, payload);

    expect(acceptedEvents(events)).toHaveLength(1);
  });

  it("(b) a subsequent own-echo 'skipped' signal for an unrelated fact neither throws nor produces a second domain_event_accepted", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    await startWelcomeToLive(engine, mockAdapter);

    const rumorId = "rumor-dedupe-2";
    const payload = taskCreatedPayload("task-dedupe-2");
    await engine.acceptLocal(rumorId, payload);

    // Own-echo shape: MLS never decrypts a device's own outgoing message
    // back to itself, so the ratchet reports it via "skipped", never
    // "message" -- this is a DISTINCT code path (handleSkipped) that never
    // touches the accepted-log. `pushLive` enqueues its processing onto the
    // SAME serial FIFO `acceptLocal` uses (see `enterCatchingUp`'s
    // `openLive` callback) -- awaiting a second `acceptLocal` call flushes
    // that FIFO past the pushed signal's own turn, so any throw inside
    // `handleSkipped` would already have surfaced as an unhandled rejection
    // by the time this test finishes.
    mockAdapter.pushLive(skippedSignal({}));
    await engine.acceptLocal(`${rumorId}-flush`, payload);

    // Only the original acceptLocal's accept, plus the flush call's own
    // accept -- never a second accept for `rumorId` itself.
    const acceptedForRumor = acceptedEvents(events).filter((e) => e.event.id === rumorId);
    expect(acceptedForRumor).toHaveLength(1);
  });

  it("(c) the optimistic-then-echo projection deep-equals a pure remote-only projection of the same edit", async () => {
    const rumorId = "rumor-converge-1";
    const payload = taskCreatedPayload("task-converge-1");

    // (i) Local-accept flow.
    const local = buildEngine();
    await startWelcomeToLive(local.engine, local.mockAdapter);
    await local.engine.acceptLocal(rumorId, payload);
    const localProjection = foldProjection(local.events);

    // (ii) Pure remote-only flow: the SAME rumorId/payload arrives as a
    // "message" signal via catchUp() on a fresh, second engine -- never via
    // acceptLocal.
    const remote = buildEngine();
    remote.mockAdapter.scriptFetchBootstrap([]);
    remote.mockAdapter.scriptCatchUp([messageSignal({ rumorId, payload })]);
    await remote.engine.start({ origin: "welcome" });
    expect(remote.engine.getState().lifecycle).toBe("live");
    const remoteProjection = foldProjection(remote.events);

    expect(localProjection).toEqual(remoteProjection);
  });
});

// ---------------------------------------------------------------------------
// S11B-Fable-2: AC-OPT-3's convergence claim exercised DIRECTLY on a
// task.updated supersession, not only inherited from taskWinsOver's own
// (task-crdt.ts-level) unit coverage or AC-OPT-3(c)'s single task.created
// comparison. Pins that an OWN optimistic edit is correctly won-over by a
// remote edit with a HIGHER updatedAt, and correctly RETAINED against a
// remote edit with a LOWER updatedAt -- both directions of the tie-break,
// through the exact acceptLocal -> domain_event_accepted -> applyEvent path
// the UI's projection is built from.
// ---------------------------------------------------------------------------

describe("S11B-Fable-2: an own optimistic task.updated is correctly superseded by (or retained over) a remote task.updated for the SAME task, per taskWinsOver's updatedAt ordering", () => {
  it("a remote edit with a HIGHER updatedAt (T+1) supersedes the own optimistic edit -- projection reflects the remote value", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    await startWelcomeToLive(engine, mockAdapter);

    const taskId = "task-supersede-higher";
    await engine.acceptLocal(`${taskId}-create`, taskCreatedPayload(taskId));

    const ownUpdate: TaskEvent = {
      type: "task.updated",
      taskId,
      changes: { title: "own title" },
      updatedAt: 2000,
      updatedBy: "pk-own",
      updatedByDevice: "device-own",
    };
    await engine.acceptLocal(`${taskId}-own-update`, ownUpdate);
    // Own optimistic value visible immediately, before any remote input.
    expect(foldProjection(events).get(taskId)?.title).toBe("own title");

    const remoteUpdate: TaskEvent = {
      type: "task.updated",
      taskId,
      changes: { title: "remote title" },
      updatedAt: 2001, // strictly newer -- unambiguous win, no tie-break path
      updatedBy: "pk-remote",
      updatedByDevice: "device-remote",
    };
    mockAdapter.pushLive(
      messageSignal({ rumorId: `${taskId}-remote-update`, payload: remoteUpdate }),
    );
    // Flush the serial FIFO the pushed signal was enqueued onto (same idiom
    // as AC-OPT-3(b)).
    await engine.acceptLocal(`${taskId}-flush`, taskCreatedPayload(`${taskId}-flush`));

    const finalProjection = foldProjection(events);
    expect(finalProjection.get(taskId)?.title).toBe("remote title");
    expect(finalProjection.get(taskId)?.updatedBy).toBe("pk-remote");
  });

  it("a remote edit with a LOWER updatedAt (T-1) loses to the own optimistic edit -- projection retains the own value", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    await startWelcomeToLive(engine, mockAdapter);

    const taskId = "task-supersede-lower";
    await engine.acceptLocal(`${taskId}-create`, taskCreatedPayload(taskId));

    const ownUpdate: TaskEvent = {
      type: "task.updated",
      taskId,
      changes: { title: "own title" },
      updatedAt: 2000,
      updatedBy: "pk-own",
      updatedByDevice: "device-own",
    };
    await engine.acceptLocal(`${taskId}-own-update`, ownUpdate);

    const remoteUpdate: TaskEvent = {
      type: "task.updated",
      taskId,
      changes: { title: "remote title (stale)" },
      updatedAt: 1999, // strictly older -- unambiguous loss, no tie-break path
      updatedBy: "pk-remote",
      updatedByDevice: "device-remote",
    };
    mockAdapter.pushLive(
      messageSignal({ rumorId: `${taskId}-remote-update`, payload: remoteUpdate }),
    );
    await engine.acceptLocal(`${taskId}-flush`, taskCreatedPayload(`${taskId}-flush`));

    const finalProjection = foldProjection(events);
    expect(finalProjection.get(taskId)?.title).toBe("own title");
    expect(finalProjection.get(taskId)?.updatedBy).toBe("pk-own");
  });
});

// ---------------------------------------------------------------------------
// AC-OPT-5
// ---------------------------------------------------------------------------

describe("AC-OPT-5: acceptLocal's id derivation is the exact rumorId, never re-derived or content-hashed", () => {
  it("deriveMlsAcceptedEventId is the identity function (regression guard)", () => {
    expect(deriveMlsAcceptedEventId("rumor-identity-1")).toBe("rumor-identity-1");
    expect(deriveMlsAcceptedEventId("rumor-identity-2")).toBe("rumor-identity-2");
  });

  it("domain_event_accepted.event.id equals the exact rumorId argument passed to acceptLocal, with no transformation", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    await startWelcomeToLive(engine, mockAdapter);

    const rumorId = "rumor-exact-id-1";
    const payload = taskCreatedPayload("task-exact-id-1");
    await engine.acceptLocal(rumorId, payload);

    const accepted = acceptedEvents(events);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].event.id).toBe(rumorId);
  });

  it("two different rumorIds with same-content payloads never collide -- both produce their own domain_event_accepted", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    await startWelcomeToLive(engine, mockAdapter);

    // Same payload CONTENT (simulating two different devices/pubkeys
    // authoring similar-looking edits), deliberately different rumorIds.
    const payload = taskCreatedPayload("task-collision-1");
    await engine.acceptLocal("rumor-a", payload);
    await engine.acceptLocal("rumor-b", payload);

    const accepted = acceptedEvents(events);
    expect(accepted).toHaveLength(2);
    expect(new Set(accepted.map((e) => e.event.id))).toEqual(new Set(["rumor-a", "rumor-b"]));
  });
});

// ---------------------------------------------------------------------------
// VQ-S11B-010 (post-impl): the pre-start() race acceptLocal's
// enqueue()-with-execution-time-generation-capture design exists to survive.
// ---------------------------------------------------------------------------

describe("VQ-S11B-010: acceptLocal called BEFORE start() resolves is never silently dropped", () => {
  it("a call issued synchronously before start(), never awaited until after, still lands once the engine reaches live", async () => {
    const { engine, mockAdapter, events } = buildEngine();
    mockAdapter.scriptFetchBootstrap([]);
    mockAdapter.scriptCatchUp([]);

    const rumorId = "rumor-pre-start-race-1";
    const payload = taskCreatedPayload("task-pre-start-race-1");

    // Fired BEFORE start() -- at this point `generation` is still its
    // pre-start value (0). If acceptLocal captured `gen` at CALL time (like
    // enqueueGen does for adapter-sourced signals), this job would compare
    // its stale gen=0 against the post-start generation and silently
    // abandon. It must not.
    const acceptPromise = engine.acceptLocal(rumorId, payload);
    const startPromise = engine.start({ origin: "welcome" });

    await Promise.all([acceptPromise, startPromise]);

    expect(engine.getState().lifecycle).toBe("live");
    const accepted = acceptedEvents(events);
    expect(accepted.some((e) => e.event.id === rumorId)).toBe(true);
  });
});
