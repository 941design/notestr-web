/**
 * react-engine-hooks.ts
 *
 * The React integration shell for the event-sourced receive engine (see
 * specs/epic-event-sourced-receive-engine/architecture.md, "Module Map"
 * (react-engine-hooks row), "Seam Contracts › EngineOutputEvent", and
 * "Implementation Constraint 7").
 *
 * RESPONSIBILITIES:
 *  - Subscribe to a per-group `ReceiveEngine`'s `EngineOutputEvent` stream.
 *  - Fold `domain_event_accepted` INCREMENTALLY via
 *    `task-projector.applyEvent(currentProjection, event.payload)`. Full
 *    `buildProjection` is reserved for exactly two cases: the mount-time
 *    "restart" seed (this hook is the sole owner of the in-memory
 *    `TaskProjection` -- `receive-engine.ts` is deliberately projection-free,
 *    see its own module doc comment) and an explicit `projection_invalidated`
 *    event. See judgment_calls in this story's architecture.json for the
 *    full rationale ("mount-time-persistence-seed-is-the-restart-case").
 *  - Expose engine lifecycle/health to the UI verbatim (no reinterpretation
 *    of the `EngineState` shape -- judgment_calls
 *    "engineState-shape-is-verbatim").
 *  - Expose the most recent `domain_event_rejected` with a classified,
 *    always-graceful `RejectionReasonKind` (never throws on an unrecognized
 *    reason string -- judgment_calls "rejection-reason-vocabulary-classifier").
 *
 * BOUNDARY RULE 10 (architecture.md): the engine owns the adapter; React
 * manages exactly ONE object (the engine) with exactly ONE `useEffect`
 * cleanup, which calls `engine.stop()`. `engine.stop()` itself closes the
 * owned adapter as its final adapter-observable action (already implemented
 * inside `receive-engine.ts`'s `stop()` -- this file does not, and must not,
 * duplicate that ordering logic). This file therefore contains EXACTLY ONE
 * `useEffect` call.
 *
 * FRESH-ENGINE-PER-MOUNT (judgment_calls "fresh-engine-per-mount-via-factory"):
 * `UseReceiveEngineParams.createEngine` is a FACTORY, not a pre-built
 * `ReceiveEngine`. The effect constructs a brand-new engine on every mount
 * and only ever calls `start()`/`stop()` on that one instance, once each.
 * This sidesteps `receive-engine.ts`'s "start() only from lifecycle
 * 'uninitialized'" contract under a React 18 Strict-Mode dev double-invoke
 * (mount -> cleanup -> mount): a reused, already-`stopped` engine would
 * throw on the second `start()` call. A fresh engine per mount is always
 * `uninitialized` when `start()` is called.
 *
 * STABLE EFFECT DEPENDENCIES (F2 fix, 2026-07-14 Stage-1 cold review --
 * sev-3): the effect's dependency array is `[groupId]` ONLY. `persistence`,
 * `createEngine`, and `startOptions` are read through refs
 * (`persistenceRef`/`createEngineRef`/`startOptionsRef`) kept current by a
 * plain assignment during render -- NOT inside an effect, so this file still
 * contains exactly one `useEffect` call (Boundary Rule 10). A caller passing
 * a fresh inline `startOptions={{origin:'welcome'}}` object (or an
 * unstabilized `createEngine` closure) on every render therefore no longer
 * tears down and reconstructs the engine on every unrelated re-render; only
 * an actual `groupId` change (or mount/unmount) does.
 *
 * SNAPSHOT-AT-EFFECT-ENTRY (F4 fix, 2026-07-14 Stage-2 cold review --
 * architecture): writing these refs during render is itself safe (they are
 * never READ during render, only later inside the effect's async
 * callbacks), but under concurrent rendering (`startTransition` /
 * Suspense-discarded renders) a never-committed render can still mutate the
 * SAME ref object. Re-reading `.current` on every rebuild -- rather than
 * once -- let a still-committed OLD-`groupId` effect's async continuation
 * observe a NEWER, abandoned render's `persistence`/`createEngine`/
 * `startOptions` values: a torn pair (e.g. `newPersistence.loadAcceptedEvents
 * (oldGroupId)`). The fix: `persistenceRef.current`/`createEngineRef.current`/
 * `startOptionsRef.current` are read exactly ONCE, at effect entry (commit
 * phase, alongside where `createEngine` is already invoked to construct the
 * engine), into local consts (`persistenceForThisMount`/
 * `startOptionsForThisMount`) used for this effect instance's entire
 * lifetime, rebuild closures included. This pins every read to the render
 * that actually committed this effect instance, regardless of how many
 * later (possibly-discarded) renders mutate the shared refs afterward.
 *
 * Boundary compliance (architecture.md "Allowed dependency edges"): this
 * file imports ONLY types from `src/engine/receive-engine.ts` and
 * `src/engine/engine-types.ts`, runtime helpers from
 * `src/domain/task-projector.ts`, and React. It imports NO marmot-ts
 * package and NO `src/integration/marmot-adapter.ts` -- adapter
 * construction is entirely the concern of the caller's `createEngine`
 * factory (architecture.md: "marmot-adapter.ts is the ONLY file permitted
 * to import marmot-ts types outside the engine receive path").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReceiveEngine, StartOptions } from "../engine/receive-engine";
import type {
  AcceptedDomainEvent,
  EngineOutputEvent,
  EngineState,
  PersistenceAdapter,
} from "../engine/engine-types";
import type { TaskEvent } from "../domain/task-events";
import {
  applyEvent,
  buildProjection,
  EMPTY_PROJECTION,
  replayOrder,
  type TaskProjection,
} from "../domain/task-projector";

// ---------------------------------------------------------------------------
// Rejection reason classification
// ---------------------------------------------------------------------------

/**
 * Closed classification vocabulary for the four reasons `receive-engine.ts`
 * documents itself emitting on `domain_event_rejected.reason`
 * (`REJECTED_REASON_*` constants + `"parse_error"`), plus a mandatory
 * `"unknown"` fallback. `EngineOutputEvent`'s `reason` field is deliberately
 * a free-form `string` (architecture.md), not this closed union -- this
 * type exists purely as an S8-owned, additive UI convenience and never
 * narrows the seam itself.
 */
export type RejectionReasonKind =
  | "parse_error"
  | "retry-exhausted"
  | "deferred-ttl-expired"
  | "persistence-exhausted"
  | "unknown";

const KNOWN_REJECTION_REASONS: ReadonlySet<string> = new Set<string>([
  "parse_error",
  "retry-exhausted",
  "deferred-ttl-expired",
  "persistence-exhausted",
]);

/**
 * Classifies a `domain_event_rejected.reason` string into the closed
 * `RejectionReasonKind` vocabulary. Never throws: any string outside the
 * four known reasons classifies as `"unknown"` so the UI can always render
 * something gracefully, per this story's ledger handoff ("S8 UI must
 * handle all four + unknown gracefully").
 */
export function classifyRejectionReason(reason: string): RejectionReasonKind {
  return KNOWN_REJECTION_REASONS.has(reason)
    ? (reason as RejectionReasonKind)
    : "unknown";
}

// ---------------------------------------------------------------------------
// Hook contract
// ---------------------------------------------------------------------------

/** The most recent `domain_event_rejected` surfaced to the UI. */
export interface RejectionInfo {
  factId: string;
  groupId: string;
  /** Verbatim `EngineOutputEvent.domain_event_rejected.reason`. */
  reason: string;
  reasonKind: RejectionReasonKind;
}

export interface UseReceiveEngineParams {
  groupId: string;
  /** The fact/accepted-event half is read directly by this hook (mount-time
   *  restart seed + `projection_invalidated` rebuild); the checkpoint/
   *  deferred half is exercised only inside the engine this hook owns.
   *  Read through a ref -- see module doc comment "STABLE EFFECT
   *  DEPENDENCIES" -- so an unstable identity across renders does NOT tear
   *  down and reconstruct the engine. The ref is snapshotted ONCE at effect
   *  entry (see "SNAPSHOT-AT-EFFECT-ENTRY") -- `persistence`/`createEngine`
   *  MAY vary in object identity across renders, but for a given `groupId`
   *  they MUST resolve to the same underlying durable store; this hook only
   *  ever reads the identity that was current when its effect for that
   *  `groupId` last (re)mounted. */
  persistence: PersistenceAdapter;
  /** Factory, NOT a pre-built engine -- see this file's module doc comment
   *  ("FRESH-ENGINE-PER-MOUNT"). Read through a ref -- see "STABLE EFFECT
   *  DEPENDENCIES" -- so it no longer needs to be referentially stable
   *  across renders; only `groupId` changing (or mount/unmount) re-runs the
   *  effect.
   *
   *  SIDE-EFFECT-FREE CONSTRUCTION CONSTRAINT (F6, 2026-07-14 Stage-2 cold
   *  review -- best_practices): this factory (and any adapter it
   *  constructs) MUST be side-effect-free until `engine.start()` is called.
   *  A React 18 Strict-Mode dev double-invoke (mount -> cleanup -> mount)
   *  constructs a throwaway engine instance that is `stop()`-ed from
   *  lifecycle `"uninitialized"` -- which no-ops BEFORE `adapter.close()`
   *  runs (see `receive-engine.ts`'s `stop()`) -- so the throwaway
   *  instance's adapter is never explicitly closed. This is safe only
   *  because construction itself does no I/O and holds no closeable
   *  resource open. */
  createEngine: () => ReceiveEngine;
  /** Read through a ref -- see "STABLE EFFECT DEPENDENCIES" -- so an inline
   *  object literal passed on every render (e.g. `startOptions={{origin:
   *  'welcome'}}`) does NOT tear down and reconstruct the engine. */
  startOptions: StartOptions;
}

export interface ReceiveEngineHookState {
  projection: TaskProjection;
  /** Verbatim `EngineState` ({lifecycle, health}) -- see judgment_calls
   *  "engineState-shape-is-verbatim". */
  engineState: EngineState;
  lastRejection: RejectionInfo | null;
  /**
   * OPTIMISTIC LOCAL ECHO (S11B, AC-OPT-4; broadened by S11B-Fable-1): task
   * ids with at least one locally-dispatched edit the outbox is still
   * actively tracking as unresolved / in-flight. Cleared by `confirmLocal`
   * on ANY terminal `OutboxEntry` outcome -- own-echo reconciled (success),
   * a permanent send failure, or 256-cap eviction -- never only the
   * reconciled case; "pending" means "not yet resolved," not "not yet
   * successful." Derived entirely from `dispatchLocal`/`confirmLocal` call
   * pairs below -- this hook tracks NO outbox/marmot state itself, it only
   * counts rumorId membership per task id.
   */
  pendingTaskIds: ReadonlySet<string>;
  /**
   * OPTIMISTIC LOCAL ECHO (S11B, AC-OPT-1/2/3/5): accepts a locally-authored
   * `TaskEvent` into THIS mount's engine immediately (via
   * `ReceiveEngine.acceptLocal`) and marks `taskIdOf(payload)` pending until
   * the matching `confirmLocal(rumorId)` call arrives. `undefined` before
   * the underlying engine has been constructed (first render of a fresh
   * mount) -- callers must optional-chain.
   */
  dispatchLocal?: (rumorId: string, payload: TaskEvent) => Promise<void>;
  /**
   * OPTIMISTIC LOCAL ECHO (S11B, AC-OPT-4; broadened by S11B-Fable-1):
   * clears `rumorId`'s pending membership. Called for ANY terminal
   * `OutboxEntry` outcome the outbox bridge reports via
   * `PublishOutboxDeps.onPendingCleared` -- own-echo reconciled, a
   * permanent send failure, or 256-cap eviction -- not only reconciliation;
   * this function itself is outcome-agnostic, it just clears membership. A
   * rumorId with no matching pending entry is a silent no-op. `undefined`
   * before the underlying engine has been constructed -- callers must
   * optional-chain.
   */
  confirmLocal?: (rumorId: string) => void;
}

/** Same derivation `receive-engine.ts`'s own (private) `taskIdOf` uses --
 *  duplicated here (not exported from receive-engine.ts, and not worth a
 *  new shared seam for a two-line pure function) so `dispatchLocal` can key
 *  its pending-tracking map by task id without reaching into engine
 *  internals. */
function taskIdOf(payload: TaskEvent): string {
  return payload.type === "task.created" ? payload.task.id : payload.taskId;
}

/** `getState()` value of a freshly-constructed, not-yet-started engine
 *  (fsm.md: `uninitialized`/`joining`/`recovering`/`stopped` are always
 *  `health: "nominal"`). Used only as this hook's pre-first-event default. */
const INITIAL_ENGINE_STATE: EngineState = {
  lifecycle: "uninitialized",
  health: "nominal",
};

/**
 * Subscribes to a per-group receive engine and exposes its incrementally-
 * folded task projection plus lifecycle/health/rejection state to React.
 *
 * See this file's module doc comment for the full rationale behind the
 * fresh-engine-per-mount design and the mount-time persistence seed.
 */
export function useReceiveEngine(
  params: UseReceiveEngineParams,
): ReceiveEngineHookState {
  const { groupId, persistence, createEngine, startOptions } = params;

  const [projection, setProjection] = useState<TaskProjection>(EMPTY_PROJECTION);
  const [engineState, setEngineState] =
    useState<EngineState>(INITIAL_ENGINE_STATE);
  const [lastRejection, setLastRejection] = useState<RejectionInfo | null>(
    null,
  );
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // OPTIMISTIC LOCAL ECHO (S11B): a ref to THIS mount's engine instance, so
  // `dispatchLocal`/`confirmLocal` below (stable across every render, see
  // their `useCallback([])`) can reach the CURRENT mount's engine without
  // being re-created per mount themselves. Set inside the effect right after
  // construction, cleared in the effect's cleanup -- mirrors
  // `persistenceForThisMount`/`startOptionsForThisMount`'s snapshot-at-
  // effect-entry discipline, but as a ref (not a local const) because these
  // two callbacks must reach it from OUTSIDE the effect closure.
  const engineRef = useRef<ReceiveEngine | null>(null);
  // rumorId -> taskId, plus the reverse per-task Set -- reset naturally on
  // remount (a fresh useRef per hook call; `EngineTaskBridge` already keys
  // on `groupId` -- FRESH-ENGINE-PER-MOUNT -- so a group change always tears
  // down and reconstructs this hook's whole call frame, this ref included).
  const pendingByTaskRef = useRef<Map<string, Set<string>>>(new Map());
  const rumorToTaskRef = useRef<Map<string, string>>(new Map());

  function recomputePendingTaskIds(): void {
    const next = new Set<string>();
    for (const [taskId, rumorIds] of pendingByTaskRef.current) {
      if (rumorIds.size > 0) next.add(taskId);
    }
    setPendingTaskIds(next);
  }

  // `useCallback([])`: referentially stable across EVERY render (not merely
  // within one mount), matching the discipline `EngineTaskBridge`'s own
  // `onState` effect already relies on (see task-store.tsx: depending on
  // unstable function identities would fire that effect every render).
  // Safe with an empty dep array because both bodies touch only refs and
  // `setPendingTaskIds` (React-guaranteed stable) -- nothing render-scoped.
  const dispatchLocal = useCallback(
    async (rumorId: string, payload: TaskEvent): Promise<void> => {
      const engine = engineRef.current;
      if (!engine) return;
      await engine.acceptLocal(rumorId, payload);
      const taskId = taskIdOf(payload);
      rumorToTaskRef.current.set(rumorId, taskId);
      let set = pendingByTaskRef.current.get(taskId);
      if (!set) {
        set = new Set();
        pendingByTaskRef.current.set(taskId, set);
      }
      set.add(rumorId);
      recomputePendingTaskIds();
    },
    [],
  );

  const confirmLocal = useCallback((rumorId: string): void => {
    const taskId = rumorToTaskRef.current.get(rumorId);
    if (taskId === undefined) return;
    rumorToTaskRef.current.delete(rumorId);
    const set = pendingByTaskRef.current.get(taskId);
    if (!set || !set.delete(rumorId)) return;
    if (set.size === 0) pendingByTaskRef.current.delete(taskId);
    recomputePendingTaskIds();
  }, []);

  // STABLE EFFECT DEPENDENCIES (see module doc comment): kept current by a
  // plain assignment during render, NOT inside an effect -- these values are
  // never read during render, only later inside the effect's async
  // callbacks, so this is safe and does not introduce a second effect-shaped
  // hook (Boundary Rule 10 still requires exactly one `useEffect` call).
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;
  const createEngineRef = useRef(createEngine);
  createEngineRef.current = createEngine;
  const startOptionsRef = useRef(startOptions);
  startOptionsRef.current = startOptions;

  // Exactly one useEffect call, per Boundary Rule 10 / AC-BOUND-5: it owns
  // exactly one object (a freshly-constructed engine) and its cleanup calls
  // engine.stop() -- nothing else in this hook registers its own
  // effect/cleanup.
  useEffect(() => {
    let cancelled = false;
    // Local fold accumulator -- NOT React state. `setProjection` is called
    // only when this local value's identity actually changes (mirrors
    // task-projector.ts's own "prev !== next = changed" contract), so a
    // no-op applyEvent() never triggers a spurious re-render.
    let currentProjection: TaskProjection = EMPTY_PROJECTION;

    // REBUILD RACE (F1 fix, 2026-07-14 Stage-1 cold review -- sev-6):
    // `domain_event_accepted` folds and `projection_invalidated` rebuilds
    // arrive on the SAME serial engine callback, but `rebuildFromPersistence`
    // is an unawaited async continuation (`void rebuildFromPersistence()`
    // below) -- a fold that lands DURING its `loadAcceptedEvents` await
    // window must never be clobbered by the rebuild's own later, stale-as-
    // of-await-start overwrite. This is exactly the S11 recovery / R3
    // crash-gap-replay shape (`projection_invalidated` followed by
    // `domain_event_accepted` for the gap-tail facts), so an unconditional
    // overwrite here defeats R-INV-4's rebuild-equality guarantee at this
    // integration layer. Guarded the same way receive-engine.ts guards its
    // own async continuations (see that file's "Per-session GENERATION
    // TOKEN" comment): a generation token captured at entry, re-checked
    // after the await.
    //  - `rebuildGeneration`/`activeRebuildGeneration`: a NEWER
    //    `rebuildFromPersistence` call (two back-to-back
    //    `projection_invalidated` events) supersedes an in-flight OLDER one.
    //    The older one discards its own result entirely on resolve -- it
    //    would otherwise be able to resolve AFTER the newer one and win with
    //    a staler snapshot ("older snapshot wins" -- the reviewed defect).
    //  - `eventsSinceRebuildStart`: every `domain_event_accepted` observed
    //    while a rebuild is in flight is folded into `currentProjection`
    //    immediately as usual (the UI never waits on the rebuild) AND queued
    //    here, so the rebuild -- once its load resolves, provided it was not
    //    superseded -- replays those events on top of its freshly loaded
    //    base instead of silently dropping them.
    let rebuildGeneration = 0;
    let activeRebuildGeneration: number | null = null;
    let eventsSinceRebuildStart: AcceptedDomainEvent[] = [];

    // SNAPSHOT-AT-EFFECT-ENTRY (F4 fix, see module doc comment): read every
    // ref exactly ONCE, here, and use these local consts for the rest of
    // this effect instance's lifetime instead of re-reading `.current`.
    const persistenceForThisMount = persistenceRef.current;
    const startOptionsForThisMount = startOptionsRef.current;
    const engine = createEngineRef.current();
    // OPTIMISTIC LOCAL ECHO (S11B): publish this mount's engine instance for
    // `dispatchLocal`/`confirmLocal` (defined outside this effect) to reach.
    engineRef.current = engine;

    function commitProjection(next: TaskProjection): void {
      if (next !== currentProjection) {
        currentProjection = next;
        setProjection(next);
      }
    }

    /** Folds ONE `domain_event_accepted` into `currentProjection` via
     *  `applyEvent` and, if a rebuild is currently in flight, also queues it
     *  for replay on top of that rebuild's freshly loaded base -- see
     *  "REBUILD RACE" above. */
    function foldAccepted(event: AcceptedDomainEvent): void {
      commitProjection(applyEvent(currentProjection, event));
      if (activeRebuildGeneration !== null) {
        eventsSinceRebuildStart.push(event);
      }
    }

    /**
     * The ONLY two call sites of `buildProjection` in this hook (mount-time
     * restart seed below, and the `projection_invalidated` case in the
     * event switch) -- Implementation Constraint 7 reserves full rebuild
     * for exactly these two cases; every other `domain_event_accepted`
     * folds via `applyEvent` only.
     *
     * READ-FAILURE HANDLING (F1 fix, 2026-07-14 Stage-2 cold review --
     * sev-5 BLOCKER): unlike every persistence WRITE path in
     * `receive-engine.ts` (bounded-backoff retry + degradation), this is
     * the read path -- `loadAcceptedEvents` can reject (IDB quota,
     * eviction, private-mode). A rejection here must NOT propagate as an
     * unhandled rejection: if this call still owns
     * `activeRebuildGeneration` when the read fails, that ownership (and
     * the replay queue) is cleared and the failure is logged, but
     * `currentProjection` is left untouched so the incremental
     * `foldAccepted` path keeps working unaffected. A superseded call
     * (see the generation check below) fails silently -- ownership already
     * belongs to a newer call, so there is nothing for this one to clean up.
     */
    async function rebuildFromPersistence(): Promise<void> {
      const myGeneration = ++rebuildGeneration;
      activeRebuildGeneration = myGeneration;
      eventsSinceRebuildStart = [];
      let events: AcceptedDomainEvent[];
      try {
        events = await persistenceForThisMount.loadAcceptedEvents(groupId);
      } catch (err) {
        if (!cancelled) {
          console.error(
            "[react-engine-hooks] loadAcceptedEvents failed during rebuild",
            err,
          );
        }
        if (activeRebuildGeneration === myGeneration) {
          activeRebuildGeneration = null;
          eventsSinceRebuildStart = [];
        }
        return;
      }
      if (cancelled) return;
      if (activeRebuildGeneration !== myGeneration) {
        // A NEWER rebuildFromPersistence call superseded this one while we
        // awaited the load -- that newer rebuild owns committing the final
        // projection (and will replay its own eventsSinceRebuildStart,
        // which by construction covers everything durable since ITS start,
        // including whatever this stale call would have found). This call
        // contributes nothing rather than racing to overwrite last.
        return;
      }
      let rebuilt = buildProjection(replayOrder(events));
      // DEDUPE-AGAINST-SNAPSHOT (F3 fix, 2026-07-14 Stage-2 cold review --
      // sev-3): persist-before-emit guarantees persist-THEN-emit, not
      // emit-then-visible-to-an-already-issued read -- an event accepted
      // during this call's `loadAcceptedEvents` await window can land in
      // BOTH `events` (the just-loaded snapshot) AND
      // `eventsSinceRebuildStart` (queued by `foldAccepted` off the SAME
      // `domain_event_accepted` emission). Replaying it unconditionally
      // would apply a duplicate `AcceptedDomainEvent.id`, violating
      // task-projector.ts's documented "input log contains unique ids"
      // precondition. Skip anything already present in the snapshot.
      const seenIds = new Set(events.map((event) => event.id));
      for (const event of eventsSinceRebuildStart) {
        if (!seenIds.has(event.id)) {
          rebuilt = applyEvent(rebuilt, event);
        }
      }
      activeRebuildGeneration = null;
      eventsSinceRebuildStart = [];
      commitProjection(rebuilt);
    }

    const unsubscribe = engine.subscribe((event: EngineOutputEvent) => {
      switch (event.type) {
        case "domain_event_accepted":
          foldAccepted(event.event);
          break;

        case "projection_invalidated":
          void rebuildFromPersistence();
          break;

        case "engine_state_changed":
          setEngineState({ lifecycle: event.state, health: event.health });
          break;

        case "domain_event_rejected":
          setLastRejection({
            factId: event.factId,
            groupId: event.groupId,
            reason: event.reason,
            reasonKind: classifyRejectionReason(event.reason),
          });
          break;

        // The remaining six variants carry no projection/lifecycle/
        // rejection state this hook is required to expose (AC-BOUND-5 /
        // AC-INV-4 / Implementation Constraint 7 name only the four cases
        // above). Listed explicitly (not folded into a wildcard) so the
        // exhaustiveness guard below still catches a genuinely new variant.
        case "envelope_received":
        case "envelope_deferred":
        case "group_epoch_advanced":
        case "group_ratchet_advanced":
        case "deferred_retry_started":
        case "recovered":
          break;

        default: {
          // Exhaustiveness guard: a new EngineOutputEvent variant fails
          // this assignment at compile time rather than silently falling
          // through unhandled at runtime.
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    });

    async function boot(): Promise<void> {
      // Restart seed FIRST, before the engine can possibly emit anything
      // (subscribe() above already happened synchronously, so no event is
      // ever missed; start() has not been called yet, so nothing races
      // this initial rebuild).
      //
      // OWN TRY/CATCH (F1 fix): `rebuildFromPersistence` already swallows a
      // failed `loadAcceptedEvents` internally (see its own doc comment),
      // so this call should never reject in practice -- but this is given
      // its own try/catch anyway so a mount-time seed failure of ANY kind
      // can never prevent `engine.start()` below from running. Before this
      // fix, an unhandled rejection here left the hook permanently dead
      // (EMPTY_PROJECTION, lifecycle stuck "uninitialized") with nothing
      // surfaced to the UI.
      try {
        await rebuildFromPersistence();
      } catch (err) {
        if (!cancelled) {
          console.error(
            "[react-engine-hooks] mount-time persistence seed failed",
            err,
          );
        }
      }
      if (cancelled) return;
      try {
        await engine.start(startOptionsForThisMount);
      } catch (err) {
        if (!cancelled) {
          // A freshly-constructed engine should always be startable from
          // "uninitialized"; surface unexpected failures loudly (console)
          // rather than silently swallowing them or crashing the render.
          console.error("[react-engine-hooks] engine.start failed", err);
        }
      }
    }
    void boot();

    return () => {
      cancelled = true;
      unsubscribe();
      // OPTIMISTIC LOCAL ECHO (S11B): a post-unmount dispatchLocal/confirmLocal
      // call must not reach a stopped engine -- both already no-op when
      // `engineRef.current` is null.
      engineRef.current = null;
      // Idempotent by construction on the engine side (receive-engine.ts's
      // stop() no-ops when lifecycle is already "stopped"/"uninitialized"),
      // and this closure's `engine` is never shared with another effect
      // instance (FRESH-ENGINE-PER-MOUNT), so this is safe to call
      // unconditionally regardless of how far `boot()` progressed.
      void engine.stop();
    };
    // STABLE EFFECT DEPENDENCIES (see module doc comment, F2 fix): only
    // `groupId` re-runs this effect. `persistence`/`createEngine`/
    // `startOptions` are read through the refs kept current above, not
    // captured as dependencies -- an unstable identity across renders no
    // longer tears down and reconstructs the engine.
  }, [groupId]);

  return {
    projection,
    engineState,
    lastRejection,
    pendingTaskIds,
    dispatchLocal,
    confirmLocal,
  };
}
