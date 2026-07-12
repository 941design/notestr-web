import { describe, expect, it } from "vitest";
import { taskWinsOver, type TieBreakFields } from "./task-crdt";

/**
 * Exhaustive coverage of ADR-001's three-level tie-break, per S3's story
 * text: "each level decisive, ties fall through, "" default for missing
 * device". Mirrors src/store/task-reducer.ts's four inlined call sites'
 * behavior (task-crdt.ts's module doc comment proves the algebraic
 * equivalence); these tests pin that behavior down as an executable
 * contract independent of the reducer.
 */
describe("taskWinsOver", () => {
  const base: TieBreakFields = {
    updatedAt: 100,
    updatedBy: "b0b0",
    updatedByDevice: "device-b",
  };

  // ---------------------------------------------------------------------
  // Level 1: updatedAt
  // ---------------------------------------------------------------------

  it("level 1 decisive: strictly newer updatedAt wins regardless of updatedBy/updatedByDevice", () => {
    const candidate: TieBreakFields = {
      updatedAt: 101,
      updatedBy: "zzzz", // would lose level 2 on its own
      updatedByDevice: "zzzz", // would lose level 3 on its own
    };
    expect(taskWinsOver(candidate, base)).toBe(true);
  });

  it("level 1 decisive: strictly older updatedAt loses regardless of updatedBy/updatedByDevice", () => {
    const candidate: TieBreakFields = {
      updatedAt: 99,
      updatedBy: "aaaa", // would win level 2 on its own
      updatedByDevice: "aaaa", // would win level 3 on its own
    };
    expect(taskWinsOver(candidate, base)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Level 2: updatedBy (only reached when updatedAt ties)
  // ---------------------------------------------------------------------

  it("level 2 decisive: equal updatedAt, strictly lower updatedBy wins", () => {
    const candidate: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: "a0a0", // lower than b0b0
      updatedByDevice: "zzzz", // would lose level 3 on its own
    };
    expect(taskWinsOver(candidate, base)).toBe(true);
  });

  it("level 2 decisive: equal updatedAt, strictly higher updatedBy loses", () => {
    const candidate: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: "c0c0", // higher than b0b0
      updatedByDevice: "aaaa", // would win level 3 on its own
    };
    expect(taskWinsOver(candidate, base)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Level 3: updatedByDevice (only reached when updatedAt AND updatedBy tie)
  // ---------------------------------------------------------------------

  it("level 3 decisive: equal updatedAt + updatedBy, strictly lower updatedByDevice wins", () => {
    const candidate: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      updatedByDevice: "device-a", // lower than device-b
    };
    expect(taskWinsOver(candidate, base)).toBe(true);
  });

  it("level 3 decisive: equal updatedAt + updatedBy, strictly higher updatedByDevice loses", () => {
    const candidate: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      updatedByDevice: "device-c", // higher than device-b
    };
    expect(taskWinsOver(candidate, base)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Full tie -> false (idempotent re-application)
  // ---------------------------------------------------------------------

  it("full tie (all three fields equal) loses -- candidate does not beat an identical existing", () => {
    const candidate: TieBreakFields = { ...base };
    expect(taskWinsOver(candidate, base)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Missing updatedByDevice defaults to ""
  // ---------------------------------------------------------------------

  it('missing candidate.updatedByDevice defaults to "" -- "" sorts before any non-empty device, so candidate wins', () => {
    const candidate: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      updatedByDevice: undefined,
    };
    expect(taskWinsOver(candidate, base)).toBe(true);
  });

  it('missing existing.updatedByDevice defaults to "" -- candidate with any non-empty device loses to ""', () => {
    const existingNoDevice: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      updatedByDevice: undefined,
    };
    const candidate: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      updatedByDevice: "device-a",
    };
    expect(taskWinsOver(candidate, existingNoDevice)).toBe(false);
  });

  it("both updatedByDevice missing -- treated as equal (\"\" === \"\"), tie loses", () => {
    const a: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      updatedByDevice: undefined,
    };
    const b: TieBreakFields = {
      updatedAt: base.updatedAt,
      updatedBy: base.updatedBy,
      updatedByDevice: undefined,
    };
    expect(taskWinsOver(a, b)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Legacy reducer parity: reproduce the exact OR/AND expression from
  // task-reducer.ts:18-32 and assert it agrees with taskWinsOver on a small
  // adversarial matrix -- direct evidence of the "preserve behavior EXACTLY"
  // extraction requirement, independent of the algebraic-equivalence
  // argument in the module doc comment.
  // ---------------------------------------------------------------------

  function legacyInlineComparator(
    candidate: TieBreakFields,
    existing: TieBreakFields,
  ): boolean {
    return (
      candidate.updatedAt > existing.updatedAt ||
      (candidate.updatedAt === existing.updatedAt &&
        (candidate.updatedBy < existing.updatedBy ||
          (candidate.updatedBy === existing.updatedBy &&
            (candidate.updatedByDevice ?? "") < (existing.updatedByDevice ?? ""))))
    );
  }

  const matrix: ReadonlyArray<[TieBreakFields, TieBreakFields]> = [
    [{ updatedAt: 5, updatedBy: "a", updatedByDevice: "x" }, { updatedAt: 5, updatedBy: "a", updatedByDevice: "x" }],
    [{ updatedAt: 6, updatedBy: "z", updatedByDevice: "z" }, { updatedAt: 5, updatedBy: "a", updatedByDevice: "a" }],
    [{ updatedAt: 4, updatedBy: "a", updatedByDevice: "a" }, { updatedAt: 5, updatedBy: "z", updatedByDevice: "z" }],
    [{ updatedAt: 5, updatedBy: "a", updatedByDevice: "z" }, { updatedAt: 5, updatedBy: "b", updatedByDevice: "a" }],
    [{ updatedAt: 5, updatedBy: "b", updatedByDevice: "a" }, { updatedAt: 5, updatedBy: "a", updatedByDevice: "z" }],
    [{ updatedAt: 5, updatedBy: "a", updatedByDevice: "m" }, { updatedAt: 5, updatedBy: "a", updatedByDevice: "z" }],
    [{ updatedAt: 5, updatedBy: "a", updatedByDevice: "z" }, { updatedAt: 5, updatedBy: "a", updatedByDevice: "m" }],
    [{ updatedAt: 5, updatedBy: "a" }, { updatedAt: 5, updatedBy: "a", updatedByDevice: "m" }],
    [{ updatedAt: 5, updatedBy: "a", updatedByDevice: "m" }, { updatedAt: 5, updatedBy: "a" }],
  ];

  it.each(matrix)(
    "taskWinsOver(%o, %o) agrees with the legacy inline reducer expression",
    (candidate, existing) => {
      expect(taskWinsOver(candidate, existing)).toBe(
        legacyInlineComparator(candidate, existing),
      );
    },
  );
});
