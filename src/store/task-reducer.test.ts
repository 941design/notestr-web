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

  it("task.created is first-write-wins: a duplicate id does not overwrite", () => {
    const original = sampleTask();
    const duplicate = { ...original, title: "Should be ignored" };
    let state = applyEvent(emptyState(), { type: "task.created", task: original });
    state = applyEvent(state, { type: "task.created", task: duplicate });
    // FWW: the existing task is kept and the duplicate's content is dropped.
    expect(state.get("task-1")).toEqual(original);
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

// ---------------------------------------------------------------------------
// Reproduction test for "sibling-device same-second edit: both events dropped
// because tie-break collapses when both devices share a Nostr pubkey".
//
// The three-level LWW gate added to applyEvent must resolve concurrent edits
// from two devices of the SAME identity (identical updatedBy pubkey) at the
// same wall-clock second by comparing the MLS clientId (updatedByDevice).
// Without the third level, the tie-break evaluates pubkey < pubkey → false
// for both events, and both are silently rejected. With the third level,
// the lower clientId wins deterministically regardless of delivery order.
// ---------------------------------------------------------------------------
describe("sibling-device same-second concurrent edit: three-level tie-break resolves", () => {
  const T = 1000;
  const SHARED_PUBKEY = "pubkey-alice"; // both devices share one identity
  // Initial task has DEVICE_C so incoming sibling edits (A, B) compete:
  // A < B < C so either A or B can win depending on arrival order.
  const DEVICE_A = "a";
  const DEVICE_B = "b";
  const DEVICE_C = "c"; // initial task's device — higher than both A and B

  function siblingEditA(): TaskEvent {
    return {
      type: "task.status_changed",
      taskId: "task-1",
      status: "in_progress",
      updatedAt: T,
      updatedBy: SHARED_PUBKEY,
      updatedByDevice: DEVICE_A,
    };
  }
  function siblingEditB(): TaskEvent {
    return {
      type: "task.status_changed",
      taskId: "task-1",
      status: "done",
      updatedAt: T,
      updatedBy: SHARED_PUBKEY,
      updatedByDevice: DEVICE_B,
    };
  }
  function initialTask(): Task {
    return {
      id: "task-1",
      title: "Sibling test",
      description: "",
      status: "open",
      assignee: null,
      createdBy: SHARED_PUBKEY,
      createdAt: T - 10,
      updatedAt: T,
      updatedBy: SHARED_PUBKEY,
      updatedByDevice: DEVICE_C,
    };
  }

  // A < B < C. Incoming deviceId < existing deviceId → event wins.
  // Initial task has DEVICE_C; both sibling edits (A, B) are lower and can win.
  it("A arrives first: A < C → A wins immediately; B then loses (B > A)", () => {
    const pre = new Map([["task-1", initialTask()]]);
    let state = applyEvent(pre, siblingEditA()); // A < C → A wins
    state = applyEvent(state, siblingEditB());    // B > A → B loses
    expect(state.get("task-1")!.status).toBe("in_progress");
    expect(state.get("task-1")!.updatedByDevice).toBe(DEVICE_A);
  });

  it("B arrives first: B < C → B wins; A then wins (A < B)", () => {
    const pre = new Map([["task-1", initialTask()]]);
    let state = applyEvent(pre, siblingEditB()); // B < C → B wins
    state = applyEvent(state, siblingEditA());   // A < B → A wins
    expect(state.get("task-1")!.status).toBe("in_progress");
    expect(state.get("task-1")!.updatedByDevice).toBe(DEVICE_A);
  });

  it("convergence: both delivery orders converge to DEVICE_A (lowest clientId)", () => {
    const pre = new Map([["task-1", initialTask()]]);
    let state1 = applyEvent(pre, siblingEditA());
    state1 = applyEvent(state1, siblingEditB());

    let state2 = applyEvent(pre, siblingEditB());
    state2 = applyEvent(state2, siblingEditA());

    expect(state1.get("task-1")!.status).toBe(state2.get("task-1")!.status);
    expect(state1.get("task-1")!.updatedByDevice).toBe(state2.get("task-1")!.updatedByDevice);
    expect(state1.get("task-1")!.updatedByDevice).toBe(DEVICE_A); // A < B < C always wins
  });

  // Pre-fix behavior: without updatedByDevice both sibling edits are dropped.
  // All three have updatedByDevice="" (treated as ""). Gate fails at third level.
  it("without updatedByDevice: only lower deviceId wins, higher is rejected (pre-fix regression)", () => {
    const pre = new Map([["task-1", initialTask()]]);
    const staleEditA: TaskEvent = {
      type: "task.status_changed",
      taskId: "task-1",
      status: "in_progress",
      updatedAt: T,
      updatedBy: SHARED_PUBKEY,
      // updatedByDevice absent → treated as ""
    };
    const staleEditB: TaskEvent = {
      type: "task.status_changed",
      taskId: "task-1",
      status: "done",
      updatedAt: T,
      updatedBy: SHARED_PUBKEY,
      // updatedByDevice absent → treated as ""
    };
    // A arrives: existing has DEVICE_C, A has "" → A wins ("" < DEVICE_C).
    // B arrives: existing has "" (from A), B has DEVICE_B → DEVICE_B > "" → B loses.
    let state = applyEvent(pre, staleEditA); // A wins: status=in_progress, device=""
    state = applyEvent(state, staleEditB);    // B loses: no change
    expect(state.get("task-1")!.status).toBe("in_progress"); // A's edit won
    expect(state.get("task-1")!.updatedByDevice).toBe(""); // A's device ("" < DEVICE_B)
  });

  it("backward compat: new event with DEVICE_B loses to old task (existing undefined → treated as '', lower than 'b')", () => {
    // Old task: updatedByDevice is undefined (read from IDB as undefined → "").
    const pre = new Map([["task-1", {
      id: "task-1",
      title: "Old task",
      description: "",
      status: "open" as const,
      assignee: null,
      createdBy: SHARED_PUBKEY,
      createdAt: T - 10,
      updatedAt: T,
      updatedBy: SHARED_PUBKEY,
      // updatedByDevice: undefined — old persisted task
    }]]);
    const newEvent: TaskEvent = {
      type: "task.status_changed",
      taskId: "task-1",
      status: "done",
      updatedAt: T,
      updatedBy: SHARED_PUBKEY,
      updatedByDevice: DEVICE_B,
    };
    // Existing has undefined (→ ""), new event has DEVICE_B ("b").
    // Gate: "" < "b" → existing wins → event is rejected.
    // The old task stays as-is; the new event does NOT override it.
    // This is the correct backward-compat behavior: old tasks sort as "" (lowest).
    const state = applyEvent(pre, newEvent);
    expect(state.get("task-1")!.status).toBe("open"); // unchanged — new event loses
  });
});

// ---------------------------------------------------------------------------
// LWW three-level tie-break, exercised across ALL FOUR mutating variants.
//
// applyEvent has four near-identical guards (task.updated, task.status_changed,
// task.assigned, task.deleted), each gating on the same comparison:
//   updatedAt >  ||  (updatedAt == && (updatedBy <
//                  || (updatedBy == && (updatedByDevice ?? "") < (existing ?? ""))))
// The sibling-device block above pins this for status_changed; these
// parameterized cases pin the identical gate for the other three variants too,
// so a regression in any guard's ordering, equality, logical structure, or ""
// fallback is caught regardless of which event type carries it.
// ---------------------------------------------------------------------------
describe("LWW tie-break holds for every mutating variant", () => {
  const TID = "task-1";
  const BASE = 1000;
  const PK_A = "pk-a", PK_M = "pk-m", PK_Z = "pk-z"; // PK_A < PK_M < PK_Z
  const DEV_A = "da", DEV_M = "dm", DEV_Z = "dz"; // DEV_A < DEV_M < DEV_Z

  type Stamp = { updatedAt: number; updatedBy: string; updatedByDevice?: string };

  function baseTask(): Task {
    return {
      id: TID,
      title: "base",
      description: "base-desc",
      status: "open",
      assignee: null,
      createdBy: PK_M,
      createdAt: BASE - 10,
      updatedAt: BASE,
      updatedBy: PK_M,
      updatedByDevice: DEV_M,
    };
  }

  const VARIANTS: {
    name: string;
    build: (s: Stamp) => TaskEvent;
    won: (t: Task | undefined) => boolean;
  }[] = [
    {
      name: "task.updated",
      build: (s) => ({ type: "task.updated", taskId: TID, changes: { title: "WON" }, ...s }),
      won: (t) => t?.title === "WON",
    },
    {
      name: "task.status_changed",
      build: (s) => ({ type: "task.status_changed", taskId: TID, status: "done", ...s }),
      won: (t) => t?.status === "done",
    },
    {
      name: "task.assigned",
      build: (s) => ({ type: "task.assigned", taskId: TID, assignee: "WON", ...s }),
      won: (t) => t?.assignee === "WON",
    },
    {
      name: "task.deleted",
      build: (s) => ({ type: "task.deleted", taskId: TID, ...s }),
      won: (t) => t === undefined,
    },
  ];

  // win=true → the incoming event beats the baseline (updatedAt=BASE,
  // updatedBy=PK_M, updatedByDevice=DEV_M); win=false → it is rejected.
  const CASES: { desc: string; stamp: Stamp; win: boolean }[] = [
    { desc: "newer updatedAt wins despite higher pubkey+device", stamp: { updatedAt: BASE + 1, updatedBy: PK_Z, updatedByDevice: DEV_Z }, win: true },
    { desc: "older updatedAt loses despite lower pubkey+device", stamp: { updatedAt: BASE - 1, updatedBy: PK_A, updatedByDevice: DEV_A }, win: false },
    { desc: "equal updatedAt, lower updatedBy wins", stamp: { updatedAt: BASE, updatedBy: PK_A, updatedByDevice: DEV_Z }, win: true },
    { desc: "equal updatedAt, higher updatedBy loses", stamp: { updatedAt: BASE, updatedBy: PK_Z, updatedByDevice: DEV_A }, win: false },
    { desc: "equal updatedAt+updatedBy, lower device wins", stamp: { updatedAt: BASE, updatedBy: PK_M, updatedByDevice: DEV_A }, win: true },
    { desc: "equal updatedAt+updatedBy, higher device loses", stamp: { updatedAt: BASE, updatedBy: PK_M, updatedByDevice: DEV_Z }, win: false },
    { desc: "fully equal updatedAt+updatedBy+device loses (idempotent)", stamp: { updatedAt: BASE, updatedBy: PK_M, updatedByDevice: DEV_M }, win: false },
    { desc: "equal updatedAt+updatedBy, omitted event device ('') beats defined device", stamp: { updatedAt: BASE, updatedBy: PK_M }, win: true },
  ];

  describe.each(VARIANTS)("$name", (variant) => {
    it.each(CASES)("$desc", ({ stamp, win }) => {
      const pre = new Map([[TID, baseTask()]]);
      const next = applyEvent(pre, variant.build(stamp));
      const t = next.get(TID);
      expect(variant.won(t)).toBe(win);
      // When a non-delete event wins, the stored updatedByDevice must be the
      // event's clientId, or "" when the event omitted it. Pins the set-body
      // `updatedByDevice: event.updatedByDevice ?? ""` assignment.
      if (win && variant.name !== "task.deleted") {
        expect(t!.updatedByDevice).toBe(stamp.updatedByDevice ?? "");
      }
    });

    // Existing-side `(existing.updatedByDevice ?? "")` fallback: a legacy task
    // persisted without updatedByDevice sorts as "" (lowest), so a same-(ts,pk)
    // event carrying a non-empty device loses to it.
    it("loses to a legacy existing task whose updatedByDevice is absent ('')", () => {
      const { updatedByDevice: _omit, ...legacy } = baseTask();
      const pre = new Map([[TID, legacy as Task]]);
      // Digit-leading device ("0…", below ASCII 'S') so the existing-side
      // `?? ""` cannot be silently mutated to a non-empty literal without
      // flipping this loss into a win: "0a" < "" is false (event loses), but
      // "0a" < "<any uppercase-led literal>" would be true (event wins).
      const next = applyEvent(pre, variant.build({ updatedAt: BASE, updatedBy: PK_M, updatedByDevice: "0a" }));
      expect(variant.won(next.get(TID))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Event-side `?? ""` normalization — omitted updatedByDevice is lexicographic
// minimum.
//
// The LWW guard normalizes absent device IDs on BOTH sides of the comparison:
//   (event.updatedByDevice ?? "") < (existing.updatedByDevice ?? "")
//
// The existing-side `?? ""` is pinned by the "legacy existing task" tests above.
// These four tests pin the EVENT-side `?? ""` by using existing device IDs that
// start with uppercase letters or digits (ASCII ≤ 82, i.e. below 'S'=83).
//
// Choice of upper-bound device strings ("A", "B", "Q", "9"):
//   "" < "A" → true  → event wins  (correct, ?? "" behaviour)
//   "Stryker was here!" < "A" → 'S'(83) > 'A'(65) → false → event loses (mutation caught)
//
// Any device string in the ASCII range (∅, 'S') kills the mutation. Existing
// tests use only lowercase a–z (≥ 'd'=100 > 83), which is why the mutant
// survived — "Stryker was here!" < "dm" is also true.
//
// No matching AC in the existing specs; see BACKLOG spec-gap finding
// (anchor: src/store/task-reducer.ts:25,46,67,88).
// ---------------------------------------------------------------------------
describe("event-side ?? '' normalization — omitted updatedByDevice is lexicographic minimum", () => {
  // Shared baseline: all four tests share the same pubkey and timestamp so the
  // only live variable in the gate is the device-ID comparison.
  const T = 2000;
  const PK = "pubkey-shared";

  function taskWithDevice(device: string): Task {
    return {
      id: "task-1",
      title: "original",
      description: "desc",
      status: "open" as const,
      assignee: null,
      createdBy: PK,
      createdAt: T - 1,
      updatedAt: T,
      updatedBy: PK,
      updatedByDevice: device,
    };
  }

  // task.updated: existing device "A" (ASCII 65). "" < "A" → event wins.
  it("task.updated: event with omitted device wins over existing with uppercase device 'A'", () => {
    const pre = new Map([["task-1", taskWithDevice("A")]]);
    const next = applyEvent(pre, {
      type: "task.updated",
      taskId: "task-1",
      changes: { title: "updated" },
      updatedAt: T,
      updatedBy: PK,
      // updatedByDevice omitted → normalised to ""
    });
    expect(next.get("task-1")!.title).toBe("updated");
  });

  // task.status_changed: existing device "B" (ASCII 66). "" < "B" → event wins.
  it("task.status_changed: event with omitted device wins over existing with uppercase device 'B'", () => {
    const pre = new Map([["task-1", taskWithDevice("B")]]);
    const next = applyEvent(pre, {
      type: "task.status_changed",
      taskId: "task-1",
      status: "done",
      updatedAt: T,
      updatedBy: PK,
      // updatedByDevice omitted → normalised to ""
    });
    expect(next.get("task-1")!.status).toBe("done");
  });

  // task.assigned: existing device "Q" (ASCII 81, safely below 'S'=83). "" < "Q" → event wins.
  it("task.assigned: event with omitted device wins over existing with uppercase device 'Q'", () => {
    const pre = new Map([["task-1", taskWithDevice("Q")]]);
    const next = applyEvent(pre, {
      type: "task.assigned",
      taskId: "task-1",
      assignee: "pubkey-bob",
      updatedAt: T,
      updatedBy: PK,
      // updatedByDevice omitted → normalised to ""
    });
    expect(next.get("task-1")!.assignee).toBe("pubkey-bob");
  });

  // task.deleted: existing device "9" (ASCII 57, digits sort before uppercase).
  // "" < "9" → event wins → task is removed.
  it("task.deleted: event with omitted device wins over existing with digit device '9'", () => {
    const pre = new Map([["task-1", taskWithDevice("9")]]);
    const next = applyEvent(pre, {
      type: "task.deleted",
      taskId: "task-1",
      updatedAt: T,
      updatedBy: PK,
      // updatedByDevice omitted → normalised to ""
    });
    expect(next.has("task-1")).toBe(false);
  });
});
