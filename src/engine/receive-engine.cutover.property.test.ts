/**
 * receive-engine.cutover.property.test.ts
 *
 * AC-FSM-8 property test: the catching_up -> buffering_live -> live cutover
 * applies every historical and live-arrived fact EXACTLY ONCE (no fact
 * dropped, no fact duplicated) under an ARBITRARY interleaving of historical
 * facts (draining via `adapter.catchUp()`) and live facts arriving
 * concurrently with that drain (pushed via `adapter.openLive()`'s callback).
 * `fast-check` generates the interleaving; the property is checked across
 * many randomized runs, not a single fixed ordering (VQ-S5-004/AC-FSM-8's
 * observable).
 *
 * PERSISTENCE NOTE: this story's brief says fact/accepted-event persistence
 * should use "the real S4 raw-event-log-store" in integration-style tests.
 * That is not available under `src/engine/` -- `engine-boundary.structural.
 * test.ts`'s AC-BOUND-1 scanner forbids ANY `.ts` file under `src/engine/`
 * (tests included, no carve-out) from importing anything matching
 * `/persistence/`, verified directly against the scanner source plus its
 * `src/persistence` scanner-liveness fixture. This is the identical boundary
 * constraint documented in architecture.json's
 * "ingest-policy-cannot-import-marmot-ingest-queue" judgment call, applying
 * here to test files too. This file's mock `PersistenceAdapter` therefore
 * REPLICATES raw-event-log-store.ts's exact fact/accepted-event algorithm
 * (idempotent lookup-before-insert, seq = last-seq+1, append-order
 * preservation) rather than importing it -- "real" in behavior, structurally
 * independent. Recorded as a post-impl verification question.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { createReceiveEngine, createRealEngineScheduler } from "./receive-engine";
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
// Controllable async iterable (same shape as receive-engine.fsm.test.ts's;
// duplicated per-file since scope.includes lists no shared test-helpers
// file for this story).
// ---------------------------------------------------------------------------

interface ControllableIterable<T> {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  complete(): void;
}

function createControllableAsyncIterable<T>(): ControllableIterable<T> {
  const queue: T[] = [];
  let pendingResolve: ((r: IteratorResult<T>) => void) | null = null;
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
          return new Promise((resolve) => {
            pendingResolve = resolve;
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
        r({ value: undefined as unknown as T, done: true });
      }
    },
  };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Mock IngestSource: joining's bootstrap fetch (fetchBootstrap(), the
// DEDICATED channel -- amended 2026-07-12, S5 Stage-1 review -- sev-6)
// always resolves empty and immediately; the cutover catchUp() call --
// now catchUp()'s ONLY call, invoked exactly once per start() -- is
// manually controlled so the test can interleave live pushes with the
// historical drain.
// ---------------------------------------------------------------------------

function createMockIngestSource(cutoverController: ControllableIterable<IngestSignal>): {
  source: IngestSource;
  pushLive(signal: IngestSignal): void;
  /** Resolves once openLive() has actually been called. `transitionTo`
   *  awaits an (async, even if trivially-resolving) checkpoint save between
   *  emitting "engine_state_changed{state:catching_up}" and enterCatchingUp
   *  calling openLive() on the next line -- so "catching_up" being the
   *  current state does NOT guarantee the live subscription is open yet.
   *  Pushing a live signal before openLive() runs would be silently
   *  swallowed (onSignal is still null), which is a test-timing artifact,
   *  not a real scenario (a real relay subscription has no events to push
   *  before the subscription object exists) -- so callers await this
   *  before pushing any live signal. */
  liveOpened: Promise<void>;
} {
  let onSignal: ((signal: IngestSignal) => void) | null = null;
  let resolveLiveOpened!: () => void;
  const liveOpened = new Promise<void>((resolve) => {
    resolveLiveOpened = resolve;
  });

  const source: IngestSource = {
    catchUp() {
      // The cutover drain -- catchUp()'s ONLY call, per-start exactly-once
      // invariant (see engine-types.ts's IngestSource.catchUp doc).
      return cutoverController.iterable;
    },
    openLive(cb) {
      onSignal = cb;
      resolveLiveOpened();
      return () => {
        if (onSignal === cb) onSignal = null;
      };
    },
    ingestPersisted() {
      return fromArray([]);
    },
    fetchBootstrap() {
      // Joining's dedicated bootstrap channel: resolves empty immediately.
      return fromArray([]);
    },
    close() {},
  };

  return {
    source,
    liveOpened,
    pushLive(signal) {
      onSignal?.(signal);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock PersistenceAdapter -- replicates raw-event-log-store.ts's algorithm
// (see module doc comment).
// ---------------------------------------------------------------------------

function createMockPersistenceAdapter(): PersistenceAdapter {
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
// Fixture builders
// ---------------------------------------------------------------------------

const GROUP_ID = "group-1";

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

function factInput(id: string): RawProtocolFactInput {
  return {
    id,
    groupId: GROUP_ID,
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

function taskEvent(id: string): TaskEvent {
  return { type: "task.created", task: task(id) };
}

function messageSignal(taskId: string): IngestSignal {
  return {
    type: "message",
    fact: factInput(`fact-${taskId}`),
    rumorId: `rumor-${taskId}`,
    payload: taskEvent(taskId),
    epoch: "epoch-0",
    receiptSource: "historical",
  };
}

// ---------------------------------------------------------------------------
// The property
//
// Strengthened 2026-07-12 (S5 Stage-2 cold review -- sev-6, "property-test
// strength"):
//  (a) a microtask yield is inserted BETWEEN every move push (not just
//      after the whole batch), so live signals genuinely arrive while a
//      historical signal is mid-flight through the engine's async
//      processing chain -- not merely "queued before drain starts". The
//      historical channel is completed as soon as its LAST "H"-kind move
//      has been pushed (not after every move, historical or live), so any
//      "L"-kind moves that the shuffle places AFTER it land during
//      `buffering_live`'s own drain (or, depending on timing, `live`
//      directly) rather than exclusively during `catching_up`.
//  (b) an "overlap" arbitrary generates ids delivered on BOTH the
//      historical AND the live channel (two separate `IngestSignal`s
//      carrying the same fact/rumor id) -- asserting they are still
//      accepted EXACTLY ONCE proves `receive-engine.ts`'s
//      `ingestPolicy.hasProcessed` dedupe, not merely "no drops on a single
//      channel". See this file's header for the accompanying mutant-kill
//      verification performed against `handleMessage`'s dedupe check.
// ---------------------------------------------------------------------------

type Move = { kind: "H"; id: string } | { kind: "L"; id: string };

describe("AC-FSM-8: gap-free cutover applies every fact exactly once under arbitrary interleaving", () => {
  it("historical-before-live ordering and exactly-once application hold across randomized interleavings, including ids delivered on both channels", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }), // historical-only ids
        fc.integer({ min: 0, max: 5 }), // live-only ids
        fc.integer({ min: 0, max: 2 }), // overlap ids (delivered on BOTH channels)
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        async (historicalOnlyCount, liveOnlyCount, overlapCount, seed) => {
          const historicalOnlyIds = Array.from(
            { length: historicalOnlyCount },
            (_, i) => `ho${i}`,
          );
          const liveOnlyIds = Array.from({ length: liveOnlyCount }, (_, i) => `lo${i}`);
          const overlapIds = Array.from({ length: overlapCount }, (_, i) => `ov${i}`);

          // Every historical-only and overlap id contributes an "H" move;
          // every live-only and overlap id contributes an "L" move. Overlap
          // ids therefore contribute TWO moves (same id, both channels).
          const moves: Move[] = [
            ...historicalOnlyIds.map((id): Move => ({ kind: "H", id })),
            ...liveOnlyIds.map((id): Move => ({ kind: "L", id })),
            ...overlapIds.map((id): Move => ({ kind: "H", id })),
            ...overlapIds.map((id): Move => ({ kind: "L", id })),
          ];
          const totalHMoves = historicalOnlyIds.length + overlapIds.length;

          // Deterministic shuffle of the move multiset, seeded per-run by
          // fast-check's own generated seed (so shrinking still explores
          // varied interleavings, not just move-list length).
          let rngState = seed;
          const nextRand = () => {
            rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
            return rngState / 0x7fffffff;
          };
          for (let i = moves.length - 1; i > 0; i--) {
            const j = Math.floor(nextRand() * (i + 1));
            [moves[i], moves[j]] = [moves[j], moves[i]];
          }

          const cutoverController = createControllableAsyncIterable<IngestSignal>();
          const mock = createMockIngestSource(cutoverController);
          const persistence = createMockPersistenceAdapter();
          const events: EngineOutputEvent[] = [];
          const engine = createReceiveEngine({
            groupId: GROUP_ID,
            adapter: mock.source,
            persistence,
            scheduler: createRealEngineScheduler(),
          });
          engine.subscribe((e) => events.push(e));

          // Event-driven wait (not polling): resolves as soon as the live
          // subscription is actually open (see mock.liveOpened's doc
          // comment -- this is later than the "catching_up" state event by
          // one microtask, and pushing a live signal before openLive() has
          // run would be silently dropped). Zero interval overhead, unlike
          // vi.waitFor -- load-bearing at numRuns=100, where polling
          // overhead would approach the default per-test timeout.
          const startPromise = engine.start({ origin: "welcome" });
          await mock.liveOpened;

          let hPushed = 0;
          for (const move of moves) {
            if (move.kind === "H") {
              cutoverController.push(messageSignal(move.id));
              hPushed += 1;
              // Complete the historical channel the instant its LAST move
              // has been pushed -- any remaining "L" moves the shuffle
              // placed after it (item (a)) then land during
              // `buffering_live`'s drain (or `live` itself), not only
              // during `catching_up`.
              if (hPushed === totalHMoves) cutoverController.complete();
            } else {
              mock.pushLive(messageSignal(move.id));
            }
            // Yield a few microtask turns BETWEEN every push so the
            // engine's internal (promise-chained, not timer-based) FIFO
            // processing genuinely advances mid-interleaving rather than
            // draining the whole pushed backlog only once the loop below
            // finishes.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
          }
          await startPromise;

          const acceptedIds = events
            .filter(
              (e): e is Extract<EngineOutputEvent, { type: "domain_event_accepted" }> =>
                e.type === "domain_event_accepted",
            )
            .map((e) => (e.event.payload.type === "task.created" ? e.event.payload.task.id : ""));

          const allIds = [...historicalOnlyIds, ...liveOnlyIds, ...overlapIds];

          // Exactly-once, no drop, no duplicate -- including overlap ids
          // pushed on BOTH channels: the emitted id MULTISET equals the
          // exact distinct-id SET with matching length (proves no
          // duplicate emission for the double-delivered ids, not just "the
          // set matches").
          expect(acceptedIds).toHaveLength(allIds.length);
          expect(new Set(acceptedIds)).toEqual(new Set(allIds));

          // Historical-before-live: overlap ids are accepted via their
          // historical delivery (I-FSM-3 guarantees the historical drain
          // fully processes -- including accepting -- every historical
          // signal before `buffering_live` ever begins draining the
          // buffered live copy, so the buffered live delivery always hits
          // the dedupe check as a no-op). Every historical-only/overlap
          // id's emission index is therefore less than every live-only id's.
          const historicalLikeIds = [...historicalOnlyIds, ...overlapIds];
          const maxHistoricalIndex = Math.max(
            -1,
            ...historicalLikeIds.map((id) => acceptedIds.indexOf(id)),
          );
          const minLiveIndex =
            liveOnlyIds.length === 0
              ? Number.POSITIVE_INFINITY
              : Math.min(...liveOnlyIds.map((id) => acceptedIds.indexOf(id)));
          expect(maxHistoricalIndex).toBeLessThan(minLiveIndex);

          await engine.stop();
        },
      ),
      { numRuns: 100 },
    );
  });
});
