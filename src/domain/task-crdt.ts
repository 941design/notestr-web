/**
 * task-crdt.ts
 *
 * The single shared tie-break authority for task CRDT merges (ADR-001).
 * See specs/epic-event-sourced-receive-engine/architecture.md, "Module Map"
 * (task-crdt row) and Implementation Constraint 10: "task-crdt.ts is the
 * single tie-break authority. Both applyEvent (task-reducer.ts:18-32) and
 * the bootstrap merge gate (device-sync.ts:1433-1452) must delegate to
 * taskWinsOver. Any new tie-break logic must go into task-crdt.ts;
 * implementing it independently in either call site reconstitutes the
 * duplicate-projection drift risk."
 *
 * ADR-001 ordering rule (three-level, strict, cascading):
 *   1. Newer `updatedAt` (seconds) wins.
 *   2. Equal `updatedAt` -> lower `updatedBy` (hex pubkey) wins.
 *   3. Equal `updatedAt` AND equal `updatedBy` -> lower `updatedByDevice`
 *      (MLS clientId) wins. A missing `updatedByDevice` is treated as `""`
 *      (backward compat with tasks persisted before per-device tie-break was
 *      introduced).
 *
 * Extracted verbatim-behavior from src/store/task-reducer.ts:18-32 (S3 story
 * mandate: "The extraction must preserve the legacy reducer's behavior
 * EXACTLY"). The reducer's four call sites all inline the same expression:
 *
 *   event.updatedAt > existing.updatedAt ||
 *   (event.updatedAt === existing.updatedAt &&
 *     (event.updatedBy < existing.updatedBy ||
 *       (event.updatedBy === existing.updatedBy &&
 *         (event.updatedByDevice ?? "") < (existing.updatedByDevice ?? ""))))
 *
 * `taskWinsOver` below is an algebraically identical cascading rewrite: at
 * each level, an unequal comparison short-circuits and returns that level's
 * strict-inequality result directly; only an equal comparison falls through
 * to the next level. This is provably the same truth table as the original
 * OR/AND expression for every input (see task-crdt.test.ts's per-level
 * coverage plus its directed 9-pair adversarial matrix — a cold-review
 * brute-force enumeration over all 1,296 three-level combinations
 * independently confirmed agreement with the legacy inline expression on
 * every one, corroborating this matrix rather than replacing it) — no
 * behavior change, just a flatter shape.
 *
 * PURE FUNCTION, ZERO EXTERNAL IMPORTS (architecture.md Module Map: task-crdt
 * "Owned Data: None (pure function)"; Boundary Rule: `src/domain/* ->
 * nothing`). Enforced by ./domain-boundary.structural.test.ts.
 */

/**
 * The structural shape `taskWinsOver` compares. Deliberately narrower than
 * the full `Task` type (src/domain/task-events.ts) so both call sites can
 * pass through without an adapter:
 *  - src/domain/task-projector.ts's `applyEvent` extracts these three fields
 *    directly off an `AcceptedDomainEvent.payload` (a `TaskEvent` variant
 *    carrying `updatedAt`/`updatedBy`/`updatedByDevice`).
 *  - src/marmot/device-sync.ts's bootstrap merge gate compares two full
 *    `Task` objects, which structurally satisfy this interface already.
 */
export interface TieBreakFields {
  updatedAt: number;
  updatedBy: string;
  updatedByDevice?: string;
}

/**
 * Returns `true` if `candidate` should replace `existing` under the ADR-001
 * three-level ordering rule; `false` otherwise (including the fully-tied
 * case, where every field is equal — this is what makes re-applying an
 * already-applied event a safe no-op, see task-projector.property.test.ts's
 * AC-INV-2 coverage).
 *
 * Pure: no I/O, no mutation of its arguments, no nondeterministic reads.
 */
export function taskWinsOver(
  candidate: TieBreakFields,
  existing: TieBreakFields,
): boolean {
  if (candidate.updatedAt !== existing.updatedAt) {
    return candidate.updatedAt > existing.updatedAt;
  }
  if (candidate.updatedBy !== existing.updatedBy) {
    return candidate.updatedBy < existing.updatedBy;
  }
  return (candidate.updatedByDevice ?? "") < (existing.updatedByDevice ?? "");
}
