/**
 * failed-welcomes IDB store
 *
 * Owns the `notestr-failed-welcomes` IndexedDB store. A record is appended
 * whenever a Welcome join fails (in `joinFromWelcomeInvite`) or a gift-wrap
 * decrypt fails (in `inviteReader.on("error")`). The store is consumed by
 * S2 (PendingInvitations panel) and the signin-time probe (S4).
 *
 * Boundary rules (architecture.md):
 *   - Never import React or UI components (pure data layer).
 *   - Never import NDK directly.
 *   - IDB access only via createKVStore from ./storage.
 *   - DOM events dispatched on window after every mutation.
 *   - No direct idb-keyval imports.
 */

import { createKVStore } from "./storage";

/** Matches the `notestr-failed-welcomes` IDB store. */
const failedWelcomesStore = createKVStore<FailedWelcomeRecord>("failed-welcomes");

/** DOM event name dispatched after every mutation (load-bearing for S2). */
const FAILED_WELCOMES_CHANGED = "notestr:failed-welcomes-changed";

/**
 * A single failed-Welcome record.
 *
 * `giftWrapEventId` is the unique key:
 *   - join-failure path: `invite.id` (Rumor ID, the ID used by InviteManager)
 *   - decrypt-failure path: the kind-1059 event ID passed to the error handler
 *
 * Fields marked `| null` are best-effort; unavailable when the rumor could
 * not be decrypted or when the marmot-ts API does not surface the value.
 */
export interface FailedWelcomeRecord {
  /** Unix ms timestamp of when this record was written. */
  recordedAt: number;
  /** Unique key for dedup. Invite ID (join-failure) or event ID (decrypt-failure). */
  giftWrapEventId: string;
  /** Inner rumor kind: 444 for Welcome, 0 if unknown. */
  innerKind: number;
  /** Inner rumor created_at unix seconds; 0 if unavailable. */
  innerCreatedAt: number;
  /** Rumor author pubkey (potential inviter), or null if unavailable. */
  inviterPubkey: string | null;
  /** Hex-encoded MLS group ID, or null if not extracted. */
  groupId: string | null;
  /** Hex-encoded MLS key-package ref used in the Welcome, or null. */
  kpRef: string | null;
  /**
   * Failure classification:
   *   "no_matching_kp"        — no local key package matched the Welcome
   *   "ciphersuite_mismatch"  — ciphersuite not supported by this client
   *   "decrypt_failed"        — gift-wrap decryption failed entirely
   *   "unknown"               — anything else
   */
  failureReason: string;
  /** Free-form error text, truncated to 500 characters. */
  failureDetail: string;
}

/** Dispatches the changed event after every IDB mutation. */
function dispatchChanged(): void {
  window.dispatchEvent(new CustomEvent(FAILED_WELCOMES_CHANGED));
}

/**
 * Appends (or overwrites) a `FailedWelcomeRecord` in the IDB store.
 *
 * Uses `setItem` (PUT semantics) so calling this twice with the same
 * `giftWrapEventId` produces exactly one entry — satisfying AC-LOG-3's
 * dedup invariant.
 *
 * Dispatches `notestr:failed-welcomes-changed` AFTER the write so that any
 * listener who calls `loadFailedWelcomes()` immediately inside the handler
 * already sees the new record.
 */
export async function appendFailedWelcome(record: FailedWelcomeRecord): Promise<void> {
  // Truncate failureDetail to 500 chars as a safety bound (AC-OBS-4 / VQ-S1-012).
  const safe: FailedWelcomeRecord = {
    ...record,
    failureDetail: record.failureDetail.slice(0, 500),
  };
  await failedWelcomesStore.setItem(safe.giftWrapEventId, safe);
  dispatchChanged();
}

/**
 * Returns stored records, optionally filtered and/or limited.
 *
 * @param opts.since  — include only records with `recordedAt >= since` (unix ms)
 * @param opts.limit  — cap the number of returned records
 *
 * Results are sorted descending by `recordedAt` (most recent first).
 */
export async function loadFailedWelcomes(
  opts?: { since?: number; limit?: number },
): Promise<FailedWelcomeRecord[]> {
  const keys = await failedWelcomesStore.keys();
  const records = await Promise.all(
    keys.map((k) => failedWelcomesStore.getItem(k)),
  );

  let result = records.filter((r): r is FailedWelcomeRecord => r !== null);

  if (opts?.since !== undefined) {
    const since = opts.since;
    result = result.filter((r) => r.recordedAt >= since);
  }

  result.sort((a, b) => b.recordedAt - a.recordedAt);

  if (opts?.limit !== undefined) {
    result = result.slice(0, opts.limit);
  }

  return result;
}

/**
 * Removes the record for `giftWrapEventId` from the store.
 *
 * No-op when the key is absent. Dispatches the changed event regardless so
 * UI consumers do not need to check existence before listening.
 */
export async function forgetFailedWelcome(giftWrapEventId: string): Promise<void> {
  await failedWelcomesStore.removeItem(giftWrapEventId);
  dispatchChanged();
}

/**
 * Deletes all records whose `recordedAt` is older than `Date.now() - ms`.
 *
 * Intended to be called once per `MarmotProvider` mount (AC-LOG-5) with
 * `30 * 86400 * 1000` (30 days) to keep the store bounded.
 *
 * Dispatches `notestr:failed-welcomes-changed` after any deletions (or even
 * when nothing was pruned, to keep the event contract simple).
 */
export async function pruneOlderThan(ms: number): Promise<void> {
  const cutoff = Date.now() - ms;
  const keys = await failedWelcomesStore.keys();

  await Promise.all(
    keys.map(async (k) => {
      const r = await failedWelcomesStore.getItem(k);
      if (r !== null && r.recordedAt < cutoff) {
        await failedWelcomesStore.removeItem(k);
      }
    }),
  );

  dispatchChanged();
}
