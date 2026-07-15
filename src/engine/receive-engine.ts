/**
 * receive-engine.ts
 *
 * The per-group receive-engine state machine. Implements fsm.md's
 * authoritative transition table VERBATIM (states, L1-L11, H1-H2, guard
 * definitions, the cutover protocol, T_join wiring, invariants I-FSM-1..6)
 * -- see specs/epic-event-sourced-receive-engine/fsm.md, which this file
 * MUST conform to exactly (Implementation Constraint 4: any deviation is a
 * review-blocking defect). Design decisions this story had to make beyond
 * fsm.md's text are recorded in
 * specs/epic-event-sourced-receive-engine/S5-receive-engine-core-fsm/architecture.json's
 * "judgment_calls" -- read that file alongside this one.
 *
 * PROJECTION-FREE BY DESIGN (architecture.json "engine-stays-projection-free"):
 * this module holds no in-memory `TaskProjection` and never imports
 * task-projector.ts/task-crdt.ts. It emits `domain_event_accepted` (and the
 * other nine `EngineOutputEvent` variants); folding into a projection is the
 * integration layer's job (Implementation Constraint 7).
 *
 * Boundary compliance (architecture.md Boundary Rule 1): no import of react,
 * next, next/navigation, src/integration/*, marmot-ts, src/marmot/*, or
 * src/persistence/* (the engine calls `PersistenceAdapter` methods on an
 * injected instance; it never imports an implementation file). Enforced by
 * ./engine-boundary.structural.test.ts.
 *
 * NONDETERMINISM: the only sanctioned `Date.now`/`setTimeout`/`clearTimeout`
 * call site in this module is `createRealEngineScheduler()` below -- every
 * other function receives time and timers exclusively through the injected
 * `EngineScheduler`, so tests can substitute a fully controllable
 * (fake-timer-backed) scheduler. `src/engine/` currently has no automated
 * nondeterminism-guard structural test (unlike `src/domain/`), but this
 * discipline is followed anyway per this story's explicit instruction and to
 * keep T_join/periodic-checkpoint timing test-controllable.
 */

import type {
  AcceptedDomainEvent,
  AppendFactResult,
  DeferredReason,
  EngineCheckpoint,
  EngineHealth,
  EngineLifecycleState,
  EngineOutputEvent,
  EngineState,
  IngestSignal,
  IngestSource,
  PersistenceAdapter,
  RawProtocolFact,
  RawProtocolFactInput,
  Unsubscribe,
} from "./engine-types";
import {
  deriveBootstrapAcceptedEventId,
  deriveMlsAcceptedEventId,
} from "../domain/domain-events";
import type { TaskEvent } from "../domain/task-events";
import {
  createIngestPolicy,
  DEFAULT_INGEST_POLICY_OPTIONS,
  type DeferredPolicyEntry,
  type IngestPolicy,
  type IngestPolicyOptions,
} from "./ingest-policy";

// ---------------------------------------------------------------------------
// EngineScheduler -- injected timer/clock abstraction
// ---------------------------------------------------------------------------

/** Opaque handle returned by `EngineScheduler.setTimeout`. */
export type EngineTimerHandle = { readonly __brand: "EngineTimerHandle" };

export interface EngineScheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): EngineTimerHandle;
  clearTimeout(handle: EngineTimerHandle): void;
}

/**
 * Production `EngineScheduler`, backed by the real global `Date.now` /
 * `setTimeout` / `clearTimeout`. Delegating to the GLOBAL `setTimeout`
 * (rather than a captured local reference) means `vi.useFakeTimers()` in a
 * test still transparently controls this scheduler's timing -- fake-timer
 * tests do not need a separate hand-rolled scheduler implementation.
 */
export function createRealEngineScheduler(): EngineScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) =>
      globalThis.setTimeout(fn, ms) as unknown as EngineTimerHandle,
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  };
}

export const DEFAULT_T_JOIN_MS = 8000;
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * AC-PERS-1 / Implementation Constraint 11 bounded-backoff schedule for
 * appendFact/appendAcceptedEvent/acceptDeferredFact/saveCheckpoint
 * failures (S6). "Bounded" = both a growing, CAPPED per-attempt delay AND a
 * finite attempt count (see this story's architecture.json
 * "persistence-retry-bounded-backoff-constants"): exponential backoff
 * (factor 2) from a 1000ms base, capped at 30000ms per wait, for a maximum
 * of 8 total attempts before a write is treated as exhausted for the
 * session (architecture.json "persistence-retry-exhaustion-disposition").
 * Independent of ingest-policy.ts's `maxRetryAttempts`, which bounds the
 * UNRELATED deferred-queue epoch-triggered retry budget, not raw
 * persistence I/O retries.
 */
export const PERSISTENCE_RETRY_BASE_DELAY_MS = 1000;
export const PERSISTENCE_RETRY_MAX_DELAY_MS = 30_000;
export const PERSISTENCE_RETRY_BACKOFF_FACTOR = 2;
export const PERSISTENCE_RETRY_MAX_ATTEMPTS = 8;

/**
 * REJECTION VOCABULARY (extended 2026-07-12, S6 Stage-2 cold review -- P3-6a):
 * `domain_event_rejected.reason` is a free-form string field (no
 * `EngineOutputEvent` type change across any of these additions), but this
 * engine emits exactly FOUR values on it, each tied to a distinct terminal
 * disposition:
 *   1. `"parse_error"`      -- handleMalformed/handleDeferredRetrySignal's
 *      "malformed" case: decryption succeeded, payload decode failed.
 *      Terminal; never parked, never retried.
 *   2. `REJECTED_REASON_RETRY_EXHAUSTED` ("retry-exhausted") -- a parked
 *      entry's ingest-policy attempt budget (maxRetryAttempts) is spent.
 *   3. `REJECTED_REASON_DEFERRED_TTL_EXPIRED` ("deferred-ttl-expired") -- a
 *      parked entry aged out (maxDeferredAgeSec) before ever being retried.
 *   4. `REJECTED_REASON_PERSISTENCE_EXHAUSTED` ("persistence-exhausted") --
 *      a primary-state write (appendFact/appendAcceptedEvent/
 *      acceptDeferredFact) exhausted its bounded-backoff retry budget
 *      (PERSISTENCE_RETRY_MAX_ATTEMPTS). Distinct from the other three: this
 *      is an I/O-outage disposition, not a content/policy one, and unlike
 *      them it does NOT imply the fact's raw-log/deferred-store bookkeeping
 *      was updated -- the write that failed IS the durability record this
 *      fact was waiting on (see `advanceWatermark` call-site comments below
 *      for the corresponding P1-2 watermark discipline). Any ledger/S8
 *      consumer that reduces over `domain_event_rejected.reason` MUST be
 *      updated to recognize this fourth value alongside the pre-existing
 *      three.
 *
 * SERIAL-BACKLOG UNDER HARD-DOWN PERSISTENCE: because primary-state writes
 * are BLOCKING within the serial FIFO chain (see `withPersistenceRetry`'s
 * own doc comment), a sustained persistence outage does not corrupt
 * ordering or duplicate work -- each queued signal simply pays its own
 * bounded retry loop (up to PERSISTENCE_RETRY_MAX_ATTEMPTS attempts, capped
 * exponential backoff) before the FIFO advances to the next one. The
 * observable cost is a GROWING backlog (every signal queued behind the
 * stuck one waits its full turn) rather than any signal being silently
 * dropped or reordered -- this is Implementation Constraint 11's
 * block-don't-drop tradeoff applied uniformly across the whole queue, not
 * just the write currently retrying.
 */
export const REJECTED_REASON_RETRY_EXHAUSTED = "retry-exhausted";
export const REJECTED_REASON_DEFERRED_TTL_EXPIRED = "deferred-ttl-expired";
/** See the REJECTION VOCABULARY block above (item 4). */
export const REJECTED_REASON_PERSISTENCE_EXHAUSTED = "persistence-exhausted";

/** Exponential (factor `PERSISTENCE_RETRY_BACKOFF_FACTOR`), capped at
 *  `PERSISTENCE_RETRY_MAX_DELAY_MS`, delay to wait after the `attemptNumber`th
 *  (1-based) failed attempt before trying again. */
function persistenceRetryDelayMs(attemptNumber: number): number {
  const raw =
    PERSISTENCE_RETRY_BASE_DELAY_MS *
    PERSISTENCE_RETRY_BACKOFF_FACTOR ** (attemptNumber - 1);
  return Math.min(raw, PERSISTENCE_RETRY_MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Public engine surface
// ---------------------------------------------------------------------------

export type EngineOrigin = "restored" | "welcome";

export interface StartOptions {
  origin: EngineOrigin;
}

export interface ReceiveEngineDeps {
  groupId: string;
  adapter: IngestSource;
  persistence: PersistenceAdapter;
  scheduler: EngineScheduler;
  /** Default 8000ms (fsm.md T_join). */
  tJoinMs?: number;
  /** Default 30000ms -- periodic checkpoint save while `live` (AC-FSM-4). */
  checkpointIntervalMs?: number;
  /** Default `DEFAULT_INGEST_POLICY_OPTIONS` (ingest-policy.ts). */
  ingestPolicyOptions?: IngestPolicyOptions;
}

export interface ReceiveEngine {
  /**
   * Only callable from lifecycle `"uninitialized"` (throws otherwise). See
   * this story's architecture.json judgment calls
   * "l1-l2-restart-routing" and "start-does-not-block-on-an-in-flight-t-join-continuation".
   */
  start(options: StartOptions): Promise<void>;
  /** L10. Idempotent. */
  stop(): Promise<void>;
  /** L11. Callable from any lifecycle. */
  reset(): Promise<void>;
  subscribe(listener: (event: EngineOutputEvent) => void): Unsubscribe;
  getState(): EngineState;
  /**
   * OPTIMISTIC LOCAL ECHO (S11B — engine-boundary realization of spec.md
   * Layer 4's "optimistic local publish intent" the S10 outbox explicitly
   * deferred). Accepts a locally-authored `TaskEvent` into this engine's
   * projection and durable accepted-log IMMEDIATELY — before any relay
   * round-trip — using the SAME deterministic id the publish path already
   * computes for the rumor it is about to send (`rumorId`, via
   * `deriveMlsAcceptedEventId`, an identity function today). Idempotent: a
   * second call with an already-processed `rumorId` (duplicate dispatch, or
   * the id was already accepted via a real `message` signal) is a no-op.
   * Emits the SAME `domain_event_accepted` a remote accept would, so
   * `react-engine-hooks.ts` folds it via the identical `applyEvent` path a
   * remote edit uses (AC-OPT-3 convergence). Durable via the same
   * bounded-backoff `appendAcceptedEventWithRetry` path remote accepts use
   * (AC-OPT-2: survives restart via `buildProjection(replayOrder(acceptedLog))`).
   * Deliberately does NOT append a `RawProtocolFact` or advance
   * `lastIngestedSeq` — see architecture.json judgment call
   * "s11b-no-raw-fact-for-local-accept". Callable at any lifecycle,
   * including before `start()` has resolved (see judgment call
   * "s11b-generation-captured-at-execution-not-call-time") — a dispatch
   * racing engine startup is never silently dropped.
   */
  acceptLocal(rumorId: string, payload: TaskEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal degradation-reason bookkeeping (health is a computed projection
// of this set -- see fsm.md "Health transitions (orthogonal)")
// ---------------------------------------------------------------------------

type DegradationReason =
  | "bootstrap-unresolved"
  | "preserve-and-replay-recovery"
  /** AC-PERS-1 / Implementation Constraint 11 (S6): set while ANY
   *  appendFact/appendAcceptedEvent/acceptDeferredFact/saveCheckpoint
   *  write is failing/retrying. Backed by the numeric `activePersistenceFailures`
   *  ref-count (not plain Set membership) -- see architecture.json
   *  "persistence-retry-shared-degradation-reason-refcounted" for why a
   *  boolean reason would let one write's success incorrectly clear
   *  degraded status while an unrelated write is still failing. */
  | "persistence-write-failing";

const ACTIVE_LIFECYCLES: ReadonlySet<EngineLifecycleState> = new Set([
  "catching_up",
  "buffering_live",
  "live",
  "retrying_deferred",
]);

function taskIdOf(payload: TaskEvent): string {
  return payload.type === "task.created" ? payload.task.id : payload.taskId;
}

function isValidCheckpoint(value: unknown): value is EngineCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.groupId === "string" &&
    typeof c.savedAt === "number" &&
    typeof c.engineState === "string" &&
    (c.lastEpoch === null || typeof c.lastEpoch === "string") &&
    typeof c.lastIngestedSeq === "number" &&
    (c.lastAcceptedDomainEventId === null ||
      typeof c.lastAcceptedDomainEventId === "string") &&
    typeof c.bootstrapCompleted === "boolean"
  );
}

// ---------------------------------------------------------------------------
// createReceiveEngine
// ---------------------------------------------------------------------------

export function createReceiveEngine(deps: ReceiveEngineDeps): ReceiveEngine {
  const { groupId, adapter, persistence, scheduler } = deps;
  const tJoinMs = deps.tJoinMs ?? DEFAULT_T_JOIN_MS;
  const checkpointIntervalMs =
    deps.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
  // `let`, not `const`: reset() (L11) swaps in a fresh instance to clear
  // both the dedupe-processed set and the deferred/retry-budget queue.
  // Every handler below reads the CURRENT binding via closure, so a
  // reassignment here is visible everywhere without threading a setter.
  let ingestPolicy: IngestPolicy = createIngestPolicy(
    deps.ingestPolicyOptions ?? DEFAULT_INGEST_POLICY_OPTIONS,
  );

  // ---- mutable engine state ----
  let lifecycle: EngineLifecycleState = "uninitialized";
  const degradationReasons = new Set<DegradationReason>();
  let lastEpoch: string | null = null;
  let lastIngestedSeq = 0;
  let lastAcceptedDomainEventId: string | null = null;
  let bootstrapCompleted = false;
  // Latched epoch-advance retry request (amended 2026-07-12, S5 Stage-2 cold
  // review -- P2-4 / sev-6): an `epoch_advanced` signal that arrives while
  // the lifecycle is active but NOT `live` (e.g. drained from the buffer
  // while `buffering_live`) used to fall through `handleEpochAdvanced`'s
  // `lifecycle === "live"` guard and be silently dropped -- the deferred
  // queue would then sit unflushed until some LATER, unrelated epoch bump
  // happened to arrive while already live. Instead it is latched here and
  // consumed by `enterLive` (L7): entry action takes L8 immediately if the
  // latch is set and the deferred queue is non-empty. See fsm.md's L8
  // amendment. Cleared by `enterLive` either way (queue empties or the
  // retry pass runs) and by `reset()`.
  let pendingDeferredRetry = false;

  // Per-session GENERATION TOKEN (added 2026-07-12, S5 Stage-2 cold review --
  // sev-9 "lifecycle cancellation"). Bumped synchronously as the FIRST
  // action of every start()/stop()/reset() call. Every long-lived
  // continuation that resumes after an `await` -- drain loops
  // (fetchBootstrap/catchUp/buffering-live/retry-pass), timer callbacks
  // (T_join, periodic checkpoint), and entry-action bodies -- captures the
  // generation value in effect when it BEGAN and re-checks it after every
  // subsequent await/callback fire. A mismatch means a stop()/reset()/newer
  // start() happened in the meantime: the continuation abandons silently
  // (no emission, no persistence write, no lifecycle transition) rather
  // than resurrecting a session the caller believes is gone. This is the
  // sole authority for staleness -- do NOT rely on `scheduler.clearTimeout`
  // or closing the adapter alone, since a timer callback that has already
  // fired (queued as a macrotask) cannot be un-fired by a later
  // `clearTimeout` call; the generation check is what makes that race safe.
  let generation = 0;

  // AC-PERS-1 (S6) persistence-write retry bookkeeping. `activePersistenceFailures`
  // is a ref-count (not plain Set.add/delete) backing the shared
  // "persistence-write-failing" degradation reason -- see
  // architecture.json "persistence-retry-shared-degradation-reason-refcounted".
  // `activeRetryCancellers` tracks every in-flight backoff wait so
  // stop()/reset() can unblock them immediately (both `clearTimeout` the
  // underlying timer AND resolve the wait's promise directly) instead of
  // leaving an awaiting retry loop -- and the serial FIFO chain it may be
  // blocking -- hanging until a real timer eventually elapses. See
  // architecture.json "persistence-retry-generation-token-discipline".
  let activePersistenceFailures = 0;
  const activeRetryCancellers = new Set<() => void>();

  // P1-1 (SEV-8, S6 Stage-2 cold review): monotonic checkpoint-save
  // versioning. `checkpointSaveCounter` is incremented once per
  // `saveCheckpointResilient` INVOCATION (sync attempt or detached retry
  // spawn), never per individual retry attempt within that invocation.
  // `lastCommittedSaveCounter` is bumped to a counter's value only once that
  // counter's write has actually landed in the store. Together these let a
  // stale detached retry (spawned by an OLDER, since-superseded save)
  // recognize -- immediately before EACH of its own retry attempts, not
  // merely at spawn time -- that a NEWER save has already committed, and
  // abort silently rather than overwrite fresher state with an older
  // snapshot. See `saveCheckpointResilient` below.
  let checkpointSaveCounter = 0;
  let lastCommittedSaveCounter = 0;

  let liveBuffer: IngestSignal[] = [];
  let liveUnsubscribe: Unsubscribe | undefined;
  let checkpointTimer: EngineTimerHandle | undefined;
  // The pending T_join timer handle, if any (added alongside the generation
  // token -- sev-9). Cleared (both the scheduler handle AND this reference)
  // by stop()/reset() so a stopped/reset engine holds no live timer;
  // generation-checking inside the callback is the PRIMARY defense (see
  // above), this is a resource-hygiene secondary measure.
  let tJoinTimer: EngineTimerHandle | undefined;
  // Exactly-once invariant guard (amended 2026-07-12, S5 Stage-1 review --
  // sev-6): `adapter.catchUp()` is the sole historical cutover drain and
  // MUST be invoked exactly once per engine start() -- L3/L4/L5 funnel into
  // one `catching_up` entry per start (see engine-types.ts's
  // IngestSource.catchUp doc). Reset to 0 by reset() alongside every other
  // per-start counter below -- SAFE ORDERING (sev-9): the generation bump
  // that opens reset()'s synchronous prefix runs BEFORE this counter reset,
  // and no other code can interleave inside that synchronous prefix (JS is
  // single-threaded/cooperative), so any stale `enterCatchingUp` drain from
  // a PRIOR session that later resumes past its own next `await` will see a
  // mismatched generation and abandon before it could ever observe (let
  // alone re-increment) this freshly-zeroed counter. Generation abandonment
  // makes the old iterator inert first; only then is zeroing the counter
  // safe.
  let catchUpInvocationCount = 0;

  const listeners = new Set<(event: EngineOutputEvent) => void>();

  // Serial processing chain: every signal (historical, buffered-live,
  // direct-live, deferred-retry) is funneled through this single FIFO chain
  // so ordering is preserved even when signals arrive concurrently (e.g. two
  // live pushes back-to-back while lifecycle==="live"). See architecture.json
  // for the ordering rationale.
  let serialQueue: Promise<void> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = serialQueue.then(fn);
    serialQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Generation-guarded variant of `enqueue`: re-checks `gen` immediately
   *  before running `fn`, at the moment this job's FIFO turn actually
   *  arrives (which may be long after it was scheduled, since it waits
   *  behind every earlier job) -- not merely at schedule time. A stale job
   *  (scheduled before a stop()/reset()/newer start()) becomes a silent
   *  no-op instead of running against a session the caller believes is
   *  gone (sev-9). */
  function enqueueGen<T>(gen: number, fn: () => Promise<T>): Promise<T | undefined> {
    return enqueue(async () => {
      if (gen !== generation) return undefined;
      return fn();
    });
  }

  // ---- event emission ----
  function emit(event: EngineOutputEvent): void {
    for (const listener of listeners) listener(event);
  }

  function health(): EngineHealth {
    if (!ACTIVE_LIFECYCLES.has(lifecycle)) return "nominal";
    return degradationReasons.size > 0 ? "degraded" : "nominal";
  }

  function emitStateChanged(): void {
    emit({ type: "engine_state_changed", groupId, state: lifecycle, health: health() });
  }

  function addDegradationReason(reason: DegradationReason): void {
    const before = health();
    degradationReasons.add(reason);
    if (health() !== before) emitStateChanged();
  }

  function clearDegradationReason(reason: DegradationReason): void {
    const before = health();
    degradationReasons.delete(reason);
    if (health() !== before) emitStateChanged();
  }

  // ---- AC-PERS-1 (S6): persistence-write bounded-backoff retry ----

  /** Resolves after `ms`, backed exclusively by the injected `scheduler`
   *  (the file's sole timing authority -- never a raw `setTimeout`).
   *  Tracked in `activeRetryCancellers` so stop()/reset() can force-resolve
   *  it immediately rather than leaving the awaiting caller blocked until a
   *  real timer would otherwise have elapsed. */
  function retryDelay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const handle = scheduler.setTimeout(() => {
        activeRetryCancellers.delete(cancel);
        resolve();
      }, ms);
      const cancel = (): void => {
        scheduler.clearTimeout(handle);
        activeRetryCancellers.delete(cancel);
        resolve();
      };
      activeRetryCancellers.add(cancel);
    });
  }

  /** Called by stop()/reset(), immediately after their own generation bump
   *  (see architecture.json "persistence-retry-generation-token-discipline"):
   *  force-resolves every currently in-flight backoff wait so any
   *  withPersistenceRetry loop blocked on one re-checks `gen !== generation`
   *  on its very next microtask and abandons cleanly, instead of a
   *  stop()/reset() call appearing to hang for up to
   *  PERSISTENCE_RETRY_MAX_DELAY_MS while a real timer elapses. */
  function abandonPendingRetries(): void {
    for (const cancel of Array.from(activeRetryCancellers)) cancel();
  }

  // `exhausted` (added P3-6a alongside REJECTED_REASON_PERSISTENCE_EXHAUSTED)
  // distinguishes a GENUINE give-up (PERSISTENCE_RETRY_MAX_ATTEMPTS spent)
  // from a gen-stale abandonment (stop()/reset()/newer start() mid-retry):
  // only the former should ever surface a `domain_event_rejected` -- a
  // stale abandonment is not this write's failure, it is this SESSION
  // ending, and must stay silent (see each `gen !== generation` return
  // site below).
  type PersistenceRetryOutcome<T> =
    | { ok: true; value: T }
    | { ok: false; exhausted: boolean };

  /**
   * BLOCKING bounded-backoff retry loop for primary-state writes
   * (appendFact/appendAcceptedEvent/acceptDeferredFact/saveDeferredIds --
   * saveDeferredIds joined this family P2-4, S6 Stage-2 cold review) -- the
   * caller `await`s this inline, inside the serial FIFO chain, which is
   * exactly how this design "holds" that signal's processing (design note
   * (c)): no envelope_received/domain_event_accepted emission, no watermark
   * advance, until the write succeeds, the generation goes stale
   * (stop()/reset()), or PERSISTENCE_RETRY_MAX_ATTEMPTS is exhausted. In
   * every one of those non-success outcomes this returns `{ ok: false, ... }`
   * and the CALLER abandons ONLY that one signal -- the FIFO queue itself
   * always resolves and the next enqueued job runs normally (never a
   * permanent deadlock). Exhaustion does NOT clear the shared degradation
   * reason (architecture.json "persistence-retry-exhaustion-disposition"):
   * the engine stays degraded for the rest of this session once any write
   * gives up, since the fact/event was never durably recorded and a later
   * unrelated success cannot itself prove THIS write's problem is gone.
   */
  async function withPersistenceRetry<T>(
    gen: number,
    attempt: () => Promise<T>,
  ): Promise<PersistenceRetryOutcome<T>> {
    let attemptNumber = 1;
    let markedDegraded = false;
    while (true) {
      try {
        const value = await attempt();
        if (gen !== generation) return { ok: false, exhausted: false };
        if (markedDegraded) {
          activePersistenceFailures = Math.max(0, activePersistenceFailures - 1);
          if (activePersistenceFailures === 0) clearDegradationReason("persistence-write-failing");
        }
        return { ok: true, value };
      } catch {
        if (gen !== generation) return { ok: false, exhausted: false };
        if (!markedDegraded) {
          markedDegraded = true;
          activePersistenceFailures += 1;
          addDegradationReason("persistence-write-failing");
        }
        if (attemptNumber >= PERSISTENCE_RETRY_MAX_ATTEMPTS) {
          // Exhausted -- stop retrying THIS write this session; never
          // discard (the fact/event was never durably appended, so its
          // seq watermark never advanced and the relay/catchUp() will
          // redeliver it on the engine's next start()).
          return { ok: false, exhausted: true };
        }
        await retryDelay(persistenceRetryDelayMs(attemptNumber));
        if (gen !== generation) return { ok: false, exhausted: false };
        attemptNumber += 1;
      }
    }
  }

  /** P3-6a: emits the FOURTH rejection-vocabulary reason on a genuine
   *  (non-gen-stale) primary-write exhaustion. Centralized here so every
   *  caller of the four `*WithRetry` wrappers below gets this emission for
   *  free, rather than duplicating the check at each of the ~10 call sites
   *  across handleMessage/handleDeferred/handleMalformed/
   *  handleDeferredRetrySignal. */
  function reportIfExhausted(factId: string, exhausted: boolean): void {
    if (!exhausted) return;
    emit({
      type: "domain_event_rejected",
      factId,
      groupId,
      reason: REJECTED_REASON_PERSISTENCE_EXHAUSTED,
    });
  }

  async function appendFactWithRetry(
    gen: number,
    fact: RawProtocolFactInput,
  ): Promise<AppendFactResult | undefined> {
    const outcome = await withPersistenceRetry(gen, () => persistence.appendFact(fact));
    if (outcome.ok) return outcome.value;
    reportIfExhausted(fact.id, outcome.exhausted);
    return undefined;
  }

  async function appendAcceptedEventWithRetry(
    gen: number,
    event: AcceptedDomainEvent,
  ): Promise<boolean> {
    const outcome = await withPersistenceRetry(gen, () => persistence.appendAcceptedEvent(event));
    if (!outcome.ok) reportIfExhausted(event.factId, outcome.exhausted);
    return outcome.ok;
  }

  async function acceptDeferredFactWithRetry(
    gen: number,
    factId: string,
    event: AcceptedDomainEvent,
  ): Promise<boolean> {
    const outcome = await withPersistenceRetry(gen, () =>
      persistence.acceptDeferredFact(groupId, factId, event),
    );
    if (!outcome.ok) reportIfExhausted(factId, outcome.exhausted);
    return outcome.ok;
  }

  /** P2-4 (S6 Stage-2 cold review): `saveDeferredIds` joined the BLOCKING
   *  retry family -- deferred ids are primary recoverability state (the
   *  ONLY durable record of what is parked; see architecture.md's "Single
   *  deferred truth"), not a best-effort side write. On exhaustion this
   *  does NOT emit REJECTED_REASON_PERSISTENCE_EXHAUSTED (unlike the three
   *  wrappers above) and callers must NOT unwind their drain on `false` --
   *  the in-memory `ingestPolicy` queue still holds the entry regardless of
   *  whether this particular save landed, so a later successful save (the
   *  next signal that touches the same group's deferred queue) or, failing
   *  that, next-start R2's rebuild-from-stale-store plus ordinary live
   *  redelivery recovers it. Callers gate only the SEQ WATERMARK on this
   *  return value where P1-2 durability-before-advance applies (see
   *  `handleDeferred`); they always continue emitting their own signal's
   *  normal output regardless of the boolean here. */
  async function saveDeferredIdsWithRetry(gen: number, ids: string[]): Promise<boolean> {
    const outcome = await withPersistenceRetry(gen, () => persistence.saveDeferredIds(groupId, ids));
    return outcome.ok;
  }

  /**
   * NON-BLOCKING checkpoint write (design note (c): "MUST NOT block the
   * signal chain -- checkpoint is derived state"). Awaits exactly ONE
   * synchronous attempt -- so the success path's call-count/timing is
   * byte-identical to S5's plain `await persistence.saveCheckpoint(...)`
   * (verified against every fsm.test.ts assertion that counts
   * saveCheckpointCalls) -- and only on failure hands off to a DETACHED
   * background withPersistenceRetry() loop that this function's own
   * returned promise never waits for. Always resolves (never rejects).
   *
   * P1-1 (SEV-8, S6 Stage-2 cold review -- "stale checkpoint replay"):
   * previously this took a checkpoint SNAPSHOT as a parameter and the
   * detached retry replayed that same frozen object on every attempt. If a
   * LATER, independent `saveCheckpointResilient` call (a subsequent
   * transition, periodic tick, etc.) landed successfully while the earlier
   * one's retry was still backing off, the stale retry could eventually
   * succeed too and OVERWRITE the fresher checkpoint with the older
   * snapshot -- e.g. regressing a since-flipped `bootstrapCompleted: true`
   * back to `false`. Fixed two ways, both required: (1) the checkpoint is
   * REBUILT from CURRENT engine state at the moment of every individual
   * write attempt (`buildCheckpoint()` is called fresh each time, never
   * passed in), so even a late-firing retry writes at-least-as-current
   * data; (2) `checkpointSaveCounter`/`lastCommittedSaveCounter` additionally
   * guard the WRITE ITSELF: immediately before each retry attempt -- i.e.
   * every time `withPersistenceRetry`'s loop invokes this attempt function,
   * not merely once at spawn time -- the attempt checks whether a
   * higher-numbered save has already committed and, if so, silently aborts
   * without calling `persistence.saveCheckpoint` at all, rather than racing
   * a demonstrably-stale write against the store.
   */
  function saveCheckpointResilient(gen: number): Promise<void> {
    const myCounter = ++checkpointSaveCounter;
    return persistence.saveCheckpoint(buildCheckpoint()).then(
      () => {
        if (myCounter > lastCommittedSaveCounter) lastCommittedSaveCounter = myCounter;
      },
      () => {
        if (gen !== generation) return;
        void withPersistenceRetry(gen, async () => {
          // Re-checked on EVERY attempt (this function is `attempt` inside
          // withPersistenceRetry's while loop, invoked once per iteration):
          // stop()/reset() abandonment is covered by withPersistenceRetry's
          // own post-attempt `gen` check, and staleness relative to a
          // NEWER save is covered here, before any I/O is issued.
          if (gen !== generation) return;
          if (myCounter <= lastCommittedSaveCounter) return; // newer save already committed -- abort silently
          await persistence.saveCheckpoint(buildCheckpoint());
          if (myCounter > lastCommittedSaveCounter) lastCommittedSaveCounter = myCounter;
        });
      },
    );
  }

  // ---- checkpoint persistence ----
  function buildCheckpoint(): EngineCheckpoint {
    return {
      groupId,
      savedAt: scheduler.now(),
      engineState: lifecycle,
      lastEpoch,
      lastIngestedSeq,
      lastAcceptedDomainEventId,
      bootstrapCompleted,
    };
  }

  /** Schedules the next periodic checkpoint save while `live` (AC-FSM-4).
   *  `gen` is captured at schedule time; the callback (a continuation that
   *  resumes on an unrelated future tick, possibly long after a
   *  stop()/reset()) re-checks it both before AND after its own await, and
   *  only re-arms the next tick if still current -- an orphaned chain from
   *  a stopped/reset session self-terminates instead of looping forever
   *  (sev-9, P3 item (c)). */
  function scheduleNextPeriodicCheckpoint(gen: number): void {
    checkpointTimer = scheduler.setTimeout(() => {
      void (async () => {
        if (gen !== generation) return;
        await saveCheckpointResilient(gen);
        if (gen !== generation) return;
        if (lifecycle === "live") scheduleNextPeriodicCheckpoint(gen);
      })();
    }, checkpointIntervalMs);
  }

  function manageCheckpointTimer(newLifecycle: EngineLifecycleState, gen: number): void {
    if (checkpointTimer !== undefined) {
      scheduler.clearTimeout(checkpointTimer);
      checkpointTimer = undefined;
    }
    if (newLifecycle === "live") scheduleNextPeriodicCheckpoint(gen);
  }

  /** Low-level state-set primitive: updates `lifecycle`, (re)manages the
   *  periodic-checkpoint timer, emits `engine_state_changed`, and -- unless
   *  explicitly skipped (reset()'s final transition) -- persists a
   *  checkpoint. Every named L1-L11 transition function below calls this
   *  plus whatever additional entry-action side effects that transition
   *  requires (AC-FSM-4: saveCheckpoint at least once per transition).
   *  `gen` is re-checked at entry (sev-9): a stale caller that raced past
   *  its own earlier check with no intervening await cannot exist (JS is
   *  single-threaded), but every caller of transitionTo already re-checks
   *  after its own prior await before calling in -- this entry check is a
   *  defense-in-depth backstop, not the primary guard. */
  async function transitionTo(
    gen: number,
    newLifecycle: EngineLifecycleState,
    opts?: { skipCheckpointSave?: boolean },
  ): Promise<void> {
    if (gen !== generation) return;
    lifecycle = newLifecycle;
    manageCheckpointTimer(newLifecycle, gen);
    emitStateChanged();
    if (!opts?.skipCheckpointSave) {
      await saveCheckpointResilient(gen);
    }
  }

  function advanceWatermark(seq: number): void {
    if (seq > lastIngestedSeq) lastIngestedSeq = seq;
  }

  function shouldBufferLiveSignal(): boolean {
    return lifecycle === "catching_up" || lifecycle === "buffering_live";
  }

  // ---- shared per-signal handler (historical drain, buffer drain, direct
  // live application, and recovery-gap R3 resubmission all route through
  // this) ----
  // `gen` (sev-9): the generation captured by the LOOP that enqueued this
  // job -- re-checked here immediately after every internal `await` before
  // any emission/persistence write, so a stop()/reset() that lands WHILE a
  // signal is mid-flight (not merely between signals) also silently
  // aborts the remainder of this signal's processing.
  async function processSignal(signal: IngestSignal, gen: number): Promise<void> {
    switch (signal.type) {
      case "message":
        await handleMessage(signal, gen);
        return;
      case "deferred":
        await handleDeferred(signal, gen);
        return;
      case "skipped":
        await handleSkipped(signal, gen);
        return;
      case "malformed":
        await handleMalformed(signal, gen);
        return;
      case "epoch_advanced":
        await handleEpochAdvanced(signal, gen);
        return;
    }
  }

  async function handleMessage(
    signal: Extract<IngestSignal, { type: "message" }>,
    gen: number,
  ): Promise<void> {
    const appended = await appendFactWithRetry(gen, signal.fact);
    if (appended === undefined) return; // gen-stale abandon or AC-PERS-1 exhaustion give-up
    if (gen !== generation) return;
    const { fact } = appended;
    // P1-2 (SEV-8, S6 Stage-2 cold review -- "watermark-before-durability"):
    // `advanceWatermark` MUST NOT run here (immediately after the raw-fact
    // append) as it used to. The invariant is "lastIngestedSeq covers a
    // fact ONLY once its outcome is durable" -- for a fresh `message` signal
    // the outcome is the accepted-log entry (or deferred-store entry, on the
    // un-park branch below), NOT merely the raw-fact append. Advancing here
    // unconditionally meant an accepted-write that later exhausted its
    // retry budget left the watermark ALREADY past this fact's seq, so R3
    // would never re-submit it on the next restart even though no
    // `AcceptedDomainEvent` was ever durably recorded -- silent data loss.
    // See the per-branch `advanceWatermark` calls below.
    emit({ type: "envelope_received", factId: fact.id, groupId });

    const sourceKind =
      signal.receiptSource === "bootstrap-kind-30078"
        ? ("bootstrap-kind-30078" as const)
        : ("mls-rumor" as const);
    const eventId =
      sourceKind === "bootstrap-kind-30078"
        ? deriveBootstrapAcceptedEventId(groupId, taskIdOf(signal.payload))
        : deriveMlsAcceptedEventId(signal.rumorId);

    if (ingestPolicy.hasProcessed(eventId)) {
      // Already durably accepted in a prior pass -- nothing new to write,
      // so covering this fact's seq now is safe.
      advanceWatermark(fact.seq);
      return;
    }

    const event: AcceptedDomainEvent = {
      id: eventId,
      factId: fact.id,
      sourceKind,
      groupId,
      acceptedAt: scheduler.now(),
      epoch: signal.epoch,
      payload: signal.payload,
    };

    // R-INV-3 / sev-6 (S5 Stage-2 cold review): this fact may currently be
    // PARKED (a prior delivery was unreadable/epoch-mismatched and enqueued
    // it into the deferred queue) yet still arrive here readable via an
    // ordinary live push or catchUp() re-delivery -- NOT via the L8/L9
    // retry pass. Route acceptance through the SAME single entry point
    // (`acceptDeferredFact`) the retry pass uses, mirroring
    // `handleMalformed`'s defensive un-park below: otherwise the deferred
    // queue and `deferred-store` would silently retain an id that has
    // already been accepted, and a later epoch_advanced would needlessly
    // resubmit it via L8.
    const wasParked = ingestPolicy.hasDeferred(fact.id);
    if (wasParked) {
      const accepted = await acceptDeferredFactWithRetry(gen, fact.id, event);
      if (gen !== generation) return;
      if (!accepted) return; // NOT durable -- watermark stays behind; R3 resubmits this fact next start
      ingestPolicy.removeDeferred(fact.id);
      await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
      if (gen !== generation) return;
    } else {
      const appendedEvent = await appendAcceptedEventWithRetry(gen, event);
      if (gen !== generation) return;
      if (!appendedEvent) return; // NOT durable -- watermark stays behind; R3 resubmits this fact next start
    }
    ingestPolicy.markProcessed(eventId);
    lastAcceptedDomainEventId = eventId;
    advanceWatermark(fact.seq); // NOW durable -- accepted-log entry has landed
    emit({ type: "domain_event_accepted", event });
  }

  async function handleDeferred(
    signal: Extract<IngestSignal, { type: "deferred" }>,
    gen: number,
  ): Promise<void> {
    const appended = await appendFactWithRetry(gen, signal.fact);
    if (appended === undefined) return;
    if (gen !== generation) return;
    const { fact } = appended;
    emit({ type: "envelope_received", factId: fact.id, groupId });

    const isNew = ingestPolicy.enqueueDeferred(
      fact.id,
      fact,
      signal.reason,
      scheduler.now(),
    );
    // P1-2 (SEV-8): this fact's durable outcome is the deferred-store entry
    // -- `deferredDurable` tracks whether that outcome has actually landed
    // (already true if this id was already parked from a prior save; only
    // conditional on a FRESH save's success otherwise). The watermark only
    // advances once `deferredDurable`; on saveDeferredIds exhaustion we
    // still emit `envelope_deferred` normally (P2-4: never unwind the
    // drain -- the in-memory queue holds the entry regardless), we simply
    // leave the watermark behind so R3 also resubmits this raw fact next
    // start (harmless -- it re-derives "still unreadable" and re-parks it).
    let deferredDurable = !isNew;
    if (isNew) {
      deferredDurable = await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
      if (gen !== generation) return;
    }
    if (deferredDurable) advanceWatermark(fact.seq);
    emit({
      type: "envelope_deferred",
      factId: fact.id,
      groupId,
      reason: signal.reason,
    });
  }

  async function handleSkipped(
    signal: Extract<IngestSignal, { type: "skipped" }>,
    gen: number,
  ): Promise<void> {
    const appended = await appendFactWithRetry(gen, signal.fact);
    if (appended === undefined) return;
    if (gen !== generation) return;
    const { fact } = appended;
    // P1-2 asymmetry (deliberate, SEV-8 disposition): "skipped" has no
    // separate durable outcome beyond the raw-fact append itself -- a
    // re-ingest of the SAME raw fact after a restart deterministically
    // re-derives "ratchet already consumed this id" and re-emits the
    // identical group_ratchet_advanced signal, so advancing the watermark
    // immediately (before this in-memory emission) is safe: there is
    // nothing further that could fail to land durably.
    advanceWatermark(fact.seq);
    emit({ type: "envelope_received", factId: fact.id, groupId });
    // "skipped" == the ratchet already consumed this id (own-echo/duplicate):
    // no new domain content, so this is the ratchet-advance signal, NEVER
    // the deferred-retry trigger (I-FSM-6 / AC-FSM-6).
    emit({ type: "group_ratchet_advanced", groupId });
  }

  async function handleMalformed(
    signal: Extract<IngestSignal, { type: "malformed" }>,
    gen: number,
  ): Promise<void> {
    const appended = await appendFactWithRetry(gen, signal.fact);
    if (appended === undefined) return;
    if (gen !== generation) return;
    const { fact } = appended;
    // P1-2 asymmetry (deliberate, SEV-8 disposition): like "skipped",
    // "malformed" has no durable outcome beyond the raw-fact append --
    // parse_error is terminal (never parked, never retried), so a re-ingest
    // of the same raw fact after a restart deterministically re-classifies
    // malformed and re-emits the identical rejection. Advancing before this
    // in-memory `domain_event_rejected` emission (rather than after) is
    // therefore safe -- unlike the fresh-accept/defer paths, there is no
    // separate store write whose success this watermark advance could be
    // getting ahead of.
    advanceWatermark(fact.seq);
    emit({ type: "envelope_received", factId: fact.id, groupId });
    // parse_error is terminal: never parked, never retried (I-FSM-6 covers
    // only unreadable/epoch_mismatch). Defensively un-park it in case an
    // earlier delivery of the same fact was parked as "unreadable" and a
    // later re-delivery decrypts but fails to decode.
    if (ingestPolicy.hasDeferred(fact.id)) {
      ingestPolicy.removeDeferred(fact.id);
      await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
      if (gen !== generation) return;
    }
    emit({
      type: "domain_event_rejected",
      factId: fact.id,
      groupId,
      reason: "parse_error",
    });
  }

  async function handleEpochAdvanced(
    signal: Extract<IngestSignal, { type: "epoch_advanced" }>,
    gen: number,
  ): Promise<void> {
    lastEpoch = signal.newEpoch;
    emit({
      type: "group_epoch_advanced",
      groupId,
      newEpoch: signal.newEpoch,
      prevEpoch: signal.prevEpoch,
    });
    if (lifecycle === "live") {
      if (ingestPolicy.deferredSize > 0) {
        await enterRetryingDeferred(gen);
      }
    } else {
      // Non-live active lifecycle: LATCH the request instead of dropping it
      // -- fsm.md's L8 amendment (P2-4, sev-6). Two distinct latch-setting
      // situations land here, consumed by two distinct sites (P2-3, SEV-7,
      // S6 Stage-2 cold review -- fixed the comment that used to claim only
      // ONE consumer):
      //   1. Drained from the live buffer while still `buffering_live` (or
      //      any other non-live, non-retrying lifecycle) -- consumed by
      //      `enterLive` (L7), which takes L8 immediately on reaching live
      //      if the latch is set and the queue is non-empty.
      //   2. A NESTED epoch_advanced observed WHILE ALREADY mid retry pass
      //      (lifecycle === "retrying_deferred", routed here via
      //      `handleDeferredRetrySignal`'s "epoch_advanced" case) --
      //      consumed by `enterRetryingDeferred`'s own loop (L9 amendment),
      //      which re-runs another pass before transitioning back to live
      //      rather than leaving this latch to rot until some LATER,
      //      unrelated epoch bump happens to arrive while already live.
      pendingDeferredRetry = true;
    }
  }

  // ---- deferred-retry pass (L8 -> L9), using
  // PersistenceAdapter.acceptDeferredFact for the deferred->accepted
  // transition per its single-entry-point contract ----
  async function handleDeferredRetrySignal(signal: IngestSignal, gen: number): Promise<void> {
    switch (signal.type) {
      case "message": {
        const appended = await appendFactWithRetry(gen, signal.fact);
        if (appended === undefined) return;
        if (gen !== generation) return;
        const { fact } = appended;
        // P1-2 (SEV-8): as in handleMessage, do NOT advance here -- the
        // durable outcome is the accepted-log entry, landed only via
        // `acceptDeferredFactWithRetry` below.
        emit({ type: "envelope_received", factId: fact.id, groupId });

        const sourceKind =
          signal.receiptSource === "bootstrap-kind-30078"
            ? ("bootstrap-kind-30078" as const)
            : ("mls-rumor" as const);
        const eventId =
          sourceKind === "bootstrap-kind-30078"
            ? deriveBootstrapAcceptedEventId(groupId, taskIdOf(signal.payload))
            : deriveMlsAcceptedEventId(signal.rumorId);

        if (!ingestPolicy.hasProcessed(eventId)) {
          const event: AcceptedDomainEvent = {
            id: eventId,
            factId: fact.id,
            sourceKind,
            groupId,
            acceptedAt: scheduler.now(),
            epoch: signal.epoch,
            payload: signal.payload,
          };
          const accepted = await acceptDeferredFactWithRetry(gen, fact.id, event);
          if (gen !== generation) return;
          if (!accepted) {
            // AC-PERS-1: the write never durably landed -- leave this entry
            // PARKED (do NOT fall through to the unconditional removal
            // below) so it is retried on a future L8/L9 pass, eventually
            // exhausted via ingest-policy's own attempt budget (S6 ledger
            // obligation 2) rather than silently discarded here. Watermark
            // stays behind too (P1-2) -- R3 also resubmits this fact next
            // start if the engine stops before a later pass ever succeeds.
            //
            // P3-6c (attempt-refund): `runDeferredRetryPass` already
            // charged this entry's DECRYPT retry budget via `recordAttempt`
            // before this pass began -- but THIS signal is the "message"
            // variant, proving decrypt already succeeded. The failure here
            // is entirely on the PERSISTENCE side (`acceptDeferredFact`), so
            // refund the charge: a transient persistence outage must never
            // be misreported as "this fact's ciphertext is unrecoverable"
            // (REJECTED_REASON_RETRY_EXHAUSTED) via attempts consumed by
            // passes that never even got to test decryptability.
            ingestPolicy.refundAttempt(fact.id);
            return;
          }
          ingestPolicy.markProcessed(eventId);
          lastAcceptedDomainEventId = eventId;
          advanceWatermark(fact.seq); // NOW durable
          emit({ type: "domain_event_accepted", event });
        } else {
          // Already durably accepted in a prior pass -- safe to cover now.
          advanceWatermark(fact.seq);
        }
        // sev-6 fix: whichever branch above ran, the in-memory removal below
        // must ALSO be reflected in `deferred-store` -- previously the
        // `hasProcessed` (dedupe-hit) branch removed the in-memory entry but
        // never called `saveDeferredIds`, leaving the persisted store
        // pointing at an id the in-memory policy had already forgotten (a
        // crash before the next unrelated save would resurrect it as
        // "still parked" on restart).
        ingestPolicy.removeDeferred(fact.id);
        await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
        if (gen !== generation) return;
        return;
      }
      case "deferred": {
        const appended = await appendFactWithRetry(gen, signal.fact);
        if (appended === undefined) return;
        if (gen !== generation) return;
        const { fact } = appended;
        // P1-2 asymmetry: still unreadable, remains queued (already present
        // in deferred-store from a prior save) -- nothing NEW to persist
        // here, so advancing immediately is safe (matches handleDeferred's
        // "already durable" branch for a re-park of an already-parked id).
        advanceWatermark(fact.seq);
        emit({ type: "envelope_received", factId: fact.id, groupId });
        emit({
          type: "envelope_deferred",
          factId: fact.id,
          groupId,
          reason: signal.reason,
        });
        return;
      }
      case "skipped": {
        const appended = await appendFactWithRetry(gen, signal.fact);
        if (appended === undefined) return;
        if (gen !== generation) return;
        const { fact } = appended;
        // P1-2 asymmetry (see handleSkipped's identical comment): no
        // separate durable outcome beyond the raw-fact append; safe to
        // advance immediately.
        advanceWatermark(fact.seq);
        emit({ type: "envelope_received", factId: fact.id, groupId });
        emit({ type: "group_ratchet_advanced", groupId });
        ingestPolicy.removeDeferred(fact.id);
        await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
        if (gen !== generation) return;
        return;
      }
      case "malformed": {
        const appended = await appendFactWithRetry(gen, signal.fact);
        if (appended === undefined) return;
        if (gen !== generation) return;
        const { fact } = appended;
        // P1-2 asymmetry (see handleMalformed's identical comment): terminal,
        // no separate durable outcome; safe to advance immediately.
        advanceWatermark(fact.seq);
        emit({ type: "envelope_received", factId: fact.id, groupId });
        emit({
          type: "domain_event_rejected",
          factId: fact.id,
          groupId,
          reason: "parse_error",
        });
        ingestPolicy.removeDeferred(fact.id);
        await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
        if (gen !== generation) return;
        return;
      }
      case "epoch_advanced":
        await handleEpochAdvanced(signal, gen);
        return;
    }
  }

  async function runDeferredRetryPass(
    gen: number,
    batch: DeferredPolicyEntry[],
  ): Promise<void> {
    if (batch.length === 0) return;
    for (const entry of batch) ingestPolicy.recordAttempt(entry.factId);
    const facts: RawProtocolFact[] = batch.map((entry) => entry.fact);
    // NOT routed through enqueue(): runDeferredRetryPass only ever runs as
    // part of a job ALREADY executing inside the serial chain (it is called
    // from handleEpochAdvanced, which processSignal only ever reaches via
    // enqueue()). Re-entering enqueue() here would chain a new job onto
    // `serialQueue` behind the very job that is awaiting it -- a deadlock,
    // since that job cannot resolve until this nested job runs, and this
    // nested job cannot start until the outer one resolves. Calling the
    // handler directly is safe and correct: we already hold exclusive
    // execution (no other job can run concurrently while we're mid-flight),
    // and any NEW signal arriving concurrently (e.g. a live push during this
    // pass) still goes through the top-level enqueue() and correctly waits
    // its turn behind this one.
    for await (const signal of adapter.ingestPersisted(facts)) {
      if (gen !== generation) return;
      await handleDeferredRetrySignal(signal, gen);
      if (gen !== generation) return;
    }
  }

  /** S6 ledger obligation 1: prunes TTL-expired deferred entries (ahead of
   *  computing the retry-eligible batch, so an aged-out entry is never
   *  resubmitted or counted against its own retry budget one last time),
   *  persists the resulting id list, and reports each pruned entry via
   *  domain_event_rejected{reason: REJECTED_REASON_DEFERRED_TTL_EXPIRED} --
   *  see architecture.json "deferred-ttl-prune-invocation-point" for why
   *  this is the ONLY invocation point (no periodic timer). */
  async function pruneAndReportTtlExpired(gen: number): Promise<void> {
    const pruned = ingestPolicy.pruneDeferred(scheduler.now());
    if (pruned.length === 0) return;
    await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
    if (gen !== generation) return;
    for (const entry of pruned) {
      emit({
        type: "domain_event_rejected",
        factId: entry.factId,
        groupId,
        reason: REJECTED_REASON_DEFERRED_TTL_EXPIRED,
      });
    }
  }

  /** S6 ledger obligation 2: after a retry pass, entries whose ingest-policy
   *  ATTEMPT budget is now exhausted (retryBatch() already excludes them
   *  from future passes, but previously nothing evicted or reported them --
   *  they rotted in the queue forever) are removed, persisted, and reported
   *  via domain_event_rejected{reason: REJECTED_REASON_RETRY_EXHAUSTED}. See
   *  architecture.json "exhausted-entry-cleanup-runs-after-every-retry-pass". */
  async function reportAndRemoveExhausted(gen: number): Promise<void> {
    const exhausted = ingestPolicy.exhaustedEntries();
    if (exhausted.length === 0) return;
    for (const entry of exhausted) ingestPolicy.removeDeferred(entry.factId);
    await saveDeferredIdsWithRetry(gen, ingestPolicy.deferredFactIds());
    if (gen !== generation) return;
    for (const entry of exhausted) {
      emit({
        type: "domain_event_rejected",
        factId: entry.factId,
        groupId,
        reason: REJECTED_REASON_RETRY_EXHAUSTED,
      });
    }
  }

  /**
   * P2-3 (SEV-7, S6 Stage-2 cold review -- "L9 latch consumption",
   * fsm.md conformance): a nested `epoch_advanced` yielded by
   * `adapter.ingestPersisted` INSIDE a retry pass (`handleDeferredRetrySignal`'s
   * "epoch_advanced" case routes to `handleEpochAdvanced`, which -- since
   * lifecycle is "retrying_deferred", i.e. non-live, for the whole duration
   * of this function -- always takes the LATCH branch, setting
   * `pendingDeferredRetry`) used to be silently stranded: this function's
   * old body transitioned straight back to "live" via `transitionTo`
   * (never `enterLive`, which is the only other latch-consumer), so the
   * latch sat unconsumed until some LATER, unrelated epoch bump happened to
   * arrive while already live. Fixed by looping: after each pass, if the
   * latch is set AND the queue is still non-empty, run ANOTHER pass before
   * ever transitioning back to live -- consuming the latch internally
   * rather than leaving it for a consumer that is never called from this
   * path. Bounded/terminating: each iteration either drains entries
   * (`recordAttempt`s consumed, batch shrinks) or exhausts budgets
   * (`reportAndRemoveExhausted` evicts them), so a queue that cannot ever
   * be fully retried converges to empty or fully-exhausted within a finite
   * number of passes even under a pathological stream of nested advances.
   */
  async function enterRetryingDeferred(gen: number): Promise<void> {
    if (gen !== generation) return;
    let everEnteredRetrying = false;
    for (;;) {
      await pruneAndReportTtlExpired(gen);
      if (gen !== generation) return;
      // Compute the ACTUAL retry-eligible batch up front (excludes entries
      // that have exhausted their retry budget -- see ingest-policy.ts's
      // `retryBatch`/`isExhausted`) rather than trusting `deferredSize`, and
      // skip the L8/L9 transition ENTIRELY when it is empty (P3 batch item
      // (a), S5 Stage-2 cold review): a parked queue that is non-empty but
      // fully exhausted has nothing left to retry, so round-tripping
      // through `retrying_deferred` would be an empty, observably pointless
      // transition pair.
      const batch = ingestPolicy.retryBatch();
      if (batch.length > 0) {
        if (!everEnteredRetrying) {
          await transitionTo(gen, "retrying_deferred");
          if (gen !== generation) return;
          everEnteredRetrying = true;
        }
        // `deferred_retry_started.count` reports the batch actually about
        // to be retried, not the raw parked-queue size (which may include
        // exhausted entries not in this pass). Emitted once per PASS (not
        // once per call), so a nested-advance-triggered second pass emits
        // its own `deferred_retry_started` with its own batch count.
        emit({ type: "deferred_retry_started", groupId, count: batch.length });
        await runDeferredRetryPass(gen, batch);
        if (gen !== generation) return;
      }
      await reportAndRemoveExhausted(gen);
      if (gen !== generation) return;

      if (pendingDeferredRetry && ingestPolicy.deferredSize > 0) {
        // A nested epoch_advanced latched mid-pass and there is still
        // something to retry -- consume the latch and loop for another
        // pass instead of transitioning back to live with it unconsumed.
        pendingDeferredRetry = false;
        continue;
      }
      pendingDeferredRetry = false;
      break;
    }
    if (everEnteredRetrying) {
      await transitionTo(gen, "live");
    }
  }

  // ---- cutover protocol (catching_up -> buffering_live -> live) ----
  async function enterCatchingUp(gen: number): Promise<void> {
    if (gen !== generation) return;
    await transitionTo(gen, "catching_up");
    if (gen !== generation) return;
    // AC-PERS-2 (Implementation Constraint 12), S11: the
    // "preserve-and-replay-recovery" degradation reason (set by
    // enterRecovering's viaPreserveAndReplay arm, see that function's
    // comment) is cleared HERE, not in enterRecovering. transitionTo's own
    // emitStateChanged() fires SYNCHRONOUSLY, before its awaited checkpoint
    // save -- so with the reason still present at that moment, the FIRST
    // catching_up engine_state_changed event correctly reports
    // health:"degraded" (catching_up IS an ACTIVE lifecycle, unlike
    // recovering). The transitionTo call immediately above has, by the time
    // we reach this line, already awaited its own checkpoint save to
    // completion -- so clearing now satisfies "until the first successful
    // checkpoint save" and emits a second engine_state_changed reporting
    // health:"nominal" once that save has landed. No-op (nothing to clear)
    // for the ordinary joining->catching_up paths (L4/L5), which never add
    // this reason.
    clearDegradationReason("preserve-and-replay-recovery");
    liveBuffer = [];
    liveUnsubscribe = adapter.openLive((signal) => {
      if (gen !== generation) return;
      if (shouldBufferLiveSignal()) {
        liveBuffer.push(signal);
      } else {
        void enqueueGen(gen, () => processSignal(signal, gen));
      }
    });
    // Exactly-once invariant: L3/L4/L5 all funnel into this single
    // catching_up entry point per start(), so catchUp() must never be
    // called more than once here. This throws rather than silently
    // tolerating a second concurrent drain because group.ingest() is
    // stateful and cannot support two concurrent historical iterators.
    // Guarded on `gen` above/below: a STALE `enterCatchingUp` continuation
    // can never reach this increment (sev-9), so it can never spuriously
    // trip this invariant against a freshly-started session's own count.
    catchUpInvocationCount += 1;
    if (catchUpInvocationCount > 1) {
      throw new Error(
        "receive-engine: invariant violation -- adapter.catchUp() invoked " +
          `${catchUpInvocationCount} times for a single engine start() (expected exactly once)`,
      );
    }
    // P2-4 (S6 Stage-2 cold review) containment, mirroring runBootstrapFetch's
    // existing try/catch: ordinary persistence-write failures reaching this
    // drain (appendFact/appendAcceptedEvent/acceptDeferredFact/
    // saveDeferredIds, all now via withPersistenceRetry) never throw --
    // withPersistenceRetry resolves `{ ok: false, ... }` on exhaustion or
    // gen-staleness rather than rejecting -- so this is a defensive
    // backstop against the historical drain's OWN failure (`adapter.catchUp()`
    // itself throwing) or any other unexpected exception, not the primary
    // path for a degraded-but-recovering write. Without it, such an
    // exception would propagate out of this function uncaught, abandoning
    // the drain mid-stream and leaving the engine permanently wedged in
    // "catching_up" while `getState().health` still reports "nominal"
    // (misleadingly, since no degradation reason was ever added for THIS
    // failure) -- "no unhandled rejection can strand the engine
    // wedged-nominal".
    try {
      for await (const signal of adapter.catchUp()) {
        if (gen !== generation) return;
        await enqueueGen(gen, () => processSignal(signal, gen));
        if (gen !== generation) return;
      }
    } catch {
      if (gen !== generation) return;
      addDegradationReason("persistence-write-failing");
      return;
    }
    await enterBufferingLive(gen);
  }

  async function enterBufferingLive(gen: number): Promise<void> {
    if (gen !== generation) return;
    await transitionTo(gen, "buffering_live");
    if (gen !== generation) return;
    while (liveBuffer.length > 0) {
      const signal = liveBuffer.shift()!;
      await enqueueGen(gen, () => processSignal(signal, gen));
      if (gen !== generation) return;
    }
    await enterLive(gen);
  }

  async function enterLive(gen: number): Promise<void> {
    if (gen !== generation) return;
    await transitionTo(gen, "live");
    if (gen !== generation) return;
    emit({ type: "recovered", groupId });
    if (pendingDeferredRetry) {
      // Consume the latch either way it resolves: the queue has since
      // emptied (nothing to do), or it hasn't (take L8 immediately) -- both
      // are "the latch has been handled" (fsm.md L8 amendment).
      pendingDeferredRetry = false;
      if (ingestPolicy.deferredSize > 0) {
        await enterRetryingDeferred(gen);
      }
    }
  }

  // ---- joining (L2, L4, L5) ----
  async function enterJoining(gen: number): Promise<void> {
    if (gen !== generation) return;
    bootstrapCompleted = false;
    await transitionTo(gen, "joining");
    if (gen !== generation) return;
    await runBootstrapFetch(gen);
  }

  /**
   * Drains `adapter.fetchBootstrap()` -- the DEDICATED joining-phase
   * bootstrap channel (amended 2026-07-12, S5 Stage-1 review -- sev-6),
   * NOT `adapter.catchUp()`. `catchUp()` is reserved exclusively for the
   * catching_up cutover drain (see `enterCatchingUp`'s exactly-once
   * invariant) -- the original design raced `catchUp()` itself against
   * `T_join` and, on timeout, called `enterCatchingUp()` which invoked a
   * SECOND, concurrent `catchUp()` iterator: unimplementable, since
   * `group.ingest()` is stateful and cannot support two concurrent
   * historical drains. `fetchBootstrap()` decrypts via NIP-44 and never
   * touches the MLS ratchet, so it is safe for it to keep running in the
   * background, overlapping `catchUp()`/`openLive()`, past a T_join
   * timeout -- its signals still route through the normal serial
   * `processSignal` chain (persist fact + emit `domain_event_accepted` as
   * bootstrap events; idempotent + LWW-safe merge at fold time) whenever
   * they arrive, pre- or post-cutover.
   */
  async function runBootstrapFetch(gen: number): Promise<void> {
    if (gen !== generation) return;
    let timerFired = false;
    // T_join timer handle (sev-9): stored in `tJoinTimer` so stop()/reset()
    // can cancel it, AND `gen`-checked inside the callback -- the callback
    // itself is the PRIMARY defense (a real clearTimeout cannot un-fire a
    // callback that has already been queued to run, so cancellation alone
    // is not sufficient to prevent a post-stop() resurrection).
    const timerHandle = scheduler.setTimeout(() => {
      timerFired = true;
      if (tJoinTimer === timerHandle) tJoinTimer = undefined;
      void (async () => {
        if (gen !== generation) return;
        addDegradationReason("bootstrap-unresolved");
        await enterCatchingUp(gen);
      })();
    }, tJoinMs);
    tJoinTimer = timerHandle;

    try {
      for await (const signal of adapter.fetchBootstrap()) {
        if (gen !== generation) return;
        await enqueueGen(gen, () => processSignal(signal, gen));
        if (gen !== generation) return;
      }
      if (gen !== generation) return;
      if (!timerFired) {
        scheduler.clearTimeout(timerHandle);
        if (tJoinTimer === timerHandle) tJoinTimer = undefined;
        bootstrapCompleted = true;
        await enterCatchingUp(gen);
      } else {
        // Late resolve after L5 already taken: background bootstrap
        // succeeded (H2 late-merge). bootstrapCompleted flips here -- on
        // the fetchBootstrap drain's own completion, whether pre- or
        // post-timeout -- never on catchUp() completion, which is a
        // distinct, unrelated drain.
        bootstrapCompleted = true;
        clearDegradationReason("bootstrap-unresolved");
        await saveCheckpointResilient(gen);
        if (gen !== generation) return;
      }
    } catch {
      if (gen !== generation) return;
      if (!timerFired) {
        scheduler.clearTimeout(timerHandle);
        if (tJoinTimer === timerHandle) tJoinTimer = undefined;
        addDegradationReason("bootstrap-unresolved");
        await enterCatchingUp(gen);
      }
      // else: background bootstrap failed AFTER the timeout already fired --
      // fsm.md: "a re-fetch is attempted on the next live-subscription
      // reconnect", out of this story's scope. Swallowed without crashing.
    }
  }

  // ---- recovering (L1) ----
  async function enterRecovering(
    gen: number,
    usableCheckpoint: EngineCheckpoint | null,
    viaPreserveAndReplay: boolean,
  ): Promise<void> {
    if (gen !== generation) return;
    if (viaPreserveAndReplay) {
      lastIngestedSeq = 0;
      lastEpoch = null;
      lastAcceptedDomainEventId = null;
      // Re-infer bootstrapCompleted=true IMMEDIATELY on taking this arm,
      // BEFORE any checkpoint is saved (architecture.md Constraint 12,
      // revised 2026-07-12, S5 Stage-2 cold review -- P2-1; sev-7).
      // Rationale (Constraint 12's own): accepted events only exist after a
      // completed-or-replayable bootstrap, and the kind-30078 snapshot fact
      // itself lives in the raw log, regenerated idempotently by R3 if the
      // original bootstrap was partial -- so this is both SAFE and
      // NECESSARY to set now rather than deferring to `enterLive`. The
      // prior "re-infer on reaching live" wording left a window where a
      // crash mid-recovery (after this function's own first checkpoint
      // save, before ever reaching live) would have already persisted
      // `bootstrapCompleted: false`, which poisons the NEXT restart's L1/L2
      // routing straight back to L2 joining over non-empty logs.
      bootstrapCompleted = true;
      addDegradationReason("preserve-and-replay-recovery");
    } else {
      const checkpoint = usableCheckpoint!;
      lastIngestedSeq = checkpoint.lastIngestedSeq;
      lastEpoch = checkpoint.lastEpoch;
      lastAcceptedDomainEventId = checkpoint.lastAcceptedDomainEventId;
      bootstrapCompleted = true;
    }
    await transitionTo(gen, "recovering");
    if (gen !== generation) return;
    // AC-PERS-2 conformance (S11, architecture.json judgment call
    // "ac-pers-2-health-timing-fix-is-in-scope-not-a-rewrite"): the
    // "preserve-and-replay-recovery" degradation reason is deliberately
    // NOT cleared here. fsm.md forces health:nominal for the non-ACTIVE
    // "recovering" lifecycle regardless of degradationReasons ("uninitialized,
    // joining, recovering, and stopped are always nominal"), so clearing the
    // reason immediately after THIS checkpoint save (as S5/S6 originally
    // shipped it) makes the degraded window structurally unobservable --
    // the engine would already read nominal by the time catching_up is
    // entered, violating AC-PERS-2's literal text ("MUST enter catching_up
    // with health: degraded until the first successful checkpoint save").
    // The clear is instead performed in `enterCatchingUp`, right after ITS
    // OWN transitionTo(gen, "catching_up") checkpoint save resolves -- see
    // that function's own comment.

    // R1 (partial -- see architecture.json "recovering-r1-r3-best-effort"):
    // load the three stores needed to rebuild the deferred queue and mark
    // already-accepted ids processed so R3's full resubmission on the
    // corrupt-checkpoint path cannot re-emit a duplicate accepted event.
    const [rawLog, acceptedLog, deferredIds] = await Promise.all([
      persistence.loadFacts(groupId),
      persistence.loadAcceptedEvents(groupId),
      persistence.loadDeferredIds(groupId),
    ]);
    if (gen !== generation) return;

    for (const event of acceptedLog) ingestPolicy.markProcessed(event.id);

    // R2a -- prune stale deferred ids already present in the accepted log.
    const acceptedFactIds = new Set(acceptedLog.map((event) => event.factId));
    const liveDeferredIds = deferredIds.filter((id) => !acceptedFactIds.has(id));
    if (liveDeferredIds.length !== deferredIds.length) {
      await saveDeferredIdsWithRetry(gen, liveDeferredIds);
      if (gen !== generation) return;
    }

    // R2 -- rebuild the in-memory deferred queue (do NOT re-ingest yet).
    // CONTRACT NOTE (S6 disposition of the S5 Stage-2 cold review's P3 batch
    // item (e) -- SETTLED, not a deferred TODO): the original `DeferredReason`
    // ("unreadable" vs "epoch_mismatch") cannot be recovered at this point,
    // and this is ACCEPTABLE KNOWN-LOSSY behavior BY DESIGN, not an
    // oversight to fix later. `deferred-store` persists fact ids ONLY, by
    // design (architecture.md "Recovery Sequencing" -- the checkpoint
    // itself carries no deferred ids either, per S5's removal of
    // `deferredNostrEventIds`), so every rebuilt entry below is hardcoded to
    // "unreadable" regardless of what it was actually parked under before
    // the restart. `DeferredPolicyEntry.reason` is DIAGNOSTIC ONLY: neither
    // `retryBatch()` nor the L8/L9 pass branches on it, so this has zero
    // effect on retry correctness. Do NOT add reason persistence to
    // `deferred-store` to "fix" this -- that would be a real scope/format
    // change to a store whose id-only shape is intentional, for a field
    // that is provably unused by any correctness-affecting code path.
    const rawFactsById = new Map(rawLog.map((fact) => [fact.id, fact]));
    for (const id of liveDeferredIds) {
      const fact = rawFactsById.get(id);
      if (fact) {
        ingestPolicy.enqueueDeferred(fact.id, fact, "unreadable", scheduler.now());
      }
    }

    // R3 -- resubmit only the crash-gap tail (seq > watermark).
    const gapFacts = rawLog.filter((fact) => fact.seq > lastIngestedSeq);
    if (gapFacts.length > 0) {
      for await (const signal of adapter.ingestPersisted(gapFacts)) {
        if (gen !== generation) return;
        await enqueueGen(gen, () => processSignal(signal, gen));
        if (gen !== generation) return;
      }
    }
    if (gen !== generation) return;

    // R4 -- resume via the standard cutover protocol.
    await enterCatchingUp(gen);
  }

  // ---- start() / stop() / reset() ----
  // Synchronous re-entrancy latch (P3 batch item (b), S5 Stage-2 cold
  // review): the `lifecycle !== "uninitialized"` check alone is NOT
  // sufficient on the "restored" path, because that path's first statement
  // is `await persistence.loadCheckpoint(...)` -- lifecycle has not yet
  // moved off "uninitialized" by the time control yields there, so a SECOND
  // synchronous `start()` call in the same tick would also observe
  // "uninitialized" and race in. (The "welcome" path is incidentally safe
  // without this latch, since `enterJoining` -> `transitionTo` assigns
  // `lifecycle` synchronously before its own first await -- but the latch
  // covers both paths uniformly rather than relying on that asymmetry.)
  let startInFlight = false;

  async function start(options: StartOptions): Promise<void> {
    if (lifecycle !== "uninitialized" || startInFlight) {
      throw new Error(
        `receive-engine: start() called from lifecycle "${lifecycle}"; only callable from "uninitialized"`,
      );
    }
    startInFlight = true;
    generation += 1;
    const gen = generation;
    try {
      if (options.origin === "welcome") {
        await enterJoining(gen);
        return;
      }

      // origin === "restored" -- reconciled L1/L2 guard (architecture.json
      // "l1-l2-restart-routing").
      let checkpoint: EngineCheckpoint | null = null;
      try {
        const loaded = await persistence.loadCheckpoint(groupId);
        checkpoint = loaded !== null && isValidCheckpoint(loaded) ? loaded : null;
      } catch {
        checkpoint = null;
      }
      if (gen !== generation) return;

      if (checkpoint !== null && checkpoint.bootstrapCompleted === true) {
        await enterRecovering(gen, checkpoint, false);
        return;
      }
      if (checkpoint !== null && checkpoint.bootstrapCompleted === false) {
        await enterJoining(gen);
        return;
      }

      const [rawLog, acceptedLog] = await Promise.all([
        persistence.loadFacts(groupId),
        persistence.loadAcceptedEvents(groupId),
      ]);
      if (gen !== generation) return;
      if (rawLog.length === 0 && acceptedLog.length === 0) {
        await enterJoining(gen);
      } else {
        await enterRecovering(gen, null, true);
      }
    } finally {
      startInFlight = false;
    }
  }

  async function stop(): Promise<void> {
    if (lifecycle === "stopped" || lifecycle === "uninitialized") return;
    // Bump generation FIRST, synchronously, before any other statement --
    // every in-flight continuation from this session (drain loops, timer
    // callbacks, entry-action bodies) now observes a stale `gen` on its next
    // check and abandons rather than resurrecting this session (sev-9).
    generation += 1;
    const gen = generation;
    // AC-PERS-1 (S6): unblock every in-flight persistence-retry backoff
    // wait immediately -- see architecture.json
    // "persistence-retry-generation-token-discipline". Must run right after
    // the generation bump (so the abandoned continuations' next `gen`
    // check already observes the new value) and before anything else that
    // could itself kick off a NEW retry (e.g. the final saveCheckpoint
    // below), matching stop()'s existing "bump first" discipline.
    abandonPendingRetries();
    activePersistenceFailures = 0;
    manageCheckpointTimer("stopped", gen);
    if (tJoinTimer !== undefined) {
      scheduler.clearTimeout(tJoinTimer);
      tJoinTimer = undefined;
    }
    if (liveUnsubscribe) {
      liveUnsubscribe();
      liveUnsubscribe = undefined;
    }
    adapter.close();
    lifecycle = "stopped";
    degradationReasons.clear();
    emitStateChanged();
    await saveCheckpointResilient(gen);
  }

  async function reset(): Promise<void> {
    // Bump generation FIRST -- see stop()'s comment; the same discipline
    // applies here, and additionally makes the `catchUpInvocationCount`
    // reset below safe (see that field's own doc comment for the ordering
    // argument in full).
    generation += 1;
    const gen = generation;
    abandonPendingRetries(); // AC-PERS-1 (S6) -- see stop()'s identical call for the rationale
    activePersistenceFailures = 0;
    manageCheckpointTimer("uninitialized", gen);
    if (tJoinTimer !== undefined) {
      scheduler.clearTimeout(tJoinTimer);
      tJoinTimer = undefined;
    }
    if (liveUnsubscribe) {
      liveUnsubscribe();
      liveUnsubscribe = undefined;
    }
    liveBuffer = [];
    degradationReasons.clear();
    lastEpoch = null;
    lastIngestedSeq = 0;
    lastAcceptedDomainEventId = null;
    bootstrapCompleted = false;
    pendingDeferredRetry = false;
    catchUpInvocationCount = 0;
    serialQueue = Promise.resolve();
    // Fresh ingest-policy instance: clears both the dedupe-processed set and
    // the deferred/retry-budget queue.
    ingestPolicy = createIngestPolicy(
      deps.ingestPolicyOptions ?? DEFAULT_INGEST_POLICY_OPTIONS,
    );

    await persistence.clearGroupState(groupId);
    await transitionTo(gen, "uninitialized", { skipCheckpointSave: true });
  }

  function subscribe(listener: (event: EngineOutputEvent) => void): Unsubscribe {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getState(): EngineState {
    return { lifecycle, health: health() };
  }

  // ---- acceptLocal (S11B — optimistic local echo) ----
  // Routed through the SAME serial FIFO (`enqueue`) as ingest signals, so a
  // local accept is ordered consistently relative to concurrent live/catchUp
  // processing for this group. Deliberately `enqueue()`, not `enqueueGen()`:
  // see architecture.json judgment call
  // "s11b-generation-captured-at-execution-not-call-time" for why `gen` is
  // read fresh at execution time rather than pinned at call time.
  function acceptLocal(rumorId: string, payload: TaskEvent): Promise<void> {
    return enqueue(async () => {
      const gen = generation;
      const eventId = deriveMlsAcceptedEventId(rumorId);
      if (ingestPolicy.hasProcessed(eventId)) return; // AC-OPT-3 dedupe: already accepted (duplicate local accept, or a real message already landed this id)

      const event: AcceptedDomainEvent = {
        id: eventId,
        // See architecture.json judgment call "s11b-factid-deterministic-placeholder":
        // the real kind-445 id is unknown until send completes and cannot be
        // backfilled (appendAcceptedEvent is idempotent-on-id, first write wins).
        factId: `local:${rumorId}`,
        sourceKind: "mls-rumor",
        groupId,
        acceptedAt: scheduler.now(),
        epoch: lastEpoch ?? "unknown",
        payload,
      };

      const appended = await appendAcceptedEventWithRetry(gen, event);
      if (!appended) return; // gen-stale abandon or AC-PERS-1 exhaustion give-up (reportIfExhausted already emitted)
      if (gen !== generation) return;

      ingestPolicy.markProcessed(eventId);
      lastAcceptedDomainEventId = eventId;
      emit({ type: "domain_event_accepted", event });
    });
  }

  return { start, stop, reset, subscribe, getState, acceptLocal };
}
