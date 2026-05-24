/**
 * Regression tests for the sender-side monotonic timestamp bump introduced to
 * fix "same-actor edit within one second is silently dropped."
 *
 * Root cause: the reducer gate is strict `>` with an inter-author tie-breaker.
 * When the same actor edits the same task twice within one wall-clock second,
 * `event.updatedAt === existing.updatedAt` AND `event.updatedBy === existing.updatedBy`,
 * so the second event is rejected. `ensureMonotonicTimestamp` fixes this by
 * bumping `updatedAt` to `existing.updatedAt + 1` when the event would otherwise
 * tie or lose on timestamp — guaranteeing the reducer always sees strictly
 * increasing timestamps for sequential edits from the same actor.
 *
 * See: bug-reports/task-same-second-edit-dropped-report.md
 */

import { describe, it, expect } from "vitest";
import { ensureMonotonicTimestamp } from "./task-store-utils";
import type { Task, TaskEvent } from "./task-events";

function baseTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    title: "Test task",
    description: "",
    status: "open",
    assignee: null,
    createdBy: "pubkey-alice",
    createdAt: 1000,
    updatedAt: 1000,
    updatedBy: "pubkey-alice",
    ...overrides,
  };
}

describe("ensureMonotonicTimestamp", () => {
  // VQ1: same actor, equal timestamps → second event must win (get a bumped timestamp).
  // This test FAILS pre-fix because the helper does not exist yet.
  it("bumps updatedAt to existing.updatedAt + 1 when timestamps tie on same-actor edit", () => {
    const existing = baseTask({ updatedAt: 1000, updatedBy: "pubkey-alice" });
    const event: TaskEvent = {
      type: "task.assigned",
      taskId: "task-1",
      assignee: null,
      updatedAt: 1000, // same second — would tie and be rejected by raw reducer
      updatedBy: "pubkey-alice",
    };
    const bumped = ensureMonotonicTimestamp(event, existing);
    // The bumped event must have a strictly greater updatedAt so the reducer accepts it.
    expect(bumped.type).toBe("task.assigned");
    if (bumped.type === "task.assigned") {
      expect(bumped.updatedAt).toBe(1001);
    }
  });

  it("bumps updatedAt when new timestamp is less than existing (non-monotonic producer)", () => {
    const existing = baseTask({ updatedAt: 5000, updatedBy: "pubkey-alice" });
    const event: TaskEvent = {
      type: "task.status_changed",
      taskId: "task-1",
      status: "done",
      updatedAt: 4999, // strictly older — would be rejected
      updatedBy: "pubkey-alice",
    };
    const bumped = ensureMonotonicTimestamp(event, existing);
    if (bumped.type === "task.status_changed") {
      expect(bumped.updatedAt).toBe(5001);
    }
  });

  it("does NOT bump updatedAt when event already has a strictly greater timestamp", () => {
    const existing = baseTask({ updatedAt: 1000 });
    const event: TaskEvent = {
      type: "task.updated",
      taskId: "task-1",
      changes: { title: "New title" },
      updatedAt: 1001, // already strictly greater — no bump needed
      updatedBy: "pubkey-alice",
    };
    const bumped = ensureMonotonicTimestamp(event, existing);
    if (bumped.type === "task.updated") {
      expect(bumped.updatedAt).toBe(1001);
    }
  });

  it("does NOT bump when there is no existing task (new task's mutation is first edit)", () => {
    const event: TaskEvent = {
      type: "task.status_changed",
      taskId: "task-new",
      status: "in_progress",
      updatedAt: 1000,
      updatedBy: "pubkey-alice",
    };
    const bumped = ensureMonotonicTimestamp(event, undefined);
    if (bumped.type === "task.status_changed") {
      expect(bumped.updatedAt).toBe(1000); // no existing task → no bump
    }
  });

  it("does NOT modify task.created events (FWW — not subject to LWW gate)", () => {
    const task = baseTask();
    const event: TaskEvent = { type: "task.created", task };
    const result = ensureMonotonicTimestamp(event, undefined);
    expect(result).toBe(event); // same reference — untouched
  });

  it("returns a new event object, not a mutation of the input", () => {
    const existing = baseTask({ updatedAt: 1000 });
    const event: TaskEvent = {
      type: "task.assigned",
      taskId: "task-1",
      assignee: null,
      updatedAt: 1000,
      updatedBy: "pubkey-alice",
    };
    const bumped = ensureMonotonicTimestamp(event, existing);
    // Original event must be unchanged.
    if (event.type === "task.assigned") {
      expect(event.updatedAt).toBe(1000);
    }
    expect(bumped).not.toBe(event);
  });

  it("bumps task.deleted events consistently with other mutation types", () => {
    const existing = baseTask({ updatedAt: 2000, updatedBy: "pubkey-alice" });
    const event: TaskEvent = {
      type: "task.deleted",
      taskId: "task-1",
      updatedAt: 2000, // same second
      updatedBy: "pubkey-alice",
    };
    const bumped = ensureMonotonicTimestamp(event, existing);
    if (bumped.type === "task.deleted") {
      expect(bumped.updatedAt).toBe(2001);
    }
  });

  // Inter-author tie at same timestamp: the reducer's own tie-breaker handles this.
  // dispatch() must NOT bump here because we want the reducer's commutative tie-break
  // to remain in effect for concurrent inter-author edits.
  //
  // However, approach B bumps for ALL ties (same or different author), because
  // same-actor sequential edits are a SUPERSET of the problem: we bump whenever
  // event.updatedAt <= existing.updatedAt, regardless of who authored what.
  // This is safe: different-author concurrent edits both go through their own
  // actor's dispatch(), each of which sees its own stateRef.current — so both
  // actors bump their own event, producing two events with updatedAt = existing + 1.
  // The reducer tie-breaker (lower pubkey wins) still resolves that concurrent case.
  it("bumps inter-author tie too — reducer tie-breaker still resolves it convergently", () => {
    const existing = baseTask({ updatedAt: 1000, updatedBy: "pubkey-bob" });
    const event: TaskEvent = {
      type: "task.updated",
      taskId: "task-1",
      changes: { title: "Alice's update" },
      updatedAt: 1000, // tie with existing from bob
      updatedBy: "pubkey-alice",
    };
    const bumped = ensureMonotonicTimestamp(event, existing);
    if (bumped.type === "task.updated") {
      expect(bumped.updatedAt).toBe(1001); // bumped; reducer will accept it
    }
  });
});
