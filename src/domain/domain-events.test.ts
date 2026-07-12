/**
 * domain-events.test.ts
 *
 * Unit tests for src/domain/domain-events.ts: the dual idempotency-key
 * derivation helpers and the AcceptedDomainEvent<T> shape.
 *
 * Boundary compliance note: this file lives under src/domain/ and is
 * therefore itself scanned by ./domain-boundary.structural.test.ts. It only
 * imports "vitest" (an allowed *.test.ts exception) and relative sibling
 * modules ("./domain-events", "./task-events") — never src/engine/,
 * src/persistence/, src/integration/, or any other src/* tree (in
 * particular, it never imports src/engine/engine-types.ts to cross-check
 * type equivalence — that check lives in
 * src/engine/engine-boundary.structural.test.ts instead, which is allowed
 * the src/engine -> src/domain edge).
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  deriveBootstrapAcceptedEventId,
  deriveMlsAcceptedEventId,
  SOURCE_KIND_PHASE_ORDER,
  type AcceptedDomainEvent,
  type DomainEventSourceKind,
} from "./domain-events";
import type { Task, TaskEvent } from "./task-events";

// ---------------------------------------------------------------------------
// deriveMlsAcceptedEventId
// ---------------------------------------------------------------------------

describe("deriveMlsAcceptedEventId", () => {
  it("returns rumor.id verbatim (MLS path idempotency key = rumor.id)", () => {
    const rumorId = "6f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";
    expect(deriveMlsAcceptedEventId(rumorId)).toBe(rumorId);
  });

  it("is deterministic: the same rumor id always derives the same accepted-event id", () => {
    const rumorId = "abc123";
    expect(deriveMlsAcceptedEventId(rumorId)).toBe(deriveMlsAcceptedEventId(rumorId));
  });

  it("is not a hard-coded placeholder: different rumor ids derive different accepted-event ids", () => {
    expect(deriveMlsAcceptedEventId("rumor-a")).not.toBe(deriveMlsAcceptedEventId("rumor-b"));
  });
});

// ---------------------------------------------------------------------------
// deriveBootstrapAcceptedEventId
// ---------------------------------------------------------------------------

describe("deriveBootstrapAcceptedEventId", () => {
  it("derives the exact bootstrap:${groupId}:${task.id} string from the architecture.md seam contract", () => {
    expect(deriveBootstrapAcceptedEventId("group-a", "task-1")).toBe("bootstrap:group-a:task-1");
  });

  it("is deterministic across re-runs of the same kind-30078 snapshot", () => {
    const groupId = "mls-group-hex-id";
    const taskId = "9f8e7d6c-5b4a-3210-9876-543210fedcba";
    expect(deriveBootstrapAcceptedEventId(groupId, taskId)).toBe(
      deriveBootstrapAcceptedEventId(groupId, taskId),
    );
  });

  it("is not a hard-coded placeholder: different task ids in the same group derive different ids", () => {
    expect(deriveBootstrapAcceptedEventId("group-a", "task-1")).not.toBe(
      deriveBootstrapAcceptedEventId("group-a", "task-2"),
    );
  });

  it("prefixes with groupId to prevent cross-group task.id collision (two different groupIds, same task.id -> distinct ids)", () => {
    const taskId = "shared-task-id";
    const idInGroupA = deriveBootstrapAcceptedEventId("group-a", taskId);
    const idInGroupB = deriveBootstrapAcceptedEventId("group-b", taskId);
    expect(idInGroupA).not.toBe(idInGroupB);
    expect(idInGroupA).toBe("bootstrap:group-a:shared-task-id");
    expect(idInGroupB).toBe("bootstrap:group-b:shared-task-id");
  });

  it("without the groupId prefix, colliding task ids across groups WOULD produce the same id (regression guard: proves the prefix is load-bearing, not decorative)", () => {
    const taskId = "collision-prone-task-id";
    // If a future edit dropped the groupId prefix, both calls below would
    // degenerate to the same bare "bootstrap:${taskId}"-style string. This
    // test pins the current, correct, prefix-bearing behavior so that
    // regression is caught immediately.
    const idInGroupX = deriveBootstrapAcceptedEventId("group-x", taskId);
    const idInGroupY = deriveBootstrapAcceptedEventId("group-y", taskId);
    expect(idInGroupX).not.toBe(idInGroupY);
    expect(idInGroupX.endsWith(`:${taskId}`)).toBe(true);
    expect(idInGroupY.endsWith(`:${taskId}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No dispatcher / no silent-fallthrough-on-unrecognized-sourceKind
// (VQ-S2-001): structural proof by construction, not just by absence.
// ---------------------------------------------------------------------------

describe("dual idempotency-key derivation has no sourceKind-dispatch branch to silently fall through", () => {
  it("the two derivation functions are independent — each takes only the arguments its own path needs, with no shared sourceKind parameter", () => {
    // deriveMlsAcceptedEventId takes exactly one argument (rumorId).
    expect(deriveMlsAcceptedEventId.length).toBe(1);
    // deriveBootstrapAcceptedEventId takes exactly two arguments
    // (groupId, taskId) — neither function accepts a sourceKind argument
    // that a switch/dispatch could silently mis-route or default on.
    expect(deriveBootstrapAcceptedEventId.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AcceptedDomainEvent<T> shape + invariants
// ---------------------------------------------------------------------------

describe("AcceptedDomainEvent<T>", () => {
  const exampleTask: Task = {
    id: "task-1",
    title: "Write the seam contract",
    description: "",
    status: "open",
    assignee: null,
    createdBy: "abcd",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    updatedBy: "abcd",
  };

  const examplePayload: TaskEvent = { type: "task.created", task: exampleTask };

  it("constructs with the default T=TaskEvent payload and every seam-table field present", () => {
    const event: AcceptedDomainEvent = {
      id: deriveMlsAcceptedEventId("rumor-xyz"),
      factId: "fact-abc",
      sourceKind: "mls-rumor",
      groupId: "group-a",
      acceptedAt: 1_700_000_100,
      epoch: "3",
      payload: examplePayload,
    };
    expect(event.id).toBe("rumor-xyz");
    expect(event.factId).toBe("fact-abc");
    expect(event.sourceKind).toBe("mls-rumor");
    expect(event.payload).toBe(examplePayload);
  });

  it("supports the bootstrap sourceKind with the bootstrap-derived id, and factId is always a concrete non-null string on both paths", () => {
    const event: AcceptedDomainEvent = {
      id: deriveBootstrapAcceptedEventId("group-a", "task-1"),
      // Bootstrap path: factId is the backing kind-30078 snapshot's
      // RawProtocolFact.id — a concrete string, never null (architecture.md
      // amended 2026-07-12, Stage-2 cold review, P2-7: the snapshot IS
      // itself persisted as a RawProtocolFact).
      factId: "snapshot-fact-id",
      sourceKind: "bootstrap-kind-30078",
      groupId: "group-a",
      acceptedAt: 1_700_000_200,
      epoch: "0",
      payload: examplePayload,
    };
    expect(event.id).toBe("bootstrap:group-a:task-1");
    expect(typeof event.factId).toBe("string");
    expect(event.factId.length).toBeGreaterThan(0);
  });

  it("type-level: factId is exactly `string`, never `string | null` (mandatory obligation #1 — do NOT reintroduce nullability)", () => {
    expectTypeOf<AcceptedDomainEvent["factId"]>().toEqualTypeOf<string>();
    // Sanity: `string | null` would NOT equal `string`, so this assertion
    // fails to compile (not just fails at runtime) the moment factId
    // regresses to nullable — the earliest possible signal, at
    // `npx tsc --noEmit` time.
  });

  it("type-level: sourceKind is exactly the two-member DomainEventSourceKind union, no drift", () => {
    expectTypeOf<AcceptedDomainEvent["sourceKind"]>().toEqualTypeOf<DomainEventSourceKind>();
    expectTypeOf<DomainEventSourceKind>().toEqualTypeOf<"mls-rumor" | "bootstrap-kind-30078">();
  });

  it("type-level: the generic default (bare AcceptedDomainEvent, no type argument) is structurally identical to AcceptedDomainEvent<TaskEvent>", () => {
    expectTypeOf<AcceptedDomainEvent>().toEqualTypeOf<AcceptedDomainEvent<TaskEvent>>();
  });

  it("is generic over payload: a non-TaskEvent T is also assignable, proving the module stays app-shape-agnostic", () => {
    interface OtherPayload {
      kind: "other";
      value: number;
    }
    const event: AcceptedDomainEvent<OtherPayload> = {
      id: "some-id",
      factId: "some-fact-id",
      sourceKind: "mls-rumor",
      groupId: "group-a",
      acceptedAt: 1_700_000_300,
      epoch: "1",
      payload: { kind: "other", value: 42 },
    };
    expect(event.payload.value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// SOURCE_KIND_PHASE_ORDER — replay-order invariant encoded as shared data
// ---------------------------------------------------------------------------

describe("SOURCE_KIND_PHASE_ORDER", () => {
  it("ranks bootstrap-kind-30078 before mls-rumor (architecture.md: replay sort order is phase order, bootstrap before MLS, never acceptedAt clock order)", () => {
    expect(SOURCE_KIND_PHASE_ORDER["bootstrap-kind-30078"]).toBeLessThan(
      SOURCE_KIND_PHASE_ORDER["mls-rumor"],
    );
  });

  it("covers exactly the two DomainEventSourceKind members, no more, no fewer", () => {
    expect(Object.keys(SOURCE_KIND_PHASE_ORDER).sort()).toEqual(
      ["bootstrap-kind-30078", "mls-rumor"].sort(),
    );
  });

  it("is usable to sort a mixed-sourceKind log by phase, independent of acceptedAt clock order (demonstrates the intended S3 consumption pattern without implementing projection logic here)", () => {
    const mixedLog: Array<Pick<AcceptedDomainEvent, "sourceKind" | "acceptedAt">> = [
      { sourceKind: "mls-rumor", acceptedAt: 100 }, // earliest clock time, but MLS
      { sourceKind: "bootstrap-kind-30078", acceptedAt: 500 }, // latest clock time, but bootstrap
    ];

    const sortedByPhase = [...mixedLog].sort(
      (a, b) => SOURCE_KIND_PHASE_ORDER[a.sourceKind] - SOURCE_KIND_PHASE_ORDER[b.sourceKind],
    );

    // Bootstrap sorts first despite its LATER acceptedAt — proving this is
    // phase order, not acceptedAt clock order.
    expect(sortedByPhase[0].sourceKind).toBe("bootstrap-kind-30078");
    expect(sortedByPhase[1].sourceKind).toBe("mls-rumor");
  });
});
