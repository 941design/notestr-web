import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getNostrGroupIdHex } from "@internet-privacy/marmot-ts";
import type { EventSigner } from "applesauce-core";
import type { MarmotClient, MarmotGroup } from "@internet-privacy/marmot-ts";
import { useGroup, useMarmot } from "../marmot/client";
import {
  beginDispatchPublishWindow,
  endDispatchPublishWindow,
  enqueueExpectedPublish,
  removeExpectedPublishByRumorId,
} from "../marmot/device-sync";
import { type Task, type TaskEvent } from "./task-events";
import { ensureMonotonicTimestamp } from "./task-store-utils";
import { useReceiveEngine, type ReceiveEngineHookState } from "../integration/react-engine-hooks";
import { createMarmotIngestAdapter } from "../integration/marmot-adapter";
import {
  createPublishOutbox,
  computeRumorId,
  type PublishOutbox,
} from "../integration/publish-outbox";
import {
  createReceiveEngine,
  createRealEngineScheduler,
  type EngineOrigin,
  type ReceiveEngine,
  type StartOptions,
} from "../engine/receive-engine";
import type {
  EngineLifecycleState,
  IngestSource,
  PersistenceAdapter,
} from "../engine/engine-types";
import { createPersistenceAdapter } from "../persistence/deferred-store";
import { loadCheckpoint } from "../persistence/checkpoint-store";
import { loadAcceptedEvents } from "../persistence/raw-event-log-store";

export { ensureMonotonicTimestamp };

function isTestRuntime(): boolean {
  return process.env.NEXT_PUBLIC_E2E === "1" || process.env.NODE_ENV === "test";
}

// S10: the per-group dispatch/publish mutex that used to live here moved to
// src/integration/publish-outbox.ts (createPublishOutbox's withPublishLock)
// alongside the rest of the send-path logic it protects — see this story's
// architecture.json judgment call
// "s10-task-store-dispatch-delegation-out-of-listed-scope-includes".

/**
 * OPTIMISTIC LOCAL ECHO READINESS GATE (S12-Fable-1 cutover fix, sev-5
 * remediation).
 *
 * A tiny "resolve every waiter the first time a value becomes non-null"
 * primitive. `dispatch` (below) uses two instances of this to bridge two
 * INDEPENDENT async readiness windows without ever resolving as a false
 * success while the caller's own edit is silently dropped or permanently
 * hidden behind the engine's own-echo suppression:
 *  - `dispatchLocalGateRef`: armed once `EngineTaskBridge`'s
 *    `useReceiveEngine` first reports state (gated on `engineOrigin`
 *    resolving — a 2-IDB-read round trip, plus engine mount).
 *  - `publishOutboxGateRef`: armed once the outbox's own `loadPersisted()`
 *    rehydration settles (a single IDB read).
 *
 * These settle independently and in EITHER order — before this fix,
 * `EngineTaskBridge`'s slower 2-read path routinely lost the race to the
 * outbox's 1-read path, so a dispatch landing in that gap sent the edit to
 * the group (via `publishOutbox.publish`) while its `onLocalAccept` callback
 * silently no-op'd (dispatchLocal not yet wired) — the own kind-445 then
 * returned as "skipped" (own-echo suppression) and the edit was NEVER
 * accepted into the author's own projection, despite `dispatch` having
 * already resolved successfully. `dispatch` waits on the relevant gate(s)
 * instead of racing them.
 */
interface ReadinessGate<T> {
  current: T | null;
  waiters: Set<() => void>;
}

function createReadinessGate<T>(): ReadinessGate<T> {
  return { current: null, waiters: new Set() };
}

/** Arms the gate with a non-null value and resolves every pending waiter.
 *  Passing `null` just resets `.current` (used on teardown) — it never
 *  resolves waiters, since `null` is not a ready state. */
function setReadinessGateValue<T>(gate: ReadinessGate<T>, value: T | null): void {
  gate.current = value;
  if (value === null) return;
  const waiters = gate.waiters;
  gate.waiters = new Set();
  waiters.forEach((resolve) => resolve());
}

/** Unblocks every pending waiter WITHOUT setting a value — used on provider
 *  unmount so a `dispatch()` call that started waiting just before teardown
 *  can never hang past the component's own lifetime. */
function releaseReadinessGateWaiters<T>(gate: ReadinessGate<T>): void {
  const waiters = gate.waiters;
  gate.waiters = new Set();
  waiters.forEach((resolve) => resolve());
}

function waitForReadinessGate<T>(gate: ReadinessGate<T>): Promise<void> {
  if (gate.current !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    gate.waiters.add(resolve);
  });
}

const INITIAL_ENGINE_HOOK_STATE: ReceiveEngineHookState = {
  projection: new Map(),
  engineState: { lifecycle: "uninitialized", health: "nominal" },
  lastRejection: null,
  pendingTaskIds: new Set(),
};

/**
 * S9-2 remediation (Stage-2 review — F3): the engine path's "loading" set of
 * lifecycles — every phase the engine passes through BEFORE its projection
 * is necessarily populated (`"uninitialized"` pre-`start()`, `"joining"`
 * bootstrap fetch, `"catching_up"` historical drain — see fsm.md L2-L5).
 * `loading` flips to `false` only once the engine reaches
 * `"buffering_live"`/`"live"` (fsm.md L6/L7), never merely on leaving
 * `"uninitialized"`. `"recovering"` (S9/Opus watch-item, now reachable now
 * that restored-origin routing is wired — see `engineOrigin` below) is
 * included for the same reason: the projection is not necessarily populated
 * until recovery's R1 rebuild has run.
 */
const ENGINE_LOADING_LIFECYCLES: ReadonlySet<EngineLifecycleState> = new Set([
  "uninitialized",
  "joining",
  "catching_up",
  "recovering",
]);

interface EngineTaskBridgeProps {
  groupId: string;
  group: MarmotGroup | undefined;
  client: MarmotClient | null;
  signer: EventSigner | null;
  pubkey: string;
  relays: string[];
  /** Test-only: substitutes the real marmot-adapter `IngestSource` so unit
   *  tests can drive fixture events through the engine path without a real
   *  `MarmotGroup`/`MarmotClient`. Production callers MUST leave this
   *  undefined (see `TaskStoreProviderProps.engineIngestSourceOverride`). */
  ingestSourceOverride: IngestSource | undefined;
  /** CUTOVER-CORRECTNESS (S12, architecture.md "Re-join and Reset" /
   *  Implementation Constraint 12 / AC-REC-9): resolved by the parent
   *  (`TaskStoreProvider`'s `engineOrigin` state) BEFORE this component
   *  mounts, so `useReceiveEngine`'s effect always observes a synchronous,
   *  correctly-routed value on this component's first commit. `"restored"`
   *  when a persisted `EngineCheckpoint` already exists for the group
   *  (AC-REC-9's own routing then disambiguates recovering vs.
   *  preserve-and-replay internally); `"welcome"` for a genuinely fresh
   *  group. See `TaskStoreProvider`'s `engineOrigin` effect for the
   *  detection itself. */
  startOptions: StartOptions;
  onState: (state: ReceiveEngineHookState) => void;
}

/**
 * Mounted only once `TaskStoreProvider` has real marmot deps ready (or a
 * test override is supplied) AND this mount's engine-start origin has been
 * resolved — see the `shouldMountEngine` gate at its call site. CUTOVER
 * (S12): the strangler flag no longer participates in this gate — the
 * engine is now the SOLE receive path for every caller, unconditionally,
 * once ready. Its ENTIRE job is calling `useReceiveEngine` (S8) and
 * forwarding every resulting state to the parent via `onState`; it owns no
 * decision logic of its own (no if/switch/ternary — Boundary Rule 5) and
 * renders no DOM. `key={groupId}` at the call site (per the S8/S9
 * watch-item) forces a clean remount — and therefore a fresh engine
 * instance and a fresh persistence adapter — on group change, matching
 * react-engine-hooks.ts's own FRESH-ENGINE-PER-MOUNT contract.
 */
function EngineTaskBridge(props: EngineTaskBridgeProps): null {
  const {
    groupId,
    group,
    client,
    signer,
    pubkey,
    relays,
    ingestSourceOverride,
    startOptions,
    onState,
  } = props;

  // CUTOVER (S12): the S9 interim, session-scoped in-memory
  // PersistenceAdapter (used before checkpoint-store.ts/deferred-store.ts
  // existed) is replaced by the REAL, durable ten-method adapter S11 built
  // (deferred-store.ts's createPersistenceAdapter, composing
  // raw-event-log-store.ts + checkpoint-store.ts + its own deferred-id
  // CRUD). This is the first production composition root to consume it
  // (previously exercised only by deferred-store.test.ts) — checkpoints and
  // deferred ids now genuinely survive a reload, which is what makes the
  // origin-routing detection below (`engineOrigin`) meaningful: against the
  // old interim adapter, `loadCheckpoint` could never observe prior state
  // and every mount would look "welcome" forever. Lazily constructed
  // exactly once per mount (React's useState lazy-initializer form) — a
  // fresh, durable-store-backed adapter per group-mount.
  const [persistence] = useState<PersistenceAdapter>(() =>
    createPersistenceAdapter(),
  );

  function createEngine(): ReceiveEngine {
    // SIDE-EFFECT-FREE CONSTRUCTION (react-engine-hooks.ts's documented
    // constraint): constructing MarmotIngestAdapter/ReceiveEngine performs
    // no I/O — I/O only happens once `engine.start()` runs.
    const adapter: IngestSource =
      ingestSourceOverride ??
      createMarmotIngestAdapter({
        group: group as MarmotGroup,
        client: client as MarmotClient,
        groupId,
        relays,
        signer: signer as EventSigner,
        ownPubkey: pubkey,
      });
    return createReceiveEngine({
      groupId,
      adapter,
      persistence,
      scheduler: createRealEngineScheduler(),
    });
  }

  const hookState = useReceiveEngine({
    groupId,
    persistence,
    createEngine,
    startOptions,
  });
  const { projection, engineState, lastRejection, pendingTaskIds, dispatchLocal, confirmLocal } =
    hookState;

  // Depend on the INDIVIDUAL fields, not the `hookState` container object:
  // `useReceiveEngine` returns a freshly-constructed `{projection,
  // engineState, lastRejection, ...}` literal on every render (see its own
  // source), so keying this effect on that whole object would fire on
  // every render regardless of whether the underlying values changed --
  // and since firing calls `onState` -> the parent's setState -> a
  // re-render -> a new `hookState` literal, that shape is an infinite
  // render loop. The individual fields are only reassigned by
  // `useReceiveEngine`'s own `useState` setters on a genuine change
  // (`commitProjection`'s `next !== currentProjection` guard,
  // `engineState`/`lastRejection` only on their respective
  // `EngineOutputEvent` variants, and `pendingTaskIds` only inside
  // `recomputePendingTaskIds`), so depending on them directly makes this
  // effect fire only on real updates. `dispatchLocal`/`confirmLocal` are
  // `useCallback([])` inside `useReceiveEngine` -- referentially stable for
  // this hook's entire lifetime -- so including them below never itself
  // triggers a re-fire.
  useEffect(() => {
    onState({ projection, engineState, lastRejection, pendingTaskIds, dispatchLocal, confirmLocal });
  }, [projection, engineState, lastRejection, pendingTaskIds, dispatchLocal, confirmLocal, onState]);

  return null;
}

interface TaskStoreContextValue {
  tasks: Task[];
  dispatch: (event: TaskEvent) => Promise<void>;
  loading: boolean;
  /**
   * OPTIMISTIC LOCAL ECHO (S11B-Opus-1 remediation, AC-OPT-4): task ids with
   * at least one locally-dispatched edit not yet confirmed (own-echo not yet
   * observed) -- verbatim `engineHookState.pendingTaskIds` (react-engine-
   * hooks.ts owns the actual set-membership bookkeeping; this is pure
   * pass-through, no new decision logic, per Boundary Rule 5).
   *
   * Before `EngineTaskBridge` mounts (deps not yet ready, or this mount's
   * engine-start origin not yet resolved -- see `shouldMountEngine`),
   * `engineHookState` stays at `INITIAL_ENGINE_HOOK_STATE` and this is the
   * empty `Set()` from that constant.
   */
  pendingTaskIds: ReadonlySet<string>;
}

const TaskStoreContext = createContext<TaskStoreContextValue | null>(null);

interface TaskStoreProviderProps {
  groupId: string;
  children: ReactNode;
  /** Test-only override for the engine read-path's `IngestSource` — lets
   *  `task-store.cutover.test.tsx` drive fixture events through the engine
   *  path without a real `MarmotGroup`/`MarmotClient`. Production callers
   *  MUST leave this undefined (see `EngineTaskBridge`). */
  engineIngestSourceOverride?: IngestSource;
}

export const TaskStoreProvider: React.FC<TaskStoreProviderProps> = ({
  groupId,
  children,
  engineIngestSourceOverride,
}) => {
  const group = useGroup(groupId);
  const { pubkey, client, signer, relays } = useMarmot();

  // `engineHookState` mirrors the most recent state `EngineTaskBridge`
  // forwarded from `useReceiveEngine`. `readyForEngine` gates mounting the
  // bridge on either a test override or real marmot deps being available
  // (`group`/`client`/`signer`/`pubkey` load asynchronously — see
  // `useGroup`/`useMarmot`) — plain boolean composition, no
  // if/switch/ternary.
  const [engineHookState, setEngineHookState] = useState<ReceiveEngineHookState>(
    INITIAL_ENGINE_HOOK_STATE,
  );
  // OPTIMISTIC LOCAL ECHO READINESS GATES (S12-Fable-1): one pair per
  // PROVIDER mount (not per group) -- `dispatch`'s own `readyForEngineRef`
  // guard is what keeps a wait bounded across a group change; these gates
  // are simply re-armed (`.current` reset to `null`) whenever their
  // underlying value tears down, mirroring `publishOutbox`'s own per-group
  // reconstruction below.
  const dispatchLocalGateRef = useRef(
    createReadinessGate<NonNullable<ReceiveEngineHookState["dispatchLocal"]>>(),
  );
  const publishOutboxGateRef = useRef(createReadinessGate<PublishOutbox>());

  const handleEngineState = useCallback((next: ReceiveEngineHookState) => {
    setEngineHookState(next);
    // OPTIMISTIC LOCAL ECHO (S12-Fable-1): arm from `next` directly, not
    // from `engineHookStateRef` -- that ref is only refreshed during THIS
    // provider's own render (see below), which has not necessarily happened
    // yet at the moment this callback runs (it fires from the CHILD
    // `EngineTaskBridge`'s effect).
    setReadinessGateValue(dispatchLocalGateRef.current, next.dispatchLocal ?? null);
  }, []);

  useEffect(() => {
    return () => {
      // OPTIMISTIC LOCAL ECHO (S12-Fable-1): release any dispatch() call
      // still awaiting engine/outbox readiness so it never hangs past this
      // provider's own unmount.
      releaseReadinessGateWaiters(dispatchLocalGateRef.current);
      releaseReadinessGateWaiters(publishOutboxGateRef.current);
    };
  }, []);

  // CUTOVER-CORRECTNESS (S12, architecture.md "Re-join and Reset" +
  // Implementation Constraint 12 / AC-REC-9): the integration layer must
  // tell the engine whether this is a fresh group (`"welcome"` -> L2
  // joining -> fresh bootstrap) or one with existing local engine state
  // (`"restored"` -> L1, with the engine's own AC-REC-9 routing then
  // disambiguating recovering vs. preserve-and-replay from there).
  //
  // S12-2 (Stage-1 review remediation): a bare checkpoint-existence check is
  // a WEAKER proxy than Constraint 12's rule -- if a checkpoint save ever
  // failed while an accepted-log append succeeded (IDB partial/quota), a
  // reload would find `loadCheckpoint === null`, route `"welcome"`, and
  // silently drop the non-empty accepted log (the engine's own
  // checkpoint-absent-but-logs-present recovery only fires on the
  // `"restored"` path). Routing is now "any prior durable state exists":
  // checkpoint present OR the accepted-event log is non-empty. Still a
  // single boolean composition (`||` of two existence checks), not a branch
  // tree, per this story's Boundary Rule 5 allowance (see architecture.json
  // judgment call "s12-origin-routing-boolean-authorized-by-lead-brief").
  // `null` while unresolved so `shouldMountEngine` below can gate on it and
  // `EngineTaskBridge` never observes a wrong default. Re-resolved on every
  // `groupId` change.
  //
  // KNOWN GAP (flagged, not built here -- see architecture.json judgment
  // call "s12-rejoin-detection-gap-flagged-not-built"): a re-join (a NEW
  // Welcome for a group that already has local engine state, e.g. the
  // forget-device -> re-invite flow) is specified in architecture.md as
  // stop()->reset()->start("welcome"), integration-layer-detected. Nothing
  // here detects that case while the group is already mounted --
  // `EngineTaskBridge`'s `key={groupId}` only forces a fresh mount on a
  // `groupId` CHANGE, not a same-groupId re-join. The logs-non-empty
  // addition does not change this: a stale re-join checkpoint already
  // routes `"restored"` before and after this fix.
  const [engineOrigin, setEngineOrigin] = useState<EngineOrigin | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEngineOrigin(null);
    Promise.all([loadCheckpoint(groupId), loadAcceptedEvents(groupId)])
      .then(([checkpoint, acceptedEvents]) => {
        if (!cancelled) {
          setEngineOrigin(
            checkpoint !== null || acceptedEvents.length > 0 ? "restored" : "welcome",
          );
        }
      })
      .catch((err: unknown) => {
        console.error("[task-store] origin-routing durable-state check failed:", err);
        if (!cancelled) setEngineOrigin("welcome");
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const readyForEngine =
    Boolean(engineIngestSourceOverride) ||
    Boolean(group && client && signer && pubkey);
  const startOptionsForEngine: StartOptions | null =
    engineOrigin !== null ? { origin: engineOrigin } : null;
  // The actual mount gate: the engine is now the SOLE receive path, so it
  // mounts unconditionally once deps are ready AND the origin has resolved
  // -- no `EngineTaskBridge` (and no engine/live subscription/
  // `group.ingest()` call) until both are true. CUTOVER-COMPLETE (S13): the
  // strangler feature flag (`NEXT_PUBLIC_ENGINE_TASK_READS`) and its
  // `isEngineReadPathEnabled()` accessor have been physically deleted --
  // this gate never consulted the flag (S12 already made it unconditional),
  // so removing the dead scaffolding changes no runtime behavior.
  const shouldMountEngine = readyForEngine && startOptionsForEngine !== null;

  // OPTIMISTIC LOCAL ECHO (S12-Fable-1): read through a ref so `dispatch`
  // (below) can make a call-time bounded-vs-unbounded-wait decision without
  // needing `readyForEngine` in its own dependency array. `readyForEngine`
  // becoming true is the signal that BOTH `engineOrigin` resolution (and
  // therefore `EngineTaskBridge`'s mount) AND the outbox-construction effect
  // below are guaranteed to eventually settle (each has its own try/catch
  // fallback), which is what makes awaiting the readiness gates safe/bounded
  // rather than a potential indefinite hang.
  const readyForEngineRef = useRef(readyForEngine);
  readyForEngineRef.current = readyForEngine;

  // OPTIMISTIC LOCAL ECHO (S11B): read through a ref (mirrors `dispatchRef`/
  // `groupIdRef` below) so the publishOutbox-construction effect's
  // `onLocalAccept`/`onPendingCleared` closures always reach the CURRENT
  // `engineHookState.dispatchLocal`/`.confirmLocal` at CALL time, without
  // needing `engineHookState` in that effect's dependency array (which would
  // tear down and reconstruct `publishOutbox` -- durable outbox state -- on
  // every engine projection update). CUTOVER (S12): `dispatch`'s own
  // monotonic-timestamp lookup also reads through this ref -- see below.
  const engineHookStateRef = useRef(engineHookState);
  engineHookStateRef.current = engineHookState;

  // S10 (Phase 6, publish/outbox ownership): the SEND half of dispatch is
  // fully delegated to src/integration/publish-outbox.ts. One instance per
  // group/identity, rebuilt whenever `group`/`pubkey`/`client` change
  // (mirrors the reasoning behind EngineTaskBridge's `key={groupId}`
  // remount contract). `loadPersisted()` rehydrates marmot-adapter.ts's
  // in-memory reconciliation registry from durable storage BEFORE the
  // instance is published to `dispatch`, so a restart never races a fresh
  // publish against not-yet-rehydrated prior entries (AC-PUB-1).
  // S12-Fable-1: the VALUE half of this state is no longer read anywhere --
  // `dispatch` reads the current outbox through `publishOutboxGateRef`
  // instead (see that ref's doc comment), so only the setter survives.
  // `setPublishOutbox` is kept (rather than dropping the state entirely) so
  // this component still re-renders when the outbox becomes available,
  // preserving the pre-existing render-timing contract other effects in
  // this file may rely on.
  const [, setPublishOutbox] = useState<PublishOutbox | null>(null);
  useEffect(() => {
    if (!group || !client || !pubkey) {
      setPublishOutbox(null);
      publishOutboxGateRef.current.current = null;
      return;
    }
    const outbox = createPublishOutbox({
      groupId,
      pubkey,
      sendApplicationRumor: (rumor) => {
        // Preserves the pre-existing e2e test hook (window.__notestrTestArmPublishFailure)
        // that forces the NEXT publish to fail, e.g. to exercise
        // notestr:taskPublishFailed handling. isTestRuntime()-gated so it
        // is inert in production builds.
        const forcedError = isTestRuntime() ? window.__notestrTestPublishFailureOnce : null;
        if (forcedError) {
          window.__notestrTestPublishFailureOnce = null;
          return Promise.reject(new Error(forcedError));
        }
        return group.sendApplicationRumor(rumor);
      },
      nostrGroupIdHex: () => getNostrGroupIdHex(group.state),
      network: client.network,
      legacyPublishTrace: {
        enqueueExpectedPublish,
        beginDispatchPublishWindow,
        endDispatchPublishWindow,
        removeExpectedPublishByRumorId,
      },
      // OPTIMISTIC LOCAL ECHO (S11B, AC-OPT-1/4/8): delegates to whatever
      // engine-boundary mount currently exists (`EngineTaskBridge`, only
      // mounted while `shouldMountEngine` is true). No-ops via optional
      // chaining when the engine is not yet mounted (deps not ready / origin
      // not yet resolved).
      onLocalAccept: (rumorId, taskEvent) =>
        engineHookStateRef.current.dispatchLocal?.(rumorId, taskEvent),
      // S11B-Fable-1: onPendingCleared fires on every terminal outbox
      // outcome (reconciled / failed / cap-evicted), not just reconciled —
      // confirmLocal is a plain rumorId-membership clear regardless of why,
      // so the existing wiring already does the right thing unchanged.
      onPendingCleared: (rumorId) =>
        engineHookStateRef.current.confirmLocal?.(rumorId),
    });
    // Rehydration failure (IDB quota/eviction/private-mode — a real
    // failure mode, not hypothetical) must NOT disable NEW sends: the
    // rehydrated registry only matters for reconciling PRIOR entries'
    // own-echoes (AC-PUB-1), not for issuing fresh publishes. Committing
    // the outbox to state regardless of outcome is what keeps `dispatch`'s
    // `if (publishOutbox)` send-gate (below) from silently going dark for
    // the rest of the session.
    //
    // WINDOW, NOT DROPPED (S12-Fable-1 cutover fix): between deps-ready and
    // `loadPersisted` settling, `publishOutbox` (and
    // `publishOutboxGateRef.current.current`) are still null, so a dispatch
    // in this window has its SEND half deferred -- `dispatch` awaits
    // `publishOutboxGateRef` before touching `outbox`, rather than silently
    // skipping the send as it used to. The premise this comment previously
    // relied on -- that a legacy unconditional optimistic-apply block
    // already covered the local view regardless of this window -- no longer
    // holds (CUTOVER (S12) removed that block); `dispatch`'s own local
    // accept is bounded by the SEPARATE `dispatchLocalGateRef`, not this
    // one, so local reflection is unaffected by outbox timing either way.
    // Publishing the outbox synchronously (closing this window entirely)
    // would still race a fresh publish against not-yet-rehydrated
    // prior-entry reconciliation (AC-PUB-1), so the wait -- not a
    // synchronous construction -- remains the right fix.
    let cancelled = false;
    void outbox
      .loadPersisted()
      .catch((err: unknown) => {
        console.error("[task-store] outbox rehydrate failed:", err);
      })
      .finally(() => {
        if (!cancelled) {
          setPublishOutbox(outbox);
          setReadinessGateValue(publishOutboxGateRef.current, outbox);
        }
      });
    return () => {
      cancelled = true;
      outbox.dispose();
      if (publishOutboxGateRef.current.current === outbox) {
        publishOutboxGateRef.current.current = null;
      }
    };
  }, [group, groupId, client, pubkey]);

  // Dispatch a task event: stamp timestamps/device, then reflect it locally
  // and send it to the group.
  //
  // S12-Fable-1 CUTOVER-REGRESSION FIX (sev-5 blocker): CUTOVER (S12) had
  // deleted the legacy unconditional optimistic apply/persist block
  // (applyEvent + setState against the now-removed `state`, and appendEvent
  // against the retired src/store/persistence.ts) and left own-edit
  // visibility ENTIRELY dependent on `publishOutbox.publish`'s internal
  // `onLocalAccept` call -- which only fires once `publishOutbox` itself
  // exists, and only reaches the engine if `dispatchLocal` happens to
  // already be wired at that exact moment. Two silent-drop windows followed,
  // BOTH resolving this function as a false success:
  //  (A) `publishOutbox` still null (deps-ready -> `loadPersisted`-settling
  //      window): the edit was sent nowhere and reflected nowhere.
  //  (B) `publishOutbox` ready but `dispatchLocal` not yet wired
  //      (`EngineTaskBridge`'s 2-IDB-read origin resolution routinely loses
  //      the race to the outbox's 1-IDB-read `loadPersisted`): the edit WAS
  //      sent to the group, but the local accept no-op'd -- the own kind-445
  //      then returned "skipped" (own-echo suppression), so the edit reached
  //      every OTHER member but was PERMANENTLY invisible in the author's
  //      own projection.
  //
  // Fix: the local accept is now driven DIRECTLY from here, independent of
  // `publishOutbox`'s own readiness -- optimistic reflection happens the
  // moment the engine boundary is available, not gated on outbox
  // rehydration. `createdAt`/`rumorId` are computed ONCE (via the same
  // `computeRumorId` publish-outbox.ts uses internally) and threaded into
  // BOTH the direct local accept AND the outbox send below, so the two
  // agree byte-for-byte -- required for AC-OPT-3's own-echo dedupe (the
  // engine's own-echo suppression keys off exactly this id).
  //
  // Not-ready handling: `readyForEngineRef.current` decides whether waiting
  // for a gate is safe. When marmot deps (or a test override) are present,
  // `engineOrigin` resolution and the outbox's `loadPersisted()` are BOTH
  // guaranteed to eventually settle (each has its own try/catch fallback --
  // see their respective effects above), so awaiting the readiness gates is
  // bounded, never an indefinite hang, and keeps the common (engine-live)
  // case fast (`gate.current` is already non-null, so `waitForReadinessGate`
  // resolves synchronously). When deps are NOT present at all (no
  // group/session -- there is nothing that will ever become ready), this
  // function does not wait and does not throw: it preserves the pre-cutover
  // degenerate behavior of best-effort send (if an outbox happens to exist
  // already) with no local reflection -- see
  // task-store.optimistic-echo.test.tsx's "regression guard" case, which
  // exercises exactly this branch and asserts no throw.
  const dispatch = useCallback(
    async (taskEvent: TaskEvent) => {
      // Guarantee strict monotonicity before publish. Producers stamp
      // Math.floor(Date.now()/1000); two edits within the same wall-clock
      // second get the same updatedAt, causing the second to be silently
      // dropped by the strict-`>` LWW gate. `existing` reads the engine's
      // own projection -- the sole source of task state post-cutover.
      // task.created is exempt (FWW).
      const existing = taskEvent.type !== "task.created"
        ? engineHookStateRef.current.projection.get(taskEvent.taskId)
        : undefined;
      taskEvent = ensureMonotonicTimestamp(taskEvent, existing);

      // Stamp the third tie-break level: MLS clientId of this device.
      // Both the engine's local accept and the published rumor carry this
      // field, so the reducer's three-level gate (updatedAt → updatedBy →
      // updatedByDevice) resolves sibling-device same-second edits
      // deterministically.
      //
      // task.created embeds a full Task object; stamp the device on the nested
      // task so the resulting record honors the "device that last wrote this
      // task" contract from day one (otherwise bootstrap snapshots serialize
      // created-only tasks with an empty deviceId forever).
      const deviceId = client?.keyPackages.clientId ?? "";
      if (taskEvent.type === "task.created") {
        taskEvent = {
          ...taskEvent,
          task: { ...taskEvent.task, updatedByDevice: deviceId },
        };
      } else {
        taskEvent = { ...taskEvent, updatedByDevice: deviceId };
      }

      // OPTIMISTIC LOCAL ECHO, decoupled from outbox timing (see this
      // function's doc comment above). `createdAt`/`rumorId` computed ONCE,
      // shared with the outbox send below.
      const createdAt = Date.now();
      const rumorId = computeRumorId(createdAt, taskEvent, pubkey);

      if (readyForEngineRef.current) {
        await waitForReadinessGate(dispatchLocalGateRef.current);
      }
      const dispatchLocal = dispatchLocalGateRef.current.current;
      if (dispatchLocal) {
        await dispatchLocal(rumorId, taskEvent);
      }

      // Send to the MLS group. S10/S12: entirely delegated to
      // src/integration/publish-outbox.ts -- durable OutboxEntry creation,
      // send-attempt bookkeeping, own-publish/own-echo correlation, and
      // failure observability (including the notestr:taskPublishFailed
      // CustomEvent) all live there now. `publish()` is given the SAME
      // `createdAt`/`rumorId` computed above (see its `precomputed`
      // parameter doc) rather than deriving its own -- its own internal
      // `onLocalAccept` call becomes a safe no-op dedupe against the direct
      // `dispatchLocal` call above (`ReceiveEngine.acceptLocal` dedupes by
      // id), not a second independent accept.
      if (readyForEngineRef.current) {
        await waitForReadinessGate(publishOutboxGateRef.current);
      }
      const outbox = publishOutboxGateRef.current.current;
      if (outbox) {
        await outbox.publish(taskEvent, { createdAt, rumorId });
      }
    },
    [client, pubkey],
  );

  // Keep the latest dispatch and groupId reachable via refs so the test
  // hooks installed below can be registered ONCE per provider mount and
  // stay registered across re-renders. Earlier wiring re-ran the effect
  // whenever `dispatch` or `groupId` changed (which happens whenever a
  // relay echo advances the group's MLS epoch and rebuilds the `group`
  // reference under `useCallback`'s deps), so the cleanup briefly deleted
  // `window.__notestrTestDispatchTaskEvent` between renders. A test that
  // fired a `dispatchTaskEvent` during that window saw the hook missing.
  const dispatchRef = useRef(dispatch);
  const groupIdRef = useRef(groupId);
  dispatchRef.current = dispatch;
  groupIdRef.current = groupId;

  useEffect(() => {
    if (!isTestRuntime()) return;

    window.__notestrTestDispatchTaskEvent = (taskEvent) =>
      dispatchRef.current(taskEvent);
    window.__notestrTestTasks = () =>
      Array.from(engineHookStateRef.current.projection.values());
    // CUTOVER (S12): the legacy `notestr:events:${groupId}` log this hook
    // used to read is retired -- sourced from the durable engine accepted-
    // event log instead. `.map((e) => e.payload)` preserves the pre-
    // existing `Promise<TaskEvent[]>` return contract (see
    // src/types/notestr-test-hooks.d.ts) so e2e specs consuming this hook
    // are unaffected by the underlying store swap.
    window.__notestrTestPersistedTaskEvents = async () =>
      (await loadAcceptedEvents(groupIdRef.current)).map((e) => e.payload);
    window.__notestrTestArmPublishFailure = (message = "forced publish failure") => {
      window.__notestrTestPublishFailureOnce = message;
    };

    return () => {
      delete window.__notestrTestDispatchTaskEvent;
      delete window.__notestrTestTasks;
      delete window.__notestrTestPersistedTaskEvents;
      delete window.__notestrTestArmPublishFailure;
      delete window.__notestrTestPublishFailureOnce;
    };
  }, []);

  // CUTOVER (S12, AC-MIG-3): task-store now reads exclusively from the
  // engine's projection -- the legacy MLS-group-message-listener-fed
  // `state`/`loading` and the S9 activeRead selector ternary that chose
  // between them are gone (this file registers no such listener anymore).
  // `ENGINE_LOADING_LIFECYCLES` still gates `loading` the same way it
  // always has for the engine path.
  const tasks = Array.from(engineHookState.projection.values());
  const loading = ENGINE_LOADING_LIFECYCLES.has(
    engineHookState.engineState.lifecycle,
  );

  return (
    <>
      {shouldMountEngine && startOptionsForEngine && (
        <EngineTaskBridge
          key={groupId}
          groupId={groupId}
          group={group}
          client={client}
          signer={signer}
          pubkey={pubkey}
          relays={relays}
          ingestSourceOverride={engineIngestSourceOverride}
          startOptions={startOptionsForEngine}
          onState={handleEngineState}
        />
      )}
      <TaskStoreContext.Provider
        value={{
          tasks,
          dispatch,
          loading,
          pendingTaskIds: engineHookState.pendingTaskIds,
        }}
      >
        {children}
      </TaskStoreContext.Provider>
    </>
  );
};

export function useTaskStore(): TaskStoreContextValue {
  const context = useContext(TaskStoreContext);
  if (!context) {
    throw new Error("useTaskStore must be used within a TaskStoreProvider");
  }
  return context;
}
