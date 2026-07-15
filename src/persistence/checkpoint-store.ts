/**
 * checkpoint-store.ts
 *
 * Durable per-group `EngineCheckpoint` half of `PersistenceAdapter`
 * (specs/epic-event-sourced-receive-engine/architecture.md, "Seam Contracts
 * › PersistenceAdapter" and "Module Map" — checkpoint-store row). Resolves
 * the checkpoint portion of `MOCK-05-002` (introduced S5, resolved S11 —
 * see mocks-registry.json).
 *
 * SCOPE: exactly the checkpoint CRUD (`saveCheckpoint`/`loadCheckpoint`/
 * `clearCheckpoint`). The deferred-id half, and the cross-store
 * compositions (`acceptDeferredFact`, `clearGroupState`,
 * `createPersistenceAdapter`) that also touch this store, live in
 * `./deferred-store.ts` — see this story's architecture.json judgment call
 * "composed-methods-and-full-adapter-factory-live-in-deferred-store-ts".
 * `clearCheckpoint` is exported (not merely used internally) precisely so
 * `deferred-store.ts`'s `clearGroupState` can call it FIRST, per the
 * checkpoint-first clear-ordering invariant documented on that function.
 *
 * WHOLE-OBJECT OVERWRITE, NO RMW: `saveCheckpoint`'s caller
 * (`receive-engine.ts`'s `buildCheckpoint()`) always constructs and passes
 * every `EngineCheckpoint` field on every call — there is no partial-update
 * use case — so a plain `setItem` is the correct primitive here, unlike
 * `raw-event-log-store.ts`'s `appendFact`/`appendAcceptedEvent` (which read-
 * modify-write an array) or `deferred-store.ts`'s `acceptDeferredFact`
 * (which removes one id from a list read at call time).
 *
 * NO SHAPE VALIDATION HERE (architecture.json judgment call
 * "checkpoint-store-loadCheckpoint-does-not-validate-shape"): `loadCheckpoint`
 * returns whatever is stored, faithfully, even if it does not actually
 * satisfy the `EngineCheckpoint` shape (a schema-drifted or corrupted
 * value). AC-PERS-2 / Implementation Constraint 12's "malformed checkpoint
 * at restart" handling is entirely `receive-engine.ts`'s job (its
 * pre-existing `isValidCheckpoint` type guard) — this store's contract is
 * byte-for-byte round trip, never inference or coercion.
 *
 * IDB KEYS: sourced exclusively from `src/engine/engine-types.ts`
 * (`engineCheckpointsKey`) — the sanctioned
 * `src/persistence/* -> src/engine/engine-types.ts` carve-out
 * (architecture.md Forbidden Rule 3 exception). No `notestr:` key literal
 * is inlined here.
 */

import { createKVStore } from "../marmot/storage";
import {
  engineCheckpointsKey,
  type EngineCheckpoint,
} from "../engine/engine-types";

const checkpointsStore = createKVStore<EngineCheckpoint>("engine-checkpoints");

/**
 * Persists `checkpoint` under `engineCheckpointsKey(checkpoint.groupId)`,
 * overwriting any prior value for the group wholesale (a checkpoint save is
 * never a partial update — the caller always supplies every field).
 *
 * Precondition: `checkpoint.groupId` is a non-empty string (thrown `Error`
 * otherwise, matching this epic's other persistence preconditions).
 *
 * FIELD-PICKING: the stored value is built by explicitly picking exactly
 * the six `EngineCheckpoint` fields off `checkpoint` (never `{ ...checkpoint
 * }`), so an extra enumerable property a structurally-typed caller happens
 * to carry can never enter the durable record — same schema-drift-
 * containment discipline as `raw-event-log-store.ts`.
 */
export async function saveCheckpoint(
  checkpoint: EngineCheckpoint,
): Promise<void> {
  if (!checkpoint.groupId) {
    throw new Error("saveCheckpoint: checkpoint.groupId must be a non-empty string");
  }

  const toStore: EngineCheckpoint = {
    groupId: checkpoint.groupId,
    savedAt: checkpoint.savedAt,
    engineState: checkpoint.engineState,
    lastEpoch: checkpoint.lastEpoch,
    lastIngestedSeq: checkpoint.lastIngestedSeq,
    lastAcceptedDomainEventId: checkpoint.lastAcceptedDomainEventId,
    bootstrapCompleted: checkpoint.bootstrapCompleted,
  };
  await checkpointsStore.setItem(engineCheckpointsKey(checkpoint.groupId), toStore);
}

/**
 * Returns the group's persisted checkpoint, or `null` if none is stored.
 * Returns the stored value AS-IS — see this module's doc comment "NO SHAPE
 * VALIDATION HERE". Callers needing shape validation (receive-engine.ts's
 * `isValidCheckpoint`) must perform it themselves.
 */
export async function loadCheckpoint(
  groupId: string,
): Promise<EngineCheckpoint | null> {
  return checkpointsStore.getItem(engineCheckpointsKey(groupId));
}

/**
 * Removes the group's persisted checkpoint. No-op (resolves without error)
 * if nothing was stored. Exported so `deferred-store.ts`'s `clearGroupState`
 * can invoke it as the FIRST step of a full per-group purge (checkpoint-
 * first clear-ordering invariant — see that function's doc comment).
 *
 * Precondition: `groupId` is a non-empty string.
 */
export async function clearCheckpoint(groupId: string): Promise<void> {
  if (!groupId) {
    throw new Error("clearCheckpoint: groupId must be a non-empty string");
  }
  await checkpointsStore.removeItem(engineCheckpointsKey(groupId));
}
