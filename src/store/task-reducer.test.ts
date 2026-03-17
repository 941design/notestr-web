import { describe, it, expect } from "vitest";
import { applyEvent, replayEvents, type TaskState } from "./task-reducer";
import { createTask, type Task, type TaskEvent } from "./task-events";

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

  it("task.snapshot replaces entire state", () => {
    const old = sampleTask({ id: "old" });
    const t1 = sampleTask({ id: "t1", title: "One" });
    const t2 = sampleTask({ id: "t2", title: "Two" });
    let state: TaskState = new Map([["old", old]]);
    state = applyEvent(state, {
      type: "task.snapshot",
      tasks: [t1, t2],
    });
    expect(state.has("old")).toBe(false);
    expect(state.size).toBe(2);
    expect(state.get("t1")!.title).toBe("One");
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
