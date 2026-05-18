/**
 * F-class classifier for the MLS live-delivery diagnostic harness.
 *
 * Pure module: no Playwright, no fs, no DOM imports. Accepts in-memory
 * trace arrays and returns a verdict. The harness in
 * `e2e/tests/multi-user-diag.spec.ts` collects the traces from each
 * page, dumps them to `e2e/.triage/mls-trace-*.json`, and feeds them
 * here for classification.
 *
 * Verdicts are defined by AC-DIAG-3b in
 * `specs/epic-mls-live-delivery-race/acceptance-criteria.md`. The
 * lookup chain is:
 *
 *   failed assertion → expected rumorId
 *     → matching publish-task in sender's trace
 *     → kind-445 eventId
 *     → receiver's sub-event / ingest-result / queue-drain / task-store-* records
 *
 * Per GAP-1 the canonical correlator is `rumor.id`. The trace event
 * field name `taskEventId` is populated from rumor.id at every emit
 * site (see device-sync.ts and task-store.tsx) — this module treats
 * the rumorId as the join key.
 */

// Local TraceEvent type — mirrors src/marmot/mls-trace.ts. Duplicated
// here rather than imported to keep this module self-contained for the
// e2e build; the shape is locked by the unit tests in mls-trace.test.ts
// (S1) and any drift would break those.
export type TraceEvent =
  | { kind: "req-start"; t: number; relay: string; filter: unknown; reqId: string }
  | { kind: "req-event"; t: number; reqId: string; eventId: string; createdAt: number }
  | { kind: "req-eose"; t: number; reqId: string; eventCount: number }
  | { kind: "req-close"; t: number; reqId: string }
  | { kind: "sub-start"; t: number; relay: string; filter: unknown; subId: string }
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

export type Verdict = "F1" | "F2" | "F3a" | "F3b" | "F3c" | "F3d" | "unknown";

export interface ClassifyInput {
  /** Sender's trace dump (from the page that dispatched the task). */
  senderTrace: readonly TraceEvent[];
  /** Receiver's trace dump (from the page whose UI assertion timed out). */
  receiverTrace: readonly TraceEvent[];
  /** The rumor.id of the dispatched task whose UI surfacing was asserted. */
  expectedRumorId: string;
}

export interface ClassifyResult {
  verdict: Verdict;
  /** Human-readable rationale citing the load-bearing trace records. */
  rationale: string;
  /** The kind-445 eventId resolved from the sender's publish-task, if any. */
  resolvedEventId: string | null;
}

/**
 * Classify a single failing assertion.
 *
 * @param input - sender + receiver traces + the expected rumorId
 * @returns the verdict + rationale + the resolved kind-445 eventId
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const { senderTrace, receiverTrace, expectedRumorId } = input;

  // Resolve the kind-445 eventId via the sender's publish-task record.
  const publishTask = senderTrace.find(
    (e): e is Extract<TraceEvent, { kind: "publish-task" }> =>
      e.kind === "publish-task" && e.rumorId === expectedRumorId,
  );

  if (!publishTask) {
    // The bridge couldn't correlate the rumor — could be S2's "count>1
    // → no emit" ambiguity branch, a race, or sender-side publish
    // failure. Per AC-REPORT-3, missing publish-task is unknown.
    return {
      verdict: "unknown",
      rationale: `No publish-task record found for rumorId=${expectedRumorId} in sender trace (${senderTrace.length} events). Possible causes: (a) sender-side publish-task bridge ambiguity (count>1 in window — see device-sync.ts windowKind445State), (b) sender publish failed before reaching network.publish, (c) trace flag was off when task was dispatched.`,
      resolvedEventId: null,
    };
  }

  const eventId = publishTask.eventId;

  // F1: kind-445 eventId never appeared in any sub-event.
  const subEvent = receiverTrace.find(
    (e): e is Extract<TraceEvent, { kind: "sub-event" }> =>
      e.kind === "sub-event" && e.eventId === eventId,
  );
  if (!subEvent) {
    return {
      verdict: "F1",
      rationale: `Receiver never observed kind-445 ${eventId.slice(0, 12)} in any sub-event record. Sender published it (publish-task.t=${publishTask.t}) but it never reached the receiver's subscription pipeline. Likely fetch-then-subscribe gap (F1) — see spec.md § Failure modes F1.`,
      resolvedEventId: eventId,
    };
  }

  // ingest-result for this eventId
  const ingestResults = receiverTrace.filter(
    (e): e is Extract<TraceEvent, { kind: "ingest-result" }> =>
      e.kind === "ingest-result" && e.eventId === eventId,
  );

  // F2: ingest-result with result="unreadable" AND no later queue-drain that
  // would have re-attempted this event before the timeout window.
  const unreadable = ingestResults.find((r) => r.result === "unreadable");
  if (unreadable) {
    const drainAfter = receiverTrace.find(
      (e): e is Extract<TraceEvent, { kind: "queue-drain" }> =>
        e.kind === "queue-drain" && e.t > unreadable.t,
    );
    // Also look for a SUCCEEDING ingest-result with result="processed" for
    // the same event after a drain — if present, the event eventually
    // recovered, so this is NOT F2.
    const recoveredAfterDrain = ingestResults.find(
      (r) => r.t > unreadable.t && r.result === "processed",
    );
    if (!recoveredAfterDrain) {
      return {
        verdict: "F2",
        rationale: `Receiver ingested kind-445 ${eventId.slice(0, 12)} as 'unreadable' (epochBefore=${unreadable.epochBefore}, reason=${unreadable.reason ?? "none"}). ${drainAfter ? `A queue-drain with trigger=${drainAfter.trigger} fired at t=${drainAfter.t} but the event remained unreadable.` : "No queue-drain fired in the timeout window."} Welcome-epoch lag (F2) — see spec.md § Failure modes F2.`,
        resolvedEventId: eventId,
      };
    }
  }

  // F3: ingest-result with result="processed" but UI assertion still
  // timed out — subclassify via task-store-* events.
  const processed = ingestResults.find((r) => r.result === "processed");
  if (processed) {
    return classifyF3(receiverTrace, expectedRumorId, eventId, processed);
  }

  return {
    verdict: "unknown",
    rationale: `kind-445 ${eventId.slice(0, 12)} appeared in sub-event but was never the subject of a final ingest-result (or was rejected/skipped without follow-up). Receiver trace contains ${ingestResults.length} ingest-result records for this event. Manual triage required.`,
    resolvedEventId: eventId,
  };
}

function classifyF3(
  receiverTrace: readonly TraceEvent[],
  rumorId: string,
  eventId: string,
  processed: Extract<TraceEvent, { kind: "ingest-result" }>,
): ClassifyResult {
  const recv = receiverTrace.find(
    (e): e is Extract<TraceEvent, { kind: "task-store-recv" }> =>
      e.kind === "task-store-recv" && e.rumorId === rumorId,
  );
  if (!recv) {
    return {
      verdict: "F3a",
      rationale: `kind-445 ${eventId.slice(0, 12)} was processed by ts-mls (epochAfter=${processed.epochAfter}), but no task-store-recv was emitted for rumorId=${rumorId}. The applicationMessage listener was not yet attached when the event fired (F3a — TaskStoreProvider mount-ordering bug).`,
      resolvedEventId: eventId,
    };
  }

  const errorRecord = receiverTrace.find(
    (e): e is Extract<TraceEvent, { kind: "task-store-error" }> =>
      e.kind === "task-store-error" && e.rumorId === rumorId,
  );
  if (errorRecord) {
    return {
      verdict: "F3b",
      rationale: `task-store handler errored for rumorId=${rumorId} (reason=${errorRecord.reason}, message=${errorRecord.message.slice(0, 80)}). F3b — handler errored before setState.`,
      resolvedEventId: eventId,
    };
  }

  // F3b also fires when deserializeApplicationData throws — in that
  // case rumorId is null on the error record, so we missed it above.
  // Cross-check: a deserialize-throw error with timestamp near processed.t
  // is the only way for an ingest to succeed yet task-store to never see
  // a recv with a known rumor.id. (We still won't know the rumorId in
  // that case so the path is academic for the classifier — it's a
  // sender-side rumor-shape bug.)
  const rejected = receiverTrace.find(
    (e): e is Extract<TraceEvent, { kind: "task-store-rejected" }> =>
      e.kind === "task-store-rejected" && e.rumorId === rumorId,
  );
  if (rejected) {
    return {
      verdict: "F3c",
      rationale: `task-store rejected rumorId=${rumorId} with reason=${rejected.reason}. F3c — protocol/kind-routing drift.`,
      resolvedEventId: eventId,
    };
  }

  const accepted = receiverTrace.find(
    (e): e is Extract<TraceEvent, { kind: "task-store-accepted" }> =>
      e.kind === "task-store-accepted" && e.rumorId === rumorId,
  );
  if (accepted) {
    // F3d: a task-store-load-complete fires AFTER accepted on the same
    // groupId, AND the load's restoredCount does NOT cover the accepted
    // task. The classifier can't directly check restoredCount-vs-task
    // because the trace doesn't carry the task-id list — so we use the
    // weaker but still useful "later load-complete clobbered live state"
    // signal.
    const lateLoadComplete = receiverTrace.find(
      (e): e is Extract<TraceEvent, { kind: "task-store-load-complete" }> =>
        e.kind === "task-store-load-complete" &&
        e.groupId === accepted.groupId &&
        e.t > accepted.t,
    );
    if (lateLoadComplete) {
      return {
        verdict: "F3d",
        rationale: `task-store accepted rumorId=${rumorId} at t=${accepted.t}, but task-store-load-complete fired LATER at t=${lateLoadComplete.t} with restoredCount=${lateLoadComplete.restoredCount}. The mount-time load resolved late and clobbered the live update (F3d — load/live merge bug).`,
        resolvedEventId: eventId,
      };
    }
    // Accepted with no late load-complete — UI should have updated. The
    // assertion timeout in this case is the strangest shape; mark as
    // unknown for manual triage.
    return {
      verdict: "unknown",
      rationale: `task-store accepted rumorId=${rumorId} at t=${accepted.t} with no later load-complete clobber, yet UI assertion timed out. Manual triage — possibly a React render-cycle bug not visible in the trace.`,
      resolvedEventId: eventId,
    };
  }

  return {
    verdict: "unknown",
    rationale: `task-store-recv was emitted for rumorId=${rumorId} but no follow-up accepted/rejected/error record found. Trace likely truncated. Manual triage required.`,
    resolvedEventId: eventId,
  };
}

/**
 * Format a single classification line for the cumulative log file.
 * One line per failed test, suitable for tailing/grepping.
 */
export function formatClassifyLine(args: {
  testName: string;
  run: number;
  result: ClassifyResult;
}): string {
  return `[${new Date().toISOString()}] run=${args.run} test="${args.testName}" verdict=${args.result.verdict} eventId=${args.result.resolvedEventId ?? "n/a"} rationale="${args.result.rationale.replace(/"/g, "'")}"`;
}
