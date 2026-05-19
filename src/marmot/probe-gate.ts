/**
 * probe-gate.ts — pure gating logic for the signin-time invitation probe.
 *
 * Extracted from client.tsx so that unit tests can import and exercise it
 * without pulling in the React + NDK + JSX dependency tree. client.tsx cannot
 * be directly imported in the vitest node environment because vite:define
 * substitution fails on JSX.
 *
 * Boundary: pure computation, no I/O, no imports.
 */

/** Probe interval: run at most once every 24 hours (in ms). */
export const PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns true if the signin-time probe should run given the stored
 * `lastProbeAt` timestamp (unix ms) or null when the key is absent.
 *
 * - null → always run (first visit)
 * - value >= PROBE_INTERVAL_MS ms ago → run (stale)
 * - value < PROBE_INTERVAL_MS ms ago → skip (fresh)
 *
 * Uses a numeric comparison (>=) on unix-ms integers, not string comparison.
 */
export function shouldRunProbe(lastProbeAtMs: number | null): boolean {
  if (lastProbeAtMs === null) return true;
  return Date.now() - lastProbeAtMs >= PROBE_INTERVAL_MS;
}
