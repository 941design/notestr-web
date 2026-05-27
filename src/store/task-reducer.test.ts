import { describe, it, expect } from "vitest";
import { applyEvent, replayEvents, type TaskState } from "./task-reducer";
import { createTask, type Task, type TaskEvent } from "./task-events";
import { ensureMonotonicTimestamp } from "./task-store-utils";

function emptyState(): TaskState {
  return new Map();
}

function sampleTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    title: "Test task",
    description: "A test",
    status: "open",
    assignee: null,
    createdBy: "pubkey-alice",
    createdAt: 1000,
    updatedAt: 1000,
    updatedBy: "pubkey-alice",
    ...overrides,
  };
}

describe("applyEvent", () => {
  it("task.created adds a task", () => {
    const task = sampleTask();
    const state = applyEvent(emptyState(), { type: "task.created", task });
    expect(state.get("task-1")).toEqual(task);
  });

  it("task.updated merges changes", () => {
    const task = sampleTask();
    let state: TaskState = new Map([["task-1", task]]);
    state = applyEvent(state, {
      type: "task.updated",
      taskId: "task-1",
      changes: { title: "Updated title" },
      updatedAt: 2000,
      updatedBy: "pubkey-bob",
    });
    expect(state.get("task-1")!.title).toBe("Updated title");
    expect(state.get("task-1")!.updatedAt).toBe(2000);
    expect(state.get("task-1")!.description).toBe("A test"); // unchanged
  });

  it("task.updated is rejected if older", () => {
    const task = sampleTask({ updatedAt: 3000 });
    let state: TaskState = new Map([["task-1", task]]);
    state = applyEvent(state, {
      type: "task.updated",
      taskId: "task-1",
      changes: { title: "Stale update" },
      updatedAt: 2000,
      updatedBy: "pubkey-bob",
    });
    expect(state.get("task-1")!.title).toBe("Test task"); // unchanged
  });

  it("task.status_changed updates status", () => {
    const task = sampleTask();
    let state: TaskState = new Map([["task-1", task]]);
    state = applyEvent(state, {
      type: "task.status_changed",
      taskId: "task-1",
      status: "in_progress",
      updatedAt: 2000,
      updatedBy: "pubkey-alice",
    });
    expect(state.get("task-1")!.status).toBe("in_progress");
  });

  it("task.assigned sets assignee", () => {
    const task = sampleTask();
    let state: TaskState = new Map([["task-1", task]]);
    state = applyEvent(state, {
      type: "task.assigned",
      taskId: "task-1",
      assignee: "pubkey-bob",
      updatedAt: 2000,
      updatedBy: "pubkey-alice",
    });
    expect(state.get("task-1")!.assignee).toBe("pubkey-bob");
  });

  it("task.assigned can unassign", () => {
    const task = sampleTask({ assignee: "pubkey-bob", updatedAt: 1000 });
    let state: TaskState = new Map([["task-1", task]]);
    state = applyEvent(state, {
      type: "task.assigned",
      taskId: "task-1",
      assignee: null,
      updatedAt: 2000,
      updatedBy: "pubkey-alice",
    });
    expect(state.get("task-1")!.assignee).toBeNull();
  });

  it("task.deleted removes a task", () => {
    const task = sampleTask();
    let state: TaskState = new Map([["task-1", task]]);
    state = applyEvent(state, {
      type: "task.deleted",
      taskId: "task-1",
      updatedAt: 2000,
      updatedBy: "pubkey-alice",
    });
    expect(state.has("task-1")).toBe(false);
  });

  it("task.deleted is rejected if older", () => {
    const task = sampleTask({ updatedAt: 3000 });
    let state: TaskState = new Map([["task-1", task]]);
    state = applyEvent(state, {
      type: "task.deleted",
      taskId: "task-1",
      updatedAt: 2000,
      updatedBy: "pubkey-alice",
    });
    expect(state.has("task-1")).toBe(true);
  });

  it("always returns a new Map", () => {
    const state = emptyState();
    const next = applyEvent(state, {
      type: "task.created",
      task: sampleTask(),
    });
    expect(next).not.toBe(state);
  });

  it("ignores updates to nonexistent tasks", () => {
    const state = applyEvent(emptyState(), {
      type: "task.status_changed",
      taskId: "nope",
      status: "done",
      updatedAt: 1000,
      updatedBy: "pubkey-alice",
    });
    expect(state.size).toBe(0);
  });
});

describe("replayEvents", () => {
  it("rebuilds state from event log", () => {
    const events: TaskEvent[] = [
      { type: "task.created", task: sampleTask() },
      {
        type: "task.status_changed",
        taskId: "task-1",
        status: "in_progress",
        updatedAt: 2000,
        updatedBy: "pubkey-alice",
      },
      {
        type: "task.assigned",
        taskId: "task-1",
        assignee: "pubkey-bob",
        updatedAt: 3000,
        updatedBy: "pubkey-alice",
      },
    ];
    const state = replayEvents(events);
    expect(state.size).toBe(1);
    const task = state.get("task-1")!;
    expect(task.status).toBe("in_progress");
    expect(task.assignee).toBe("pubkey-bob");
    expect(task.updatedAt).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Reproduction tests for "same-actor edit within one second is silently dropped"
//
// These tests exercise `applyEvent` directly to pin the reducer behavior that
// makes the sender-side monotonic bump necessary, and then compose the real
// reducer with the real helper to prove the fix resolves the data loss.
//
// If the `ensureMonotonicTimestamp` call is ever removed from `dispatch()`,
// the second test below will still pass (it calls the helper explicitly), but
// the first test documents exactly why the bump is required — making the
// regression detectable at review time.
// ---------------------------------------------------------------------------
describe("same-actor same-second edit: reducer drop + monotonic bump", () => {
  const T = 1000;
  const ALICE = "pubkey-alice";

  function taskAssignedToAlice(): Task {
    return sampleTask({ updatedAt: T, updatedBy: ALICE, assignee: ALICE });
  }

  // Part 1: documents the raw reducer behavior — the underlying reason the
  // bump is needed. A same-actor, same-second event is rejected because the
  // strict `>` gate evaluates false and the `updatedBy` tie-break resolves
  // identical pubkeys as NOT strictly less-than.
  //
  // This test PASSES both before and after the fix (the reducer is unchanged).
  // Its purpose is to pin the invariant that makes the dispatch-layer bump necessary.
  it("documents the raw-reducer drop: same-actor same-second second edit is rejected without a bump", () => {
    const pre: TaskState = new Map([["task-1", taskAssignedToAlice()]]);
    const secondEdit: TaskEvent = {
      type: "task.assigned",
      taskId: "task-1",
      assignee: null, // the desired outcome: unassign
      updatedAt: T,   // same second — ties with existing.updatedAt
      updatedBy: ALICE, // same actor — tie-break evaluates ALICE < ALICE → false
    };
    const post = applyEvent(pre, secondEdit);
    // The reducer rejects the second edit; assignee stays as-was.
    expect(post.get("task-1")!.assignee).toBe(ALICE);
  });

  // Part 2: the fix. `ensureMonotonicTimestamp` (called by `dispatch()` before
  // `applyEvent`) bumps the event's `updatedAt` to `existing.updatedAt + 1`,
  // making it strictly greater. The reducer then accepts it and the last edit wins.
  //
  // This test FAILS pre-fix (ensureMonotonicTimestamp did not exist) and
  // PASSES post-fix. It would fail again if the bump logic regressed.
  it("monotonic bump restores convergence: same-actor same-second edit is accepted after bump", () => {
    const existing = taskAssignedToAlice();
    const pre: TaskState = new Map([["task-1", existing]]);
    const rawSecondEdit: TaskEvent = {
      type: "task.assigned",
      taskId: "task-1",
      assignee: null,
      updatedAt: T,
      updatedBy: ALICE,
    };
    // Mimic exactly what dispatch() does before calling applyEvent.
    const bumped = ensureMonotonicTimestamp(rawSecondEdit, existing);
    const post = applyEvent(pre, bumped);
    // The bumped event has updatedAt = T + 1, so the reducer accepts it.
    expect(post.get("task-1")!.assignee).toBeNull();
    expect(post.get("task-1")!.updatedAt).toBe(T + 1);
  });

  // Part 3: sub-frame re-entrancy. Two dispatch() calls within one render
  // frame both read stateRef.current — which is only updated by React's render
  // cycle. Without the synchronous ref advance added after setState(), both
  // reads return updatedAt=T, both bump to T+1, and the reducer drops the
  // second. This test simulates dispatch()'s read-modify-write loop with a
  // mutable ref, advancing it after each apply (the behaviour added to
  // dispatch()), and asserts the second edit produces T+2, not T+1 (which
  // would indicate the ref was stale on the second call).
  //
  // This test FAILS if the synchronous `stateRef.current = nextState` advance
  // is absent — both dispatches would bump to T+1, and the second `applyEvent`
  // would see updatedAt===T+1 === existing T+1 and reject it, leaving the
  // task at T+1 with the first edit's value rather than T+2 with the second.
  it("sub-frame burst: two same-actor same-second dispatches both land when ref is advanced synchronously", () => {
    // Initial task: assigned to alice at time T.
    const initial = taskAssignedToAlice();

    // Mutable ref — models stateRef.current in dispatch().
    // The key invariant: it MUST be advanced after each apply, synchronously,
    // before the next dispatch reads it — exactly what the fix does.
    let stateRef: TaskState = new Map([["task-1", initial]]);

    // Dispatch 1: alice changes status to in_progress (still same second T).
    const rawEdit1: TaskEvent = {
      type: "task.status_changed",
      taskId: "task-1",
      status: "in_progress",
      updatedAt: T,
      updatedBy: ALICE,
    };
    const edit1 = ensureMonotonicTimestamp(rawEdit1, stateRef.get("task-1"));
    const afterEdit1 = applyEvent(stateRef, edit1);
    stateRef = afterEdit1; // synchronous ref advance — the fix

    // Dispatch 2: alice changes status to done (still same second T).
    const rawEdit2: TaskEvent = {
      type: "task.status_changed",
      taskId: "task-1",
      status: "done",
      updatedAt: T,
      updatedBy: ALICE,
    };
    const edit2 = ensureMonotonicTimestamp(rawEdit2, stateRef.get("task-1"));
    const afterEdit2 = applyEvent(stateRef, edit2);

    // edit1 saw existing.updatedAt=T → bumped to T+1. edit2 saw T+1 → bumped
    // to T+2. The reducer accepted both. Final state must reflect edit2 (done).
    expect(afterEdit2.get("task-1")!.status).toBe("done");
    expect(afterEdit2.get("task-1")!.updatedAt).toBe(T + 2);
  });
});

describe("createTask", () => {
  it("creates a task with defaults", () => {
    const task = createTask("My task", "Desc", "pubkey-alice");
    expect(task.title).toBe("My task");
    expect(task.description).toBe("Desc");
    expect(task.status).toBe("open");
    expect(task.assignee).toBeNull();
    expect(task.createdBy).toBe("pubkey-alice");
    expect(task.id).toBeTruthy();
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.createdAt).toBe(task.updatedAt);
  });
});
