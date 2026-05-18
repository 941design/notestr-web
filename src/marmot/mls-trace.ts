/**
 * MLS receive-pipeline trace recorder.
 *
 * Why this exists
 * ---------------
 * The kind-445 subscription path between relay broadcast and ts-mls
 * decryption has at least four candidate races (F1..F4 — see
 * `specs/epic-mls-live-delivery-race/spec.md`). Distinguishing them
 * requires a chronological, machine-readable log of every decision
 * the pipeline takes: REQ open/close, subscription event arrival,
 * ingest result per event, retry-queue enqueue/drain, epoch advance,
 * task-store load and dispatch. This module owns that log.
 *
 * Build-time gate
 * ---------------
 * The recording implementation is selected at module load via the
 * `process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1"` check. Next.js inlines
 * `NEXT_PUBLIC_*` env vars at build time, so when the flag is unset the
 * branch evaluates to a static `false` and webpack's dead-code
 * elimination removes the recording implementation from the production
 * bundle. Per-call overhead in production is one empty function
 * invocation per trace site.
 *
 * Design constraints
 * ------------------
 * * Pure module — zero runtime dependencies on `react`, `next`, or DOM.
 *   Only `import type` is used so the type graph erases at build time.
 * * The no-op default's `record`, `dump`, and `clear` method bodies are
 *   intentionally empty (no allocation per call). `dump()` returns a
 *   shared frozen empty array. The source-level shape is the contract;
 *   minification mangles names so a bundle grep is not load-bearing.
 * * The TraceEvent union is the single source of truth for every event
 *   shape consumed by the S3 classifier. All variants from spec.md
 *   § Trace event shape are present.
 * * `epoch` fields are `string` (bigint serialized) so dumps are
 *   JSON-safe.
 * * `record()` and `dump()` are SYMMETRIC ABOUT JSON-CLONING. `record()`
 *   clones on enqueue so post-record mutation of the caller's argument
 *   (a reused `filter`, a later-mutated `eventIds`) cannot rewrite the
 *   stored entry. `dump()` clones again on egress so a consumer mutating
 *   a returned event cannot rewrite the buffer. Together these close
 *   both leak directions (call-site → recorder, recorder → consumer);
 *   the S3 classifier depends on chronological trace accuracy, so the
 *   clone is contract enforcement, not convenience. The clone primitive
 *   is `JSON.parse(JSON.stringify(...))` because TraceEvent is JSON-safe
 *   by construction (string/number/string[]/plain-object filter, no
 *   functions, no cycles).
 * * `dump()` is typed `readonly TraceEvent[]` to communicate
 *   immutability uniformly across the no-op (frozen empty array) and
 *   recording (fresh array of cloned events) implementations.
 */

import type { Filter } from "applesauce-core/helpers/filter";

export type TraceEvent =
  | { kind: "req-start"; t: number; relay: string; filter: Filter; reqId: string }
  | { kind: "req-event"; t: number; reqId: string; eventId: string; createdAt: number }
  | { kind: "req-eose"; t: number; reqId: string; eventCount: number }
  | { kind: "req-close"; t: number; reqId: string }
  | { kind: "sub-start"; t: number; relay: string; filter: Filter; subId: string }
  | {
      kind: "sub-event";
      t: number;
      subId: string;
      eventId: string;
      createdAt: number;
      epoch: string;
    }
  | { kind: "sub-close"; t: number; subId: string }
  | { kind: "ingest-call"; t: number; groupId: string; eventIds: string[]; epoch: string }
  | {
      kind: "ingest-result";
      t: number;
      groupId: string;
      eventId: string;
      result: "processed" | "skipped" | "rejected" | "unreadable";
      reason?: string;
      epochBefore: string;
      epochAfter: string;
    }
  | { kind: "queue-enqueue"; t: number; groupId: string; eventId: string; queueSize: number }
  | { kind: "queue-remove"; t: number; groupId: string; eventId: string; reason: string }
  | {
      kind: "queue-drain";
      t: number;
      groupId: string;
      trigger: "epoch-advance" | "ingest-activity";
      entries: number;
    }
  | { kind: "epoch-change"; t: number; groupId: string; from: string; to: string }
  | {
      kind: "publish-task";
      t: number;
      groupId: string;
      taskEventId: string;
      rumorId: string;
      eventId: string;
      createdAt: number;
    }
  | { kind: "task-store-load-start"; t: number; groupId: string }
  | {
      kind: "task-store-load-complete";
      t: number;
      groupId: string;
      restoredCount: number;
    }
  | { kind: "task-store-recv"; t: number; groupId: string; rumorId: string }
  | {
      kind: "task-store-accepted";
      t: number;
      groupId: string;
      rumorId: string;
      taskEventId: string;
    }
  | {
      kind: "task-store-rejected";
      t: number;
      groupId: string;
      rumorId: string;
      reason: "wrong-kind";
    }
  | {
      kind: "task-store-error";
      t: number;
      groupId: string;
      rumorId: string | null;
      reason: "deserialize-throw" | "apply-throw";
      message: string;
    };

export interface MlsTrace {
  record(event: TraceEvent): void;
  dump(): readonly TraceEvent[];
  clear(): void;
}

const FROZEN_EMPTY: readonly TraceEvent[] = Object.freeze([]);

const noopTrace: MlsTrace = {
  record(_event: TraceEvent): void {},
  dump(): readonly TraceEvent[] {
    return FROZEN_EMPTY;
  },
  clear(): void {},
};

/**
 * Recording-trace factory. Exported (rather than module-private) so that
 * `mls-trace.test.ts` exercises the same code path that ships into S2/S3,
 * not a duplicated inline copy that could drift. Production builds DCE
 * this export when `NEXT_PUBLIC_E2E_TRACE_MLS` is unset because nothing
 * else references it (the module-local selection at the bottom resolves
 * to `noopTrace`).
 */
export function createRecordingTrace(): MlsTrace {
  const buffer: TraceEvent[] = [];
  return {
    record(event: TraceEvent): void {
      buffer.push(JSON.parse(JSON.stringify(event)) as TraceEvent);
    },
    dump(): readonly TraceEvent[] {
      // Deep-clone on dump so consumers cannot mutate buffer-internal
      // entries via the returned array. Symmetric with record(): together
      // these close both leak directions (call-site → recorder, recorder
      // → consumer). JSON-clone is total because TraceEvent is JSON-safe
      // by construction.
      return buffer.map((e) => JSON.parse(JSON.stringify(e)) as TraceEvent);
    },
    clear(): void {
      buffer.length = 0;
    },
  };
}

export const mlsTrace: MlsTrace =
  process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1" ? createRecordingTrace() : noopTrace;

export default mlsTrace;
