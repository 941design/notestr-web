/**
 * forgotten-slots IDB store
 *
 * Owns the `notestr-forgotten-slots` IndexedDB store. A slot is marked
 * forgotten when the user instructs the app to stop auto-inviting that
 * device. The store is the producer of the ForgottenSlotsAPI seam consumed
 * by device-sync.ts (S2) and forget-device.ts (S3).
 *
 * Boundary rules (architecture.md):
 *   - Never import idb-keyval directly; use createKVStore from storage.ts.
 *   - No React or UI imports; this module is pure async functions.
 *   - DOM event name "notestr:forgotten-slots-changed" is load-bearing for
 *     device-sync.ts; do not change it.
 */

import { createKVStore } from "./storage";

/** IDB store name matches AC-STORE-1. Value type is always `true`. */
const forgottenStore = createKVStore<true>("forgotten-slots");

/**
 * Marks a device slot as forgotten.
 *
 * Writes `slot → true` to the notestr-forgotten-slots IDB store, then
 * dispatches `new CustomEvent("notestr:forgotten-slots-changed")` on
 * `window` so any in-memory cache (device-sync.ts's `forgottenSlots`
 * variable) can reload the set before the next invite-scan iteration.
 *
 * Idempotent: calling with the same slot a second time overwrites with
 * the same value (idb-keyval setItem is upsert) and dispatches the event
 * again. The store still contains exactly one entry for that slot.
 *
 * Postcondition: after this function resolves, `loadForgottenSlots()`
 * will return a Set containing `slot`.
 */
export async function markSlotForgotten(slot: string): Promise<void> {
  // Write FIRST so that any consumer of the DOM event who calls
  // loadForgottenSlots() inside the listener already sees the new slot.
  await forgottenStore.setItem(slot, true);
  window.dispatchEvent(new CustomEvent("notestr:forgotten-slots-changed"));
}

/**
 * Returns the set of all forgotten slot strings from IDB.
 *
 * Uses `forgottenStore.keys()` per AC-STORE-2 — `getAllKeys` does not exist
 * on KeyValueStoreBackend and must never be called here.
 *
 * Returns an empty Set<string> when the store has never been written to,
 * so callers do not need to handle null/undefined.
 */
export async function loadForgottenSlots(): Promise<Set<string>> {
  const keys = await forgottenStore.keys();
  return new Set(keys);
}
