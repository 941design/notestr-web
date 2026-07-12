/**
 * task-projector.ts
 *
 * Deterministic task projector for the event-sourced receive engine. See
 * specs/epic-event-sourced-receive-engine/architecture.md, "Module Map"
 * (task-projector row) and "Seam Contracts › AcceptedDomainEvent", whose
 * invariant this module's `replayOrder` implements verbatim: "Replay sort
 * order over a mixed-sourceKind log is phase order (bootstrap events before
 * MLS events, see SOURCE_KIND_PHASE_ORDER), NOT acceptedAt clock order —
 * client clock skew could otherwise reorder bootstrap after live."
 *
 * This module is the S3 replacement for src/store/task-reducer.ts's fold,
 * adapted to operate over `AcceptedDomainEvent<TaskEvent>` (not bare
 * `TaskEvent`) and to delegate every conflict decision to task-crdt.ts's
 * `taskWinsOver` (the single shared tie-break authority, ADR-001) instead of
 * inlining the three-level comparator. Field-copy behavior on a win mirrors
 * task-reducer.ts exactly — this is a seam change, not a behavior change.
 *
 * PURE FUNCTIONS, ZERO EXTERNAL IMPORTS beyond intra-domain relatives
 * (architecture.md Boundary Rule: `src/domain/* -> nothing`). No wall-clock
 * reads, no randomness, no I/O. Enforced by ./domain-boundary.structural.test.ts.
 */

import { taskWinsOver } from "./task-crdt";
import type { Task } from "./task-events";
import type { AcceptedDomainEvent } from "./domain-events";
import { SOURCE_KIND_PHASE_ORDER } from "./domain-events";

/**
 * The projector's output: a snapshot of every live task, keyed by task id.
 * Read-only from the caller's perspective — every projector function returns
 * a fresh Map rather than mutating a prior one.
 */
export type TaskProjection = ReadonlyMap<string, Task>;

/** The projection before any event has been applied. */
export const EMPTY_PROJECTION: TaskProjection = new Map();

/**
 * Sorts an accepted-event log into valid replay order: bootstrap-sourced
 * events before MLS-sourced events (per `SOURCE_KIND_PHASE_ORDER`), NOT by
 * `acceptedAt` clock order (see this module's doc comment and
 * AcceptedDomainEvent's invariant in domain-events.ts).
 *
 * `Array.prototype.sort` is spec-guaranteed stable since ES2019, so no
 * secondary sort key is needed: within a phase, events retain their
 * input-array relative order.
 *
 * Returns a NEW array; `events` is not mutated.
 */
export function replayOrder(
  events: readonly AcceptedDomainEvent[],
): AcceptedDomainEvent[] {
  return [...events].sort(
    (a, b) =>
      SOURCE_KIND_PHASE_ORDER[a.sourceKind] - SOURCE_KIND_PHASE_ORDER[b.sourceKind],
  );
}

/**
 * Incrementally folds a single accepted domain event into `projection`,
 * returning a NEW `TaskProjection` (the input map is never mutated).
 *
 * Dispatches on `event.payload.type`, mirroring task-reducer.ts's
 * `applyEvent` shape exactly:
 *  - `task.created` is first-write-wins (no tie-break: a duplicate id is a
 *    no-op).
 *  - `task.updated` / `task.status_changed` / `task.assigned` /
 *    `task.deleted` all delegate their conflict decision to
 *    `taskWinsOver(event.payload, existing)` — the single shared tie-break
 *    authority (ADR-001, task-crdt.ts) — rather than an inlined comparator.
 *
 * PRECONDITION: the input log contains unique `AcceptedDomainEvent.id`s —
 * guaranteed by the persistence layer (appendAcceptedEvent is idempotent on
 * id). The projector does not dedup; a hypothetical duplicate-id log is
 * outside the contract (a non-adjacent duplicated task.created after
 * task.deleted would resurrect the task).
 *
 * IDENTITY-PRESERVATION CONTRACT: when an event produces NO change to the
 * projection (a losing tie-break, a duplicate `task.created` that loses
 * first-write-wins, a mutation targeting a nonexistent `taskId`, or an
 * unrecognized `payload.type`), this function returns the SAME `projection`
 * reference it was given (`===`), rather than a fresh copy. A `Map` copy is
 * only ever allocated on a path that actually mutates state. This is a pure
 * optimization with an observable contract callers may rely on: S8's React
 * integration layer uses referential inequality (`prev !== next`) as its
 * sole "did anything change" signal, so a spurious fresh-copy-with-identical-
 * contents on a no-op would cause an unnecessary re-render.
 */
export function applyEvent(
  projection: TaskProjection,
  event: AcceptedDomainEvent,
): TaskProjection {
  const payload = event.payload;

  switch (payload.type) {
    case "task.created": {
      if (projection.has(payload.task.id)) {
        return projection; // duplicate id: first-write-wins loses, no-op
      }
      const next = new Map(projection);
      next.set(payload.task.id, payload.task);
      return next;
    }

    case "task.updated": {
      const existing = projection.get(payload.taskId);
      if (!existing || !taskWinsOver(payload, existing)) {
        return projection; // nonexistent task or losing tie-break: no-op
      }
      const next = new Map(projection);
      next.set(payload.taskId, {
        ...existing,
        ...payload.changes,
        updatedAt: payload.updatedAt,
        updatedBy: payload.updatedBy,
        updatedByDevice: payload.updatedByDevice ?? "",
      });
      return next;
    }

    case "task.status_changed": {
      const existing = projection.get(payload.taskId);
      if (!existing || !taskWinsOver(payload, existing)) {
        return projection; // nonexistent task or losing tie-break: no-op
      }
      const next = new Map(projection);
      next.set(payload.taskId, {
        ...existing,
        status: payload.status,
        updatedAt: payload.updatedAt,
        updatedBy: payload.updatedBy,
        updatedByDevice: payload.updatedByDevice ?? "",
      });
      return next;
    }

    case "task.assigned": {
      const existing = projection.get(payload.taskId);
      if (!existing || !taskWinsOver(payload, existing)) {
        return projection; // nonexistent task or losing tie-break: no-op
      }
      const next = new Map(projection);
      next.set(payload.taskId, {
        ...existing,
        assignee: payload.assignee,
        updatedAt: payload.updatedAt,
        updatedBy: payload.updatedBy,
        updatedByDevice: payload.updatedByDevice ?? "",
      });
      return next;
    }

    case "task.deleted": {
      const existing = projection.get(payload.taskId);
      if (!existing || !taskWinsOver(payload, existing)) {
        return projection; // nonexistent task or losing tie-break: no-op
      }
      const next = new Map(projection);
      next.delete(payload.taskId);
      return next;
    }

    default:
      return projection; // unrecognized payload.type: no-op
  }
}

/**
 * Builds a `TaskProjection` from an accepted-event log by folding
 * `applyEvent` over `EMPTY_PROJECTION`.
 *
 * ASSUMES `events` is already in valid replay order — this function does
 * NOT call `replayOrder` internally. The caller composes
 * `buildProjection(replayOrder(acceptedLog))`, per architecture.md's
 * Recovery Sequencing R1 pseudocode. This is deliberate: it is what makes
 * `log.reduce(applyEvent, EMPTY_PROJECTION)` deep-equal `buildProjection(log)`
 * by construction, not by coincidence.
 *
 * PRECONDITION: the input log contains unique `AcceptedDomainEvent.id`s —
 * guaranteed by the persistence layer (appendAcceptedEvent is idempotent on
 * id). The projector does not dedup; a hypothetical duplicate-id log is
 * outside the contract (a non-adjacent duplicated task.created after
 * task.deleted would resurrect the task).
 */
export function buildProjection(
  events: readonly AcceptedDomainEvent[],
): TaskProjection {
  return events.reduce(applyEvent, EMPTY_PROJECTION);
}
