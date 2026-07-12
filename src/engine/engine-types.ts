/**
 * engine-types.ts
 *
 * Sole cross-module type authority AND sole IDB-key authority for the
 * event-sourced-receive-engine epic (see
 * specs/epic-event-sourced-receive-engine/architecture.md, "Seam Contracts",
 * "Module Map", and Boundary Rule 8/9).
 *
 * PURE TYPE MODULE (per this story's scope.excludes: "no runtime logic
 * beyond type definitions and IDB key string constants"). The only runtime
 * exports are the four IDB key-prefix constants and their key-builder
 * functions below — trivial string literals/templates, never state or
 * side-effecting code.
 *
 * Boundary compliance (architecture.md Boundary Rule 1, Rule 9): no import
 * of react, next, next/navigation, any src/integration/* file, or
 * marmot-ts. Enforced by ./engine-boundary.structural.test.ts, which scans
 * every .ts file under src/engine/ (this one included).
 *
 * Persistence import carve-out (amended 2026-07-12, Stage-2 cold review —
 * P1-1): `src/persistence/*` is allowed to import THIS FILE ONLY (seam
 * types + IDB key constants), never `receive-engine.ts` or any other
 * src/engine/ file — see architecture.md "Allowed dependency edges" and
 * Forbidden Rule 3.
 */

import type { TaskEvent } from "../domain/task-events";
import type { AcceptedDomainEvent } from "../domain/domain-events";

// ---------------------------------------------------------------------------
// Nostr relay envelope (minimal structural type)
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of a signed Nostr relay event (NIP-01), defined
 * locally rather than imported from an external SDK (the app currently
 * types NostrEvent via `applesauce-core/helpers/event`, per
 * specs/epic-event-sourced-receive-engine/exploration.json).
 *
 * JUDGMENT CALL (S1): architecture.md's "Allowed dependency edges" table
 * grants src/engine/* exactly one edge for its own code —
 * `src/engine/* -> src/domain/*` (types and pure helpers only). No external
 * npm package is a declared allowed edge for src/engine/*. Rather than
 * adding an undeclared runtime/type dependency on applesauce-core purely to
 * type one field, this file declares its own structural NostrEvent shape.
 * It mirrors the plain NIP-01 event fields (no SDK-specific behavior), so
 * any real implementation (applesauce-core's, NDK's, or a future one) is
 * structurally assignable here without a cast.
 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ---------------------------------------------------------------------------
// RawProtocolFact
// ---------------------------------------------------------------------------

export type ReceiptSource = "historical" | "live" | "bootstrap-kind-30078";

/**
 * A durable, content-addressed record of one relay delivery, prior to any
 * MLS decryption or domain interpretation. See architecture.md "Seam
 * Contracts › RawProtocolFact".
 *
 * Invariants:
 *  - `id` (== `nostrEvent.id` == `nostrEventId`) is content-addressed and is
 *    the dedupe key. It is NOT ordered — never compare ids to determine
 *    sequence.
 *  - `seq` is assigned monotonically on append to the per-group raw log and
 *    is the sole ordering / recovery-watermark key. A duplicate delivery
 *    (same `id`) does NOT get a new `seq` (idempotent append by `id`).
 *  - `epochAtReceipt` is DIAGNOSTIC ONLY. It MUST NOT be used as a retrieval
 *    key for a past `SerializedClientState` (no snapshot-at-epoch API
 *    exists in marmot-ts).
 *  - Bootstrap-sourced facts enter the same store as MLS-sourced facts;
 *    `receiptSource` discriminates origin.
 *  - `nostrEvent.content` is encrypted MLS ciphertext; raw-fact storage does
 *    not attempt decryption.
 */
export interface RawProtocolFact {
  id: string;
  seq: number;
  groupId: string;
  nostrEventId: string;
  nostrEvent: NostrEvent;
  receivedAt: number;
  receiptSource: ReceiptSource;
  epochAtReceipt: string;
}

/**
 * `RawProtocolFact` minus `seq` (amended 2026-07-12, Codex review — P1).
 *
 * `seq` is assigned by the raw log ON APPEND (see the `seq` invariant
 * above), so producers — `marmot-adapter.ts`, and any `IngestSignal`
 * variant carrying a pre-persistence fact — can never pre-supply it. This
 * is the type constructed by producers and passed to
 * `PersistenceAdapter.appendFact`; the store hands back the sequenced
 * `RawProtocolFact` (see `AppendFactResult`).
 */
export type RawProtocolFactInput = Omit<RawProtocolFact, "seq">;

/**
 * Return shape of `PersistenceAdapter.appendFact` (amended 2026-07-12,
 * Codex review — P1). `duplicate: true` means `fact` is the EXISTING
 * stored fact (its original `seq` — no new `seq` was minted) because a
 * fact with the same `id` was already present.
 */
export interface AppendFactResult {
  fact: RawProtocolFact;
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// AcceptedDomainEvent
// ---------------------------------------------------------------------------

/**
 * OWNERSHIP HANDOFF (S2, mandatory obligation from S1's review cycle).
 *
 * S1 carried a COMPLETE, non-generic forward declaration of
 * `AcceptedDomainEvent` here (Boundary Rules made `src/domain/* -> nothing`
 * / `src/engine/* -> src/domain/*` the only legal direction, and
 * `src/domain/` did not exist yet, so engine-types.ts could not import a
 * not-yet-existing domain module). S2 created `src/domain/domain-events.ts`
 * as the canonical, authoritative definition (architecture.md Module Map:
 * "domain-events" owns this type). This file now imports + re-exports it —
 * NEVER reintroduce an independent copy.
 *
 * `AcceptedDomainEvent` is generic (`<T = TaskEvent>`) in its domain-owned
 * definition; every reference below is the bare (no type-argument) form,
 * which resolves via the default to the same shape the S1 forward
 * declaration had — this file's usage is effectively the non-generic alias
 * the S1/S2 handoff required.
 *
 * See src/domain/domain-events.ts for the full field-by-field invariants
 * (id/factId/sourceKind/groupId/acceptedAt/epoch/payload) and the dual
 * idempotency-key derivation helpers (`deriveMlsAcceptedEventId`,
 * `deriveBootstrapAcceptedEventId`).
 */
export type {
  AcceptedDomainEvent,
  DomainEventSourceKind,
} from "../domain/domain-events";

// ---------------------------------------------------------------------------
// Engine lifecycle + health (fsm.md "State = { lifecycle, health }")
// ---------------------------------------------------------------------------

/**
 * Lifecycle phase names from fsm.md. `degraded` is intentionally NOT a
 * member of this union — I-FSM-1 requires it be encoded only as
 * `EngineHealth`, never as a lifecycle value.
 */
export type EngineLifecycleState =
  | "uninitialized"
  | "joining"
  | "recovering"
  | "catching_up"
  | "buffering_live"
  | "live"
  | "retrying_deferred"
  | "stopped";

export type EngineHealth = "nominal" | "degraded";

/**
 * The engine's full state is a pair, never a flat enum (fsm.md "State =
 * { lifecycle, health }"). `degraded` is an orthogonal health flag that may
 * apply to any *active* lifecycle (`catching_up`, `buffering_live`, `live`,
 * `retrying_deferred`); `uninitialized`, `joining`, `recovering`, and
 * `stopped` are always `nominal`.
 */
export interface EngineState {
  lifecycle: EngineLifecycleState;
  health: EngineHealth;
}

// ---------------------------------------------------------------------------
// EngineCheckpoint
// ---------------------------------------------------------------------------

/**
 * Durable per-group engine checkpoint. See architecture.md "Seam Contracts ›
 * EngineCheckpoint".
 *
 * Invariants:
 *  - `lastIngestedSeq` and `lastAcceptedDomainEventId` are DISTINCT
 *    markers. An unreadable/deferred event advances `lastIngestedSeq` but
 *    NOT `lastAcceptedDomainEventId`. Conflating them is a known
 *    anti-pattern from the original proposal.
 *  - On restart, the engine re-ingests only raw-log facts with
 *    `seq > lastIngestedSeq`; facts at or below the watermark already have
 *    their outcome recorded in the accepted-log or deferred-store (see
 *    architecture.md "Recovery Sequencing", R1-R4).
 *  - The deferred queue has exactly ONE durable source of truth:
 *    `deferred-store` (R2a prune, then R2 rebuild) — this checkpoint
 *    carries no deferred ids (amended 2026-07-12, Stage-2 cold review —
 *    P2-6; removed `deferredNostrEventIds`, a stale checkpoint copy could
 *    have bypassed the R2a accepted-wins prune).
 */
export interface EngineCheckpoint {
  groupId: string;
  savedAt: number;
  engineState: EngineLifecycleState;
  /**
   * `null` until the first epoch is observed (amended 2026-07-12,
   * Stage-2 cold review — P3-11). A checkpoint saved during `joining`
   * legally carries `null`.
   */
  lastEpoch: string | null;
  lastIngestedSeq: number;
  /**
   * `null` until the first accepted event is produced (amended
   * 2026-07-12, Stage-2 cold review — P3-11). A checkpoint saved during
   * `joining` legally carries `null`.
   */
  lastAcceptedDomainEventId: string | null;
  /**
   * True once the join-time kind-30078 bootstrap has been fully applied
   * for this group (added 2026-07-12, Stage-2 cold review — P1-2).
   * MONOTONIC once true until `reset()` clears the checkpoint; every
   * `saveCheckpoint` must carry it forward. Restart routing keys on this
   * flag — see fsm.md L1/L2.
   */
  bootstrapCompleted: boolean;
}

// ---------------------------------------------------------------------------
// EngineOutputEvent
// ---------------------------------------------------------------------------

/**
 * Shared "parked" disposition vocabulary used by both `EngineOutputEvent`'s
 * `envelope_deferred` variant and `IngestSignal`'s `deferred` variant.
 *
 * Deliberately excludes "parse_error": a payload that decrypted but failed
 * to decode into a `TaskEvent` is terminal (architecture.md, added
 * 2026-07-12; Implementation Constraint §13) — it is reported via
 * `domain_event_rejected` with `reason: "parse_error"` and MUST NOT be
 * parked, because an epoch advance can never fix a parse error.
 */
export type DeferredReason = "unreadable" | "epoch_mismatch";

/**
 * Discriminated union of every event the engine emits to its consumer
 * (`src/integration/react-engine-hooks.ts`). See architecture.md "Seam
 * Contracts › EngineOutputEvent".
 *
 * Full membership: exactly these ten variants.
 *
 * Invariants (architecture.md):
 *  - `group_epoch_advanced` triggers the deferred-retry flush.
 *  - `group_ratchet_advanced` MUST NOT trigger deferred-retry.
 *  - `projection_invalidated` is reserved for restart recovery and explicit
 *    epoch-level invalidation — never emitted on a ratchet-advance
 *    `stateChanged` (that would force a full projection rebuild on every
 *    own-dispatch).
 *  - On `domain_event_accepted`, the integration layer MUST call
 *    `applyEvent(currentProjection, event.payload)`, never
 *    `buildProjection(fullLog)` (full rebuild is restart/`projection_invalidated`
 *    only).
 *  - PARSE-ERROR-TERMINAL (added 2026-07-12): a payload that decrypted but
 *    failed to decode into a `TaskEvent` routes to `domain_event_rejected`
 *    with `reason: "parse_error"`, never to `envelope_deferred`.
 */
export type EngineOutputEvent =
  | { type: "envelope_received"; factId: string; groupId: string }
  | {
      type: "envelope_deferred";
      factId: string;
      groupId: string;
      reason: DeferredReason;
    }
  | { type: "domain_event_accepted"; event: AcceptedDomainEvent }
  | {
      type: "domain_event_rejected";
      factId: string;
      groupId: string;
      reason: string;
    }
  | { type: "projection_invalidated"; groupId: string }
  | {
      type: "group_epoch_advanced";
      groupId: string;
      newEpoch: string;
      prevEpoch: string;
    }
  | { type: "group_ratchet_advanced"; groupId: string }
  | {
      type: "engine_state_changed";
      groupId: string;
      state: EngineLifecycleState;
      health: EngineHealth;
    }
  | { type: "deferred_retry_started"; groupId: string; count: number }
  | { type: "recovered"; groupId: string };

// ---------------------------------------------------------------------------
// IngestSource / IngestSignal
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

/**
 * Marmot-free discriminated union the adapter
 * (`src/integration/marmot-adapter.ts`) emits and the engine
 * (`src/engine/receive-engine.ts`) consumes. See architecture.md "Seam
 * Contracts › IngestSource / IngestSignal".
 *
 * Full membership: exactly these five variants.
 *
 * Carries NO marmot-ts types in any field: `payload` is the app's own
 * `TaskEvent` wire type; `fact` is `RawProtocolFactInput` (itself
 * marmot-free — a `NostrEvent` envelope). Every variant's `fact` is
 * seq-less: these facts are produced by the adapter pre-persistence (or,
 * via `IngestSource.ingestPersisted`, are already-persisted
 * `RawProtocolFact`s — structurally assignable to `RawProtocolFactInput`
 * since it is a strict subset of fields). Decoding and epoch reads happen
 * inside the adapter, never here.
 */
export type IngestSignal =
  | {
      type: "message";
      fact: RawProtocolFactInput;
      rumorId: string;
      payload: TaskEvent;
      epoch: string;
      receiptSource: ReceiptSource;
    }
  | {
      type: "deferred";
      fact: RawProtocolFactInput;
      reason: DeferredReason;
      epoch: string;
    }
  | {
      /**
       * Ratchet already consumed this id (own-echo / duplicate). The fact
       * is still carried (amended 2026-07-12, Codex review — P2) — not
       * just `factId` — so an own-echo/duplicate envelope not yet present
       * in the raw log can still be appended (idempotently) and the seq
       * watermark advanced, rather than being silently dropped.
       */
      type: "skipped";
      fact: RawProtocolFactInput;
    }
  | {
      /**
       * Decryption succeeded but the payload failed to decode into a
       * `TaskEvent` (added 2026-07-12). Terminal: the engine emits
       * `domain_event_rejected` with `reason: "parse_error"`; never parked,
       * never retried.
       */
      type: "malformed";
      fact: RawProtocolFactInput;
      error: string;
    }
  | { type: "epoch_advanced"; newEpoch: string; prevEpoch: string };

/**
 * Control interface the engine calls on the adapter (architecture.md "Seam
 * Contracts › IngestSource / IngestSignal"). The engine *drives* ingest
 * (decides when to catch up, when to open live, when to stop) but never
 * *touches* marmot directly (Boundary Rule 9) — `marmot-adapter.ts` is the
 * sole implementer and the sole caller of `group.ingest()` /
 * `client.network.subscription()`.
 */
export interface IngestSource {
  /**
   * Drain historical events through `group.ingest()` once; yields one
   * signal per event. CONCURRENCY INVARIANT (amended 2026-07-12, S5
   * Stage-1 review — sev-6): invoked EXACTLY ONCE per engine `start()` and
   * never concurrently with itself — the sole historical cutover drain
   * (fsm.md L3/L4/L5 funnel into one `catching_up` entry per start). It is
   * NOT the joining-phase bootstrap channel; see `fetchBootstrap` for that.
   */
  catchUp(): AsyncIterable<IngestSignal>;
  /** Open the live subscription; pushes signals as they arrive. */
  openLive(onSignal: (signal: IngestSignal) => void): Unsubscribe;
  /**
   * Submit already-persisted facts back through `group.ingest()` for
   * (re-)ingest (amended 2026-07-12, Codex review — P1). Two callers need
   * this channel: R3 crash-gap replay (Recovery Sequencing) resubmits
   * raw-log facts with `seq > checkpoint.lastIngestedSeq`; L8 deferred
   * retry resubmits facts recovered from `deferred-store`. Yields one
   * `IngestSignal` per fact, same variant semantics as `catchUp`.
   */
  ingestPersisted(facts: RawProtocolFact[]): AsyncIterable<IngestSignal>;
  /**
   * Joining-phase bootstrap: fetch and decode the group's kind-30078
   * task-state snapshot, yielding one `IngestSignal` per synthesized
   * bootstrap event (`message` variants with `receiptSource
   * "bootstrap-kind-30078"`, all sharing the snapshot's fact). Drain
   * completion = `bootstrapResolved` (fsm.md L4 guard); `T_join` races
   * THIS drain only. CONCURRENCY INVARIANTS (amended 2026-07-12, S5
   * Stage-1 review — sev-6): (1) `fetchBootstrap` decrypts via NIP-44 and
   * NEVER touches the MLS ratchet, so a late-running background
   * `fetchBootstrap` MAY safely overlap `openLive()`/`catchUp()`/
   * `ingestPersisted()` — the adapter MUST preserve that property; (2)
   * `catchUp()` is invoked EXACTLY ONCE per engine `start()` and never
   * concurrently with itself; (3) after a `T_join` timeout the engine
   * proceeds to `catching_up` while the same `fetchBootstrap` iterator
   * continues in the background — its late signals enter the normal
   * serial signal chain (LWW-safe merge) and completion restores nominal
   * health (H2). The adapter MUST NOT require the drain to be abandoned
   * on timeout.
   */
  fetchBootstrap(): AsyncIterable<IngestSignal>;
  /** Close subscription and release marmot handles. Called by the engine during `stop()`. */
  close(): void;
}

// ---------------------------------------------------------------------------
// PersistenceAdapter
// ---------------------------------------------------------------------------

/**
 * The engine's sole persistence seam (architecture.md "Seam Contracts ›
 * PersistenceAdapter"). The engine calls these methods; it never imports a
 * persistence implementation directly (Boundary Rule: `src/engine/* ->
 * src/persistence/*` via the `PersistenceAdapter` interface only).
 */
export interface PersistenceAdapter {
  /**
   * Idempotent on `fact.id` (amended 2026-07-12, Codex review — P1).
   * Callers supply a seq-less `RawProtocolFactInput` — `seq` is assigned by
   * the raw log ON APPEND (the `RawProtocolFact.seq` invariant) and cannot
   * be pre-supplied. A duplicate append (same `id`) is a no-op that mints
   * NO new `seq`: it returns the EXISTING stored fact with
   * `duplicate: true`. Implementations MUST perform the read-modify-write
   * atomically (single IDB transaction); callers are NOT required to
   * serialize appends.
   */
  appendFact(fact: RawProtocolFactInput): Promise<AppendFactResult>;
  /**
   * Ordering contract (amended 2026-07-12, S3 Stage-1 review): returns facts
   * sorted by `seq` ascending (= append order) — never content-hash-id order.
   * R3's watermark scan and replay depend on it.
   */
  loadFacts(groupId: string): Promise<RawProtocolFact[]>;
  /**
   * Idempotent on `event.id` — appending an id already present is a no-op.
   * Implementations MUST perform the read-modify-write atomically (single
   * IDB transaction); callers are NOT required to serialize appends.
   */
  appendAcceptedEvent(event: AcceptedDomainEvent): Promise<void>;
  /**
   * Ordering contract (amended 2026-07-12, S3 Stage-1 review): returns events
   * in APPEND/insertion order — `appendAcceptedEvent` assigns a monotonic
   * position and load returns sorted by it, never by content-hash `id`.
   * Load-bearing for projection determinism: `applyEvent` is order-sensitive
   * (hard delete, no tombstone) and `replayOrder` sorts by phase only,
   * delegating within-phase order to this contract (`AcceptedDomainEvent`
   * carries no `seq`).
   */
  loadAcceptedEvents(groupId: string): Promise<AcceptedDomainEvent[]>;
  saveCheckpoint(checkpoint: EngineCheckpoint): Promise<void>;
  loadCheckpoint(groupId: string): Promise<EngineCheckpoint | null>;
  saveDeferredIds(groupId: string, ids: string[]): Promise<void>;
  loadDeferredIds(groupId: string): Promise<string[]>;
  /**
   * Single entry point for deferred→accepted acceptance (added 2026-07-12,
   * Codex review — P1; atomicity model revised same day; implements
   * R-INV-3 via crash-safe ORDERING, not a cross-store transaction — the
   * mandated createKVStore layout gives each store its own IndexedDB
   * database, and IDB transactions cannot span databases).
   *
   * Contract: (1) append `event` to the accepted-log FIRST (idempotent on
   * `event.id`); (2) only after that write resolves, remove `factId` from
   * the deferred ids. A crash between the two leaves the fact transiently
   * in BOTH stores — never in neither — and recovery's R2a prune step
   * reconciles it (accepted wins). Implementations MUST NOT reverse the
   * order, and callers MUST NOT substitute ad-hoc saveDeferredIds +
   * appendAcceptedEvent sequences for this method.
   */
  acceptDeferredFact(
    groupId: string,
    factId: string,
    event: AcceptedDomainEvent,
  ): Promise<void>;
  /**
   * Full per-group purge implementing FSM L11 `reset()` (added
   * 2026-07-12, Stage-2 cold review — P1-2 / P2-4 / P2-5): deletes the
   * raw-fact log, accepted-event log, checkpoint (which carries
   * `bootstrapCompleted`), and deferred ids for the group. After it
   * resolves, `loadCheckpoint` returns `null` and all `load*` methods
   * return empty.
   */
  clearGroupState(groupId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// IDB key schema (Boundary Rule 8/9: every new epic IDB key is defined HERE
// and nowhere else — enforced by ./engine-boundary.structural.test.ts,
// AC-BOUND-3)
// ---------------------------------------------------------------------------

/** Owner: src/persistence/raw-event-log-store.ts (new in S4). */
export const RAW_FACTS_KEY_PREFIX = "notestr:raw-facts:";
/** Owner: src/persistence/raw-event-log-store.ts (new in S4). */
export const ACCEPTED_EVENTS_KEY_PREFIX = "notestr:accepted-events:";
/** Owner: src/persistence/checkpoint-store.ts (new in S4). */
export const ENGINE_CHECKPOINTS_KEY_PREFIX = "notestr:engine-checkpoints:";
/** Owner: src/persistence/deferred-store.ts (new in S4). */
export const DEFERRED_IDS_KEY_PREFIX = "notestr:deferred-ids:";

// Note: the legacy `notestr:events:${groupId}` key (owned by
// src/store/persistence.ts, read-only during migration, removed Phase 8)
// is NOT redefined here — it is not one of "the epic's" four new keys and
// AC-BOUND-3 only protects the four above.

export function rawFactsKey(groupId: string): string {
  return `${RAW_FACTS_KEY_PREFIX}${groupId}`;
}

export function acceptedEventsKey(groupId: string): string {
  return `${ACCEPTED_EVENTS_KEY_PREFIX}${groupId}`;
}

export function engineCheckpointsKey(groupId: string): string {
  return `${ENGINE_CHECKPOINTS_KEY_PREFIX}${groupId}`;
}

export function deferredIdsKey(groupId: string): string {
  return `${DEFERRED_IDS_KEY_PREFIX}${groupId}`;
}
