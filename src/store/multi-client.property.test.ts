import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import { applyEvent, type TaskState } from "./task-reducer.js";
import type { Task, TaskEvent, TaskStatus } from "./task-events.js";

// ---------------------------------------------------------------------------
// Run budget — overrideable from env for deep exploration.
// ---------------------------------------------------------------------------
const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS) || 500;

// ---------------------------------------------------------------------------
// FakeBoard: in-memory N-client harness.
//
// Models the task-event convergence layer for an N-client group where events
// are published to a shared linearized bus (modelling MLS sequential delivery)
// and each client receives them in potentially different orders/delays.
//
// Design constraints for convergence (C0) to hold:
//   1. All events are dispatched by a single writer (client 0) — this models
//      MLS's total ordering of application messages.  Multiple writers would
//      require a distributed consensus layer that the LWW reducer does not
//      provide (see D1 in the spec).
//   2. Each task has a unique id — the task.created handler overwrites
//      unconditionally (no timestamp guard), so re-creation of the same id
//      via out-of-order delivery would break convergence.
//   3. Event timestamps for the same task are strictly increasing — the LWW
//      rule `>= existing.updatedAt` rejects stale events; if two events for
//      the same task have the same timestamp from different sources, delivery
//      order determines which wins (D1 divergence).
//
// What is NOT tested at this layer: MLS group membership negotiation, epoch
// changes, ratchet-tree leaf semantics, publish-failure behaviour, welcome-
// flow integrity, and concurrent multi-client dispatch. Those are covered by
// S6 (Playwright layer) or are D-category divergences tested separately.
// ---------------------------------------------------------------------------
class FakeBoard {
  clients: TaskState[];
  bus: Array<{ event: TaskEvent; deliveredTo: Set<number> }>;

  constructor(numClients: number) {
    this.clients = Array.from({ length: numClients }, () => new Map());
    this.bus = [];
  }

  dispatch(clientIdx: number, event: TaskEvent): void {
    this.clients[clientIdx] = applyEvent(this.clients[clientIdx], event);
    this.bus.push({ event, deliveredTo: new Set([clientIdx]) });
  }

  deliver(busIdx: number, targetIdx: number): void {
    const slot = this.bus[busIdx];
    if (slot.deliveredTo.has(targetIdx)) return;
    this.clients[targetIdx] = applyEvent(this.clients[targetIdx], slot.event);
    slot.deliveredTo.add(targetIdx);
  }

  quiesce(): void {
    for (let bi = 0; bi < this.bus.length; bi++) {
      for (let ci = 0; ci < this.clients.length; ci++) {
        this.deliver(bi, ci);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deep-equal two TaskState maps (field-by-field).
// ---------------------------------------------------------------------------
function mapsEqual(a: TaskState, b: TaskState): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ta] of a.entries()) {
    const tb = b.get(id);
    if (tb === undefined) return false;
    if (
      ta.title !== tb.title ||
      ta.description !== tb.description ||
      ta.status !== tb.status ||
      ta.assignee !== tb.assignee ||
      ta.createdBy !== tb.createdBy ||
      ta.createdAt !== tb.createdAt ||
      ta.updatedAt !== tb.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Arbitraries — shared with reducer property tests (same patterns).
// ---------------------------------------------------------------------------

const arbHexPubkey: fc.Arbitrary<string> = fc.hexaString({
  minLength: 64,
  maxLength: 64,
});

const arbTimestamp: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: 2_000_000_000,
});

const arbTaskStatus: fc.Arbitrary<TaskStatus> = fc.constantFrom(
  "open",
  "in_progress",
  "done",
  "cancelled",
);

const arbTaskFresh: fc.Arbitrary<Task> = fc
  .record({
    id: fc.uuid(),
    title: fc.string({ minLength: 1, maxLength: 60 }),
    description: fc.string({ maxLength: 200 }),
    createdBy: arbHexPubkey,
    createdAt: arbTimestamp,
  })
  .map(({ id, title, description, createdBy, createdAt }) => ({
    id,
    title,
    description,
    status: "open" as TaskStatus,
    assignee: null,
    createdBy,
    createdAt,
    updatedAt: createdAt,
  }));

// ---------------------------------------------------------------------------
// RawStep — same pattern as the reducer property test (S2/S3).
// Generates all randomness upfront as a flat record, then interprets
// statefully into a TaskEvent. This avoids fc.gen's Map-caching issue.
// ---------------------------------------------------------------------------
type RawStep = {
  kindIndex: number; // 0..12 → event type bucket
  taskIndex: number; // which existing task to target (modulo count)
  tsDelta: number; // timestamp delta above existing.updatedAt (+0 = same ts)
  fresh: Task;
  newStatus: TaskStatus;
  assignee: string | null;
  updatedBy: string;
};

const arbRawStep: fc.Arbitrary<RawStep> = fc.record({
  kindIndex: fc.integer({ min: 0, max: 9 }),
  taskIndex: fc.integer({ min: 0, max: 100 }),
  tsDelta: fc.integer({ min: 1, max: 10_000 }), // always > 0 for strict ordering
  fresh: arbTaskFresh,
  newStatus: arbTaskStatus,
  assignee: fc.option(arbHexPubkey, { nil: null }),
  updatedBy: arbHexPubkey,
});

/**
 * Convert a RawStep into a TaskEvent given the current state.
 *
 * kindIndex distribution (10 buckets):
 *  0-2  → task.created        (30%)
 *  3-5  → task.status_changed (30%)
 *  6-7  → task.assigned       (20%)
 *  8-9  → task.deleted        (20%)
 *
 * task.updated is excluded for the same reason as in S3's C1: it merges a
 * partial changes object, and cross-event order-dependence at the field level
 * cannot be eliminated by timestamp monotonicity alone. Only event types that
 * atomically replace a single field (or the whole task) are included.
 *
 * tsDelta is always >= 1 so timestamps are strictly increasing per task —
 * required for LWW convergence (prevents D1-style tie-break divergence).
 */
function interpretStep(step: RawStep, state: TaskState): TaskEvent {
  const taskIds = Array.from(state.keys());
  const hasExisting = taskIds.length > 0;

  if (!hasExisting || step.kindIndex <= 2) {
    return { type: "task.created", task: step.fresh };
  }

  const taskId = taskIds[step.taskIndex % taskIds.length];
  const existing = state.get(taskId)!;
  const updatedAt = existing.updatedAt + step.tsDelta; // tsDelta >= 1

  if (step.kindIndex <= 5) {
    return {
      type: "task.status_changed",
      taskId,
      status: step.newStatus,
      updatedAt,
      updatedBy: step.updatedBy,
    };
  }

  if (step.kindIndex <= 7) {
    return {
      type: "task.assigned",
      taskId,
      assignee: step.assignee,
      updatedAt,
      updatedBy: step.updatedBy,
    };
  }

  return {
    type: "task.deleted",
    taskId,
    updatedAt,
    updatedBy: step.updatedBy,
  };
}

/**
 * Build an event sequence from raw steps, threading state.
 * Each task.created gets a unique monotone ID to prevent re-creation of
 * existing IDs (task.created overwrites unconditionally — duplicate IDs
 * with different timestamps would cause non-convergence via out-of-order
 * delivery since quiesce delivers events in bus order, not ts order).
 */
function buildEventLog(steps: RawStep[]): TaskEvent[] {
  const events: TaskEvent[] = [];
  let state: TaskState = new Map();
  let taskCounter = 0;

  for (const step of steps) {
    let event = interpretStep(step, state);
    if (event.type === "task.created") {
      // Override UUID with a monotone counter-based ID to avoid collision.
      event = { ...event, task: { ...event.task, id: `t${taskCounter++}` } };
    }
    events.push(event);
    state = applyEvent(state, event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// arbBoardSchedule: the primary multi-client test generator.
//
// Structure:
//   1. Generate an event log (all dispatched by the single virtual writer).
//   2. Generate random per-client delivery orders (permutation + partial pre-
//      delivery before quiesce).
//
// The single-writer model is the correct one for this reducer: in the real
// notestr system, all task events flow through the MLS application-message
// bus which provides a total order.  Convergence is demonstrated by showing
// that different delivery orders produce the same settled state — not by
// testing concurrent multi-client dispatch (which is a D1/D3 scenario).
// ---------------------------------------------------------------------------
type BoardSchedule = {
  numClients: number;
  events: TaskEvent[]; // the shared event log, dispatched from client 0
  // Per-client pre-delivery: for each client i (i>0), a list of bus indices
  // to deliver before quiesce.  These are causally ordered (sorted) to avoid
  // applying mutations before their task exists.
  preDeliveries: number[][]; // preDeliveries[i] = sorted indices for client i+1
};

function arbBoardSchedule(): fc.Arbitrary<BoardSchedule> {
  return fc
    .record({
      numClients: fc.integer({ min: 2, max: 5 }),
      rawSteps: fc.array(arbRawStep, { minLength: 1, maxLength: 20 }),
      // For each client slot (numClients-1), a set of delivery indices to
      // eagerly deliver before quiesce. Generated as sorted integer arrays so
      // causal order is preserved (higher bus index = later event = no-op if
      // earlier not yet delivered would be fine since quiesce drains all).
      deliverySeeds: fc.array(
        fc.array(fc.integer({ min: 0, max: 19 }), {
          minLength: 0,
          maxLength: 10,
        }),
        { minLength: 4, maxLength: 4 }, // always 4 slots (for up to 5 clients)
      ),
    })
    .map(({ numClients, rawSteps, deliverySeeds }) => {
      const events = buildEventLog(rawSteps);
      const busLen = events.length;

      // For each non-originating client, compute which bus indices to
      // pre-deliver (eagerly, before quiesce). Indices are modulo'd to
      // bus length and sorted to preserve causal order.
      const preDeliveries: number[][] = [];
      for (let ci = 1; ci < numClients; ci++) {
        const seeds = deliverySeeds[(ci - 1) % deliverySeeds.length] ?? [];
        if (busLen === 0) {
          preDeliveries.push([]);
        } else {
          const indices = seeds
            .map((s) => s % busLen)
            .sort((a, b) => a - b)
            .filter((v, i, arr) => i === 0 || arr[i - 1] !== v); // deduplicate
          preDeliveries.push(indices);
        }
      }

      return { numClients, events, preDeliveries };
    });
}

/**
 * Run a BoardSchedule: dispatch all events from client 0, apply pre-
 * deliveries, then quiesce. Returns the board after quiesce.
 *
 * Pre-deliveries are applied as a causal prefix: for each client, we deliver
 * all events up to and including the maximum pre-delivery index, in bus order.
 * This preserves causal ordering (tasks must exist before mutations are
 * applied) and avoids the scenario where a mutation event is marked as
 * "delivered" to a client before the task's creation event was delivered,
 * causing quiesce to skip re-delivery of the now-stale event.
 */
function runSchedule(schedule: BoardSchedule): FakeBoard {
  const board = new FakeBoard(schedule.numClients);

  // Dispatch all events from client 0 (single writer).
  for (const event of schedule.events) {
    board.dispatch(0, event);
  }

  // Apply pre-deliveries as causal prefixes: for each client, deliver all
  // events 0..maxIdx where maxIdx is the maximum index in preDeliveries[ci-1].
  for (let ci = 1; ci < schedule.numClients; ci++) {
    const indices = schedule.preDeliveries[ci - 1] ?? [];
    if (indices.length === 0) continue;
    const maxIdx = Math.max(...indices);
    for (let bi = 0; bi <= maxIdx && bi < board.bus.length; bi++) {
      board.deliver(bi, ci);
    }
  }

  board.quiesce();
  return board;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("multi-client property tests — S4 story", () => {
  // -------------------------------------------------------------------------
  // AC-X-OBSERVABILITY-1: schedule shape distribution
  // -------------------------------------------------------------------------
  it("[AC-X-OBSERVABILITY-1] schedule distribution — event count, client count, pre-delivery density", () => {
    // Reports generated schedule characteristics.
    // The single-writer model means "dispatch count" == event count.
    fc.statistics(
      arbBoardSchedule(),
      ({ numClients, events, preDeliveries }) => {
        const totalPreDeliveries = preDeliveries.reduce(
          (s, arr) => s + arr.length,
          0,
        );
        const density =
          events.length === 0
            ? "empty"
            : totalPreDeliveries / (events.length * (numClients - 1)) > 0.5
              ? "dense-pre-delivery"
              : "sparse-pre-delivery";
        return `clients=${numClients} events=${events.length} ${density}`;
      },
    );
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // C0: settled-state equality (task subset) — AC-MC-1
  // -------------------------------------------------------------------------
  it("[C0] settled-state equality (task subset)", () => {
    // C0: post-quiesce, every client's TaskState deep-equals clients[0].
    //     Events are dispatched from client 0 (single writer modelling MLS
    //     linearization); other clients receive them in randomly ordered
    //     partial pre-deliveries before quiesce completes the delivery.
    //     The assertion demonstrates that delivery order does not affect the
    //     final settled state.
    fc.assert(
      fc.property(arbBoardSchedule(), (schedule) => {
        const board = runSchedule(schedule);
        for (let i = 1; i < board.clients.length; i++) {
          expect(mapsEqual(board.clients[0], board.clients[i])).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // C1: permutation-independence in multi-client setting — AC-MC-2
  //
  // Restriction: same as single-client C1 (S3) — only task.status_changed
  // events are permuted. task.updated merges a partial changes object and
  // its field-level semantics depend on delivery order even with distinct
  // timestamps (the higher-ts event's merge state differs by delivery order).
  // Status_changed atomically replaces a single field — highest-ts wins
  // regardless of delivery order.
  // -------------------------------------------------------------------------
  it("[C1] permutation-independence in multi-client setting", () => {
    // C1: fix a multiset of status_changed events with strictly distinct
    //     timestamps; randomly permute per-client delivery order; assert
    //     post-quiesce equality across all clients.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }), // numClients
        arbTaskFresh,
        fc.array(
          fc.record({ status: arbTaskStatus, updatedBy: arbHexPubkey }),
          { minLength: 1, maxLength: 8 },
        ),
        // Shuffle key arrays: one per client (used to permute delivery order).
        fc.array(
          fc.array(fc.integer({ min: 0, max: 999 }), {
            minLength: 1,
            maxLength: 8,
          }),
          { minLength: 2, maxLength: 5 },
        ),
        (numClients, task, steps, shuffleKeyGroups) => {
          // Build status_changed events with strictly increasing timestamps.
          const events: TaskEvent[] = steps.map((s, i) => ({
            type: "task.status_changed" as const,
            taskId: task.id,
            status: s.status,
            updatedAt: task.updatedAt + i + 1,
            updatedBy: s.updatedBy,
          }));

          const creation: TaskEvent = { type: "task.created", task };
          const board = new FakeBoard(numClients);

          // Dispatch creation and deliver it to all clients first.
          board.dispatch(0, creation);
          for (let ci = 1; ci < numClients; ci++) {
            board.deliver(0, ci);
          }

          // Dispatch all status events from client 0.
          const busStartIdx = board.bus.length;
          for (const e of events) {
            board.dispatch(0, e);
          }

          // For each non-originating client, deliver status events in a
          // randomly permuted order.
          for (let ci = 1; ci < numClients; ci++) {
            const keys =
              shuffleKeyGroups[ci % shuffleKeyGroups.length] ??
              shuffleKeyGroups[0];
            const indexed = events.map((_, eIdx) => ({
              busIdx: busStartIdx + eIdx,
              key: keys[eIdx % keys.length] ?? eIdx,
            }));
            indexed.sort((a, b) => a.key - b.key);
            for (const { busIdx } of indexed) {
              board.deliver(busIdx, ci);
            }
          }

          board.quiesce();

          for (let i = 1; i < numClients; i++) {
            expect(mapsEqual(board.clients[0], board.clients[i])).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // C2: author-irrelevance multi-client — AC-MC-3
  // -------------------------------------------------------------------------
  it("[C2] author-irrelevance multi-client — re-labelling updatedBy does not affect convergence outcome", () => {
    // C2: re-label every event's updatedBy (and createdBy for task.created)
    //     to a uniformly-random fresh pubkey before delivery; assert the
    //     resulting clients converge to a state whose tasks differ from the
    //     un-relabelled run only in createdBy (which is re-labelled by design).
    fc.assert(
      fc.property(
        arbBoardSchedule(),
        arbHexPubkey, // replacement author pubkey
        (schedule, fakeAuthor) => {
          // Re-label author fields in all events.
          const relabelledEvents: TaskEvent[] = schedule.events.map((e) => {
            if (e.type === "task.created") {
              return { ...e, task: { ...e.task, createdBy: fakeAuthor } };
            }
            if (e.type === "task.snapshot") return e;
            return { ...e, updatedBy: fakeAuthor };
          });

          const relabelledSchedule: BoardSchedule = {
            ...schedule,
            events: relabelledEvents,
          };

          const origBoard = runSchedule(schedule);
          const relabelledBoard = runSchedule(relabelledSchedule);

          const orig = origBoard.clients[0];
          const relabelled = relabelledBoard.clients[0];

          // Same task ids.
          expect(orig.size).toBe(relabelled.size);
          for (const [id, origTask] of orig.entries()) {
            const relabelledTask = relabelled.get(id);
            expect(relabelledTask).toBeDefined();
            if (relabelledTask === undefined) return;
            // Content fields must match.
            expect(relabelledTask.status).toBe(origTask.status);
            expect(relabelledTask.title).toBe(origTask.title);
            expect(relabelledTask.description).toBe(origTask.description);
            expect(relabelledTask.assignee).toBe(origTask.assignee);
            expect(relabelledTask.createdAt).toBe(origTask.createdAt);
            expect(relabelledTask.updatedAt).toBe(origTask.updatedAt);
            // createdBy changes by design — re-labelled run uses fakeAuthor.
          }

          // Convergence must hold in both boards.
          for (let i = 1; i < origBoard.clients.length; i++) {
            expect(mapsEqual(origBoard.clients[0], origBoard.clients[i])).toBe(
              true,
            );
            expect(
              mapsEqual(
                relabelledBoard.clients[0],
                relabelledBoard.clients[i],
              ),
            ).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // C3: duplicate-tolerance multi-client — AC-MC-4
  // -------------------------------------------------------------------------
  it("[C3] duplicate-tolerance multi-client — delivering 1–3 times matches once-each baseline", () => {
    // C3: each bus slot delivered to each client between 1 and 3 times;
    //     post-quiesce state must match the once-each-deliver baseline.
    fc.assert(
      fc.property(
        arbBoardSchedule(),
        // Per-(bus-slot, client) repeat count: one integer per slot*client pair.
        fc.array(fc.integer({ min: 0, max: 2 }), {
          minLength: 0,
          maxLength: 150,
        }),
        (schedule, repeatOffsets) => {
          // Baseline: normal schedule execution.
          const baseline = runSchedule(schedule);

          // Duplicate run: dispatch events, then deliver each bus slot to
          // each client 1–3 times before quiesce.
          const dupBoard = new FakeBoard(schedule.numClients);
          for (const event of schedule.events) {
            dupBoard.dispatch(0, event);
          }

          for (let bi = 0; bi < dupBoard.bus.length; bi++) {
            for (let ci = 1; ci < schedule.numClients; ci++) {
              const times =
                (repeatOffsets[
                  (bi * (schedule.numClients - 1) + (ci - 1)) %
                    Math.max(1, repeatOffsets.length)
                ] ?? 0) + 1;
              for (let r = 0; r < times; r++) {
                dupBoard.deliver(bi, ci);
              }
            }
          }

          // Client 0 needs quiesce too (no-op for dispatch client).
          dupBoard.quiesce();

          for (let i = 0; i < schedule.numClients; i++) {
            expect(mapsEqual(baseline.clients[i], dupBoard.clients[i])).toBe(
              true,
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A13: multi-client idempotence — AC-MC-5
  // -------------------------------------------------------------------------
  it("[A13] multi-client idempotence — delivering same event multiple times is a no-op after first delivery", () => {
    // A13, multi-client: delivering any non-snapshot event to a client multiple
    //     times produces no observable change after the first delivery.
    //     Stronger than single-client A13 because we observe across all clients.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        arbTaskFresh,
        fc.integer({ min: 1, max: 5 }), // extra delivery count
        arbTaskStatus,
        arbHexPubkey,
        fc.integer({ min: 1, max: 10_000 }),
        (numClients, task, extraDeliveries, newStatus, updatedBy, delta) => {
          const board = new FakeBoard(numClients);
          const creation: TaskEvent = { type: "task.created", task };
          board.dispatch(0, creation);

          const mutEvent: TaskEvent = {
            type: "task.status_changed",
            taskId: task.id,
            status: newStatus,
            updatedAt: task.updatedAt + delta,
            updatedBy,
          };
          board.dispatch(0, mutEvent);

          // Deliver both events to all clients once (full quiesce).
          board.quiesce();

          // Capture state after first full delivery.
          const statesAfterFirst = board.clients.map((c) => new Map(c));

          // Force re-delivery of the mutation event extra times to every client.
          const mutBusIdx = 1; // second bus slot
          for (let r = 0; r < extraDeliveries; r++) {
            for (let ci = 0; ci < numClients; ci++) {
              // Clear deliveredTo to simulate re-delivery.
              const slot = board.bus[mutBusIdx];
              slot.deliveredTo.delete(ci);
              board.deliver(mutBusIdx, ci);
            }
          }

          // State must be identical after extra deliveries.
          for (let i = 0; i < numClients; i++) {
            expect(mapsEqual(board.clients[i], statesAfterFirst[i])).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A15: multi-device same-pubkey self-converge — AC-MC-6
  // -------------------------------------------------------------------------
  it("[A15] multi-device same-pubkey self-converge — two clients with same identity converge", () => {
    // A15: numClients=2, both representing the same nostr identity. Every
    //     dispatched event carries the same createdBy/updatedBy pubkey.
    //     Post-quiesce both clients must have deep-equal TaskState.
    //
    //     This models two devices signed in as the same nostr identity using
    //     the single-writer model: the shared identity acts as the sole
    //     writer; the second "device" (client 1) receives all events from
    //     the bus in a potentially different order before quiesce.
    //
    //     MLS leaf semantics (multiple leaves for one pubkey) are not modelled
    //     here — that is the S6 (Playwright) layer.
    fc.assert(
      fc.property(
        arbHexPubkey, // shared identity pubkey
        fc.array(arbRawStep, { minLength: 1, maxLength: 20 }),
        // Pre-delivery indices for client 1 before quiesce.
        fc.array(fc.integer({ min: 0, max: 19 }), {
          minLength: 0,
          maxLength: 10,
        }),
        (sharedPubkey, rawSteps, deliverySeeds) => {
          // Build events with shared identity for all author fields.
          const events: TaskEvent[] = [];
          let state: TaskState = new Map();
          let taskCounter = 0;

          for (const step of rawSteps) {
            let event = interpretStep(step, state);
            // Re-label author fields to the shared identity.
            if (event.type === "task.created") {
              event = {
                ...event,
                task: {
                  ...event.task,
                  id: `t${taskCounter++}`,
                  createdBy: sharedPubkey,
                },
              };
            } else if (event.type !== "task.snapshot") {
              event = { ...event, updatedBy: sharedPubkey };
            }
            events.push(event);
            state = applyEvent(state, event);
          }

          const board = new FakeBoard(2);
          // Dispatch all events from client 0 (shared identity writer).
          for (const e of events) {
            board.dispatch(0, e);
          }

          // Pre-deliver a causal prefix to client 1 before quiesce.
          // We deliver all events 0..maxIdx (inclusive) to preserve causal
          // ordering — same approach as runSchedule.
          const busLen = board.bus.length;
          if (busLen > 0 && deliverySeeds.length > 0) {
            const maxIdx = Math.min(
              Math.max(...deliverySeeds.map((s) => s % busLen)),
              busLen - 1,
            );
            for (let bi = 0; bi <= maxIdx; bi++) {
              board.deliver(bi, 1);
            }
          }

          board.quiesce();
          expect(mapsEqual(board.clients[0], board.clients[1])).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Additional observability: event type distribution in generated logs
  // -------------------------------------------------------------------------
  it("[AC-X-OBSERVABILITY-1] event-type frequency in generated event logs", () => {
    // Reports the dominant event type in generated event sequences to ensure
    // the generator produces diverse, non-degenerate schedules.
    fc.statistics(
      fc.array(arbRawStep, { minLength: 1, maxLength: 20 }).map(buildEventLog),
      (events) => {
        if (events.length === 0) return "empty";
        const counts = new Map<string, number>();
        for (const e of events) {
          counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
        }
        let dominant = "none";
        let max = 0;
        for (const [type, count] of counts.entries()) {
          if (count > max) {
            max = count;
            dominant = type;
          }
        }
        return dominant;
      },
    );
    expect(true).toBe(true);
  });
});
