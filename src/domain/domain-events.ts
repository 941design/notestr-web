/**
 * domain-events.ts
 *
 * Canonical, authoritative definition of `AcceptedDomainEvent` — the
 * event-sourced-receive-engine's normalized post-acceptance domain event —
 * and its dual idempotency-key derivation helpers. See
 * specs/epic-event-sourced-receive-engine/architecture.md, "Seam Contracts
 * › AcceptedDomainEvent" and "Module Map" (owning module: domain-events).
 *
 * OWNERSHIP HANDOFF (S2, mandatory obligation from S1's review cycle):
 * src/engine/engine-types.ts previously carried a COMPLETE forward
 * declaration of this type (S1 judgment call — src/domain/ did not yet
 * exist, and `src/engine/* -> src/domain/*` is the only legal edge
 * direction, so engine-types.ts could not import a not-yet-existing domain
 * module). This file is now the single authoritative definition;
 * engine-types.ts imports and re-exports it. NEVER reintroduce a second,
 * independent definition.
 *
 * PURE TYPE + KEY-DERIVATION MODULE (per this story's scope.excludes: "no
 * projection or reducer logic -- type and key-derivation only"). Zero
 * runtime state; the two exported functions are trivial, deterministic
 * string builders, and SOURCE_KIND_PHASE_ORDER is a plain data constant.
 *
 * Boundary compliance (architecture.md Boundary Rule: `src/domain/* ->
 * nothing`; Forbidden Rule 2): no import of src/engine/, src/persistence/,
 * src/integration/, or the DOM. The only import below (`./task-events`) is
 * intra-domain — TaskEvent's relocation into src/domain/ (this same story)
 * is what makes that legal without violating "zero external imports".
 * Enforced by ./domain-boundary.structural.test.ts, which scans every .ts
 * file under src/domain/ (this one included).
 */

import type { TaskEvent } from "./task-events";

// ---------------------------------------------------------------------------
// sourceKind discriminator
// ---------------------------------------------------------------------------

/**
 * Discriminates the two provenance paths an accepted domain event can come
 * from. See architecture.md "Seam Contracts › AcceptedDomainEvent".
 */
export type DomainEventSourceKind = "mls-rumor" | "bootstrap-kind-30078";

/**
 * Replay-order ranking for a mixed-`sourceKind` accepted-event log.
 *
 * Encodes the architecture.md AcceptedDomainEvent invariant "Replay sort
 * order over a mixed-sourceKind log is phase order (bootstrap events before
 * MLS events), NOT acceptedAt clock order" as shared, importable data —
 * lower number sorts first. This is deliberately a data constant, not a
 * comparator/sort function (that would be projection logic, out of this
 * story's scope): S3's task-projector composes this into its own
 * `replayOrder` implementation rather than re-deriving the phase ranking
 * independently.
 */
export const SOURCE_KIND_PHASE_ORDER: Readonly<
  Record<DomainEventSourceKind, number>
> = {
  "bootstrap-kind-30078": 0,
  "mls-rumor": 1,
};

// ---------------------------------------------------------------------------
// AcceptedDomainEvent
// ---------------------------------------------------------------------------

/**
 * The engine's normalized output of successful ingest + decode: a single
 * accepted, idempotency-keyed domain event ready for projection.
 *
 * Generic over its payload type (`T`, defaulting to `TaskEvent`) so this
 * module stays a pure, app-shape-agnostic seam contract; every call site in
 * this epic references the bare (no-type-argument) form, which resolves to
 * `AcceptedDomainEvent<TaskEvent>` via the default — structurally identical
 * to the non-generic alias `src/engine/engine-types.ts` re-exports.
 *
 * Invariants (architecture.md "Seam Contracts › AcceptedDomainEvent"):
 *  - `id` is the primary deduplication key; `appendAcceptedEvent` /
 *    `PersistenceAdapter.appendAcceptedEvent` is idempotent on `id`.
 *  - MLS path: `id = rumor.id` from the `applicationMessage` callback
 *    (device-sync.ts:879, task-store.tsx:199-203) — see
 *    `deriveMlsAcceptedEventId`.
 *  - Bootstrap path: `id = "bootstrap:${groupId}:${task.id}"`, deterministic
 *    across re-runs; the `groupId` prefix prevents cross-group `task.id`
 *    collision — see `deriveBootstrapAcceptedEventId`.
 *  - `factId` is the backing `RawProtocolFact.id` and is ALWAYS a non-null
 *    string (never `null`, amended 2026-07-12, Stage-2 cold review — P2-7):
 *    both the MLS path (kind-445 envelope fact) and the bootstrap path
 *    (kind-30078 snapshot fact — the snapshot IS itself persisted as a
 *    `RawProtocolFact`) always have a concrete backing fact by the time an
 *    `AcceptedDomainEvent` is constructed.
 *  - Replay sort order over a mixed-`sourceKind` log is PHASE order
 *    (bootstrap events before MLS events, see `SOURCE_KIND_PHASE_ORDER`),
 *    NOT `acceptedAt` clock order — client clock skew could otherwise
 *    reorder bootstrap after live.
 *
 * Produced by: src/engine/receive-engine.ts
 * Consumed by: src/domain/task-projector.ts (S3), src/persistence/raw-event-log-store.ts (S4)
 */
export interface AcceptedDomainEvent<T = TaskEvent> {
  id: string;
  factId: string;
  sourceKind: DomainEventSourceKind;
  groupId: string;
  acceptedAt: number;
  epoch: string;
  payload: T;
}

// ---------------------------------------------------------------------------
// Dual idempotency-key derivation
// ---------------------------------------------------------------------------

/**
 * MLS path idempotency key: the rumor's own content-addressed id. `rumor.id`
 * is already stable and unique per accepted application message — this is a
 * direct passthrough, kept as a named function (rather than inlining
 * `rumor.id` at call sites) so every producer derives the id through one
 * documented, tested seam instead of re-deriving it ad hoc.
 *
 * Deliberately NOT merged with `deriveBootstrapAcceptedEventId` into a
 * single `sourceKind`-dispatching function: two independent functions mean
 * there is no branch that could silently fall through to a default id for
 * an unrecognized `sourceKind` — each producer calls the specific function
 * for the specific path it is already on.
 */
export function deriveMlsAcceptedEventId(rumorId: string): string {
  return rumorId;
}

/**
 * Bootstrap path idempotency key: deterministic across re-runs of the same
 * kind-30078 snapshot. The `groupId` prefix is mandatory — `task.id` alone
 * is only unique within one group's task list, so two different groups
 * could otherwise mint colliding synthetic bootstrap ids (architecture.md
 * "Seam Contracts › AcceptedDomainEvent" invariant; Implementation
 * Constraint §1(a)).
 */
export function deriveBootstrapAcceptedEventId(
  groupId: string,
  taskId: string,
): string {
  return `bootstrap:${groupId}:${taskId}`;
}
