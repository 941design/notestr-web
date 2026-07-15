/**
 * deferred-store.ts
 *
 * Durable per-group deferred-fact-id-list half of `PersistenceAdapter`
 * (specs/epic-event-sourced-receive-engine/architecture.md, "Seam Contracts
 * › PersistenceAdapter" and "Module Map" — deferred-store row). Resolves
 * the deferred portion of `MOCK-05-002` (introduced S5, resolved S11 —
 * see mocks-registry.json).
 *
 * IDS ONLY, KNOWN-LOSSY BY DESIGN (architecture.md "Recovery Sequencing"
 * R2, SETTLED — not a gap to close): this store persists fact ids only, no
 * `DeferredReason`/`queuedAt`/`attempts`. `receive-engine.ts`'s R2 rebuild
 * hardcodes `"unreadable"` and a fresh `queuedAt`/`attempts: 0` for every
 * restart. Do NOT widen this store's shape to "fix" that lossiness — see
 * architecture.md's own extended note on why that is deliberate.
 *
 * COMPOSITION POINT (architecture.json judgment call
 * "composed-methods-and-full-adapter-factory-live-in-deferred-store-ts"):
 * beyond this store's own CRUD (`saveDeferredIds`/`loadDeferredIds`/
 * `clearDeferredIds`), this file is also where the two genuinely
 * cross-store `PersistenceAdapter` methods are assembled:
 *
 *  - `acceptDeferredFact` — composes `raw-event-log-store.ts`'s
 *    `appendAcceptedEvent` (S4) with this store's own id removal,
 *    implementing R-INV-3's accepted-first crash-safe ordering.
 *  - `clearGroupState` — composes `checkpoint-store.ts`'s `clearCheckpoint`
 *    (called FIRST) with `raw-event-log-store.ts`'s
 *    `clearRawAndAcceptedLogs` (S4) and this store's own
 *    `clearDeferredIds`, implementing FSM L11 `reset()`.
 *  - `createPersistenceAdapter` — assembles all ten `PersistenceAdapter`
 *    methods (four from raw-event-log-store.ts, two from
 *    checkpoint-store.ts, four from this file) into one object. This is
 *    what makes `MOCK-05-002` concretely resolved: a real, fully-working
 *    `PersistenceAdapter` can be constructed with a single call. Not yet
 *    wired into any composition root (app-level wiring is out of this
 *    story's file scope) — exercised end-to-end against real IDB by
 *    `./deferred-store.test.ts`.
 *
 * This file is created LAST among the epic's persistence modules
 * (dependency-wise: it needs both `raw-event-log-store.ts` and
 * `checkpoint-store.ts` to exist), which is why it is the natural final-
 * assembly point rather than either of those two files. See
 * `raw-event-log-store.ts`'s own `clearRawAndAcceptedLogs` doc comment,
 * which already anticipates "S11's real `clearGroupState` COMPOSES this
 * partial with its own checkpoint/deferred clears" without naming a
 * specific S11 file.
 *
 * IDB KEYS: sourced exclusively from `src/engine/engine-types.ts`
 * (`deferredIdsKey`) — the sanctioned
 * `src/persistence/* -> src/engine/engine-types.ts` carve-out. No
 * `notestr:` key literal is inlined here.
 */

import { createKVStore } from "../marmot/storage";
import {
  deferredIdsKey,
  type AcceptedDomainEvent,
  type PersistenceAdapter,
} from "../engine/engine-types";
import {
  appendAcceptedEvent,
  appendFact,
  clearRawAndAcceptedLogs,
  loadAcceptedEvents,
  loadFacts,
} from "./raw-event-log-store";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from "./checkpoint-store";

const deferredIdsStore = createKVStore<string[]>("deferred-ids");

// ---------------------------------------------------------------------------
// Own CRUD
// ---------------------------------------------------------------------------

/**
 * Overwrites the group's deferred-id list wholesale. The caller
 * (`receive-engine.ts`) always supplies the full, already-recomputed id
 * list (never a delta), so a plain `setItem` is the correct primitive —
 * same rationale as `checkpoint-store.ts`'s `saveCheckpoint`.
 *
 * Precondition: `groupId` is a non-empty string.
 */
export async function saveDeferredIds(
  groupId: string,
  ids: string[],
): Promise<void> {
  if (!groupId) {
    throw new Error("saveDeferredIds: groupId must be a non-empty string");
  }
  await deferredIdsStore.setItem(deferredIdsKey(groupId), [...ids]);
}

/**
 * Returns the group's persisted deferred ids, `[]` if none are stored.
 */
export async function loadDeferredIds(groupId: string): Promise<string[]> {
  const stored = await deferredIdsStore.getItem(deferredIdsKey(groupId));
  return stored === null ? [] : [...stored];
}

/**
 * Removes the group's deferred-id list entirely. No-op if nothing was
 * stored. Precondition: `groupId` is a non-empty string.
 */
export async function clearDeferredIds(groupId: string): Promise<void> {
  if (!groupId) {
    throw new Error("clearDeferredIds: groupId must be a non-empty string");
  }
  await deferredIdsStore.removeItem(deferredIdsKey(groupId));
}

// ---------------------------------------------------------------------------
// Cross-store composition
// ---------------------------------------------------------------------------

/**
 * The single entry point for deferred→accepted acceptance
 * (`PersistenceAdapter.acceptDeferredFact`, architecture.md "Seam Contracts
 * › PersistenceAdapter"). Implements R-INV-3 via **crash-safe ORDERING, not
 * a cross-store transaction** — `createKVStore` places each store in its
 * own IndexedDB database, and IDB transactions cannot span databases.
 *
 * Contract, MUST NOT be reordered or interleaved with other writes:
 *  1. Append `event` to the accepted-log FIRST, via `raw-event-log-store.ts`'s
 *     `appendAcceptedEvent` (S4) — idempotent on `event.id`.
 *  2. Only once that write resolves, remove `factId` from this group's
 *     deferred-id list, via an atomic `updateItem` read-modify-write (never
 *     a separate get+set pair — see `raw-event-log-store.ts`'s CONCURRENCY
 *     note for why the single-transaction RMW matters for concurrent-safety).
 *
 * A crash between steps 1 and 2 leaves `factId` transiently in BOTH the
 * accepted-log AND the deferred-id list (never in neither, since step 2
 * only ever follows a successful step 1). `receive-engine.ts`'s recovery
 * R2a prune step reconciles this on the next restart — accepted wins, the
 * stale deferred id is removed.
 *
 * Precondition: `groupId` and `factId` are non-empty strings.
 */
export async function acceptDeferredFact(
  groupId: string,
  factId: string,
  event: AcceptedDomainEvent,
): Promise<void> {
  if (!groupId || !factId) {
    throw new Error(
      "acceptDeferredFact: groupId and factId must be non-empty strings",
    );
  }

  // Step 1 — accepted-first. Must resolve before step 2 ever runs.
  await appendAcceptedEvent(event);

  // Step 2 — only after step 1 durably landed. Atomic RMW: read the
  // CURRENT stored list and filter out factId inside one IDB transaction,
  // so a concurrent saveDeferredIds/acceptDeferredFact call against the
  // same group can never interleave a lost update.
  await deferredIdsStore.updateItem(deferredIdsKey(groupId), (stored) => {
    const existing = stored ?? [];
    return existing.filter((id) => id !== factId);
  });
}

/**
 * Full per-group purge implementing FSM L11 `reset()`
 * (`PersistenceAdapter.clearGroupState`). Deletes the raw-fact log,
 * accepted-event log, checkpoint (which carries `bootstrapCompleted`), and
 * deferred ids for the group.
 *
 * CHECKPOINT-FIRST CLEAR-ORDERING INVARIANT (S4 review 2026-07-12,
 * mandatory — see `raw-event-log-store.ts`'s `clearRawAndAcceptedLogs` doc
 * comment): the checkpoint MUST be cleared BEFORE the raw/accepted logs and
 * the deferred ids. `clearGroupState` spans >= 2 IndexedDB databases and is
 * therefore non-atomic across them — a crash partway through must degrade
 * toward a re-joinable state, never strand a usable `bootstrapCompleted`
 * checkpoint pointing at already-emptied (or partially-emptied) logs. Per
 * fsm.md L1/L2 + architecture.md Implementation Constraint 12: once the
 * checkpoint is gone, a crash mid-clear routes the NEXT restart to either
 * L1 preserve-and-replay (if the not-yet-cleared logs are still intact —
 * correct, since they still represent real pre-reset state) or L2 joining
 * (once everything is cleared — also correct) — NEVER the stranded case of
 * a checkpoint claiming `bootstrapCompleted: true` over emptied logs. Once
 * the checkpoint clear has resolved, the relative order of the remaining
 * two clears no longer matters for this invariant, so they run
 * concurrently.
 *
 * Composes `raw-event-log-store.ts`'s exported `clearRawAndAcceptedLogs`
 * partial verbatim — never reconstructs its store names (S4 review
 * obligation).
 *
 * Precondition: `groupId` is a non-empty string. Postcondition: after this
 * resolves, `loadCheckpoint` returns `null` and every `load*` method
 * returns empty for the group; other groups' data is untouched.
 */
export async function clearGroupState(groupId: string): Promise<void> {
  if (!groupId) {
    throw new Error("clearGroupState: groupId must be a non-empty string");
  }

  // CHECKPOINT FIRST — awaited alone, before anything else starts.
  await clearCheckpoint(groupId);

  // Order between these two no longer matters once the checkpoint is gone.
  await Promise.all([clearRawAndAcceptedLogs(groupId), clearDeferredIds(groupId)]);
}

/**
 * Assembles the full ten-method `PersistenceAdapter` from
 * `raw-event-log-store.ts` (S4), `checkpoint-store.ts`, and this file. The
 * concrete, production-usable resolution of `MOCK-05-002`: a real
 * `PersistenceAdapter` — round-tripping through actual IndexedDB — can be
 * constructed with this single call. Not yet consumed by any composition
 * root (that wiring is out of this story's file scope); exercised end-to-
 * end against real IDB by `./deferred-store.test.ts`.
 */
export function createPersistenceAdapter(): PersistenceAdapter {
  return {
    appendFact,
    loadFacts,
    appendAcceptedEvent,
    loadAcceptedEvents,
    saveCheckpoint,
    loadCheckpoint,
    saveDeferredIds,
    loadDeferredIds,
    acceptDeferredFact,
    clearGroupState,
  };
}
