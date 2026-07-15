/**
 * marmot-adapter.ts
 *
 * The SOLE file (besides receive-engine.ts's type-only consumption of
 * `IngestSource`/`IngestSignal`) permitted to import marmot-ts types
 * (architecture.md "Seam Contracts › IngestSource / IngestSignal", Boundary
 * Rule: `src/integration/marmot-adapter.ts` -> marmot-ts). Implements the
 * engine-owned `IngestSource` control interface (`src/engine/engine-types.ts`)
 * against the real `MarmotGroup`/`MarmotClient` API, translating every real
 * marmot-ts ingest outcome into the marmot-free `IngestSignal` union. This
 * file never redefines `IngestSource`/`IngestSignal` — it implements the
 * engine-defined interface.
 *
 * Resolves MOCK-05-001 (specs/epic-event-sourced-receive-engine/mocks-registry.json).
 *
 * BOUNDARY RULE 10 COMPLIANCE: this file registers ZERO independent React
 * lifecycle (no useState/useEffect/useRef, no DOM). The engine owns this
 * adapter — it is constructed and handed to the engine, which holds the only
 * reference and calls `close()` as the final action of its own `stop()`.
 *
 * ----------------------------------------------------------------------
 * Real marmot-ts contract this file translates (verified directly against
 * node_modules/@internet-privacy/marmot-ts/dist/client/group/marmot-group.{d.ts,js}
 * — NOT against src/marmot/device-sync.ts, which this file does not import,
 * per Boundary Rule 5 and the src/integration/* dependency table):
 *
 *  - `group.ingest(events)` is an `AsyncGenerator<IngestResult>` yielding
 *    exactly one `IngestResult` per input Nostr event (kind-445 envelope),
 *    already sorted/staged (non-commits first, then commits in MIP-03 race
 *    order) -- the KIND union has four members:
 *      - `{ kind: "processed", result, event, message }` -- `result` is
 *        ts-mls's `ProcessMessageResult`. When `result.kind ===
 *        "applicationMessage"`, `result.message` (a `Uint8Array`) IS the
 *        already-decrypted application payload -- no separate
 *        `group.on("applicationMessage", ...)` listener is needed to
 *        correlate content back to the triggering event (see the S7
 *        architecture.json judgment call
 *        "s7-application-message-correlation-via-processed-result-not-listener").
 *        When `result.kind === "newState"`, this was a proposal (epoch
 *        unchanged) or a commit (epoch advances by exactly one) -- neither
 *        carries application content.
 *      - `{ kind: "skipped", event, message, reason }` -- ratchet already
 *        consumed this id (own-echo / duplicate / past-epoch / etc; see the
 *        `reason` union in marmot-group.d.ts). Maps to `IngestSignal.skipped`.
 *      - `{ kind: "unreadable", event, errors }` -- not (yet) decryptable.
 *        Maps to `IngestSignal.deferred` with `reason: "unreadable"`.
 *      - `{ kind: "rejected", result, event, message }` -- an admin-rejected
 *        commit; no state mutation occurred. Mapped to `IngestSignal.skipped`
 *        (no better-fitting variant in the closed 5-member union; see the S7
 *        architecture.json judgment call
 *        "s7-non-task-rumor-kind-and-marmot-rejected-mapping").
 *  - Two concurrent `group.ingest()` calls on the SAME `MarmotGroup` race on
 *    its internal `this.state` mutation (confirmed by src/marmot/device-sync.ts's
 *    pre-existing `ingestLock` comment and by direct inspection of
 *    marmot-group.js) -- every call site below funnels through
 *    `#runIngestBatch`'s promise-chained mutex.
 *  - Epoch is read via `group.state.groupContext.epoch` (a `bigint`); it only
 *    changes when a Commit is applied (a processed proposal or application
 *    message updates `this.state` too, but never `groupContext.epoch`). This
 *    file detects a genuine epoch change by comparing the epoch immediately
 *    before/after each yielded `IngestResult` and emits `epoch_advanced` only
 *    on a strict increase -- a bare ratchet advance (app-message generation
 *    counter) produces no signal, matching the architecture.md invariant.
 * ----------------------------------------------------------------------
 */

import {
  deserializeApplicationData,
  getGroupMembers as realGetGroupMembers,
  getNostrGroupIdHex as realGetNostrGroupIdHex,
  GROUP_EVENT_KIND,
  type MarmotClient,
  type MarmotGroup,
  type Unsubscribable,
} from "@internet-privacy/marmot-ts";

import type {
  IngestSignal,
  IngestSource,
  NostrEvent,
  OutboxEntry,
  RawProtocolFact,
  RawProtocolFactInput,
  ReceiptSource,
  Unsubscribe,
} from "../engine/engine-types";
import {
  TASK_EVENT_KIND,
  TASK_STATE_SYNC_KIND,
  type Task,
  type TaskEvent,
  type TaskStateSyncPayload,
  type TaskStatus,
} from "../domain/task-events";
import { taskWinsOver } from "../domain/task-crdt";

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Minimal structural signer capability this adapter needs (NIP-44 decrypt for
 * `fetchBootstrap`'s kind-30078 snapshot). Deliberately a LOCAL structural
 * type rather than an import of applesauce-core's `EventSigner` -- mirrors
 * `engine-types.ts`'s own `NostrEvent` judgment call: architecture.md's
 * declared `src/integration/*` allowed edges list marmot-ts, not
 * applesauce-core, as an external-package edge. Any real `EventSigner`
 * (nostr-tools, applesauce, NIP-46 bunker wrapper, ...) already satisfies
 * this shape structurally.
 */
export interface Nip44Capable {
  nip44?: {
    decrypt: (pubkey: string, ciphertext: string) => Promise<string> | string;
  };
}

/**
 * Construction dependencies for `MarmotIngestAdapter`. `group`/`client` are
 * the real marmot-ts handles for this Nostr group -- the integration layer
 * (e.g. a future react-engine-hooks.ts) constructs these and hands them to
 * the adapter; the adapter never constructs its own `MarmotGroup`/
 * `MarmotClient`. `signer`/`ownPubkey` are used only by `fetchBootstrap()`.
 */
export interface MarmotAdapterDeps {
  group: MarmotGroup;
  client: MarmotClient;
  /** MLS group id (matches `RawProtocolFact.groupId`, `RawFactsKey`, etc). */
  groupId: string;
  relays: string[];
  signer: Nip44Capable;
  /** Hex pubkey of the local member; used to derive the bootstrap d-tag. */
  ownPubkey: string;
  /**
   * Reads the hex `#h` tag value (marmot-ts's `getNostrGroupIdHex`) used to
   * filter kind-445 group events. Defaults to the real marmot-ts function.
   * Overridable so tests can drive a contract-faithful stub `MarmotGroup`
   * whose `.state` is not a fully valid MLS `ClientState` (real
   * `getNostrGroupIdHex` requires a decoded `MarmotGroupData` extension,
   * which is orthogonal to the `group.ingest()` outcome translation this
   * module exists to test).
   *
   * **Test-only override seam — production callers MUST leave this
   * undefined.** It exists solely so unit tests can substitute a stub
   * that bypasses the real decode requirement above. In production the
   * real `getNostrGroupIdHex` must run against a real `ClientState`;
   * supplying an override here would silently break #h-tag filtering of
   * kind-445 group events (every event would appear to belong to, or be
   * excluded from, the wrong group).
   */
  getNostrGroupIdHex?: (state: MarmotGroup["state"]) => string;
  /**
   * Reads the current member pubkeys (marmot-ts's `getGroupMembers`), used
   * by `fetchBootstrap()`'s author-authenticity gate. Defaults to the real
   * marmot-ts function; overridable for the same reason as
   * `getNostrGroupIdHex` above (real `getGroupMembers` requires a fully
   * populated MLS ratchet tree).
   *
   * **Test-only override seam — production callers MUST leave this
   * undefined.** It exists solely so unit tests can substitute a stub
   * that bypasses the real ratchet-tree requirement above. In production
   * the real `getGroupMembers` must run against a real `ClientState`;
   * supplying an override here would silently break `fetchBootstrap()`'s
   * author-authenticity gate (a forged or non-member author could pass as
   * legitimate).
   */
  getGroupMembers?: (state: MarmotGroup["state"]) => string[];
  /** Clock override for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Preferred construction path -- callers should depend on the engine-owned
 * `IngestSource` interface, never on `MarmotIngestAdapter`'s concrete shape.
 */
export function createMarmotIngestAdapter(deps: MarmotAdapterDeps): IngestSource {
  return new MarmotIngestAdapter(deps);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TASK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.assigned",
  "task.deleted",
]);

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "done",
  "cancelled",
]);

/**
 * Structural validation of a full `Task` (src/domain/task-events.ts), used
 * both by `isTaskEvent`'s `task.created` case and by `fetchBootstrap`'s
 * per-entry validation of a member-authored kind-30078 snapshot's `tasks`
 * array. Every field checked here is one `task-projector.ts`'s `applyEvent`
 * (via the Map it builds) or `task-crdt.ts`'s `taskWinsOver` dereferences
 * downstream — a shape that passes this check can never crash projection
 * (Codex Stage-2 review, Finding P1/P2: a recognized `type`/array element
 * with a missing required field must never reach `applyEvent`/`taskWinsOver`
 * as if it were well-formed).
 */
function isValidTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<Task>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    typeof t.description === "string" &&
    typeof t.status === "string" &&
    TASK_STATUSES.has(t.status as TaskStatus) &&
    (t.assignee === null || typeof t.assignee === "string") &&
    typeof t.createdBy === "string" &&
    typeof t.createdAt === "number" &&
    typeof t.updatedAt === "number" &&
    typeof t.updatedBy === "string" &&
    (t.updatedByDevice === undefined || typeof t.updatedByDevice === "string")
  );
}

/**
 * The fields common to every non-`task.created` `TaskEvent` variant.
 * `taskId` is the `TaskProjection` Map key `applyEvent` looks up
 * (`projection.get(payload.taskId)`); `updatedAt`/`updatedBy`/
 * `updatedByDevice` are what `task-crdt.ts`'s `taskWinsOver` compares. A
 * payload missing any of these would either crash the lookup or silently
 * corrupt the tie-break, never a safe no-op.
 */
function hasValidMutationFields(
  candidate: Record<string, unknown>,
): boolean {
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.updatedAt === "number" &&
    typeof candidate.updatedBy === "string" &&
    (candidate.updatedByDevice === undefined ||
      typeof candidate.updatedByDevice === "string")
  );
}

/** `task.updated`'s `changes` field, dereferenced via `...payload.changes` spread in `task-projector.ts`. */
function isValidChanges(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    (c.title === undefined || typeof c.title === "string") &&
    (c.description === undefined || typeof c.description === "string")
  );
}

/**
 * Structural validation of a decoded rumor against the full `TaskEvent`
 * union — not just its discriminant. A rumor whose `type` names a
 * recognized variant but whose required fields (per variant, cross-checked
 * against every dereference `task-projector.ts`'s `applyEvent` and
 * `task-crdt.ts`'s `taskWinsOver` perform) are missing or mistyped is
 * REJECTED here (routes to `IngestSignal.malformed`), never passed through
 * as `message` (Codex Stage-2 review, Finding P1: an unvalidated payload
 * shape must never reach downstream projection code as if it were
 * well-formed).
 */
function isTaskEvent(value: unknown): value is TaskEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.type !== "string" ||
    !TASK_EVENT_TYPES.has(candidate.type)
  ) {
    return false;
  }
  switch (candidate.type) {
    case "task.created":
      return isValidTask(candidate.task);
    case "task.updated":
      return (
        hasValidMutationFields(candidate) && isValidChanges(candidate.changes)
      );
    case "task.status_changed":
      return (
        hasValidMutationFields(candidate) &&
        typeof candidate.status === "string" &&
        TASK_STATUSES.has(candidate.status)
      );
    case "task.assigned":
      return (
        hasValidMutationFields(candidate) &&
        (candidate.assignee === null || typeof candidate.assignee === "string")
      );
    case "task.deleted":
      return hasValidMutationFields(candidate);
    default:
      return false;
  }
}

function isTaskStateSyncPayload(
  value: unknown,
  expectedGroupId: string,
): value is TaskStateSyncPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TaskStateSyncPayload>;
  return (
    candidate.version === 1 &&
    candidate.type === "task.state_sync" &&
    candidate.groupId === expectedGroupId &&
    Array.isArray(candidate.tasks)
  );
}

function describeError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

// ---------------------------------------------------------------------------
// Outbox bridge (S10 — Phase 6 publish/outbox ownership)
// ---------------------------------------------------------------------------
//
// Owns two independent concerns, both scoped to this module (see this
// story's architecture.json judgment calls "s10-independent-outbox-wrap-not-
// network-ts-hook" for why src/marmot/device-sync.ts and src/marmot/network.ts
// are deliberately NOT touched by this story):
//
//  1. Own-publish kind-445 correlation: when publish-outbox.ts calls
//     group.sendApplicationRumor(rumor), marmot-ts internally calls
//     client.network.publish(relays, kind445Event) but never returns the
//     resulting relay event id to the caller (the same gap
//     src/marmot/device-sync.ts's pre-existing GAP-2 tracker works around
//     for a different, diagnostic-only purpose). ensureOutboxNetworkWrapped
//     idempotently wraps client.network.publish once per network object to
//     observe that id and attribute it to the OutboxEntry that requested
//     the send, using the SAME per-hTag-FIFO + in-window-kind-445-count
//     disambiguation algorithm device-sync.ts's tracker uses: a kind-445
//     commit/proposal from auto-invite or per-leaf-remove can interleave
//     with our own application-rumor publish inside the window; if more
//     than one kind-445 fires, attribution is ambiguous and is skipped
//     rather than guessed (never a wrong attribution).
//
//  2. Own-echo reconciliation: MarmotIngestAdapter.doIngestBatch already
//     translates every group.ingest() outcome. A "skipped"/"rejected"
//     result means the ratchet already consumed this id — including the
//     self-echo case, where marmot-ts intentionally never decrypts our own
//     kind-445 coming back from the relay (see this file's module doc
//     comment). reconcileOwnEcho matches the returning fact's
//     content-addressed id EXACTLY against a tracked entry's sentEventId —
//     never against taskId/content — which is what makes a same-content
//     publish from a DIFFERENT device/pubkey structurally unable to
//     false-positive-match (a different pubkey and/or a different
//     per-device `updatedByDevice` value baked into the rumor content
//     yields different MLS ciphertext, hence a different content-hashed
//     kind-445 event id). This closes VQ-S10-006.

const outboxEntries = new Map<string, OutboxEntry>();
const outboxPersistHooks = new Map<string, (entry: OutboxEntry) => void>();
/**
 * S11B-Fable-1: per-group callback fired for each `rumorId` evicted from the
 * IN-MEMORY registry by `enforceOutboxCap` below. An evicted entry's own-echo
 * can never reconcile it afterward (`reconcileOwnEcho` only matches entries
 * still tracked in `outboxEntries`), so without this signal
 * `publish-outbox.ts`'s optimistic-pending bookkeeping would stay stuck
 * forever for anything the 256-cap evicts before its echo returns. Mirrors
 * `outboxPersistHooks`'s per-group registry shape exactly (registered /
 * unregistered from the same `createPublishOutbox`/`dispose()` call sites).
 */
const outboxEvictionHooks = new Map<string, (rumorId: string) => void>();

/**
 * Bound on the number of tracked `OutboxEntry` records retained PER GROUP.
 * Mirrors `ingest-policy.ts`'s `DEFAULT_INGEST_POLICY_OPTIONS.maxDeferredSize`
 * cap-with-evict-eldest discipline (same rationale: a structure fed by every
 * local mutation, with no guarantee its normal drain path — here, own-echo
 * reconciliation — ever runs, must have a hard backstop independent of that
 * drain path). Fixes S10-1 (unbounded outbox growth for an entry whose
 * own-echo is never observed: `reconcileOwnEcho` is only reachable via
 * `MarmotIngestAdapter.doIngestBatch`, which never runs for that entry if
 * the echo is permanently lost — relay partition, group departure before it
 * arrives, etc.).
 *
 * Applied at TWO independent layers, deliberately not coupled by a shared
 * remove-hook (see the design note on {@link enforceOutboxCap}):
 *  - In-memory: `enforceOutboxCap` below, bounding `outboxEntries`.
 *  - Durable: `publish-outbox.ts`'s `persistEntry`, bounding the outbox
 *    array (`engine-types.ts`'s `outboxKey(groupId)`) on every write,
 *    self-contained inside that store's own `updateItem` transaction.
 */
export const MAX_OUTBOX_ENTRIES_PER_GROUP = 256;

function notifyOutboxPersist(entry: OutboxEntry): void {
  outboxPersistHooks.get(entry.groupId)?.(entry);
}

/**
 * Registers a per-group durability callback, fired on every OutboxEntry
 * status mutation (register / sent / failed / reconciled). Deliberately a
 * per-group registry, not a single global hook — two groups' publish-outbox
 * instances must not clobber each other's persistence.
 */
export function registerOutboxPersistHook(
  groupId: string,
  hook: (entry: OutboxEntry) => void,
): void {
  outboxPersistHooks.set(groupId, hook);
}

export function unregisterOutboxPersistHook(groupId: string): void {
  outboxPersistHooks.delete(groupId);
}

/**
 * Registers a per-group callback fired once per `rumorId` evicted by
 * {@link enforceOutboxCap} (S11B-Fable-1). See `outboxEvictionHooks`'s doc
 * comment for why this is a distinct registry from the persist hook above
 * (an eviction is NOT a status mutation on the evicted entry itself — it is
 * removed from the in-memory registry with its last-known status untouched).
 */
export function registerOutboxEvictionHook(
  groupId: string,
  hook: (rumorId: string) => void,
): void {
  outboxEvictionHooks.set(groupId, hook);
}

export function unregisterOutboxEvictionHook(groupId: string): void {
  outboxEvictionHooks.delete(groupId);
}

/**
 * Cap-with-evict-eldest for one group's IN-MEMORY tracked entries (S10-1),
 * invoked after every insertion point (`registerOutboxEntry`,
 * `rehydrateOutboxEntries`) so in-memory growth is bounded regardless of
 * whether `reconcileOwnEcho` ever runs. Evicting an unreconciled entry is
 * acceptable: relay re-sync remains the backstop, exactly as for
 * `ingest-policy.ts`'s deferred-queue eviction.
 *
 * Deliberately in-memory-only — does NOT also trigger a durable delete.
 * `publish-outbox.ts`'s `persistEntry` independently caps the durable
 * outbox array (`engine-types.ts`'s `outboxKey(groupId)`) on every write
 * (same `MAX_OUTBOX_ENTRIES_PER_GROUP`, same evict-eldest-by-createdAt
 * rule), so durable growth is bounded even for an entry that was evicted here (or
 * pruned by `reconcileOwnEcho`) before its durable write is a no-op to
 * repeat. Coupling the two via a cross-module remove-hook was considered
 * and rejected: it is unnecessary once the durable side self-caps, and a
 * reconcile-triggered durable delete would conflict with AC-PUB-1 (an
 * own-echo reconciled BEFORE a restart must still read back as
 * "reconciled" via `loadPersisted()` afterward — see the existing AC-PUB-1
 * test suite below, which this design leaves intact).
 */
function enforceOutboxCap(groupId: string): void {
  const groupEntries = Array.from(outboxEntries.values()).filter(
    (e) => e.groupId === groupId,
  );
  if (groupEntries.length <= MAX_OUTBOX_ENTRIES_PER_GROUP) return;
  groupEntries.sort((a, b) => a.createdAt - b.createdAt);
  const evictCount = groupEntries.length - MAX_OUTBOX_ENTRIES_PER_GROUP;
  const evictionHook = outboxEvictionHooks.get(groupId);
  for (let i = 0; i < evictCount; i++) {
    const victim = groupEntries[i];
    if (!victim) continue;
    outboxEntries.delete(victim.rumorId);
    // S11B-Fable-1: this entry can never reconcile now (reconcileOwnEcho
    // only matches entries still tracked in outboxEntries) -- tell
    // publish-outbox.ts so it doesn't leave the optimistic-pending
    // bookkeeping stuck forever for it.
    evictionHook?.(victim.rumorId);
  }
}

/**
 * Tracks a fresh publish intent (typically status "pending"). Called by
 * publish-outbox.ts once per NEW OutboxEntry — never for a retry of an
 * already-tracked entry (retries reuse the tracked instance directly).
 */
export function registerOutboxEntry(entry: OutboxEntry): void {
  outboxEntries.set(entry.rumorId, entry);
  notifyOutboxPersist(entry);
  enforceOutboxCap(entry.groupId);
}

export function getOutboxEntry(rumorId: string): OutboxEntry | undefined {
  return outboxEntries.get(rumorId);
}

/**
 * Restores entries loaded from durable storage (e.g. after a restart) into
 * the in-memory reconciliation registry, so a LATER own-echo can still be
 * matched (AC-PUB-1's "restart before own-echo observed" scenario). Does
 * NOT fire the persist hook — these entries are already durable; this is a
 * read-back, not a new mutation. DOES enforce the S10-1 in-memory cap per
 * rehydrated group afterward, so a REGISTRY that grew unbounded before this
 * fix shipped is trimmed back in memory on the next load rather than being
 * rehydrated wholesale forever (the durable store itself is independently
 * self-capping — see `MAX_OUTBOX_ENTRIES_PER_GROUP`'s doc comment).
 */
export function rehydrateOutboxEntries(entries: readonly OutboxEntry[]): void {
  const groupIds = new Set<string>();
  for (const entry of entries) {
    outboxEntries.set(entry.rumorId, { ...entry });
    groupIds.add(entry.groupId);
  }
  for (const groupId of groupIds) enforceOutboxCap(groupId);
}

export function clearOutboxEntry(rumorId: string): void {
  outboxEntries.delete(rumorId);
}

/**
 * Clears the in-memory outbox registry on an identity switch (S10-2:
 * `outboxEntries` is process-global module state with no per-identity reset
 * outside the test-only helper below). Unlike `resetOutboxBridgeForTests`,
 * this is the PRODUCTION reset and is deliberately narrow:
 *
 *  - `outboxEntries` is the only piece of state here with no OTHER
 *    identity-scoped teardown path — the per-group persist hook and
 *    publish-window tracking are already correctly torn down by each
 *    `PublishOutbox.dispose()` call (task-store.tsx's outbox effect cleanup,
 *    keyed on `[group, groupId, client, pubkey]`, which fires whenever the
 *    identity changes).
 *  - `networkWrapMarker` needs no explicit reset: it is a `WeakSet` keyed on
 *    the (about-to-be-discarded) `MarmotClient.network` object, which
 *    becomes unreachable and is garbage-collected once a fresh
 *    `MarmotClient` is constructed for the new identity.
 *
 * Without this, a prior identity's `OutboxEntry` records — keyed by
 * `rumorId`, a plain string, never weakly held — remain resident in this
 * process-global `Map` after sign-out/identity-switch. Not a correctness
 * bug on its own (`reconcileOwnEcho`'s groupId scoping makes a cross-
 * identity false match structurally impossible), but a leak of one
 * account's publish intents into the next account's session, and it
 * compounds S10-1's unbounded-growth exposure. The composition root
 * (`src/marmot/client.tsx`'s `MarmotProvider`) calls this from the SAME
 * effect-cleanup that calls `unbindStores()` on sign-out / identity switch.
 */
export function resetOutboxEntriesForIdentityChange(): void {
  outboxEntries.clear();
}

/**
 * Clears ALL outbox-bridge module state (entries, persist hooks, and the
 * publish-window tracking below). Test-only reset for isolation between
 * test files/cases.
 */
export function resetOutboxBridgeForTests(): void {
  outboxEntries.clear();
  outboxPersistHooks.clear();
  outboxEvictionHooks.clear();
  outboxWindowState.clear();
  outboxDispatchInFlight.clear();
  outboxExpectedByHTag.clear();
  networkWrapMarker = new WeakSet<object>();
}

/**
 * Marks the START of a send attempt (the first publish() call OR any later
 * retry() reusing the same entry). Resets status to "pending" and bumps the
 * attempt/timestamp bookkeeping — this is the ONE place `attempts`
 * increments, so exactly one increment happens per `attemptSend` call
 * regardless of which of markOutboxSent/markOutboxSentFallback/
 * markOutboxFailed ultimately decides the outcome. Resetting to "pending"
 * here (even when the entry's prior status was "failed" from an earlier
 * attempt) is what makes markOutboxSent/markOutboxSentFallback's "only
 * transition a `pending` entry" guard correct across retries, not just on
 * the first attempt.
 */
export function markOutboxAttemptStarted(rumorId: string, now: number): void {
  const entry = outboxEntries.get(rumorId);
  if (!entry) return;
  entry.status = "pending";
  entry.attempts += 1;
  entry.lastAttemptAt = now;
  entry.lastError = null;
  notifyOutboxPersist(entry);
}

/**
 * Transitions "pending" -> "sent" with an unambiguously-attributed relay
 * event id. A no-op if the entry is missing or not currently "pending" —
 * `markOutboxFailed` runs AFTER this in `attemptSend`'s ordering when the
 * overall send threw, and unconditionally overwrites whatever this function
 * set, so a same-attempt failure is always the authoritative final word.
 */
function markOutboxSent(rumorId: string, sentEventId: string, now: number): void {
  const entry = outboxEntries.get(rumorId);
  if (!entry || entry.status !== "pending") return;
  entry.status = "sent";
  entry.sentEventId = sentEventId;
  entry.lastAttemptAt = now;
  notifyOutboxPersist(entry);
}

/**
 * Fallback for when the publish window could NOT unambiguously attribute a
 * kind-445 id (an interleaved commit/proposal, or none observed) but
 * `sendApplicationRumor` itself did not throw. The entry must still advance
 * out of "pending" so it is never stuck forever. A no-op if the entry is not
 * currently "pending" (never overwrites a correctly-attributed "sent").
 */
export function markOutboxSentFallback(rumorId: string, now: number): void {
  const entry = outboxEntries.get(rumorId);
  if (!entry || entry.status !== "pending") return;
  entry.status = "sent";
  entry.lastAttemptAt = now;
  notifyOutboxPersist(entry);
}

/**
 * Authoritatively marks a send attempt as failed. Deliberately UNGUARDED
 * (no status check) — `attemptSend` calls this AFTER `endOutboxPublishWindow`
 * has had its chance to attribute a `sentEventId`, so a same-attempt failure
 * always wins regardless of whether the underlying `network.publish` call
 * was observed to fire before the eventual throw (e.g. no relay confirmed
 * via `hasAck()`).
 */
export function markOutboxFailed(rumorId: string, error: string, now: number): void {
  const entry = outboxEntries.get(rumorId);
  if (!entry) return;
  entry.status = "failed";
  entry.lastAttemptAt = now;
  entry.lastError = error;
  notifyOutboxPersist(entry);
}

/**
 * Matches a returning fact against every tracked OutboxEntry's sentEventId
 * by EXACT equality (never by taskId/content — see the module-doc security
 * note above, VQ-S10-006). Idempotent: reconciling an already-reconciled
 * entry again is a no-op (returns null; the first reconciliation already
 * pruned it from the in-memory registry below, so a duplicate skipped-
 * delivery of the same id finds no tracked entry left to match on the
 * second call).
 *
 * S10-1: a confirmed own-echo round-trip has served the outbox's IN-MEMORY
 * reconciliation purpose (matching is idempotent already, so nothing further
 * ever needs to find this entry via `getOutboxEntry`/`getEntry`) — the
 * terminal "reconciled" transition still durably PERSISTS the final status
 * (`notifyOutboxPersist`, same as every other transition — this is what
 * AC-PUB-1 depends on: a reconciled-before-restart entry must still read
 * back as "reconciled" via `loadPersisted()`), but then prunes ONLY the
 * in-memory registry (`clearOutboxEntry`). Deliberately does NOT also delete
 * the durable record here — see `enforceOutboxCap`'s design note for why
 * durable bounding is handled independently (by `publish-outbox.ts`'s
 * self-capping `persistEntry`) rather than via a reconcile-triggered durable
 * delete, which would conflict with AC-PUB-1. The RETURNED object still
 * reflects the final "reconciled" state (same object reference the Map
 * held, mutated in place before removal).
 */
export function reconcileOwnEcho(
  fact: Pick<RawProtocolFactInput, "id" | "groupId">,
  now: number,
): OutboxEntry | null {
  for (const entry of outboxEntries.values()) {
    if (
      entry.sentEventId === fact.id &&
      entry.groupId === fact.groupId &&
      entry.status !== "reconciled"
    ) {
      entry.status = "reconciled";
      entry.ownEchoObservedAt = now;
      notifyOutboxPersist(entry);
      clearOutboxEntry(entry.rumorId);
      return entry;
    }
  }
  return null;
}

// --- Own-publish kind-445 correlation (per-hTag FIFO). A fresh
// implementation scoped to this module (NOT device-sync.ts's tracker — see
// the module-doc note above).

interface OutboxWindowState {
  count: number;
  firstEventId: string | null;
}

const outboxDispatchInFlight = new Map<string, number>();
const outboxWindowState = new Map<string, OutboxWindowState>();
/** hTag -> FIFO of rumorIds currently expecting a kind-445 attribution. */
const outboxExpectedByHTag = new Map<string, string[]>();

/**
 * Opens this rumorId's attribution window on `hTag` and registers it at the
 * back of that hTag's FIFO. Must be paired with exactly one
 * {@link endOutboxPublishWindow} call, bracketing the `sendApplicationRumor`
 * call (mirrors device-sync.ts's begin/endDispatchPublishWindow pairing).
 */
export function beginOutboxPublishWindow(hTag: string, rumorId: string): void {
  const prev = outboxDispatchInFlight.get(hTag) ?? 0;
  outboxDispatchInFlight.set(hTag, prev + 1);
  if (!outboxWindowState.has(hTag)) {
    outboxWindowState.set(hTag, { count: 0, firstEventId: null });
  }
  const queue = outboxExpectedByHTag.get(hTag);
  if (queue) {
    queue.push(rumorId);
  } else {
    outboxExpectedByHTag.set(hTag, [rumorId]);
  }
}

/**
 * Closes this hTag's attribution window. If exactly one kind-445 fired
 * during the window, its id is attributed to the FIFO's front entry
 * (markOutboxSent). Zero or more-than-one observed kind-445s leave the
 * entry's status untouched here — the caller applies
 * {@link markOutboxSentFallback} once its own `sendApplicationRumor` await
 * resolves without throwing, so the entry still advances out of "pending".
 */
export function endOutboxPublishWindow(hTag: string, now: number): void {
  const cur = outboxDispatchInFlight.get(hTag) ?? 0;
  if (cur > 1) {
    outboxDispatchInFlight.set(hTag, cur - 1);
    return; // still nested, decide later
  }
  outboxDispatchInFlight.delete(hTag);

  const state = outboxWindowState.get(hTag);
  outboxWindowState.delete(hTag);
  if (!state) return;

  const queue = outboxExpectedByHTag.get(hTag);
  const rumorId = queue?.shift();
  if (queue && queue.length === 0) outboxExpectedByHTag.delete(hTag);
  if (!rumorId) return;

  if (state.count === 1 && state.firstEventId) {
    markOutboxSent(rumorId, state.firstEventId, now);
  }
  // count === 0 (never reached network.publish) or count > 1 (ambiguous,
  // an interleaved commit/proposal): leave attribution alone. The caller's
  // markOutboxSentFallback still advances a non-throwing send out of
  // "pending" even in the ambiguous/zero case.
}

/**
 * Drops a parked FIFO entry after a send failure, mirroring
 * device-sync.ts's removeExpectedPublishByRumorId — without this, a thrown
 * send would leave its expectation parked and the next successful publish
 * on the same hTag could misattribute its kind-445 id to the wrong entry.
 */
export function removeOutboxExpectation(hTag: string, rumorId: string): void {
  const queue = outboxExpectedByHTag.get(hTag);
  if (!queue) return;
  const idx = queue.indexOf(rumorId);
  if (idx === -1) return;
  queue.splice(idx, 1);
  if (queue.length === 0) outboxExpectedByHTag.delete(hTag);
}

/** Marker set tracking already-wrapped network objects, making
 *  {@link ensureOutboxNetworkWrapped} idempotent (multiple
 *  createPublishOutbox calls, or multiple groups sharing one MarmotClient,
 *  must not stack wrappers). Reassigned (not just cleared) by
 *  resetOutboxBridgeForTests so a test's wrapped network object from a
 *  PRIOR test doesn't leak a stale "already wrapped" marker across files
 *  that reuse the same network object reference. */
let networkWrapMarker = new WeakSet<object>();

export interface OutboxNetworkLike {
  publish: (relays: string[], event: NostrEvent) => Promise<unknown>;
}

/**
 * Idempotently wraps `network.publish` to observe every kind-445 it
 * publishes (any group, any hTag) and tally it against whichever hTag
 * currently has an open outbox publish window. Mirrors
 * device-sync.ts's consumeExpectedPublishForKind445 in spirit, but tracks
 * this module's OWN OutboxEntry FIFO (outboxExpectedByHTag), independent of
 * device-sync.ts's tracker.
 */
export function ensureOutboxNetworkWrapped(network: OutboxNetworkLike): void {
  if (networkWrapMarker.has(network)) return;
  networkWrapMarker.add(network);
  const original = network.publish.bind(network);
  network.publish = (relays: string[], event: NostrEvent) => {
    if (event.kind === GROUP_EVENT_KIND) {
      const hTagEntry = event.tags.find(
        (tag): tag is [string, string, ...string[]] =>
          Array.isArray(tag) && tag[0] === "h" && typeof tag[1] === "string",
      );
      const hTag = hTagEntry?.[1];
      if (hTag && (outboxDispatchInFlight.get(hTag) ?? 0) > 0) {
        const state = outboxWindowState.get(hTag);
        if (state) {
          state.count++;
          if (state.count === 1) state.firstEventId = event.id;
        }
      }
    }
    return original(relays, event);
  };
}

// ---------------------------------------------------------------------------
// MarmotIngestAdapter
// ---------------------------------------------------------------------------

export class MarmotIngestAdapter implements IngestSource {
  private readonly deps: MarmotAdapterDeps;
  /** Promise-chained mutex serializing every `group.ingest()` invocation
   * across `catchUp()`/`openLive()`/`ingestPersisted()` -- see the module
   * doc comment. Never touched by `fetchBootstrap()`, which never calls
   * `group.ingest()`. */
  private ingestChain: Promise<void> = Promise.resolve();
  private liveSub: Unsubscribable | null = null;

  constructor(deps: MarmotAdapterDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private nostrGroupIdHex(): string {
    return (this.deps.getNostrGroupIdHex ?? realGetNostrGroupIdHex)(
      this.deps.group.state,
    );
  }

  private memberPubkeys(): string[] {
    return (this.deps.getGroupMembers ?? realGetGroupMembers)(
      this.deps.group.state,
    );
  }

  // -------------------------------------------------------------------
  // IngestSource
  // -------------------------------------------------------------------

  async *catchUp(): AsyncIterable<IngestSignal> {
    const events = await this.fetchGroupEvents();
    const signals = await this.runIngestBatch(events, "historical");
    for (const signal of signals) yield signal;
  }

  openLive(onSignal: (signal: IngestSignal) => void): Unsubscribe {
    const hTag = this.nostrGroupIdHex();
    const sub = this.deps.client.network
      .subscription(this.deps.relays, [{ kinds: [GROUP_EVENT_KIND], "#h": [hTag] }])
      .subscribe({
        next: (event: NostrEvent) => {
          this.runIngestBatch([event], "live")
            .then((signals) => {
              for (const signal of signals) onSignal(signal);
            })
            .catch((err: unknown) => {
              console.warn(
                "[marmot-adapter] live event ingest failed (non-fatal):",
                err,
              );
            });
        },
      });
    this.liveSub = sub;
    return () => {
      sub.unsubscribe();
      if (this.liveSub === sub) this.liveSub = null;
    };
  }

  async *ingestPersisted(facts: RawProtocolFact[]): AsyncIterable<IngestSignal> {
    if (facts.length === 0) return;
    const byId = new Map(facts.map((f) => [f.nostrEventId, f]));
    const events = facts.map((f) => f.nostrEvent);
    const signals = await this.runIngestBatch(events, "historical", byId);
    for (const signal of signals) yield signal;
  }

  async *fetchBootstrap(): AsyncIterable<IngestSignal> {
    if (!this.deps.signer.nip44) {
      console.warn(
        "[marmot-adapter] fetchBootstrap: signer has no nip44 capability; skipping bootstrap (non-fatal)",
      );
      return;
    }
    const dTag = `notestr:task-sync:${this.deps.groupId}:${this.deps.ownPubkey}`;
    let events: NostrEvent[];
    try {
      events = await this.deps.client.network.request(this.deps.relays, [
        { kinds: [TASK_STATE_SYNC_KIND], "#d": [dTag], limit: 10 },
      ]);
    } catch (err) {
      console.warn(
        "[marmot-adapter] fetchBootstrap: relay request failed (non-fatal):",
        err,
      );
      return;
    }
    if (events.length === 0) return;

    // Author-authenticity gate: NIP-44 decryptability is not authorization —
    // only a current group member's snapshot is eligible to merge.
    const memberPubkeys = this.memberPubkeys();
    const qualifying = events.filter((e) => memberPubkeys.includes(e.pubkey));
    if (qualifying.length === 0) return;

    // Relay-order-independent per-task winner across every qualifying
    // snapshot copy, delegated entirely to the shared tie-break authority
    // (Boundary Rule 10) -- never reimplemented here.
    const winners = new Map<string, Task>();
    for (const event of qualifying) {
      let payload: TaskStateSyncPayload;
      try {
        const plaintext = await this.deps.signer.nip44.decrypt(
          event.pubkey,
          event.content,
        );
        const parsed: unknown = JSON.parse(plaintext);
        if (!isTaskStateSyncPayload(parsed, this.deps.groupId)) continue;
        payload = parsed;
      } catch {
        // Decryption failed or JSON parse failed / invalid payload shape —
        // skip this event (non-fatal, matches the pre-existing production
        // fetchAndApplyTaskBootstrap behavior).
        continue;
      }
      for (const task of payload.tasks) {
        // A malformed entry (null, or missing/mistyped required Task
        // fields) is skipped, NOT thrown on -- this loop runs OUTSIDE the
        // decrypt/parse try/catch above, so an unguarded `task.id` read
        // would abort the entire bootstrap drain over one corrupt entry
        // from an otherwise-legitimate member snapshot (Codex Stage-2
        // review, Finding P2). Matches the robustness intent of the
        // pre-existing `fetchAndApplyTaskBootstrap` behavior this
        // supersedes.
        if (!isValidTask(task)) continue;
        const existing = winners.get(task.id);
        if (!existing || taskWinsOver(task, existing)) {
          winners.set(task.id, task);
        }
      }
    }
    if (winners.size === 0) return;

    // All synthesized bootstrap messages share ONE fact representing the
    // resolved bootstrap fetch as a whole (see architecture.json judgment
    // call "s7-fetchbootstrap-shared-fact-and-crdt-merge") -- deterministically
    // the most-recently-created qualifying relay event.
    const representative = qualifying.reduce((latest, e) =>
      e.created_at > latest.created_at ? e : latest,
    );
    const epoch = this.deps.group.state.groupContext.epoch.toString();
    const fact: RawProtocolFactInput = {
      id: representative.id,
      groupId: this.deps.groupId,
      nostrEventId: representative.id,
      nostrEvent: representative,
      receivedAt: this.now(),
      receiptSource: "bootstrap-kind-30078",
      epochAtReceipt: epoch,
    };

    for (const task of winners.values()) {
      yield {
        type: "message",
        fact,
        rumorId: `bootstrap:${this.deps.groupId}:${task.id}`,
        payload: { type: "task.created", task },
        epoch,
        receiptSource: "bootstrap-kind-30078",
      };
    }
  }

  close(): void {
    if (this.liveSub) {
      this.liveSub.unsubscribe();
      this.liveSub = null;
    }
  }

  // -------------------------------------------------------------------
  // Private: real-marmot-ts translation core
  // -------------------------------------------------------------------

  private async fetchGroupEvents(): Promise<NostrEvent[]> {
    const hTag = this.nostrGroupIdHex();
    try {
      return await this.deps.client.network.request(this.deps.relays, [
        { kinds: [GROUP_EVENT_KIND], "#h": [hTag] },
      ]);
    } catch (err) {
      console.warn(
        "[marmot-adapter] historical group-event fetch failed (non-fatal):",
        err,
      );
      return [];
    }
  }

  /**
   * Drains `group.ingest(events)` to completion and translates every yielded
   * `IngestResult` into zero or more `IngestSignal`s, serialized through
   * `ingestChain` so this never races a concurrent `group.ingest()` call from
   * another entry point (see the module doc comment and architecture.json
   * judgment call "s7-ingest-mutex-buffers-a-batch-before-yielding").
   *
   * `originalFacts`, when supplied (by `ingestPersisted`), maps
   * `nostrEventId -> RawProtocolFact` so a re-submitted fact's ORIGINAL
   * `receiptSource`/`seq` is preserved instead of being reconstructed fresh.
   */
  private runIngestBatch(
    events: NostrEvent[],
    receiptSource: ReceiptSource,
    originalFacts?: Map<string, RawProtocolFact>,
  ): Promise<IngestSignal[]> {
    const run = (): Promise<IngestSignal[]> =>
      this.doIngestBatch(events, receiptSource, originalFacts);
    const result = this.ingestChain.then(run, run);
    this.ingestChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async doIngestBatch(
    events: NostrEvent[],
    receiptSource: ReceiptSource,
    originalFacts?: Map<string, RawProtocolFact>,
  ): Promise<IngestSignal[]> {
    if (events.length === 0) return [];
    const signals: IngestSignal[] = [];
    let lastKnownEpoch = this.deps.group.state.groupContext.epoch;

    for await (const result of this.deps.group.ingest(events)) {
      const epochAfter = this.deps.group.state.groupContext.epoch;
      const epochAfterStr = epochAfter.toString();
      const original = originalFacts?.get(result.event.id);
      const fact: RawProtocolFactInput =
        original ??
        ({
          id: result.event.id,
          groupId: this.deps.groupId,
          nostrEventId: result.event.id,
          nostrEvent: result.event,
          receivedAt: this.now(),
          receiptSource,
          epochAtReceipt: epochAfterStr,
        } satisfies RawProtocolFactInput);

      if (result.kind === "processed") {
        if (result.result.kind === "applicationMessage") {
          signals.push(
            this.translateApplicationMessage(
              result.result.message,
              fact,
              epochAfterStr,
              receiptSource,
            ),
          );
        }
        // result.result.kind === "newState": a proposal (epoch unchanged) or
        // a commit (epoch advances) -- no message-shaped signal; any epoch
        // change is picked up by the comparison below.
      } else if (result.kind === "skipped" || result.kind === "rejected") {
        signals.push({ type: "skipped", fact });
        // S10 own-echo reconciliation: a "skipped" outcome includes the
        // self-echo case (the ratchet already consumed this id, including
        // OUR OWN prior publish returning from the relay). Matching is by
        // exact fact.id equality against a tracked OutboxEntry's
        // sentEventId only -- see reconcileOwnEcho's doc comment / this
        // file's Outbox bridge module-doc note (VQ-S10-006). A no-op when
        // no tracked entry matches (the overwhelmingly common case: most
        // skipped facts are not our own publish).
        reconcileOwnEcho(fact, this.now());
      } else if (result.kind === "unreadable") {
        signals.push({
          type: "deferred",
          fact,
          reason: "unreadable",
          epoch: epochAfterStr,
        });
      }

      if (epochAfter > lastKnownEpoch) {
        signals.push({
          type: "epoch_advanced",
          newEpoch: epochAfterStr,
          prevEpoch: lastKnownEpoch.toString(),
        });
        lastKnownEpoch = epochAfter;
      }
    }

    return signals;
  }

  private translateApplicationMessage(
    decrypted: Uint8Array,
    fact: RawProtocolFactInput,
    epoch: string,
    receiptSource: ReceiptSource,
  ): IngestSignal {
    let rumor: ReturnType<typeof deserializeApplicationData>;
    try {
      rumor = deserializeApplicationData(decrypted);
    } catch (err) {
      return {
        type: "malformed",
        fact,
        error: describeError(err, "failed to deserialize application data"),
      };
    }

    if (rumor.kind !== TASK_EVENT_KIND) {
      // A rumor that deserialized successfully but carries a DIFFERENT kind
      // (e.g. a kind-9 chat message coexisting in the same MLS group) is not
      // a decode failure -- it simply isn't ours. `malformed` is reserved
      // for a genuine task-kind rumor whose content fails to decode into a
      // `TaskEvent` (architecture.md Implementation Constraint 13 / the
      // parse-error-is-terminal invariant): the engine turns `malformed`
      // into a TERMINAL `domain_event_rejected{reason:"parse_error"}`, whose
      // only recovery is relay re-sync -- which would redeliver and
      // re-reject this same foreign rumor forever. Pre-existing production
      // behavior (src/marmot/device-sync.ts's applicationMessage handler)
      // silently ignores a non-task rumor; `skipped` is the spec-faithful,
      // behavior-preserving mapping here -- it still carries the fact (so
      // the raw log gets it and the seq watermark advances) with no
      // rejection (corrected 2026-07-13, Stage-1 review Finding 1; see the
      // S7 architecture.json judgment call
      // "s7-non-task-rumor-kind-and-marmot-rejected-mapping", whose
      // wrong-kind half this supersedes -- the admin-rejected-commit half
      // is unaffected and still maps to `skipped` for the reason recorded
      // there).
      return { type: "skipped", fact };
    }

    let payload: TaskEvent;
    try {
      const parsed: unknown = JSON.parse(rumor.content);
      if (!isTaskEvent(parsed)) {
        return {
          type: "malformed",
          fact,
          error: "decoded rumor content is not a recognized TaskEvent shape",
        };
      }
      payload = parsed;
    } catch (err) {
      return {
        type: "malformed",
        fact,
        error: describeError(err, "failed to parse rumor content as JSON"),
      };
    }

    return {
      type: "message",
      fact,
      rumorId: rumor.id,
      payload,
      epoch,
      receiptSource,
    };
  }
}
