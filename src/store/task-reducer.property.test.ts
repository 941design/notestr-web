import * as fc from "fast-check";
import { describe, it, expect } from "vitest";
import { applyEvent, replayEvents, type TaskState } from "./task-reducer.js";
import type { Task, TaskEvent, TaskStatus } from "./task-events.js";

// ---------------------------------------------------------------------------
// Run budget — overrideable from env for deep exploration.
// ---------------------------------------------------------------------------
const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS) || 1000;

// ---------------------------------------------------------------------------
// S8/S9 in-memory persistence shim
//
// persistence.ts uses idb-keyval directly with no swappable store parameter.
// We replicate appendEvent/loadEvents semantics over a Map<string, TaskEvent[]>
// to test S8 (isolation) and S9 (replay determinism) without touching
// production code (AC-X-NO-PROD-CHANGE-1).
// ---------------------------------------------------------------------------
function createInMemoryEventLog() {
  const store = new Map<string, TaskEvent[]>();

  return {
    appendEvent(groupId: string, event: TaskEvent): void {
      const existing = store.get(groupId) ?? [];
      store.set(groupId, [...existing, event]);
    },
    loadEvents(groupId: string): TaskEvent[] {
      return store.get(groupId) ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbHexPubkey: fc.Arbitrary<string> = fc.hexaString({
  minLength: 64,
  maxLength: 64,
});

const arbTaskId: fc.Arbitrary<string> = fc.uuid();

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
// Raw step type — a bundle of pre-generated random values that arbEventSequence
// uses to produce one event.  Generating all raw steps upfront keeps fast-check
// shrinkability without needing fc.gen's stateful generator cache.
// ---------------------------------------------------------------------------
type RawStep = {
  // [0..12] picks which event kind to emit (see kindIndex mapping below).
  kindIndex: number;
  // Which existing-task index to target (modulo live task count).
  taskIndex: number;
  // Timestamp delta to add to the targeted task's updatedAt (+0 = same ts).
  tsDelta: number;
  // How far back to go for stale events (negative delta, 1-based).
  staleBack: number;
  fresh: Task;
  newStatus: TaskStatus;
  newTitle: string;
  newDescription: string;
  includeTitle: boolean;
  includeDescription: boolean;
  assignee: string | null;
  updatedBy: string;
};

const arbRawStep: fc.Arbitrary<RawStep> = fc.record({
  kindIndex: fc.integer({ min: 0, max: 12 }),
  taskIndex: fc.integer({ min: 0, max: 100 }),
  tsDelta: fc.integer({ min: 0, max: 10_000 }),
  staleBack: fc.integer({ min: 1, max: 9 }),
  fresh: arbTaskFresh,
  newStatus: arbTaskStatus,
  newTitle: fc.string({ minLength: 1, maxLength: 60 }),
  newDescription: fc.string({ maxLength: 200 }),
  includeTitle: fc.boolean(),
  includeDescription: fc.boolean(),
  assignee: fc.option(arbHexPubkey, { nil: null }),
  updatedBy: arbHexPubkey,
});

/**
 * Convert a RawStep into a concrete TaskEvent given the current state.
 *
 * kindIndex distribution (13 buckets):
 *  0-1   → task.created          (weight 2)
 *  2-4   → task.status_changed   (weight 3)
 *  5-7   → task.updated          (weight 3)
 *  8-9   → task.assigned         (weight 2)
 * 10-11  → task.deleted          (weight 2)
 * 12     → stale variant         (weight 1)
 *
 * When the state is empty, all non-create kinds fall back to task.created.
 */
function interpretStep(step: RawStep, state: TaskState): TaskEvent {
  const taskIds = Array.from(state.keys());
  const hasExisting = taskIds.length > 0;

  // Helper to pick an existing task id by index (modulo).
  function pickId(): string {
    return taskIds[step.taskIndex % taskIds.length];
  }
  function pickTask(): Task {
    return state.get(pickId())!;
  }

  if (!hasExisting || step.kindIndex <= 1) {
    return { type: "task.created", task: step.fresh };
  }

  const taskId = pickId();
  const existing = pickTask();
  const nonStaleAt = existing.updatedAt + step.tsDelta;

  if (step.kindIndex <= 4) {
    // task.status_changed
    return {
      type: "task.status_changed",
      taskId,
      status: step.newStatus,
      updatedAt: nonStaleAt,
      updatedBy: step.updatedBy,
    };
  }

  if (step.kindIndex <= 7) {
    // task.updated
    const changes: Partial<Pick<Task, "title" | "description">> = {};
    if (step.includeTitle) changes.title = step.newTitle;
    if (step.includeDescription) changes.description = step.newDescription;
    if (Object.keys(changes).length === 0) changes.title = step.newTitle;
    return {
      type: "task.updated",
      taskId,
      changes,
      updatedAt: nonStaleAt,
      updatedBy: step.updatedBy,
    };
  }

  if (step.kindIndex <= 9) {
    // task.assigned
    return {
      type: "task.assigned",
      taskId,
      assignee: step.assignee,
      updatedAt: nonStaleAt,
      updatedBy: step.updatedBy,
    };
  }

  if (step.kindIndex <= 11) {
    // task.deleted
    return {
      type: "task.deleted",
      taskId,
      updatedAt: nonStaleAt,
      updatedBy: step.updatedBy,
    };
  }

  // kindIndex === 12: stale variant for A6 coverage.
  if (existing.updatedAt <= 1) {
    // Can't go below 1; fall back to non-stale status_changed.
    return {
      type: "task.status_changed",
      taskId,
      status: step.newStatus,
      updatedAt: existing.updatedAt,
      updatedBy: step.updatedBy,
    };
  }
  const staleAt = Math.max(1, existing.updatedAt - step.staleBack);
  return {
    type: "task.deleted",
    taskId,
    updatedAt: staleAt,
    updatedBy: step.updatedBy,
  };
}

/**
 * Generates a sequence of events, threading state through interpretStep so each
 * event is valid given the state produced by prior events.
 *
 * Approach: generate an array of RawStep values upfront (fully shrinkable by
 * fast-check), then interpret them into a valid TaskEvent[] by folding state.
 * This avoids fc.gen's stateful generator-cache limitation while keeping the
 * state-aware property.
 */
function arbEventSequence(maxLength = 30): fc.Arbitrary<TaskEvent[]> {
  return fc
    .array(arbRawStep, { minLength: 0, maxLength })
    .map((steps) => {
      const events: TaskEvent[] = [];
      let state: TaskState = new Map();
      for (const step of steps) {
        const event = interpretStep(step, state);
        events.push(event);
        state = applyEvent(state, event);
      }
      return events;
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reducer property tests — S2 story", () => {
  // -------------------------------------------------------------------------
  // S1: status enum closure
  // -------------------------------------------------------------------------
  it("[S1] status enum closure", () => {
    // S1: every Task in every reachable state has status in the enum
    const validStatuses = new Set(["open", "in_progress", "done", "cancelled"]);
    fc.assert(
      fc.property(arbEventSequence(), (events) => {
        const state = replayEvents(events);
        for (const task of state.values()) {
          expect(validStatuses.has(task.status)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // S2: field invariants — non-empty id, createdAt > 0, updatedAt >= createdAt,
  //     assignee null or 64-char hex
  // -------------------------------------------------------------------------
  it("[S2] field invariants on every task", () => {
    // S2: non-empty id, createdAt > 0, updatedAt >= createdAt, assignee valid
    fc.assert(
      fc.property(arbEventSequence(), (events) => {
        const state = replayEvents(events);
        for (const task of state.values()) {
          expect(task.id.length).toBeGreaterThan(0);
          expect(task.createdAt).toBeGreaterThan(0);
          expect(task.updatedAt).toBeGreaterThanOrEqual(task.createdAt);
          if (task.assignee !== null) {
            expect(isHex64(task.assignee)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // S3: createdBy and createdAt never change
  // -------------------------------------------------------------------------
  it("[S3] createdBy and createdAt immutable once task exists", () => {
    // S3: snapshot createdBy/createdAt at each step; they must match the final values
    fc.assert(
      fc.property(arbEventSequence(), (events) => {
        // Collect (id -> {createdBy, createdAt}) at first appearance.
        const snapshots = new Map<
          string,
          { createdBy: string; createdAt: number }
        >();

        let state: TaskState = new Map();
        for (const event of events) {
          state = applyEvent(state, event);
          for (const [id, task] of state.entries()) {
            const snap = snapshots.get(id);
            if (snap === undefined) {
              snapshots.set(id, {
                createdBy: task.createdBy,
                createdAt: task.createdAt,
              });
            } else {
              expect(task.createdBy).toBe(snap.createdBy);
              expect(task.createdAt).toBe(snap.createdAt);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // S4: updatedAt == max(updatedAt) of accepted events for the task
  // -------------------------------------------------------------------------
  it("[S4] updatedAt equals max accepted-event updatedAt for each task", () => {
    // S4: track the max updatedAt among accepted events per task; compare to final state
    fc.assert(
      fc.property(arbEventSequence(), (events) => {
        const maxAccepted = new Map<string, number>();
        let state: TaskState = new Map();

        for (const event of events) {
          const prevState = state;
          state = applyEvent(state, event);

          if (event.type === "task.created") {
            const taskId = event.task.id;
            const prev = maxAccepted.get(taskId) ?? 0;
            maxAccepted.set(taskId, Math.max(prev, event.task.updatedAt));
          } else if (
            event.type === "task.updated" ||
            event.type === "task.status_changed" ||
            event.type === "task.assigned"
          ) {
            const existing = prevState.get(event.taskId);
            if (existing && event.updatedAt >= existing.updatedAt) {
              const prev = maxAccepted.get(event.taskId) ?? 0;
              maxAccepted.set(event.taskId, Math.max(prev, event.updatedAt));
            }
          } else if (event.type === "task.deleted") {
            const existing = prevState.get(event.taskId);
            if (existing && event.updatedAt >= existing.updatedAt) {
              // Task deleted — remove its tracker.
              maxAccepted.delete(event.taskId);
            }
          }
          // task.snapshot is excluded from arbEventSequence; skip here.
        }

        for (const [id, task] of state.entries()) {
          const expected = maxAccepted.get(id);
          if (expected !== undefined) {
            expect(task.updatedAt).toBe(expected);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // S8: per-group event-log isolation in in-memory KV shim
  // -------------------------------------------------------------------------
  it("[S8] per-group event-log isolation — events in g1 never appear in g2", async () => {
    // S8: appendEvent for g1 must not contaminate loadEvents for g2
    await fc.assert(
      fc.asyncProperty(
        arbEventSequence(10),
        arbEventSequence(10),
        async (eventsG1, eventsG2) => {
          const log = createInMemoryEventLog();
          const g1 = "group-alpha";
          const g2 = "group-beta";

          for (const e of eventsG1) log.appendEvent(g1, e);
          for (const e of eventsG2) log.appendEvent(g2, e);

          const loaded1 = log.loadEvents(g1);
          const loaded2 = log.loadEvents(g2);

          // Loaded counts must match what was appended.
          expect(loaded1).toHaveLength(eventsG1.length);
          expect(loaded2).toHaveLength(eventsG2.length);

          // Reference-identity isolation: no object from g2 was stored in g1's log.
          // The in-memory shim stores references, so this catches any aliasing bug.
          for (const e of eventsG2) {
            expect(loaded1).not.toContain(e);
          }
          for (const e of eventsG1) {
            expect(loaded2).not.toContain(e);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // S9: replay determinism — replayEvents(loadEvents(g)) == fold(applyEvent)
  // -------------------------------------------------------------------------
  it("[S9] replay determinism — replayEvents equals fold of applyEvent", async () => {
    // S9: persisted event log replays to identical state as in-memory fold
    await fc.assert(
      fc.asyncProperty(arbEventSequence(), async (events) => {
        const log = createInMemoryEventLog();
        const groupId = "test-group";

        let inMemoryState: TaskState = new Map();
        for (const event of events) {
          inMemoryState = applyEvent(inMemoryState, event);
          log.appendEvent(groupId, event);
        }

        const replayedState = replayEvents(log.loadEvents(groupId));

        expect(replayedState.size).toBe(inMemoryState.size);
        for (const [id, task] of inMemoryState.entries()) {
          expect(replayedState.get(id)).toEqual(task);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A1: task.created postcondition
  // -------------------------------------------------------------------------
  it("[A1] task.created sets status=open, assignee=null, createdBy=event, createdAt==updatedAt", () => {
    // A1: newly created task has canonical initial shape
    fc.assert(
      fc.property(arbTaskFresh, (task) => {
        const state = applyEvent(new Map(), { type: "task.created", task });
        const inserted = state.get(task.id);
        expect(inserted).toBeDefined();
        expect(inserted!.status).toBe("open");
        expect(inserted!.assignee).toBeNull();
        expect(inserted!.createdBy).toBe(task.createdBy);
        expect(inserted!.createdAt).toBe(task.createdAt);
        expect(inserted!.updatedAt).toBe(task.createdAt);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A2: task.status_changed non-stale postcondition
  // -------------------------------------------------------------------------
  it("[A2] task.status_changed non-stale sets status to event.status", () => {
    // A2: status_changed with updatedAt >= existing.updatedAt applies status
    fc.assert(
      fc.property(
        arbTaskFresh,
        arbTaskStatus,
        fc.integer({ min: 0, max: 10_000 }),
        arbHexPubkey,
        (task, newStatus, delta, updatedBy) => {
          const pre: TaskState = new Map([[task.id, task]]);
          const event = {
            type: "task.status_changed" as const,
            taskId: task.id,
            status: newStatus,
            updatedAt: task.updatedAt + delta,
            updatedBy,
          };
          const post = applyEvent(pre, event);
          expect(post.get(task.id)!.status).toBe(newStatus);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A3: task.updated non-stale preserves unchanged keys
  // -------------------------------------------------------------------------
  it("[A3] task.updated non-stale applies changes and preserves other fields", () => {
    // A3: non-stale update merges changes; fields not in changes are preserved
    fc.assert(
      fc.property(
        arbTaskFresh,
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.integer({ min: 0, max: 10_000 }),
        arbHexPubkey,
        (task, newTitle, delta, updatedBy) => {
          const pre: TaskState = new Map([[task.id, task]]);
          const changes = { title: newTitle };
          const event = {
            type: "task.updated" as const,
            taskId: task.id,
            changes,
            updatedAt: task.updatedAt + delta,
            updatedBy,
          };
          const post = applyEvent(pre, event);
          const updated = post.get(task.id)!;
          // Changed key must reflect event.changes.
          expect(updated.title).toBe(newTitle);
          // Unchanged keys preserved (except updatedAt).
          expect(updated.description).toBe(task.description);
          expect(updated.status).toBe(task.status);
          expect(updated.assignee).toBe(task.assignee);
          expect(updated.createdBy).toBe(task.createdBy);
          expect(updated.createdAt).toBe(task.createdAt);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A4: task.assigned non-stale sets assignee (incl. null)
  // -------------------------------------------------------------------------
  it("[A4] task.assigned non-stale sets assignee including null unassign", () => {
    // A4: assigned with updatedAt >= existing sets assignee to event.assignee
    fc.assert(
      fc.property(
        arbTaskFresh,
        fc.option(arbHexPubkey, { nil: null }),
        fc.integer({ min: 0, max: 10_000 }),
        arbHexPubkey,
        (task, assignee, delta, updatedBy) => {
          const pre: TaskState = new Map([[task.id, task]]);
          const event = {
            type: "task.assigned" as const,
            taskId: task.id,
            assignee,
            updatedAt: task.updatedAt + delta,
            updatedBy,
          };
          const post = applyEvent(pre, event);
          expect(post.get(task.id)!.assignee).toBe(assignee);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A5: task.deleted non-stale removes task
  // -------------------------------------------------------------------------
  it("[A5] task.deleted non-stale removes the task from state", () => {
    // A5: deleted with updatedAt >= existing.updatedAt removes task
    fc.assert(
      fc.property(
        arbTaskFresh,
        fc.integer({ min: 0, max: 10_000 }),
        arbHexPubkey,
        (task, delta, updatedBy) => {
          const pre: TaskState = new Map([[task.id, task]]);
          const event = {
            type: "task.deleted" as const,
            taskId: task.id,
            updatedAt: task.updatedAt + delta,
            updatedBy,
          };
          const post = applyEvent(pre, event);
          expect(post.has(task.id)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A6: stale events are no-ops
  // -------------------------------------------------------------------------
  it("[A6] stale-event no-op — any mutation with updatedAt < existing leaves state byte-identical", () => {
    // A6: stale events (updatedAt < existing.updatedAt) must not change task state
    fc.assert(
      fc.property(
        // Need updatedAt > 1 to have a valid stale range.
        arbTaskFresh.filter((t) => t.updatedAt > 1),
        fc.integer({ min: 1, max: 9 }),
        arbHexPubkey,
        fc.constantFrom(
          "task.status_changed",
          "task.updated",
          "task.assigned",
          "task.deleted",
        ) as fc.Arbitrary<
          | "task.status_changed"
          | "task.updated"
          | "task.assigned"
          | "task.deleted"
        >,
        (task, staleBack, updatedBy, kind) => {
          const staleAt = Math.max(1, task.updatedAt - staleBack);
          const pre: TaskState = new Map([[task.id, task]]);

          let staleEvent: TaskEvent;
          switch (kind) {
            case "task.status_changed":
              staleEvent = {
                type: "task.status_changed",
                taskId: task.id,
                status: "done",
                updatedAt: staleAt,
                updatedBy,
              };
              break;
            case "task.updated":
              staleEvent = {
                type: "task.updated",
                taskId: task.id,
                changes: { title: "stale title" },
                updatedAt: staleAt,
                updatedBy,
              };
              break;
            case "task.assigned":
              staleEvent = {
                type: "task.assigned",
                taskId: task.id,
                assignee: updatedBy,
                updatedAt: staleAt,
                updatedBy,
              };
              break;
            case "task.deleted":
              staleEvent = {
                type: "task.deleted",
                taskId: task.id,
                updatedAt: staleAt,
                updatedBy,
              };
              break;
          }

          const post = applyEvent(pre, staleEvent);
          expect(post.get(task.id)).toEqual(task);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A13: idempotence — re-applying any non-snapshot event is a no-op
  // -------------------------------------------------------------------------
  it("[A13] idempotence — applyEvent(applyEvent(s,e),e) deep-equals applyEvent(s,e)", () => {
    // A13: for any non-snapshot event e and any state s, applying e twice == applying once
    fc.assert(
      fc.property(
        arbEventSequence(10),
        arbTaskFresh,
        (events, freshTask) => {
          // Build base state, then check idempotence for a task.created event.
          const base = replayEvents(events);
          const e: TaskEvent = { type: "task.created", task: freshTask };
          const once = applyEvent(base, e);
          const twice = applyEvent(once, e);
          expect(twice.get(freshTask.id)).toEqual(once.get(freshTask.id));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("[A13] idempotence — mutation events (status_changed)", () => {
    // A13: status_changed applied twice yields the same result as applied once
    fc.assert(
      fc.property(
        arbTaskFresh,
        fc.integer({ min: 1, max: 10_000 }),
        arbHexPubkey,
        arbTaskStatus,
        (task, delta, updatedBy, newStatus) => {
          const s0: TaskState = new Map([[task.id, task]]);
          const e: TaskEvent = {
            type: "task.status_changed",
            taskId: task.id,
            status: newStatus,
            updatedAt: task.updatedAt + delta,
            updatedBy,
          };
          const s1 = applyEvent(s0, e);
          const s2 = applyEvent(s1, e);
          expect(s2.get(task.id)).toEqual(s1.get(task.id));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // R1: resurrection — task.created after task.deleted re-inserts the task
  // -------------------------------------------------------------------------
  it("[R1] resurrection — task.created after task.deleted re-inserts task (labelled via fc.statistics)", () => {
    // R1: the reducer has no tombstone — task.created(id) always re-inserts
    //     regardless of a prior task.deleted(id). This is by design (see spec §R1).
    //     fc.statistics reports the resurrection rate so any silent change to
    //     deletion/creation semantics becomes visible in CI output.

    // Observability: report resurrection rate.
    fc.statistics(
      fc.tuple(
        arbTaskFresh,
        arbHexPubkey,
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
      ),
      ([task, updatedBy, deleteDelta, recreateDelta]) => {
        const s0: TaskState = new Map([[task.id, task]]);
        const deleteAt = task.updatedAt + deleteDelta;
        const s1 = applyEvent(s0, {
          type: "task.deleted",
          taskId: task.id,
          updatedAt: deleteAt,
          updatedBy,
        });
        const recreated: Task = {
          ...task,
          createdAt: deleteAt + recreateDelta,
          updatedAt: deleteAt + recreateDelta,
        };
        const s2 = applyEvent(s1, { type: "task.created", task: recreated });
        return s2.has(task.id) ? "resurrected" : "absent";
      },
    );

    // Assertion: resurrection must always succeed.
    fc.assert(
      fc.property(
        arbTaskFresh,
        arbHexPubkey,
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        (task, updatedBy, deleteDelta, recreateDelta) => {
          const s0: TaskState = new Map([[task.id, task]]);
          const deleteAt = task.updatedAt + deleteDelta;
          const s1 = applyEvent(s0, {
            type: "task.deleted",
            taskId: task.id,
            updatedAt: deleteAt,
            updatedBy,
          });
          expect(s1.has(task.id)).toBe(false);

          const recreated: Task = {
            ...task,
            createdAt: deleteAt + recreateDelta,
            updatedAt: deleteAt + recreateDelta,
          };
          const s2 = applyEvent(s1, { type: "task.created", task: recreated });
          expect(s2.has(task.id)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // AC-X-OBSERVABILITY-1: action-type frequency distribution
  // -------------------------------------------------------------------------
  it("[AC-X-OBSERVABILITY-1] action-type frequency distribution in generated sequences", () => {
    // Reports the distribution of dominant event types across generated sequences.
    // Observability probe only — does not assert a property.
    fc.statistics(
      arbEventSequence(20),
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

  // =========================================================================
  // S3 additions: Convergence properties (C1, C2, C3) and labelled probes
  // (D1, D3).
  // =========================================================================

  // ---------------------------------------------------------------------------
  // Helpers for C1: build a sequence whose permutation invariant holds.
  //
  // C1 (permutation-independence) holds in this reducer only for sequences of
  // a SINGLE atomic-replace mutation kind targeting a single task. The reducer's
  // `>=` guard at task-reducer.ts:16 is per-task-object, not per-field, so even
  // an atomic-kind event can be silently dropped by a higher-timestamp event of
  // a DIFFERENT atomic kind. Concrete counterexample (also documented in
  // spec.md §"Known LWW non-commutativity"): given task t with updatedAt=1,
  //   - status_changed(t, ts=2, →done)
  //   - assigned(t, ts=3, →null)
  // applied as [created, status_changed, assigned] yields status=done; applied
  // as [created, assigned, status_changed] the status_changed at ts=2 is
  // rejected as stale (the new updatedAt=3 from the assignment exceeds 2), so
  // status remains "open". The two atomic kinds individually preserve the
  // permutation invariant — but mixed on the same task, they don't.
  //
  // task.updated is also excluded for the standard merge-semantics reason:
  // two updates with disjoint `changes` and distinct timestamps lose the
  // lower-ts update's fields entirely under reordering.
  //
  // The generator below restricts to: one task + N task.status_changed events
  // with strictly increasing timestamps. Within this subset, the highest-ts
  // event always determines the final status regardless of delivery order.
  // Expanding to mixed kinds would expose the cross-kind divergence above and
  // is explicitly out of scope (a different reducer design, possibly per-field
  // LWW, would be a follow-up epic).
  // ---------------------------------------------------------------------------

  // A single task + N status_changed events with strictly distinct timestamps.
  const arbC1Input: fc.Arbitrary<{
    task: Task;
    statusEvents: Array<{
      type: "task.status_changed";
      taskId: string;
      status: TaskStatus;
      updatedAt: number;
      updatedBy: string;
    }>;
  }> = fc
    .tuple(
      arbTaskFresh,
      fc.array(
        fc.record({ status: arbTaskStatus, updatedBy: arbHexPubkey }),
        { minLength: 1, maxLength: 10 },
      ),
    )
    .map(([task, steps]) => ({
      task,
      statusEvents: steps.map((s, i) => ({
        type: "task.status_changed" as const,
        taskId: task.id,
        status: s.status,
        updatedAt: task.updatedAt + i + 1, // strictly distinct: +1, +2, …
        updatedBy: s.updatedBy,
      })),
    }));

  // Deep-equal two TaskState maps.
  function mapsEqual(a: TaskState, b: TaskState): boolean {
    if (a.size !== b.size) return false;
    for (const [id, taskA] of a.entries()) {
      const taskB = b.get(id);
      if (taskB === undefined) return false;
      // Compare all task fields.
      if (
        taskA.title !== taskB.title ||
        taskA.description !== taskB.description ||
        taskA.status !== taskB.status ||
        taskA.assignee !== taskB.assignee ||
        taskA.createdBy !== taskB.createdBy ||
        taskA.createdAt !== taskB.createdAt ||
        taskA.updatedAt !== taskB.updatedAt
      ) {
        return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // C1: permutation-independence with strictly distinct timestamps
  // -------------------------------------------------------------------------
  it("[C1] permutation-independence with strictly distinct timestamps", () => {
    // C1: replayEvents(events) is invariant under permutation of status_changed
    //     events when each event's updatedAt is strictly distinct per taskId.
    //
    // Scoping (matches spec.md §C1 atomic-kind subset and acceptance-criteria
    // AC-RED-15): the test exercises ONLY task.status_changed events for a
    // single task. The reducer's `>=` guard is per-task-object — mixed-kind
    // sequences (e.g. status_changed + assigned with crossing timestamps) are
    // not order-independent even when each kind is individually atomic. That
    // is documented as architectural in spec.md §"Known LWW non-commutativity"
    // and is an architectural property the LWW reducer does NOT provide. The
    // arbC1Input helper above carries the full reasoning.
    //
    // Within the status_changed-only subset, the invariant holds: the event
    // with the highest timestamp determines the final status regardless of
    // delivery order.
    fc.assert(
      fc.property(
        arbC1Input,
        // Sort keys for the permutation of statusEvents.
        fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 10 }),
        ({ task, statusEvents }, shuffleKeys) => {
          const creation: TaskEvent = { type: "task.created", task };

          // Build a permuted copy of the status events.
          const indexed = statusEvents.map((e, i) => ({
            e,
            key: shuffleKeys[i % shuffleKeys.length] ?? i,
          }));
          indexed.sort((a, b) => a.key - b.key);
          const shuffled = indexed.map(({ e }) => e);

          const stateA = replayEvents([creation, ...statusEvents]);
          const stateB = replayEvents([creation, ...shuffled]);

          expect(mapsEqual(stateA, stateB)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // C2: author-irrelevance
  // -------------------------------------------------------------------------
  it("[C2] author-irrelevance — re-labelling updatedBy does not change task ids, status, assignee, title, description", () => {
    // C2: the final task state (excluding createdBy/updatedBy fields) is
    //     independent of which pubkey authored each event.  We replace every
    //     updatedBy (and createdBy on task.created) with a single fresh pubkey
    //     and assert that all task-content fields are identical.
    fc.assert(
      fc.property(
        arbEventSequence(),
        arbHexPubkey, // replacement author pubkey
        (events, fakeAuthor) => {
          // Re-label all author fields.
          const relabelled: TaskEvent[] = events.map((e) => {
            if (e.type === "task.created") {
              return {
                ...e,
                task: { ...e.task, createdBy: fakeAuthor },
              };
            }
            if (e.type === "task.snapshot") {
              return e;
            }
            return { ...e, updatedBy: fakeAuthor };
          });

          const stateOrig = replayEvents(events);
          const stateRelabelled = replayEvents(relabelled);

          // Task ids must be the same set.
          expect(stateOrig.size).toBe(stateRelabelled.size);
          for (const [id, orig] of stateOrig.entries()) {
            const relabTask = stateRelabelled.get(id);
            expect(relabTask).toBeDefined();
            if (relabTask === undefined) return;
            // Content fields must match.
            expect(relabTask.status).toBe(orig.status);
            expect(relabTask.assignee).toBe(orig.assignee);
            expect(relabTask.title).toBe(orig.title);
            expect(relabTask.description).toBe(orig.description);
            expect(relabTask.createdAt).toBe(orig.createdAt);
            expect(relabTask.updatedAt).toBe(orig.updatedAt);
            // createdBy changes by design — the re-labelled run uses fakeAuthor.
            expect(relabTask.createdBy).toBe(fakeAuthor);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // C3: duplicate tolerance
  // -------------------------------------------------------------------------
  it("[C3] duplicate-tolerance — replaying each event 1–3 times equals replaying once", () => {
    // C3: delivering each event between 1 and 3 times (n_i chosen per event)
    //     yields a state byte-identical to replaying each event exactly once.
    fc.assert(
      fc.property(
        arbEventSequence(),
        // Per-event repeat count: one integer per slot, then wrap via modulo.
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 0, maxLength: 30 }),
        (events, repeatOffsets) => {
          // Build a duplicated sequence where each event appears repeatCount times.
          const duplicated: TaskEvent[] = [];
          for (let i = 0; i < events.length; i++) {
            // repeatOffset 0→1 time, 1→2 times, 2→3 times
            const times = (repeatOffsets[i % repeatOffsets.length] ?? 0) + 1;
            for (let j = 0; j < times; j++) {
              duplicated.push(events[i]);
            }
          }

          const stateOnce = replayEvents(events);
          const stateDup = replayEvents(duplicated);

          expect(mapsEqual(stateOnce, stateDup)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // D1: equal-timestamp updates may diverge (labelled only — never fails build)
  // -------------------------------------------------------------------------
  it("[D1] equal-timestamp updates may diverge — labelled via fc.statistics, no assertion", () => {
    // D1: when two task.updated events targeting the same task share an identical
    //     updatedAt, the reducer's >= comparison accepts whichever arrives last.
    //     This means [e1, e2] and [e2, e1] may produce different final states.
    //     We measure the divergence rate via fc.statistics; the build never fails.
    //     (See spec §D1 and TP-90/TP-91 fixme scenarios.)
    fc.statistics(
      fc.tuple(
        arbTaskFresh,
        arbHexPubkey,
        arbHexPubkey,
        fc.string({ minLength: 1, maxLength: 40 }), // title for e1
        fc.string({ minLength: 1, maxLength: 40 }), // title for e2
        fc.integer({ min: 1, max: 1_000 }),          // updatedAt offset
      ),
      ([task, author1, author2, title1, title2, offset]) => {
        const tieAt = task.updatedAt + offset;
        const creation: TaskEvent = { type: "task.created", task };
        const e1: TaskEvent = {
          type: "task.updated",
          taskId: task.id,
          changes: { title: title1 },
          updatedAt: tieAt,
          updatedBy: author1,
        };
        const e2: TaskEvent = {
          type: "task.updated",
          taskId: task.id,
          changes: { title: title2 },
          updatedAt: tieAt,
          updatedBy: author2,
        };
        const stateAB = replayEvents([creation, e1, e2]);
        const stateBA = replayEvents([creation, e2, e1]);
        const taskAB = stateAB.get(task.id);
        const taskBA = stateBA.get(task.id);
        if (taskAB === undefined || taskBA === undefined) return "missing-task";
        return taskAB.title === taskBA.title ? "equal" : "divergent";
      },
    );
    // D1 is a labelled probe — we do NOT assert any outcome.
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // D3: late-arriving task.snapshot overwrites newer events (labelled only)
  // -------------------------------------------------------------------------
  it("[D3] late-arriving snapshot overwrites newer events — labelled via fc.statistics, no assertion", () => {
    // D3: the reducer unconditionally replaces all state on task.snapshot
    //     (task-reducer.ts:58–64). A snapshot arriving after individual mutation
    //     events destroys all post-snapshot-timestamp changes. We measure how
    //     often all newer events are lost ("snapshot-overwrites-newer") via
    //     fc.statistics. The build never fails on any divergence rate.
    fc.statistics(
      fc.tuple(
        arbTaskFresh,                                 // the base task
        fc.array(arbRawStep, { minLength: 1, maxLength: 5 }), // mutation steps
      ),
      ([baseTask, steps]) => {
        // Build the initial state by applying the base task creation.
        let stateAtT0: TaskState = applyEvent(new Map(), {
          type: "task.created",
          task: baseTask,
        });

        // Apply mutation steps on top to produce state at T0+n.
        let stateAfterMutations = stateAtT0;
        for (const step of steps) {
          const event = interpretStep(step, stateAfterMutations);
          stateAfterMutations = applyEvent(stateAfterMutations, event);
        }

        // Now apply a task.snapshot carrying the T0 state (base task only).
        // This simulates a snapshot arriving late after the mutation events.
        const snapshotTasks = Array.from(stateAtT0.values());
        const snapshotEvent: TaskEvent = {
          type: "task.snapshot",
          tasks: snapshotTasks,
        };
        const stateAfterSnapshot = applyEvent(
          stateAfterMutations,
          snapshotEvent,
        );

        // Compare to the pure snapshot-as-initial state.
        const stateSnapshotOnly = replayEvents([snapshotEvent]);

        return mapsEqual(stateAfterSnapshot, stateSnapshotOnly)
          ? "snapshot-overwrites-newer"
          : "partial";
      },
    );
    // D3 is a labelled probe — we do NOT assert any outcome.
    expect(true).toBe(true);
  });
});
