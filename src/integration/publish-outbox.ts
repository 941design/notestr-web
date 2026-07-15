/**
 * publish-outbox.ts
 *
 * S10 (Phase 6, event-sourced-receive-engine epic): owns the FULL lifecycle
 * of a locally-initiated `TaskEvent` publish — durable intent, send-attempt
 * bookkeeping, failure observability, and (via `marmot-adapter.ts`'s outbox
 * bridge) own-echo reconciliation. Replaces `task-store.tsx`:`dispatch`'s
 * former inline mutex/rumor-build/window-tracking/CustomEvent SEND block.
 * The React-owned halves of dispatch (optimistic `setState` and the legacy
 * `notestr:events:${groupId}` log append) remain `task-store.tsx`'s job —
 * see this story's architecture.json judgment call
 * "s10-task-store-dispatch-delegation-out-of-listed-scope-includes".
 *
 * DURABILITY (AC-PUB-1): every `OutboxEntry` is persisted to IndexedDB
 * (keyed via `engine-types.ts`'s Rule-9 `outboxKey`/`OUTBOX_KEY_PREFIX`, the
 * sole authority for that key per AC-BOUND-3) on every status transition,
 * via `marmot-adapter.ts`'s per-group
 * persist-hook registry. `loadPersisted()` rehydrates `marmot-adapter.ts`'s
 * in-memory reconciliation registry from that durable store, so an entry
 * that reached "sent" before a restart can still be reconciled by a LATER
 * own-echo arriving after the restart (AC-PUB-1 scenario (b): "restart
 * before own-echo observed").
 *
 * RETRY IMMUTABILITY (VQ-S10-005 / Boundary Rule 7): `createdAt`/`taskEvent`
 * are frozen on the FIRST `publish()` call and never reassigned by
 * `retry()`. The rumor bytes (and therefore `rumorId`) are a pure,
 * deterministic function of `(createdAt, taskEvent, pubkey)` — rebuilding
 * that draft on retry always reproduces the identical id, by construction,
 * not by caching a rumor object.
 *
 * MODULE GRAPH: this file deliberately does NOT import
 * `src/marmot/device-sync.ts` directly, even though it preserves that
 * file's pre-existing GAP-2 diagnostic tracker's behavior (see
 * `PublishOutboxDeps.legacyPublishTrace`) — device-sync.ts has no
 * lightweight named-export subset (loading it means loading its full
 * transitive graph: marmot-ts, ts-mls, the legacy persistence path). The
 * four GAP-2 functions are injected instead, so this module and its own
 * test suite stay fully self-contained; production callers (task-store.tsx,
 * which already imports those four functions today) supply the real
 * implementations.
 */

import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash } from "nostr-tools/pure";

import { createKVStore } from "../marmot/storage";
import {
  beginOutboxPublishWindow,
  endOutboxPublishWindow,
  ensureOutboxNetworkWrapped,
  getOutboxEntry,
  markOutboxAttemptStarted,
  markOutboxFailed,
  markOutboxSentFallback,
  MAX_OUTBOX_ENTRIES_PER_GROUP,
  registerOutboxEntry,
  registerOutboxEvictionHook,
  registerOutboxPersistHook,
  rehydrateOutboxEntries,
  removeOutboxExpectation,
  unregisterOutboxEvictionHook,
  unregisterOutboxPersistHook,
  type OutboxNetworkLike,
} from "./marmot-adapter";
import { outboxKey, type OutboxEntry } from "../engine/engine-types";
import { TASK_EVENT_KIND, type TaskEvent } from "../domain/task-events";

const outboxStore = createKVStore<OutboxEntry[]>("outbox");

/**
 * Per-group dispatch mutex (relocated from task-store.tsx). Two concurrent
 * `publish()`/`retry()` calls on the SAME group serialize through this so
 * one attempt's enqueue -> sendApplicationRumor -> window-close sequence
 * fully completes before the next attempt's enqueue runs — without it, the
 * GAP-2/outbox-bridge FIFOs could correlate the wrong rumor.id to the wrong
 * kind-445 eventId under a double-click race. Same chain-promise pattern as
 * device-sync.ts's ingestLock / the original task-store.tsx
 * dispatchPublishLock it replaces.
 */
const publishLocks = new Map<string, Promise<void>>();

async function withPublishLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const prevLock = publishLocks.get(groupId) ?? Promise.resolve();
  const myTurn = prevLock.catch(() => undefined);
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  publishLocks.set(groupId, myTurn.then(() => released));
  await myTurn;
  try {
    return await fn();
  } finally {
    release();
    const currentTail = publishLocks.get(groupId);
    if (currentTail) {
      currentTail.then(() => {
        if (publishLocks.get(groupId) === currentTail) {
          publishLocks.delete(groupId);
        }
      });
    }
  }
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

/**
 * Deterministic rumor draft. Content is `JSON.stringify(taskEvent)`,
 * `created_at` seeds from `createdAt` (frozen across retries), `pubkey` is
 * the account identity. Recomputing this from the SAME
 * `(createdAt, taskEvent, pubkey)` tuple always yields the same event id —
 * this IS what keeps `rumorId` byte-identical across retries, not a cached
 * object (VQ-S10-005 / Boundary Rule 7).
 */
function buildRumorDraft(
  createdAt: number,
  taskEvent: TaskEvent,
  pubkey: string,
): { id: string; kind: number; content: string; tags: string[][]; created_at: number; pubkey: string } {
  return {
    id: "",
    kind: TASK_EVENT_KIND,
    content: JSON.stringify(taskEvent),
    tags: [["t", "task"]],
    created_at: Math.floor(createdAt / 1000),
    pubkey,
  };
}

/**
 * Exported (S12-Fable-1 cutover fix) so `task-store.tsx`'s `dispatch` can
 * compute the SAME `(createdAt, rumorId)` pair this module would otherwise
 * derive internally, and pass it into `publish()` — see that function's
 * `precomputed` parameter doc. This is what lets `dispatch` drive the
 * engine-boundary local accept directly (decoupled from outbox-rehydration
 * timing) while still guaranteeing the accepted rumorId and the
 * subsequently-sent rumor's id are byte-identical (AC-OPT-3 own-echo
 * dedupe).
 */
export function computeRumorId(createdAt: number, taskEvent: TaskEvent, pubkey: string): string {
  return getEventHash(buildRumorDraft(createdAt, taskEvent, pubkey));
}

function buildRumor(entry: OutboxEntry, pubkey: string): Rumor {
  const draft = buildRumorDraft(entry.createdAt, entry.taskEvent, pubkey);
  return { ...draft, id: getEventHash(draft) };
}

export interface PublishOutboxDeps {
  groupId: string;
  /**
   * Account identity pubkey stamped on the rumor (matches the pre-existing
   * task-store.tsx dispatch behavior — NOT the per-device MLS clientId,
   * which the CALLER is responsible for having already stamped onto the
   * taskEvent (e.g. `updatedByDevice`) before calling `publish()`).
   */
  pubkey: string;
  /** Sends the built rumor through the live MLS group (`group.sendApplicationRumor`). */
  sendApplicationRumor: (rumor: Rumor) => Promise<unknown>;
  /**
   * Reads the group's current `#h` tag (`getNostrGroupIdHex(group.state)`),
   * lazily — read at send time, never cached, since epoch/ratchet state can
   * advance between construction and a later retry.
   */
  nostrGroupIdHex: () => string;
  /**
   * The live network object whose `.publish` marmot-ts calls internally.
   * Wrapped once, idempotently (see `ensureOutboxNetworkWrapped`).
   */
  network: OutboxNetworkLike;
  /**
   * Optional legacy diagnostic bridge (`src/marmot/device-sync.ts`'s
   * pre-existing GAP-2 tracker) — preserves the mlsTrace `publish-task`
   * event the COMPLETE mls-live-delivery-race epic's e2e trace classifier
   * depends on. INJECTED rather than imported directly so this module (and
   * its own test suite) does not need to resolve device-sync.ts's full
   * transitive module graph (marmot-ts / ts-mls / the legacy
   * `notestr:events:${groupId}` persistence path) — device-sync.ts has no
   * lightweight named-export subset; loading it means loading all of it.
   * Production callers (`task-store.tsx`, which already imports these
   * exact four functions today) should supply the real implementations;
   * omitting this is safe and loses only the diagnostic trace, never
   * correctness (this story's OWN outbox correlation below is fully
   * independent of it — see architecture.json's judgment calls).
   */
  legacyPublishTrace?: {
    enqueueExpectedPublish: (
      hTag: string,
      rumorId: string,
      groupId: string,
      taskEventId: string,
    ) => void;
    beginDispatchPublishWindow: (hTag: string) => void;
    endDispatchPublishWindow: (hTag: string) => void;
    removeExpectedPublishByRumorId: (hTag: string, rumorId: string) => void;
  };
  /**
   * Dispatches a DOM CustomEvent on send failure, preserving the
   * pre-existing `notestr:taskPublishFailed` UI-observability contract.
   * Overridable for tests / non-DOM environments; defaults to
   * `window.dispatchEvent` when `window` exists.
   */
  dispatchFailureEvent?: (detail: {
    groupId: string;
    taskEvent: TaskEvent;
    error: string;
  }) => void;
  now?: () => number;
  /**
   * OPTIMISTIC LOCAL ECHO (S11B). Invoked with the SAME
   * `computeRumorId(createdAt, taskEvent, pubkey)` output this module
   * already computes for the outgoing rumor — never a second, independently
   * derived id (AC-OPT-5) — BEFORE any send is attempted (AC-OPT-1: the
   * accept must precede the relay round-trip). Awaited so ordering is
   * deterministic; wrapped in a try/catch internally so a failing accept can
   * never make `publish()`/`retry()` throw (both preserve their existing
   * "never throws" contract). Called from both `publish()` (first attempt)
   * and `retry()` — the second call is a no-op via `ReceiveEngine.acceptLocal`'s
   * own id-based dedupe if the first already accepted it. Omitted (e.g. the
   * engine read-path is not mounted) loses only the immediate-visibility
   * optimization, never send correctness.
   */
  onLocalAccept?: (rumorId: string, taskEvent: TaskEvent) => Promise<void> | void;
  /**
   * OPTIMISTIC LOCAL ECHO (S11B), pending->cleared half (AC-OPT-4, extended
   * by S11B-Fable-1). Fires exactly once per entry, when that entry LEAVES
   * the in-flight/unresolved set — i.e. on any of its three terminal
   * outcomes:
   *   1. `"reconciled"` — own-echo observed (the original AC-OPT-4 case;
   *      success).
   *   2. `"failed"` — the send attempt threw and will not be auto-retried
   *      (piggybacked on the SAME per-group persist hook this module
   *      already registers via `registerOutboxPersistHook`, which
   *      marmot-adapter.ts already calls on every status mutation).
   *   3. Cap-evicted — the 256-per-group in-memory cap
   *      (`MAX_OUTBOX_ENTRIES_PER_GROUP`) dropped this entry before its
   *      echo returned, so it can never reconcile (wired via
   *      `registerOutboxEvictionHook`, a SEPARATE per-group registry —
   *      eviction is not itself a status mutation on the evicted entry).
   * Deliberately does NOT fire on a bare `"sent"` transition: a sent entry
   * may still be reconciled later, so it is not yet resolved. The name is
   * "cleared", not "reconciled", because clearing means "no longer
   * actively tracked as in-flight" — it carries no success/failure
   * judgment; `dispatchFailureEvent` above remains the sole failure
   * surface.
   */
  onPendingCleared?: (rumorId: string) => void;
}

export interface PublishOutbox {
  /**
   * Creates a fresh `OutboxEntry` (status "pending"), persists it, and
   * attempts exactly one send. Never throws — a send failure is durably
   * recorded (status "failed", `lastError` set) and observable via the
   * returned entry and the failure CustomEvent; the promise still resolves.
   *
   * `precomputed` (S12-Fable-1 cutover fix): when supplied, `createdAt`/
   * `rumorId` are used VERBATIM instead of being derived here via `now()`/
   * `computeRumorId`. This lets a caller (`task-store.tsx`'s `dispatch`)
   * perform its own local-accept call with the exact same rumorId BEFORE
   * calling `publish()`, and still have `publish()`'s outgoing rumor hash to
   * the identical id — required for AC-OPT-3's own-echo dedupe. Omitting
   * this parameter preserves the original self-contained behavior (this
   * module derives both values itself).
   */
  publish(
    taskEvent: TaskEvent,
    precomputed?: { createdAt: number; rumorId: string },
  ): Promise<OutboxEntry>;
  /**
   * Re-attempts a send for an existing tracked entry (by `rumorId`),
   * reusing its `createdAt`/`taskEvent` UNCHANGED — `rumorId` is therefore
   * byte-identical to the original (VQ-S10-005). Throws if no such entry is
   * currently tracked in memory (call `loadPersisted()` first after a
   * restart).
   */
  retry(rumorId: string): Promise<OutboxEntry>;
  /**
   * Loads every persisted `OutboxEntry` for this group from IndexedDB and
   * rehydrates `marmot-adapter.ts`'s in-memory reconciliation registry so a
   * post-restart own-echo can still be matched (AC-PUB-1 scenario (b)).
   * Call once after construction, before the first `publish()`/`retry()`.
   */
  loadPersisted(): Promise<OutboxEntry[]>;
  getEntry(rumorId: string): OutboxEntry | undefined;
  /**
   * Unregisters this instance's persist hook. Call on unmount / group
   * change so a stale closure does not survive in `marmot-adapter.ts`'s
   * per-group hook registry.
   */
  dispose(): void;
}

function defaultDispatchFailureEvent(detail: {
  groupId: string;
  taskEvent: TaskEvent;
  error: string;
}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("notestr:taskPublishFailed", { detail }));
}

export function createPublishOutbox(deps: PublishOutboxDeps): PublishOutbox {
  const now = (): number => (deps.now ?? Date.now)();
  const dispatchFailureEvent = deps.dispatchFailureEvent ?? defaultDispatchFailureEvent;

  // Idempotent — safe to call from every createPublishOutbox invocation,
  // including multiple groups sharing one MarmotClient/network object.
  ensureOutboxNetworkWrapped(deps.network);

  /**
   * Upserts `entry` into the durable outbox array (`engine-types.ts`'s
   * `outboxKey(groupId)`), then enforces the S10-1 bound
   * (`MAX_OUTBOX_ENTRIES_PER_GROUP`) DURABLY and SELF-CONTAINED — entirely
   * inside this one `updateItem` transaction, with no dependency on
   * marmot-adapter.ts's in-memory eviction (`enforceOutboxCap`) having run.
   * This is deliberate: an entry pruned from the in-memory registry (a
   * reconciled own-echo, or an in-memory cap eviction) still needs its
   * durable write to stay bounded on every subsequent write to this group's
   * array, and durable growth must be bounded EVEN WHEN `reconcileOwnEcho`
   * never runs at all for a given entry (e.g. the own-echo is permanently
   * lost — relay partition, group departure before it arrives) — the SAME
   * cap, applied here, covers that case too without any cross-module
   * signaling. Evict-eldest by `createdAt`, mirroring `ingest-policy.ts`'s
   * deferred-queue eviction; evicting an unreconciled (or even a
   * reconciled-but-not-yet-evicted) entry is acceptable — relay re-sync
   * remains the backstop.
   */
  async function persistEntry(entry: OutboxEntry): Promise<void> {
    await outboxStore.updateItem(outboxKey(deps.groupId), (stored) => {
      const existing = stored ?? [];
      const snapshot: OutboxEntry = { ...entry };
      const idx = existing.findIndex((e) => e.rumorId === entry.rumorId);
      const next =
        idx === -1
          ? [...existing, snapshot]
          : existing.map((e, i) => (i === idx ? snapshot : e));
      if (next.length <= MAX_OUTBOX_ENTRIES_PER_GROUP) return next;
      return [...next]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(next.length - MAX_OUTBOX_ENTRIES_PER_GROUP);
    });
  }

  registerOutboxPersistHook(deps.groupId, (entry) => {
    void persistEntry(entry);
    // S11B AC-OPT-4 / S11B-Fable-1: piggyback the pending->cleared signal on
    // this SAME hook, which already fires on every status mutation. Fires on
    // BOTH terminal outcomes reachable through a status mutation —
    // "reconciled" (own-echo observed, success) and "failed" (send attempt
    // threw, won't be auto-retried) — but deliberately NOT on "pending" or a
    // bare "sent" (still awaiting its own-echo, may yet reconcile). The
    // third terminal path, cap-eviction, does not go through this hook at
    // all (an eviction is not a status mutation on the evicted entry) — see
    // the `registerOutboxEvictionHook` call below.
    if (entry.status === "reconciled" || entry.status === "failed") {
      deps.onPendingCleared?.(entry.rumorId);
    }
  });

  // S11B-Fable-1: an entry evicted by the 256-cap before its own-echo
  // returns can never reach "reconciled" (reconcileOwnEcho only matches
  // entries still tracked in marmot-adapter.ts's in-memory registry) — so
  // without this, the optimistic-pending bookkeeping would stay stuck
  // forever for it. Same clear signal as the reconciled/failed cases above.
  registerOutboxEvictionHook(deps.groupId, (rumorId) => {
    deps.onPendingCleared?.(rumorId);
  });

  /**
   * S11B: notifies the engine boundary of a locally-authored task BEFORE any
   * send is attempted. Never throws — see `PublishOutboxDeps.onLocalAccept`'s
   * doc comment for the full contract.
   */
  async function notifyLocalAccept(
    rumorId: string,
    taskEvent: TaskEvent,
  ): Promise<void> {
    try {
      await deps.onLocalAccept?.(rumorId, taskEvent);
    } catch (err) {
      console.error("[publish-outbox] onLocalAccept failed (non-fatal):", err);
    }
  }

  /**
   * Sends `entry`'s rumor exactly once, bracketing the call with BOTH the
   * pre-existing device-sync.ts GAP-2 window (preserves the mlsTrace
   * `publish-task` diagnostic the COMPLETE mls-live-delivery-race epic's
   * e2e trace classifier depends on — see architecture.json judgment call)
   * and this story's own outbox-bridge window (attributes sentEventId /
   * drives own-echo reconciliation). Never throws — a failure is durably
   * recorded and observed via the returned entry.
   */
  async function attemptSend(entry: OutboxEntry): Promise<OutboxEntry> {
    return withPublishLock(deps.groupId, () => doAttemptSend(entry));
  }

  async function doAttemptSend(entry: OutboxEntry): Promise<OutboxEntry> {
    const hTag = deps.nostrGroupIdHex();
    // Resets status to "pending" and bumps attempts/lastAttemptAt exactly
    // once for this attempt — including a RETRY, whose entry's status is
    // "failed" from the prior attempt. This is what makes the "only
    // transition a pending entry" guards below correct on retries too, not
    // just on the very first attempt.
    markOutboxAttemptStarted(entry.rumorId, now());

    deps.legacyPublishTrace?.enqueueExpectedPublish(
      hTag,
      entry.rumorId,
      entry.groupId,
      entry.rumorId,
    );
    deps.legacyPublishTrace?.beginDispatchPublishWindow(hTag);
    beginOutboxPublishWindow(hTag, entry.rumorId);

    let sendFailed = false;
    let failureMessage = "";
    try {
      const rumor = buildRumor(entry, deps.pubkey);
      await deps.sendApplicationRumor(rumor);
    } catch (err) {
      sendFailed = true;
      failureMessage = describeError(err, "sendApplicationRumor failed");
      deps.legacyPublishTrace?.removeExpectedPublishByRumorId(hTag, entry.rumorId);
      removeOutboxExpectation(hTag, entry.rumorId);
    } finally {
      // endOutboxPublishWindow (and the diagnostic device-sync.ts twin, if
      // supplied) MUST run before the outcome is finalized below — it is
      // what attributes the real sentEventId when the window was
      // unambiguous, and it must run even on failure (to release the FIFO
      // slot) before markOutboxFailed authoritatively overwrites status.
      deps.legacyPublishTrace?.endDispatchPublishWindow(hTag);
      endOutboxPublishWindow(hTag, now());
    }

    if (sendFailed) {
      // Unconditional — always the final word for this attempt, even if
      // network.publish DID fire (and endOutboxPublishWindow attributed a
      // sentEventId) before sendApplicationRumor ultimately threw (e.g. no
      // relay confirmed via hasAck()).
      markOutboxFailed(entry.rumorId, failureMessage, now());
      dispatchFailureEvent({
        groupId: entry.groupId,
        taskEvent: entry.taskEvent,
        error: failureMessage,
      });
    } else {
      // No-op if the window already attributed a real sentEventId (status
      // is no longer "pending"); advances an ambiguous/unattributed-but-
      // successful send out of "pending" so it is never stuck forever.
      markOutboxSentFallback(entry.rumorId, now());
    }

    return getOutboxEntry(entry.rumorId) ?? entry;
  }

  return {
    async publish(
      taskEvent: TaskEvent,
      precomputed?: { createdAt: number; rumorId: string },
    ): Promise<OutboxEntry> {
      const createdAt = precomputed?.createdAt ?? now();
      const rumorId =
        precomputed?.rumorId ?? computeRumorId(createdAt, taskEvent, deps.pubkey);
      // AC-OPT-1/5: accept into the engine boundary BEFORE the send attempt,
      // using the exact rumorId the send will use. Idempotent/safe even if
      // `precomputed` means the CALLER already accepted this exact rumorId
      // directly (see `dispatch`'s doc comment) — `ReceiveEngine.acceptLocal`
      // dedupes by id.
      await notifyLocalAccept(rumorId, taskEvent);
      const entry: OutboxEntry = {
        rumorId,
        groupId: deps.groupId,
        createdAt,
        taskEvent,
        status: "pending",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        sentEventId: null,
        ownEchoObservedAt: null,
      };
      registerOutboxEntry(entry);
      return attemptSend(entry);
    },

    async retry(rumorId: string): Promise<OutboxEntry> {
      const existing = getOutboxEntry(rumorId);
      if (!existing) {
        throw new Error(
          `publish-outbox: retry() found no tracked entry for rumorId=${rumorId}`,
        );
      }
      // Idempotent no-op if publish() already accepted this rumorId (same id,
      // ReceiveEngine.acceptLocal's own dedupe) — defensive coverage for the
      // (currently unreachable, but not structurally impossible) case where
      // the original publish() call's accept never fired.
      await notifyLocalAccept(rumorId, existing.taskEvent);
      return attemptSend(existing);
    },

    async loadPersisted(): Promise<OutboxEntry[]> {
      const stored = (await outboxStore.getItem(outboxKey(deps.groupId))) ?? [];
      rehydrateOutboxEntries(stored);
      return [...stored];
    },

    getEntry(rumorId: string): OutboxEntry | undefined {
      return getOutboxEntry(rumorId);
    },

    dispose(): void {
      unregisterOutboxPersistHook(deps.groupId);
      unregisterOutboxEvictionHook(deps.groupId);
    },
  };
}
