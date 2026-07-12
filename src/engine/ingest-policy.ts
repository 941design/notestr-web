/**
 * ingest-policy.ts
 *
 * Dedupe + retry-budget policy for `receive-engine.ts`. See
 * specs/epic-event-sourced-receive-engine/architecture.md "Module Map"
 * (ingest-policy row: "Dedupe and retry-budget policy; wraps
 * PendingRetryQueue") and
 * specs/epic-event-sourced-receive-engine/S5-receive-engine-core-fsm/architecture.json
 * (judgment call "ingest-policy-cannot-import-marmot-ingest-queue").
 *
 * WHY THIS DOES NOT IMPORT src/marmot/ingest-queue.ts
 * ----------------------------------------------------
 * The story that authored this file was instructed to "wrap" the existing
 * `PendingRetryQueue` from `src/marmot/ingest-queue.ts`. architecture.md's
 * Boundary Rules (Forbidden Rule 5) and this repo's
 * `engine-boundary.structural.test.ts` (AC-BOUND-1) unconditionally forbid
 * any file under `src/engine/` from importing anything matching `/marmot/`
 * -- verified directly against that scanner's source, including a
 * scanner-liveness fixture that proves a `src/marmot/*` import flips the
 * test to failing. A literal import is therefore not available. This file
 * instead PORTS `createPendingRetryQueue`'s proven algorithm shape --
 * dedupe-by-id `Map` preserving insertion order, cap-with-evict-eldest,
 * TTL-prune -- into an engine-native implementation operating on
 * `RawProtocolFact` + `factId` (never `applesauce-core`'s `NostrEvent`).
 * This mirrors `engine-types.ts`'s own precedent of declaring a structural
 * `NostrEvent` type rather than importing `applesauce-core`'s, for the
 * identical boundary reason.
 *
 * TWO COHESIVE RESPONSIBILITIES
 * ------------------------------
 * 1. DEDUPE: `hasProcessed`/`markProcessed` track which derived
 *    `AcceptedDomainEvent.id` values have already been emitted this engine
 *    session. This is NOT redundant with `PersistenceAdapter`'s own
 *    id-idempotency -- it is what keeps AC-FSM-8's "no fact duplicated"
 *    property true at the EMISSION level (a duplicate `IngestSignal`
 *    delivered twice, e.g. once via historical drain and once via a
 *    boundary-overlapping live push, must not cause `domain_event_accepted`
 *    to fire twice for the same id), independent of the fact that
 *    `applyEvent` also happens to be safe to re-run (AC-INV-2).
 * 2. RETRY BUDGET: `enqueueDeferred`/`retryBatch`/`recordAttempt` track
 *    parked (deferred) facts awaiting the next `epoch_advanced` retry (FSM
 *    L8/L9), with the SAME cap+TTL discipline `PendingRetryQueue` uses, plus
 *    a bounded per-fact retry-attempt counter (`isExhausted`) so
 *    `retryBatch()` performs REAL bounded-retry accounting rather than an
 *    unconditional pass-through: an entry that has exhausted its retry
 *    budget is excluded from the next batch (though it remains queued/
 *    counted in `deferredSize` -- permanently dropping an exhausted entry is
 *    out of this story's scope, deferred to S6 ingest-hardening).
 *
 * Pure module -- no I/O, no React, no browser APIs, no wall-clock reads of
 * its own (`nowMs` is always caller-supplied, matching `receive-engine.ts`'s
 * injected-scheduler discipline). Unit-testable in isolation via vitest.
 */

import type { DeferredReason, RawProtocolFact } from "./engine-types";

export interface IngestPolicyOptions {
  /** Maximum number of parked facts to retain per group. Next insert past
   *  the cap evicts the eldest (lowest `queuedAt`) entry, mirroring
   *  `PendingRetryQueue`'s eviction policy. */
  maxDeferredSize: number;
  /** Age in seconds after which a parked entry is pruned on the next
   *  `pruneDeferred()` call, measured against the entry's `queuedAt`. */
  maxDeferredAgeSec: number;
  /** Maximum number of `recordAttempt` calls an entry may accumulate before
   *  `retryBatch()`/`isExhausted()` excludes it from the next retry pass. */
  maxRetryAttempts: number;
}

/** Reasonable production defaults; every field is override-able per engine
 *  instance via `ReceiveEngineDeps.ingestPolicyOptions`. */
export const DEFAULT_INGEST_POLICY_OPTIONS: IngestPolicyOptions = {
  maxDeferredSize: 500,
  maxDeferredAgeSec: 60 * 60 * 24 * 7, // 7 days
  maxRetryAttempts: 20,
};

/** One parked entry, as exposed to callers (`receive-engine.ts`'s L8/L9
 *  retry pass). `fact` is the ALREADY-SEQUENCED `RawProtocolFact` (not
 *  `RawProtocolFactInput`) -- `IngestSource.ingestPersisted` requires the
 *  sequenced shape, and the sequenced fact is what `appendFact` handed back
 *  at the moment the entry was parked. */
export interface DeferredPolicyEntry {
  factId: string;
  fact: RawProtocolFact;
  reason: DeferredReason;
  queuedAt: number;
  attempts: number;
}

export interface IngestPolicy {
  /** True if `eventId` (a derived `AcceptedDomainEvent.id`) has already been
   *  marked processed this session. */
  hasProcessed(eventId: string): boolean;
  /** Records `eventId` as processed. Idempotent (repeat calls are no-ops). */
  markProcessed(eventId: string): void;

  /** Parks a deferred fact. No-op (dedupe) if `factId` is already queued --
   *  returns `false` in that case, `true` if newly enqueued. Evicts the
   *  eldest entry if the cap is exceeded after insertion. */
  enqueueDeferred(
    factId: string,
    fact: RawProtocolFact,
    reason: DeferredReason,
    nowMs: number,
  ): boolean;
  /** True if `factId` is currently parked. */
  hasDeferred(factId: string): boolean;
  /** Removes `factId` from the deferred queue. No-op if not present. */
  removeDeferred(factId: string): void;
  /** All currently-parked fact ids, FIFO (insertion) order. */
  deferredFactIds(): string[];
  /** Parked entries still within retry budget (`attempts < maxRetryAttempts`),
   *  FIFO order -- the batch `receive-engine.ts`'s L8/L9 pass should submit
   *  to `IngestSource.ingestPersisted`. Entries at/over budget are EXCLUDED
   *  but not removed (see module doc comment). */
  retryBatch(): DeferredPolicyEntry[];
  /** Increments `factId`'s retry-attempt counter. No-op if not queued. Call
   *  once per fact per retry pass, before submitting the batch. */
  recordAttempt(factId: string): void;
  /** True if `factId` is queued AND has met/exceeded `maxRetryAttempts`. */
  isExhausted(factId: string): boolean;
  /** All parked entries that have met/exceeded `maxRetryAttempts` (the
   *  complement of `retryBatch()`'s exclusion set). Added S6 (ledger
   *  obligation 2): `retryBatch()` was already correctly EXCLUDING these
   *  from the next retry-eligible batch, but nothing previously gave a
   *  caller a way to find and dispose of them -- they rotted in the queue
   *  forever. `receive-engine.ts`'s L8/L9 pass calls this once per retry
   *  pass to evict + report exhausted entries (never resubmitted locally
   *  again; relay re-sync is the recovery path). Does not mutate state --
   *  callers must call `removeDeferred` themselves for each returned entry. */
  exhaustedEntries(): DeferredPolicyEntry[];
  /** Removes every entry whose age (`nowMs - queuedAt`) exceeds
   *  `maxDeferredAgeSec`, returning the removed entries (added S6, ledger
   *  obligation 1 -- was `void`; the return value lets `receive-engine.ts`
   *  persist the resulting id list via `saveDeferredIds` and report each
   *  pruned entry, rather than pruning silently). */
  pruneDeferred(nowMs: number): DeferredPolicyEntry[];
  /** Decrements `factId`'s retry-attempt counter by one (floor 0, never
   *  negative). No-op if not queued. Added S6 Stage-2 cold review (P3-6c
   *  attempt-refund): `recordAttempt` is called once per entry BEFORE a
   *  retry pass even begins (see `receive-engine.ts`'s `runDeferredRetryPass`),
   *  charging the entry's DECRYPT retry budget on the assumption the pass
   *  will genuinely test whether this fact is readable yet. When the pass
   *  instead fails for a reason UNRELATED to decryptability -- e.g. a
   *  `PersistenceAdapter.acceptDeferredFact` write outage on an entry that
   *  arrived as a `"message"` signal (proving decrypt already succeeded) --
   *  the caller refunds the charge here so a transient persistence outage is
   *  never misreported as "this fact's ciphertext is unrecoverable"
   *  (`REJECTED_REASON_RETRY_EXHAUSTED`) once attempts happen to reach
   *  `maxRetryAttempts` purely from outage-induced, refund-less passes. */
  refundAttempt(factId: string): void;
  /** Current number of parked entries. */
  readonly deferredSize: number;
}

export function createIngestPolicy(
  options: IngestPolicyOptions = DEFAULT_INGEST_POLICY_OPTIONS,
): IngestPolicy {
  if (options.maxDeferredSize <= 0) {
    throw new Error("createIngestPolicy: maxDeferredSize must be positive");
  }
  if (options.maxDeferredAgeSec <= 0) {
    throw new Error("createIngestPolicy: maxDeferredAgeSec must be positive");
  }
  if (options.maxRetryAttempts <= 0) {
    throw new Error("createIngestPolicy: maxRetryAttempts must be positive");
  }

  const processed = new Set<string>();
  // Map preserves insertion order -- the oldest queued entry is the first
  // element, matching PendingRetryQueue's FIFO eviction precedent.
  const deferred = new Map<string, DeferredPolicyEntry>();

  const evictEldest = (): void => {
    const first = deferred.keys().next();
    if (!first.done) deferred.delete(first.value);
  };

  return {
    hasProcessed(eventId) {
      return processed.has(eventId);
    },
    markProcessed(eventId) {
      processed.add(eventId);
    },

    enqueueDeferred(factId, fact, reason, nowMs) {
      if (deferred.has(factId)) return false;
      deferred.set(factId, { factId, fact, reason, queuedAt: nowMs, attempts: 0 });
      while (deferred.size > options.maxDeferredSize) {
        evictEldest();
      }
      return true;
    },
    hasDeferred(factId) {
      return deferred.has(factId);
    },
    removeDeferred(factId) {
      deferred.delete(factId);
    },
    deferredFactIds() {
      return Array.from(deferred.keys());
    },
    retryBatch() {
      return Array.from(deferred.values()).filter(
        (entry) => entry.attempts < options.maxRetryAttempts,
      );
    },
    recordAttempt(factId) {
      const entry = deferred.get(factId);
      if (entry) entry.attempts += 1;
    },
    refundAttempt(factId) {
      const entry = deferred.get(factId);
      if (entry && entry.attempts > 0) entry.attempts -= 1;
    },
    isExhausted(factId) {
      const entry = deferred.get(factId);
      return entry ? entry.attempts >= options.maxRetryAttempts : false;
    },
    exhaustedEntries() {
      return Array.from(deferred.values()).filter(
        (entry) => entry.attempts >= options.maxRetryAttempts,
      );
    },
    pruneDeferred(nowMs) {
      const cutoffMs = options.maxDeferredAgeSec * 1000;
      const toDelete: string[] = [];
      for (const [id, entry] of deferred) {
        if (nowMs - entry.queuedAt > cutoffMs) toDelete.push(id);
      }
      const removed = toDelete.map((id) => deferred.get(id)!);
      for (const id of toDelete) deferred.delete(id);
      return removed;
    },
    get deferredSize() {
      return deferred.size;
    },
  };
}
