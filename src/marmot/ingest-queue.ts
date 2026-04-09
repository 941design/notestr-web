/**
 * Pending-retry queue for MLS events that couldn't be decrypted on first
 * ingest.
 *
 * Why this exists
 * ---------------
 * ts-mls's `group.ingest()` yields `unreadable` for any kind-445 event
 * whose decryption fails at the group's current state. This can happen
 * for benign reasons:
 *
 *   - the event's epoch is one or more ahead of ours (we're missing a
 *     commit that hasn't arrived yet);
 *   - a race between the live subscription and the initial historical
 *     fetch delivers the application message before the commit that
 *     would advance our epoch.
 *
 * Previously, `device-sync.ts` logged `unreadable` and dropped the event
 * on the floor with a comment saying "may become decryptable later" —
 * but nothing ever retried it. This queue is the "later" part: events
 * are parked here and re-ingested the next time the group's epoch
 * advances.
 *
 * Design constraints
 * ------------------
 *
 * * Pure module — no React, no browser APIs. Unit-testable with vitest.
 * * Keyed by event id (O(1) dedupe — the same event id never enters
 *   the queue twice).
 * * Capped to prevent unbounded memory growth. When the cap is hit,
 *   the eldest entry (lowest `created_at`) is evicted — we favour
 *   keeping NEWER unreadable events because they're the ones the user
 *   cares about.
 * * TTL-pruned: entries older than `maxAgeSec` are dropped on every
 *   `prune()` call. This protects against events we'll never be able
 *   to read (attacker spam, corrupted relay, permanently-orphaned
 *   commits) staying in the queue forever.
 *
 * Not provided here
 * -----------------
 *
 * * Ingest serialization — `device-sync.ts` provides its own per-group
 *   mutex. This queue doesn't touch marmot-ts state.
 * * Trigger logic — `device-sync.ts` decides WHEN to drain (only on
 *   epoch advance, per the stateChanged listener contract).
 */

import type { NostrEvent } from "applesauce-core/helpers/event";

/** One entry in the pending-retry queue. */
interface PendingEntry {
  event: NostrEvent;
  /** Client-side arrival time (ms), used as a secondary sort key when
   *  `event.created_at` ties and as the prune clock. */
  queuedAt: number;
}

export interface PendingRetryQueueOptions {
  /** Maximum number of entries to retain per group. 201st insert evicts
   *  the eldest by `created_at` / `queuedAt`. */
  maxSize: number;
  /** Age in seconds after which an entry is pruned on the next
   *  `prune()` call. Measured against `event.created_at` when set,
   *  else against the entry's `queuedAt`. */
  maxAgeSec: number;
}

export interface PendingRetryQueue {
  /** Add an event to the queue. No-op if already queued (dedupe by id). */
  enqueue(event: NostrEvent): void;
  /** Return all queued events as an array in insertion order (FIFO).
   *  Does NOT clear the queue — callers decide when to drop entries
   *  after they've been re-ingested, since the caller needs to know
   *  which events became `processed`. */
  snapshot(): NostrEvent[];
  /** Remove a specific event by id (e.g. after it successfully
   *  re-ingests). */
  remove(eventId: string): void;
  /** Remove all entries whose age exceeds `maxAgeSec`. */
  prune(nowSec?: number): void;
  /** Current number of entries. */
  readonly size: number;
}

export function createPendingRetryQueue(
  options: PendingRetryQueueOptions,
): PendingRetryQueue {
  if (options.maxSize <= 0) {
    throw new Error("PendingRetryQueue maxSize must be positive");
  }
  if (options.maxAgeSec <= 0) {
    throw new Error("PendingRetryQueue maxAgeSec must be positive");
  }

  // Map preserves insertion order — the oldest queued entry is the
  // first element, which matches what we want for FIFO eviction.
  const entries = new Map<string, PendingEntry>();

  const ageSec = (entry: PendingEntry, nowSec: number): number => {
    // Prefer the event's claimed `created_at` when it's plausibly
    // recent — if it's way in the future or the distant past, fall
    // back to the entry's local queue time.
    const claimed = entry.event.created_at;
    if (
      typeof claimed === "number" &&
      Number.isFinite(claimed) &&
      claimed > 0 &&
      Math.abs(nowSec - claimed) < 86400 * 365
    ) {
      return nowSec - claimed;
    }
    return nowSec - Math.floor(entry.queuedAt / 1000);
  };

  const evictEldest = (): void => {
    const first = entries.keys().next();
    if (!first.done) entries.delete(first.value);
  };

  return {
    enqueue(event: NostrEvent) {
      if (!event.id) return; // defensive — events without ids are useless
      if (entries.has(event.id)) return;
      entries.set(event.id, { event, queuedAt: Date.now() });
      while (entries.size > options.maxSize) {
        evictEldest();
      }
    },
    snapshot() {
      return Array.from(entries.values(), (e) => e.event);
    },
    remove(eventId: string) {
      entries.delete(eventId);
    },
    prune(nowSec?: number) {
      const t = nowSec ?? Math.floor(Date.now() / 1000);
      // Collect keys to delete to avoid mutating while iterating.
      const toDelete: string[] = [];
      for (const [id, entry] of entries) {
        if (ageSec(entry, t) > options.maxAgeSec) {
          toDelete.push(id);
        }
      }
      for (const id of toDelete) entries.delete(id);
    },
    get size() {
      return entries.size;
    },
  };
}
