import { describe, expect, it } from "vitest";

import {
  classify,
  formatClassifyLine,
  type TraceEvent,
} from "./mls-trace-classify";

// Synthetic trace fixtures cover each F-class verdict the classifier
// can return. The harness in e2e/tests/multi-user-diag.spec.ts feeds
// real traces through `classify()`; these tests lock the contract that
// the classifier returns the right verdict for each shape.

const RUMOR_ID = "rumor-abc";
const KIND445_EVENT_ID = "event-deadbeef";
const GROUP_ID = "group-1";

function publishTask(rumorId = RUMOR_ID, eventId = KIND445_EVENT_ID): TraceEvent {
  return {
    kind: "publish-task",
    t: 100,
    groupId: GROUP_ID,
    taskEventId: rumorId,
    rumorId,
    eventId,
    createdAt: 1000,
  };
}

function subEvent(eventId: string, t = 200): TraceEvent {
  return {
    kind: "sub-event",
    t,
    subId: "sub-1",
    eventId,
    createdAt: 1000,
    epoch: "1",
  };
}

function ingestResult(
  eventId: string,
  result: "processed" | "skipped" | "rejected" | "unreadable",
  t = 250,
): TraceEvent {
  return {
    kind: "ingest-result",
    t,
    groupId: GROUP_ID,
    eventId,
    result,
    epochBefore: "1",
    epochAfter: result === "processed" ? "2" : "1",
  };
}

describe("classify (F-class verdicts)", () => {
  it("returns unknown when sender has no publish-task for the expected rumorId", () => {
    const result = classify({
      senderTrace: [],
      receiverTrace: [],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.resolvedEventId).toBeNull();
    expect(result.rationale).toContain("No publish-task");
  });

  it("returns F1 when the kind-445 eventId never appears in the receiver's sub-event records", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        // Receiver has OTHER sub-events but not for the expected eventId.
        subEvent("other-event"),
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("F1");
    expect(result.resolvedEventId).toBe(KIND445_EVENT_ID);
    expect(result.rationale).toContain("never observed");
  });

  it("returns F2 when ingest yields unreadable and no later drain recovers it", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        subEvent(KIND445_EVENT_ID, 200),
        ingestResult(KIND445_EVENT_ID, "unreadable", 250),
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("F2");
    expect(result.rationale).toContain("unreadable");
  });

  it("does NOT return F2 when the unreadable event is later processed after a drain", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        subEvent(KIND445_EVENT_ID, 200),
        ingestResult(KIND445_EVENT_ID, "unreadable", 250),
        {
          kind: "queue-drain",
          t: 300,
          groupId: GROUP_ID,
          trigger: "epoch-advance",
          entries: 1,
        },
        ingestResult(KIND445_EVENT_ID, "processed", 350),
        // The event was processed but UI still timed out — falls into
        // F3a (no task-store-recv) since we don't include one.
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("F3a");
  });

  it("returns F3a when ingest is processed but no task-store-recv is emitted", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        subEvent(KIND445_EVENT_ID),
        ingestResult(KIND445_EVENT_ID, "processed"),
        // No task-store-recv for this rumorId.
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("F3a");
    expect(result.rationale).toContain("listener was not yet attached");
  });

  it("returns F3b when task-store handler emits an error record", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        subEvent(KIND445_EVENT_ID),
        ingestResult(KIND445_EVENT_ID, "processed"),
        {
          kind: "task-store-recv",
          t: 300,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
        },
        {
          kind: "task-store-error",
          t: 310,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
          reason: "apply-throw",
          message: "Cannot read property 'x' of undefined",
        },
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("F3b");
    expect(result.rationale).toContain("apply-throw");
  });

  it("returns F3c when task-store rejects the rumor on kind mismatch", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        subEvent(KIND445_EVENT_ID),
        ingestResult(KIND445_EVENT_ID, "processed"),
        {
          kind: "task-store-recv",
          t: 300,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
        },
        {
          kind: "task-store-rejected",
          t: 310,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
          reason: "wrong-kind",
        },
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("F3c");
    expect(result.rationale).toContain("wrong-kind");
  });

  it("returns F3d when task-store accepts then load-complete clobbers", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        subEvent(KIND445_EVENT_ID),
        ingestResult(KIND445_EVENT_ID, "processed"),
        {
          kind: "task-store-recv",
          t: 300,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
        },
        {
          kind: "task-store-accepted",
          t: 310,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
          taskEventId: RUMOR_ID,
        },
        {
          kind: "task-store-load-complete",
          t: 400,
          groupId: GROUP_ID,
          restoredCount: 0,
        },
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("F3d");
    expect(result.rationale).toContain("clobbered");
  });

  it("returns unknown when accepted fires with no late load-complete (mysterious timeout)", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [
        subEvent(KIND445_EVENT_ID),
        ingestResult(KIND445_EVENT_ID, "processed"),
        {
          kind: "task-store-recv",
          t: 300,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
        },
        {
          kind: "task-store-accepted",
          t: 310,
          groupId: GROUP_ID,
          rumorId: RUMOR_ID,
          taskEventId: RUMOR_ID,
        },
        // task-store-load-complete fired BEFORE accepted — not F3d.
        {
          kind: "task-store-load-complete",
          t: 200,
          groupId: GROUP_ID,
          restoredCount: 0,
        },
      ],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.rationale).toContain("Manual triage");
  });

  it("returns unknown when sub-event present but no terminal ingest-result", () => {
    const result = classify({
      senderTrace: [publishTask()],
      receiverTrace: [subEvent(KIND445_EVENT_ID)],
      expectedRumorId: RUMOR_ID,
    });
    expect(result.verdict).toBe("unknown");
    expect(result.rationale).toContain("never the subject of a final ingest-result");
  });
});

describe("formatClassifyLine", () => {
  it("formats a single line with the verdict and resolved eventId", () => {
    const line = formatClassifyLine({
      testName: "multi-user.spec.ts:145",
      run: 2,
      result: {
        verdict: "F2",
        rationale: "the queue did not drain",
        resolvedEventId: "abc123",
      },
    });
    expect(line).toContain("verdict=F2");
    expect(line).toContain("eventId=abc123");
    expect(line).toContain('test="multi-user.spec.ts:145"');
    expect(line).toContain("run=2");
  });

  it("escapes embedded double quotes in the rationale", () => {
    const line = formatClassifyLine({
      testName: "t",
      run: 1,
      result: {
        verdict: "F1",
        rationale: 'sender said "hi"',
        resolvedEventId: null,
      },
    });
    expect(line).toContain("'hi'");
    expect(line).not.toMatch(/rationale="sender said "hi""/);
  });
});
