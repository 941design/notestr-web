import type { Task, TaskEvent } from "./task-events";

/**
 * Sender-side monotonic timestamp guard.
 *
 * The reducer gate is strict `>` with an inter-author tie-breaker on `updatedBy`.
 * That tie-break only resolves edits by *different* authors. When the *same* actor
 * edits the same task twice within one wall-clock second, both events get the same
 * one-second-resolution `updatedAt`, so the second is silently rejected.
 *
 * This function ensures that every outgoing mutation event has a strictly greater
 * `updatedAt` than the task's current stored value. It is called in `dispatch()`
 * before both the optimistic local apply and the rumor publish, so:
 *   - The sender's UI reflects the second edit immediately.
 *   - Receivers get the bumped timestamp and accept the event via the LWW gate.
 *
 * `task.created` is exempt — it is First-Write-Wins and has no `updatedAt` field
 * on the event itself (the timestamp is baked into `event.task`).
 *
 * Composability: this targets the *ordering* axis (sequential same-actor edits).
 * It leaves the *concurrent-tie* axis untouched — the reducer's `updatedBy`
 * tie-breaker, and the forthcoming `updatedByDevice` clientId third level, remain
 * the authority for resolving concurrent edits from different actors/devices.
 */
export function ensureMonotonicTimestamp(
  event: TaskEvent,
  existing: Task | undefined,
): TaskEvent {
  if (event.type === "task.created" || existing === undefined) {
    // FWW event or no existing task — nothing to guard.
    return event;
  }

  // For the four mutation types, bump if the event timestamp does not strictly
  // exceed the stored value (covers both the "same second" tie and any
  // pathologically non-monotonic producer).
  if (event.updatedAt <= existing.updatedAt) {
    return { ...event, updatedAt: existing.updatedAt + 1 };
  }

  return event;
}
