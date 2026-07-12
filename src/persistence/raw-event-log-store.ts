/**
 * raw-event-log-store.ts
 *
 * Idempotent, ordering-preserving fact/accepted-event half of
 * `PersistenceAdapter` (specs/epic-event-sourced-receive-engine/architecture.md,
 * "Seam Contracts › PersistenceAdapter"). Implements exactly four of the
 * interface's ten methods -- `appendFact`, `loadFacts`, `appendAcceptedEvent`,
 * `loadAcceptedEvents` -- per this story's scope (S4), plus a narrow
 * `clearRawAndAcceptedLogs` partial (this file's half of the FSM L11 reset --
 * see that function's doc comment). The full `PersistenceAdapter.clearGroupState`
 * composition, and the checkpoint/deferred methods, belong to S11's
 * checkpoint-store.ts / deferred-store.ts; this file does not implement or
 * re-export those.
 *
 * Replaces src/store/persistence.ts:appendEvent's non-idempotent
 * read-modify-write. From S4 onward, no file other than
 * src/store/persistence.ts's pre-existing implementation may write to the
 * legacy `notestr:events:${groupId}` key (AC-MIG-1; enforced by
 * ./legacy-key-guard.structural.test.ts).
 *
 * STORAGE LAYOUT (judgment call,
 * specs/epic-event-sourced-receive-engine/S4-raw-event-log-store/architecture.json
 * "single-array-per-group-storage-layout"): one array value per group key,
 * not one IDB key per item. `RawProtocolFact[]` under `rawFactsKey(groupId)`;
 * `AcceptedDomainEvent[]` under `acceptedEventsKey(groupId)`. This makes both
 * ordering contracts hold BY CONSTRUCTION: array push order === insertion
 * order === the monotonic append position `loadAcceptedEvents` must return
 * (no separate position field exists on `AcceptedDomainEvent` -- its shape is
 * fixed by src/domain/domain-events.ts). It also sidesteps the documented
 * trap entirely: there are no per-item IDB keys to enumerate, so
 * idb-keyval's key-sorted `keys()` never enters the ordering picture.
 *
 * SEQ AUTHORITY: this store is the SOLE assigner of `RawProtocolFact.seq`.
 * Producers (`marmot-adapter.ts`, `IngestSignal` variants) pass a seq-less
 * `RawProtocolFactInput`; `appendFact` assigns `seq` monotonically per group
 * ON APPEND, scoped to `fact.groupId`. A duplicate append (same `id`) mints
 * NO new `seq` -- it returns the EXISTING stored fact untouched.
 *
 * IDEMPOTENCY: `appendFact` is idempotent on `fact.id`; `appendAcceptedEvent`
 * is idempotent on `event.id`. Both are lookup-before-insert, now performed
 * INSIDE a single `storage.ts` `updateItem()` read-modify-write transaction
 * (see the CONCURRENCY note below) rather than as a separate read followed by
 * a conditional write: a duplicate id changes NOTHING observable (no new
 * entry, no mutation of an existing entry, no seq mint) even though the
 * underlying transaction still commits an unchanged-by-reference array back
 * to the same key. `appendAcceptedEvent`'s idempotency is load-bearing for
 * AC-INV-2's persistence-side half -- src/domain/task-projector.ts's
 * `buildProjection` / `applyEvent` formally depend on unique-id
 * accepted-event logs as a PRECONDITION (see acceptance-criteria.md
 * AC-INV-2, amended 2026-07-12, S3 Stage-2 cold review) rather than deduping
 * themselves.
 *
 * IDB KEYS: sourced exclusively from src/engine/engine-types.ts
 * (`rawFactsKey`, `acceptedEventsKey`) -- the sanctioned
 * `src/persistence/* -> src/engine/engine-types.ts` carve-out
 * (architecture.md Forbidden Rule 3 exception: types + IDB key constants
 * ONLY, never `receive-engine.ts` or any other src/engine/* file). No
 * `notestr:` key literal is inlined here; inlining one would trip
 * AC-BOUND-3 (engine-boundary.structural.test.ts scans all of src/).
 *
 * CONCURRENCY (amended -- cold-review remediation, closes P1-1
 * lost-update race): `appendFact` and `appendAcceptedEvent` route through
 * `src/marmot/storage.ts`'s `KeyValueStoreBackend.updateItem()`, which
 * performs the dedup-check read AND the seq-mint-and-append write inside
 * ONE IndexedDB `readwrite` transaction (idb-keyval's `update()` -- see that
 * function's doc comment). This makes concurrent same-group appends
 * serialize at the IDB transaction layer -- both in-process (idb-keyval
 * queues operations against the same store) and cross-tab (IndexedDB's own
 * transaction ordering) -- so N concurrent `appendFact` calls for the same
 * group can never interleave their get/put pairs and silently drop a seq or
 * duplicate one. `updateItem` also resolves the underlying store handle
 * exactly ONCE per call, so a mid-operation identity switch (`bindStores`
 * invoked between two ticks of the same async append) cannot split the read
 * and the write across two different pubkey partitions: an append initiated
 * before the switch lands wholly in the pre-switch partition, which is the
 * correct outcome -- the event belongs to the identity that was active when
 * it was received. Stopping the engine on an identity switch so no further
 * appends are even attempted post-switch remains the integration layer's
 * obligation; this store has no opinion on it and enforces none.
 */

import { createKVStore } from "../marmot/storage";
import {
  acceptedEventsKey,
  rawFactsKey,
  type AcceptedDomainEvent,
  type AppendFactResult,
  type RawProtocolFact,
  type RawProtocolFactInput,
} from "../engine/engine-types";

const factsStore = createKVStore<RawProtocolFact[]>("raw-facts");
const acceptedEventsStore = createKVStore<AcceptedDomainEvent[]>("accepted-events");

/**
 * Idempotent on `fact.id`. Preconditions: `fact.id` and `fact.groupId` are
 * non-empty strings (thrown `Error` otherwise -- fail fast on a malformed
 * producer rather than silently corrupting the log). Postconditions: on a
 * fresh id, the returned `fact.seq` is strictly greater than every
 * previously-appended fact's `seq` for the same `groupId`. On a duplicate
 * id, returns the UNCHANGED existing stored fact (`duplicate: true`) --
 * no new entry is created, no existing entry is mutated, and no new `seq`
 * is minted.
 *
 * ATOMICITY: dedup-check, seq mint, and write happen inside ONE
 * `updateItem()` call against `rawFactsKey(fact.groupId)` -- see this
 * file's module-level CONCURRENCY note.
 *
 * FIELD-PICKING: the stored fact is built by explicitly picking exactly the
 * eight `RawProtocolFact` fields off `fact` (never `{ ...fact, seq }`), so
 * an extra enumerable property a structurally-typed caller happens to carry
 * (schema drift, a stray function-valued prop, an accidentally-attached
 * plaintext field) can never enter the durable log.
 */
export async function appendFact(
  fact: RawProtocolFactInput,
): Promise<AppendFactResult> {
  if (!fact.id || !fact.groupId) {
    throw new Error("appendFact: fact.id and fact.groupId must be non-empty");
  }

  // storage.ts's updateItem() resolves with the updater's return value (the
  // stored array), not the {fact, duplicate} result this function needs --
  // so the outcome is captured out-of-band via this closure variable.
  let outcome: AppendFactResult | undefined;

  await factsStore.updateItem(rawFactsKey(fact.groupId), (stored) => {
    const existing = stored ?? [];
    const found = existing.find((f) => f.id === fact.id);
    if (found) {
      outcome = { fact: found, duplicate: true };
      return existing;
    }

    const seq = existing.length === 0 ? 1 : existing[existing.length - 1].seq + 1;
    const newFact: RawProtocolFact = {
      id: fact.id,
      seq,
      groupId: fact.groupId,
      nostrEventId: fact.nostrEventId,
      nostrEvent: fact.nostrEvent,
      receivedAt: fact.receivedAt,
      receiptSource: fact.receiptSource,
      epochAtReceipt: fact.epochAtReceipt,
    };
    outcome = { fact: newFact, duplicate: false };
    return [...existing, newFact];
  });

  return outcome as AppendFactResult;
}

/**
 * Returns `groupId`'s facts sorted by `seq` ascending (append order).
 * Postcondition: `[]` for a group with no stored facts, never `null`/`undefined`.
 */
export async function loadFacts(groupId: string): Promise<RawProtocolFact[]> {
  const stored = (await factsStore.getItem(rawFactsKey(groupId))) ?? [];
  return [...stored].sort((a, b) => a.seq - b.seq);
}

/**
 * Idempotent on `event.id`. Precondition: `event.id` and `event.groupId` are
 * non-empty strings. Postcondition: a fresh id is appended at the end of the
 * group's array; a duplicate id is a strict no-op (log length unchanged, no
 * entry mutated, no entry added).
 *
 * ATOMICITY: dedup-check and append happen inside ONE `updateItem()` call
 * against `acceptedEventsKey(event.groupId)` -- see this file's
 * module-level CONCURRENCY note.
 *
 * FIELD-PICKING: the stored event is built by explicitly picking exactly
 * the seven `AcceptedDomainEvent` fields off `event` (never `{ ...event }`),
 * for the same schema-drift-containment reason as `appendFact`.
 */
export async function appendAcceptedEvent(
  event: AcceptedDomainEvent,
): Promise<void> {
  if (!event.id || !event.groupId) {
    throw new Error(
      "appendAcceptedEvent: event.id and event.groupId must be non-empty",
    );
  }

  await acceptedEventsStore.updateItem(
    acceptedEventsKey(event.groupId),
    (stored) => {
      const existing = stored ?? [];
      if (existing.some((e) => e.id === event.id)) {
        return existing;
      }

      const newEvent: AcceptedDomainEvent = {
        id: event.id,
        factId: event.factId,
        sourceKind: event.sourceKind,
        groupId: event.groupId,
        acceptedAt: event.acceptedAt,
        epoch: event.epoch,
        payload: event.payload,
      };
      return [...existing, newEvent];
    },
  );
}

/**
 * Returns `groupId`'s accepted events in APPEND/insertion order (the stored
 * array's own order -- never re-sorted by id or any content field).
 * Postcondition: `[]` for a group with no stored events, never `null`/`undefined`.
 */
export async function loadAcceptedEvents(
  groupId: string,
): Promise<AcceptedDomainEvent[]> {
  const stored = (await acceptedEventsStore.getItem(acceptedEventsKey(groupId))) ?? [];
  return [...stored];
}

/**
 * S4's half of `PersistenceAdapter.clearGroupState` (FSM L11): purges the
 * raw-fact log and accepted-event log for the group. This is NOT
 * `PersistenceAdapter.clearGroupState` -- it is a partial, this file's
 * two-store slice of that full purge. S11's real `clearGroupState`
 * COMPOSES this partial with its own checkpoint/deferred clears; per the
 * recorded clear-ordering invariant (S4 review 2026-07-12: full
 * `clearGroupState` spans >=2 IDB databases and is therefore non-atomic
 * across them), the checkpoint MUST be cleared FIRST, before this partial
 * runs, so a crash mid-reset degrades toward a re-joinable state rather
 * than stranding a usable `bootstrapCompleted` checkpoint over
 * already-emptied logs. Store names stay private here; do NOT reconstruct
 * them elsewhere.
 *
 * Precondition: `groupId` is a non-empty string (thrown `Error` otherwise,
 * matching this file's other fail-fast preconditions). Postcondition: both
 * `rawFactsKey(groupId)` and `acceptedEventsKey(groupId)` are removed;
 * resolves without error for a group with nothing stored (removeItem on an
 * absent key is a no-op); other groups' data is untouched.
 */
export async function clearRawAndAcceptedLogs(groupId: string): Promise<void> {
  if (!groupId) {
    throw new Error("clearRawAndAcceptedLogs: groupId must be a non-empty string");
  }

  await Promise.all([
    factsStore.removeItem(rawFactsKey(groupId)),
    acceptedEventsStore.removeItem(acceptedEventsKey(groupId)),
  ]);
}
