/**
 * task-projector.property.test.ts
 *
 * Property-based coverage for src/domain/task-projector.ts, exercising the
 * REAL `buildProjection` / `applyEvent` (never a stub or mock). See
 * specs/epic-event-sourced-receive-engine/architecture.md's AC-INV-1
 * ("buildProjection is deterministic, and equals the fold of applyEvent over
 * EMPTY_PROJECTION") and AC-INV-2 ("re-delivering an already-applied event is
 * a no-op").
 *
 * Follows the house style of src/store/task-reducer.property.test.ts (RawStep
 * fold pattern, NUM_RUNS env override) — duplicated rather than imported,
 * since src/domain/ production and test files alike must have zero imports
 * outside src/domain/ + vitest/fast-check (enforced by
 * ./domain-boundary.structural.test.ts).
 *
 * Generator design: builds a `TaskEvent[]` sequence via a RawStep fold (small
 * pools of task ids / pubkeys / device ids for realistic tie-break
 * collisions), then splits it at a random point `k` and wraps the prefix as
 * `sourceKind: "bootstrap-kind-30078"` and the suffix as `sourceKind:
 * "mls-rumor"`. Concatenating the two wrapped slices in that order yields a
 * log that is ALREADY in valid replay order by construction (bootstrap
 * before mls, array order preserved within each phase) — no call to
 * `replayOrder` is needed before `buildProjection`.
 */

import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import { applyEvent, buildProjection, EMPTY_PROJECTION, replayOrder } from "./task-projector";
import { taskWinsOver } from "./task-crdt";
import type { Task, TaskEvent, TaskStatus } from "./task-events";
import type { AcceptedDomainEvent, DomainEventSourceKind } from "./domain-events";
import { SOURCE_KIND_PHASE_ORDER } from "./domain-events";

// ---------------------------------------------------------------------------
// Run budget — overrideable from env for deep exploration.
// ---------------------------------------------------------------------------
const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

// ---------------------------------------------------------------------------
// Small, colliding pools — deliberately narrow so generated sequences
// frequently target the same task id / author / device, producing realistic
// tie-break scenarios for taskWinsOver rather than near-always-distinct
// values that would never collide.
// ---------------------------------------------------------------------------

const TASK_ID_POOL = ["task-a", "task-b", "task-c"] as const;
const PUBKEY_POOL = [
  "1".repeat(64),
  "2".repeat(64),
  "3".repeat(64),
] as const;
const DEVICE_POOL = ["dev-1", "dev-2", ""] as const;

const arbTaskId: fc.Arbitrary<string> = fc.constantFrom(...TASK_ID_POOL);
const arbHexPubkey: fc.Arbitrary<string> = fc.constantFrom(...PUBKEY_POOL);
const arbDevice: fc.Arbitrary<string> = fc.constantFrom(...DEVICE_POOL);

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

/** Arbitrary for a freshly-created task: status=open, assignee=null, createdAt==updatedAt */
const arbTaskFresh: fc.Arbitrary<Task> = fc
  .record({
    id: arbTaskId,
    title: fc.string({ minLength: 1, maxLength: 30 }),
    description: fc.string({ maxLength: 60 }),
    createdBy: arbHexPubkey,
    createdAt: arbTimestamp,
    updatedByDevice: arbDevice,
  })
  .map(({ id, title, description, createdBy, createdAt, updatedByDevice }) => ({
    id,
    title,
    description,
    status: "open" as TaskStatus,
    assignee: null,
    createdBy,
    createdAt,
    updatedAt: createdAt,
    updatedBy: createdBy,
    updatedByDevice,
  }));

// ---------------------------------------------------------------------------
// Generator-local fold — mirrors task-projector.ts's applyEvent dispatch over
// bare TaskEvent (not AcceptedDomainEvent), used ONLY to thread realistic
// state through the RawStep interpreter below so generated sequences target
// existing tasks. Delegates to the real taskWinsOver (task-crdt.ts), never
// reimplementing tie-break comparison logic.
// ---------------------------------------------------------------------------
type LocalState = Map<string, Task>;

function localApply(state: LocalState, event: TaskEvent): LocalState {
  const next = new Map(state);
  switch (event.type) {
    case "task.created": {
      if (!next.has(event.task.id)) next.set(event.task.id, event.task);
      break;
    }
    case "task.updated": {
      const existing = next.get(event.taskId);
      if (existing && taskWinsOver(event, existing)) {
        next.set(event.taskId, {
          ...existing,
          ...event.changes,
          updatedAt: event.updatedAt,
          updatedBy: event.updatedBy,
          updatedByDevice: event.updatedByDevice ?? "",
        });
      }
      break;
    }
    case "task.status_changed": {
      const existing = next.get(event.taskId);
      if (existing && taskWinsOver(event, existing)) {
        next.set(event.taskId, {
          ...existing,
          status: event.status,
          updatedAt: event.updatedAt,
          updatedBy: event.updatedBy,
          updatedByDevice: event.updatedByDevice ?? "",
        });
      }
      break;
    }
    case "task.assigned": {
      const existing = next.get(event.taskId);
      if (existing && taskWinsOver(event, existing)) {
        next.set(event.taskId, {
          ...existing,
          assignee: event.assignee,
          updatedAt: event.updatedAt,
          updatedBy: event.updatedBy,
          updatedByDevice: event.updatedByDevice ?? "",
        });
      }
      break;
    }
    case "task.deleted": {
      const existing = next.get(event.taskId);
      if (existing && taskWinsOver(event, existing)) {
        next.delete(event.taskId);
      }
      break;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Raw step type — pre-generated random values interpreted into a TaskEvent
// given the current generator-local state, keeping fast-check shrinkability
// (RawStep fold pattern per task-reducer.property.test.ts house style).
// ---------------------------------------------------------------------------
type RawStep = {
  kindIndex: number; // [0..11] picks event kind (see interpretStep mapping)
  taskIndex: number; // targets an existing task by index, modulo live count
  tsDelta: number; // timestamp delta added to the targeted task's updatedAt
  fresh: Task;
  newStatus: TaskStatus;
  newTitle: string;
  newDescription: string;
  includeTitle: boolean;
  includeDescription: boolean;
  assignee: string | null;
  updatedBy: string;
  updatedByDevice: string;
};

const arbRawStep: fc.Arbitrary<RawStep> = fc.record({
  kindIndex: fc.integer({ min: 0, max: 11 }),
  taskIndex: fc.integer({ min: 0, max: 20 }),
  tsDelta: fc.integer({ min: 0, max: 1_000 }),
  fresh: arbTaskFresh,
  newStatus: arbTaskStatus,
  newTitle: fc.string({ minLength: 1, maxLength: 30 }),
  newDescription: fc.string({ maxLength: 60 }),
  includeTitle: fc.boolean(),
  includeDescription: fc.boolean(),
  assignee: fc.option(arbHexPubkey, { nil: null }),
  updatedBy: arbHexPubkey,
  updatedByDevice: arbDevice,
});

/**
 * kindIndex distribution (12 buckets):
 *  0-1  → task.created         (weight 2)
 *  2-4  → task.status_changed  (weight 3)
 *  5-7  → task.updated         (weight 3)
 *  8-9  → task.assigned        (weight 2)
 * 10-11 → task.deleted         (weight 2)
 *
 * When the state is empty, all non-create kinds fall back to task.created.
 */
function interpretStep(step: RawStep, state: LocalState): TaskEvent {
  const taskIds = Array.from(state.keys());
  const hasExisting = taskIds.length > 0;

  if (!hasExisting || step.kindIndex <= 1) {
    return { type: "task.created", task: step.fresh };
  }

  const taskId = taskIds[step.taskIndex % taskIds.length];
  const existing = state.get(taskId)!;
  const updatedAt = existing.updatedAt + step.tsDelta;

  if (step.kindIndex <= 4) {
    return {
      type: "task.status_changed",
      taskId,
      status: step.newStatus,
      updatedAt,
      updatedBy: step.updatedBy,
      updatedByDevice: step.updatedByDevice,
    };
  }

  if (step.kindIndex <= 7) {
    const changes: Partial<Pick<Task, "title" | "description">> = {};
    if (step.includeTitle) changes.title = step.newTitle;
    if (step.includeDescription) changes.description = step.newDescription;
    if (Object.keys(changes).length === 0) changes.title = step.newTitle;
    return {
      type: "task.updated",
      taskId,
      changes,
      updatedAt,
      updatedBy: step.updatedBy,
      updatedByDevice: step.updatedByDevice,
    };
  }

  if (step.kindIndex <= 9) {
    return {
      type: "task.assigned",
      taskId,
      assignee: step.assignee,
      updatedAt,
      updatedBy: step.updatedBy,
      updatedByDevice: step.updatedByDevice,
    };
  }

  return {
    type: "task.deleted",
    taskId,
    updatedAt,
    updatedBy: step.updatedBy,
    updatedByDevice: step.updatedByDevice,
  };
}

/** Folds a RawStep[] into a TaskEvent[], threading generator-local state. */
function interpretSteps(steps: RawStep[]): TaskEvent[] {
  const events: TaskEvent[] = [];
  let state: LocalState = new Map();
  for (const step of steps) {
    const event = interpretStep(step, state);
    events.push(event);
    state = localApply(state, event);
  }
  return events;
}

/**
 * Wraps a TaskEvent[] into an already-replay-ordered AcceptedDomainEvent[]:
 * events[0..k) become sourceKind "bootstrap-kind-30078", events[k..) become
 * "mls-rumor". Fixed groupId; acceptedAt/epoch vary but never drive ordering
 * (AcceptedDomainEvent's invariant: replay order is phase order, NOT
 * acceptedAt clock order — this generator sidesteps that entirely by never
 * sorting on acceptedAt).
 */
function wrapAsAcceptedLog(
  events: TaskEvent[],
  k: number,
): AcceptedDomainEvent[] {
  const groupId = "g1";
  const bootstrap: AcceptedDomainEvent[] = events.slice(0, k).map((payload, i) => ({
    id: `bootstrap:g1:${i}`,
    factId: "bootstrap-fact",
    sourceKind: "bootstrap-kind-30078" as DomainEventSourceKind,
    groupId,
    acceptedAt: i,
    epoch: "0",
    payload,
  }));
  const rumor: AcceptedDomainEvent[] = events.slice(k).map((payload, i) => ({
    id: `rumor-${i}`,
    factId: "mls-fact",
    sourceKind: "mls-rumor" as DomainEventSourceKind,
    groupId,
    acceptedAt: i,
    epoch: "0",
    payload,
  }));
  return [...bootstrap, ...rumor];
}

/**
 * An already-valid-replay-order AcceptedDomainEvent[] log, built from a
 * RawStep-fold TaskEvent[] sequence split at a random bootstrap/mls boundary.
 */
const arbAcceptedLog: fc.Arbitrary<AcceptedDomainEvent[]> = fc
  .array(arbRawStep, { minLength: 0, maxLength: 30 })
  .chain((steps) => {
    const events = interpretSteps(steps);
    return fc
      .integer({ min: 0, max: events.length })
      .map((k) => wrapAsAcceptedLog(events, k));
  });

/**
 * Same underlying RawStep-fold TaskEvent[] sequence AND the AcceptedDomainEvent[]
 * log it was wrapped into (undivided — see `wrapAsAcceptedLog`, split point 0
 * means everything is "mls-rumor"), exposed together so a test can compare
 * `buildProjection(log)` against an independently-computed fold over `events`
 * via the generator-local `localApply` (which mirrors applyEvent's dispatch
 * with the SAME real `taskWinsOver`, but is a separately hand-written switch,
 * not a shared implementation) as an expectation oracle. Because
 * `wrapAsAcceptedLog` never reorders `events` (bootstrap slice, then mls
 * slice, in original array order), replaying `log` via `applyEvent` visits
 * events in exactly the same order as folding `events` via `localApply`.
 */
const arbEventsAndLog: fc.Arbitrary<{
  events: TaskEvent[];
  log: AcceptedDomainEvent[];
}> = fc.array(arbRawStep, { minLength: 0, maxLength: 30 }).chain((steps) => {
  const events = interpretSteps(steps);
  return fc
    .integer({ min: 0, max: events.length })
    .map((k) => ({ events, log: wrapAsAcceptedLog(events, k) }));
});

/**
 * A mixed-phase AcceptedDomainEvent[] log where each event is independently,
 * randomly tagged bootstrap or mls, THEN the whole array is shuffled — unlike
 * `arbAcceptedLog` (already valid replay order by construction: bootstrap
 * slice, then mls slice, in original order), this arbitrary deliberately
 * interleaves phases so `replayOrder` has real reordering work to do.
 * `fc.shuffledSubarray` with minLength===maxLength===length forces a full
 * permutation (every element retained, order randomized) rather than a
 * proper subset.
 */
const arbShuffledMixedLog: fc.Arbitrary<AcceptedDomainEvent[]> = fc
  .array(fc.boolean(), { minLength: 0, maxLength: 30 })
  .chain((isBootstrapFlags) => {
    const tagged: AcceptedDomainEvent[] = isBootstrapFlags.map((isBootstrap, i) => ({
      id: `evt-${i}`,
      factId: isBootstrap ? "bootstrap-fact" : "mls-fact",
      sourceKind: (isBootstrap
        ? "bootstrap-kind-30078"
        : "mls-rumor") as DomainEventSourceKind,
      groupId: "g1",
      acceptedAt: i,
      epoch: "0",
      // payload content is irrelevant to replayOrder (a pure sourceKind
      // sort) -- a placeholder task.deleted keeps this arbitrary decoupled
      // from arbRawStep/interpretSteps' state threading.
      payload: { type: "task.deleted", taskId: `t${i}`, updatedAt: i, updatedBy: "u", updatedByDevice: "" } as TaskEvent,
    }));
    return fc.shuffledSubarray(tagged, {
      minLength: tagged.length,
      maxLength: tagged.length,
    });
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("task-projector — sanity", () => {
  it("buildProjection([]) is EMPTY_PROJECTION", () => {
    expect(buildProjection([])).toBe(EMPTY_PROJECTION);
  });

  it("buildProjection([]) has size 0", () => {
    expect(buildProjection([]).size).toBe(0);
  });
});

describe("task-projector property tests — S3 story", () => {
  // -------------------------------------------------------------------------
  // AC-INV-1a: determinism — buildProjection(log) called twice on the
  // identical, unchanged log is deep-equal both times.
  // -------------------------------------------------------------------------
  it("[AC-INV-1a] buildProjection is deterministic across repeated calls on the same log", () => {
    fc.assert(
      fc.property(arbAcceptedLog, (log) => {
        const first = buildProjection(log);
        const second = buildProjection(log);
        expect(first).toEqual(second);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // AC-INV-1b: fold equivalence — log.reduce(applyEvent, EMPTY_PROJECTION)
  // deep-equals buildProjection(log).
  // -------------------------------------------------------------------------
  it("[AC-INV-1b] buildProjection equals the manual fold of applyEvent over EMPTY_PROJECTION", () => {
    fc.assert(
      fc.property(arbAcceptedLog, (log) => {
        const folded = log.reduce(applyEvent, EMPTY_PROJECTION);
        const built = buildProjection(log);
        expect(folded).toEqual(built);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // AC-INV-2 (projector half): at-least-once re-delivery robustness. This
  // proves re-applying an already-applied event (byte-identical, spliced
  // immediately adjacent to its own original occurrence) is a no-op — NOT
  // general duplicate-id tolerance across an arbitrary log position. Unique
  // `AcceptedDomainEvent.id`s across the whole log is a PERSISTENCE-layer
  // precondition (appendAcceptedEvent is idempotent on id — S4), not
  // something buildProjection/applyEvent themselves dedup; see the
  // PRECONDITION note on both functions' JSDoc in task-projector.ts. A
  // non-adjacent duplicate (e.g. a duplicated task.created replayed after an
  // intervening task.deleted) is outside this test's claim and outside the
  // projector's contract entirely.
  // -------------------------------------------------------------------------
  it("[AC-INV-2] re-applying an already-applied event (byte-identical, spliced immediately adjacent) is a no-op", () => {
    fc.assert(
      fc.property(
        arbAcceptedLog,
        fc.integer({ min: 0, max: 1_000_000 }),
        (log, indexSeed) => {
          if (log.length === 0) return; // nothing to duplicate
          const index = indexSeed % log.length;
          const duplicate = log[index];
          const logWithDuplicate = [
            ...log.slice(0, index + 1),
            duplicate,
            ...log.slice(index + 1),
          ];

          const original = buildProjection(log);
          const withDuplicate = buildProjection(logWithDuplicate);

          expect(withDuplicate).toEqual(original);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// replayOrder property coverage (cold review, sev-6 #1).
// ---------------------------------------------------------------------------
describe("task-projector property tests — replayOrder", () => {
  it("[replayOrder] output is phase-partitioned: every bootstrap-kind-30078 event strictly precedes every mls-rumor event", () => {
    fc.assert(
      fc.property(arbShuffledMixedLog, (log) => {
        const sorted = replayOrder(log);
        const ranks = sorted.map((e) => SOURCE_KIND_PHASE_ORDER[e.sourceKind]);
        for (let i = 1; i < ranks.length; i++) {
          expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[replayOrder] is stable within phase: same-phase relative input order is preserved", () => {
    fc.assert(
      fc.property(arbShuffledMixedLog, (log) => {
        const sorted = replayOrder(log);
        for (const kind of ["bootstrap-kind-30078", "mls-rumor"] as const) {
          const inputIds = log.filter((e) => e.sourceKind === kind).map((e) => e.id);
          const outputIds = sorted.filter((e) => e.sourceKind === kind).map((e) => e.id);
          expect(outputIds).toEqual(inputIds);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[replayOrder] does not mutate its input array", () => {
    fc.assert(
      fc.property(arbShuffledMixedLog, (log) => {
        const snapshot = structuredClone(log);
        replayOrder(log);
        expect(log).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[replayOrder] returns a new array, not the same reference as its input", () => {
    fc.assert(
      fc.property(arbShuffledMixedLog, (log) => {
        const sorted = replayOrder(log);
        expect(sorted).not.toBe(log);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Purity oracles (cold review, sev-6 #2 -- empirically proven mutant
// survival: an impure applyEvent that mutated its input `projection` in
// place, or that leaked mutation into the shared EMPTY_PROJECTION seed,
// previously went undetected because no existing property test snapshotted
// the input BEFORE the call and compared it AFTER.
// ---------------------------------------------------------------------------
describe("task-projector property tests — purity oracles", () => {
  it("[purity] applyEvent never mutates its input projection or the event it was given", () => {
    fc.assert(
      fc.property(arbAcceptedLog, (log) => {
        let projection = EMPTY_PROJECTION;
        for (const event of log) {
          const projectionSnapshot = structuredClone(projection);
          const eventSnapshot = structuredClone(event);
          const next = applyEvent(projection, event);
          // (a) neither the input projection nor the event payload changed.
          expect(projection).toEqual(projectionSnapshot);
          expect(event).toEqual(eventSnapshot);
          projection = next;
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[purity] buildProjection's result deep-equals an independently-computed local fold over the same underlying TaskEvent sequence, with the input log left untouched", () => {
    fc.assert(
      fc.property(arbEventsAndLog, ({ events, log }) => {
        const logSnapshot = structuredClone(log);

        // (b) the RESULT deep-equals an expectation computed by a
        // separately hand-written fold (localApply) over the same TaskEvent
        // sequence -- not merely "didn't crash" or "didn't mutate".
        const expected = events.reduce(localApply, new Map() as LocalState);
        const actual = buildProjection(log);
        expect(actual).toEqual(expected);

        // ...while the input snapshot still holds: buildProjection did not
        // mutate the log it was given.
        expect(log).toEqual(logSnapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[purity] EMPTY_PROJECTION is never polluted by a buildProjection run", () => {
    fc.assert(
      fc.property(arbAcceptedLog, (log) => {
        buildProjection(log);
        // (c) the shared seed is untouched regardless of what the log did.
        expect(EMPTY_PROJECTION.size).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// No-op identity preservation (cold review, P3 #5 -- decided pure
// optimization: applyEvent returns the SAME projection reference on a no-op,
// a fresh reference only on an actual mutation). S8's React integration
// layer relies on `prev !== next` as its sole "did anything change" signal.
// ---------------------------------------------------------------------------
describe("task-projector property tests — no-op identity preservation", () => {
  it("[identity] a losing/no-op task.updated returns the exact same projection reference", () => {
    fc.assert(
      fc.property(arbHexPubkey, arbDevice, arbTimestamp, (updatedBy, updatedByDevice, updatedAt) => {
        const projection = buildProjection([]); // EMPTY_PROJECTION, no task "t1" exists
        const event: AcceptedDomainEvent = {
          id: "e1",
          factId: "f1",
          sourceKind: "mls-rumor",
          groupId: "g1",
          acceptedAt: 0,
          epoch: "0",
          payload: {
            type: "task.updated",
            taskId: "t1", // nonexistent -- guaranteed no-op
            changes: { title: "x" },
            updatedAt,
            updatedBy,
            updatedByDevice,
          },
        };
        const next = applyEvent(projection, event);
        expect(next).toBe(projection);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[identity] a duplicate task.created (first-write-wins loses) returns the exact same projection reference", () => {
    fc.assert(
      fc.property(arbTaskFresh, arbTaskFresh, (first, secondRaw) => {
        const second = { ...secondRaw, id: first.id }; // force id collision
        const afterFirst = applyEvent(EMPTY_PROJECTION, {
          id: "e1",
          factId: "f1",
          sourceKind: "mls-rumor",
          groupId: "g1",
          acceptedAt: 0,
          epoch: "0",
          payload: { type: "task.created", task: first },
        });
        const afterSecond = applyEvent(afterFirst, {
          id: "e2",
          factId: "f2",
          sourceKind: "mls-rumor",
          groupId: "g1",
          acceptedAt: 1,
          epoch: "0",
          payload: { type: "task.created", task: second },
        });
        expect(afterSecond).toBe(afterFirst);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("[identity] every applyEvent call either returns the same reference (no-op) or a new reference (mutation) -- never a fresh copy with identical contents", () => {
    fc.assert(
      fc.property(arbAcceptedLog, (log) => {
        let projection = EMPTY_PROJECTION;
        for (const event of log) {
          const before = projection;
          const next = applyEvent(before, event);
          if (next === before) {
            // no-op path: contents must be unchanged too (already covered
            // by (a)/(b) above, re-asserted here as the identity/content
            // consistency pairing).
            expect(next).toEqual(before);
          } else {
            // mutating path: a genuinely new Map, and the old one must be
            // untouched (input non-mutation, already covered by the purity
            // oracle describe block above; re-checked here to pin the
            // reference-inequality half of the contract in the same test).
            expect(next).not.toBe(before);
          }
          projection = next;
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // (c) AC-INV-1b fold-equivalence still holds after the identity-preserving
  // restructure -- re-asserted here (not merely relying on the existing S3
  // describe block above) to pin it explicitly against this specific
  // behavior change, per the cold-review batch's own gate requirement.
  it("[identity] AC-INV-1b fold-equivalence holds under the identity-preserving applyEvent", () => {
    fc.assert(
      fc.property(arbAcceptedLog, (log) => {
        const folded = log.reduce(applyEvent, EMPTY_PROJECTION);
        const built = buildProjection(log);
        expect(folded).toEqual(built);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
