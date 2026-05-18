import { describe, expect, it } from "vitest";

import { createRecordingTrace, type TraceEvent } from "./mls-trace";

// These tests exercise the SAME factory the module-level `mlsTrace`
// singleton resolves to when `NEXT_PUBLIC_E2E_TRACE_MLS=1` at build time.
// They lock the contract that `mls-trace.ts` ships:
//
//   - record() defensively JSON-clones the event so post-record mutation
//     of the caller's argument cannot rewrite already-recorded entries.
//   - dump() defensively JSON-clones each entry on egress so consumer
//     mutation of a returned event cannot rewrite the internal buffer.
//   - clear() empties the buffer.

describe("mls-trace recording impl", () => {
  it("clones the event on record so post-record mutation does not rewrite history", () => {
    const trace = createRecordingTrace();
    const eventIds = ["a", "b"];
    const event: TraceEvent = {
      kind: "ingest-call",
      t: 1,
      groupId: "g1",
      eventIds,
      epoch: "0",
    };

    trace.record(event);
    eventIds.push("c");
    (event as { groupId: string }).groupId = "MUTATED";

    const dumped = trace.dump();
    expect(dumped).toHaveLength(1);
    const recorded = dumped[0];
    expect(recorded.kind).toBe("ingest-call");
    if (recorded.kind === "ingest-call") {
      expect(recorded.eventIds).toEqual(["a", "b"]);
      expect(recorded.groupId).toBe("g1");
    }
  });

  it("clones nested filter objects so filter mutation post-record does not rewrite history", () => {
    const trace = createRecordingTrace();
    const filter = { kinds: [445], "#h": ["abc"] };
    const event: TraceEvent = {
      kind: "req-start",
      t: 1,
      relay: "ws://relay",
      filter,
      reqId: "r1",
    };

    trace.record(event);
    filter.kinds.push(9999);
    filter["#h"][0] = "MUTATED";

    const dumped = trace.dump();
    expect(dumped).toHaveLength(1);
    const recorded = dumped[0];
    if (recorded.kind === "req-start") {
      expect(recorded.filter.kinds).toEqual([445]);
      expect(recorded.filter["#h"]).toEqual(["abc"]);
    }
  });

  it("dump returns an array snapshot — mutating the array does not affect subsequent dumps", () => {
    const trace = createRecordingTrace();
    trace.record({ kind: "req-close", t: 1, reqId: "r1" });
    trace.record({ kind: "req-close", t: 2, reqId: "r2" });

    const first = trace.dump() as TraceEvent[];
    expect(first).toHaveLength(2);
    first.length = 0;

    const second = trace.dump();
    expect(second).toHaveLength(2);
  });

  it("dump deep-clones each entry — mutating a returned event does not corrupt the buffer", () => {
    const trace = createRecordingTrace();
    trace.record({
      kind: "ingest-call",
      t: 1,
      groupId: "g1",
      eventIds: ["a", "b"],
      epoch: "0",
    });

    const first = trace.dump();
    expect(first).toHaveLength(1);
    const consumerView = first[0];
    if (consumerView.kind === "ingest-call") {
      (consumerView as { groupId: string }).groupId = "CORRUPTED";
      consumerView.eventIds.push("c");
    }

    const second = trace.dump();
    expect(second).toHaveLength(1);
    const fresh = second[0];
    if (fresh.kind === "ingest-call") {
      expect(fresh.groupId).toBe("g1");
      expect(fresh.eventIds).toEqual(["a", "b"]);
    }
  });

  it("clear empties the buffer", () => {
    const trace = createRecordingTrace();
    trace.record({ kind: "req-close", t: 1, reqId: "r1" });
    trace.clear();
    expect(trace.dump()).toHaveLength(0);
  });
});
