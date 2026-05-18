import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@internet-privacy/marmot-ts", () => ({
  getKeyPackage: vi.fn((event: any) => event.keyPackage),
}));

vi.mock("ts-mls", () => ({
  defaultKeyPackageEqualityConfig: {
    compareKeyPackageToLeafNode: vi.fn(
      (keyPackage: { id: string }, leaf: { id: string }) => keyPackage.id === leaf.id,
    ),
  },
  nodeTypes: { leaf: "leaf" },
}));

// Swap the trace singleton for a recording impl so the publish-task
// bridge tests can inspect emitted trace events. Without this, the
// no-op default would record nothing.
const mockRecordedEvents: Array<Record<string, unknown>> = [];
vi.mock("./mls-trace", () => ({
  mlsTrace: {
    record: (event: Record<string, unknown>) => {
      mockRecordedEvents.push(event);
    },
    dump: () => mockRecordedEvents.slice(),
    clear: () => {
      mockRecordedEvents.length = 0;
    },
  },
}));

import {
  beginDispatchPublishWindow,
  consumeExpectedPublishForKind445,
  endDispatchPublishWindow,
  enqueueExpectedPublish,
  groupHasKeyPackageLeaf,
  joinFromWelcomeInvite,
  MAX_RETRIES_PER_EPOCH,
  removeExpectedPublishByRumorId,
  selectAndIncrementRetries,
} from "./device-sync";

function makeKind445Event(id: string, hTag: string, createdAt = 1000): {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
} {
  return {
    id,
    kind: 445,
    pubkey: "deadbeef",
    created_at: createdAt,
    tags: [["h", hTag]],
    content: "",
    sig: "",
  };
}

describe("groupHasKeyPackageLeaf", () => {
  it("matches a device leaf by key package identity instead of pubkey", () => {
    const state = {
      ratchetTree: [
        { nodeType: "leaf", leaf: { id: "device-a" } },
        { nodeType: "leaf", leaf: { id: "device-b" } },
      ],
    } as any;

    expect(
      groupHasKeyPackageLeaf(state, { keyPackage: { id: "device-b" } } as any),
    ).toBe(true);
    expect(
      groupHasKeyPackageLeaf(state, { keyPackage: { id: "device-c" } } as any),
    ).toBe(false);
  });
});

describe("joinFromWelcomeInvite", () => {
  it("marks same-pubkey welcomes as read when the local key package is missing", async () => {
    const inviteReader = {
      markAsRead: vi.fn().mockResolvedValue(undefined),
    } as any;
    const client = {
      joinGroupFromWelcome: vi.fn().mockRejectedValue(
        new Error("No matching KeyPackage found in local store."),
      ),
    } as any;

    const result = await joinFromWelcomeInvite(
      client,
      inviteReader,
      { id: "welcome-1" } as any,
    );

    expect(result).toBeNull();
    expect(inviteReader.markAsRead).toHaveBeenCalledWith("welcome-1");
  });
});

describe("publish-task bridge (GAP-2 publish-path)", () => {
  beforeEach(() => {
    mockRecordedEvents.length = 0;
  });

  it("emits publish-task when exactly one kind-445 fires in window (happy path)", () => {
    const hTag = "abc";
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-A", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter(
      (e) => e.kind === "publish-task",
    );
    expect(publishTaskRecords).toHaveLength(1);
    expect(publishTaskRecords[0]).toMatchObject({
      kind: "publish-task",
      groupId: "group-1",
      rumorId: "rumor-1",
      taskEventId: "rumor-1",
      eventId: "event-A",
    });
  });

  it("emits NOTHING when two kind-445s fire in window (ambiguous: commit interleaved)", () => {
    const hTag = "abc";
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);
    // Simulate auto-invite's commit publishing first, then our own application publish.
    consumeExpectedPublishForKind445(makeKind445Event("commit-event", hTag));
    consumeExpectedPublishForKind445(makeKind445Event("our-app-event", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter(
      (e) => e.kind === "publish-task",
    );
    expect(publishTaskRecords).toHaveLength(0);
  });

  it("does not poison subsequent dispatch after an ambiguous window (parked entry dropped)", () => {
    const hTag = "abc";

    // Round 1: ambiguous — commit interleaves.
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("commit-A", hTag));
    consumeExpectedPublishForKind445(makeKind445Event("our-event-1", hTag));
    endDispatchPublishWindow(hTag);

    // Round 2: clean — only our publish fires.
    enqueueExpectedPublish(hTag, "rumor-2", "group-1", "rumor-2");
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("our-event-2", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter(
      (e) => e.kind === "publish-task",
    );
    expect(publishTaskRecords).toHaveLength(1);
    expect(publishTaskRecords[0]).toMatchObject({
      rumorId: "rumor-2",
      eventId: "our-event-2",
    });
  });

  it("ignores kind-445 publishes outside the dispatch window", () => {
    const hTag = "abc";
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    // Background commit fires BEFORE we open the window.
    consumeExpectedPublishForKind445(makeKind445Event("background-commit", hTag));
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("our-event", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter(
      (e) => e.kind === "publish-task",
    );
    expect(publishTaskRecords).toHaveLength(1);
    expect(publishTaskRecords[0]).toMatchObject({ eventId: "our-event" });
  });

  it("removeExpectedPublishByRumorId drops a parked entry on dispatch failure", () => {
    const hTag = "abc";
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    // Simulate sendApplicationRumor throwing before reaching network.publish.
    removeExpectedPublishByRumorId(hTag, "rumor-1");

    // Next dispatch — its publish should NOT correlate to a stale entry.
    enqueueExpectedPublish(hTag, "rumor-2", "group-1", "rumor-2");
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-2", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter(
      (e) => e.kind === "publish-task",
    );
    expect(publishTaskRecords).toHaveLength(1);
    expect(publishTaskRecords[0]).toMatchObject({
      rumorId: "rumor-2",
      eventId: "event-2",
    });
  });

  it("emits NOTHING when publish fails AFTER consume runs (post-consume throw)", () => {
    // Codex round-3 challenged whether endDispatchPublishWindow's
    // count===1 branch could emit a stale publish-task when the publish
    // succeeds at the consume step but fails downstream (timeout, no
    // relay ack via marmot-ts hasAck check). Expected flow:
    //   1. consume runs at the start of network.publish (count=1, firstEvent captured)
    //   2. await ndk.publish rejects → marmot-ts hasAck throws
    //   3. dispatch's catch removes the FIFO entry via removeExpectedPublishByRumorId
    //   4. dispatch's finally runs endDispatchPublishWindow
    //   5. count===1 branch is gated on `&& front`; FIFO is empty → no emit
    // This test locks that contract.
    const hTag = "abc";
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-A", hTag));
    // Simulate publish rejecting AFTER consume captured the event.
    removeExpectedPublishByRumorId(hTag, "rumor-1");
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter(
      (e) => e.kind === "publish-task",
    );
    expect(publishTaskRecords).toHaveLength(0);
  });
});

/**
 * AC-B-6 — drain-on-ingest retry budget (Solution B).
 *
 * Tests for `selectAndIncrementRetries` and `MAX_RETRIES_PER_EPOCH` —
 * the exported helpers called by `ingestGroupEventsRaw`'s drain block.
 * Placed in device-sync.test.ts because `retryAttempts` lives in
 * device-sync.ts, not ingest-queue.ts (see architecture.json note).
 */
describe("AC-B-6 — drain-on-ingest retry budget (selectAndIncrementRetries)", () => {
  /**
   * Case 1: no infinite-loop within an epoch.
   *
   * Simulate 3 consecutive ingest calls in epoch N with one parked event
   * that stays unreadable. Confirm exactly 3 retry attempts are made and
   * the 4th call does NOT retry.
   */
  it("stops retrying after MAX_RETRIES_PER_EPOCH attempts within one epoch", () => {
    const groupAttempts = new Map<string, number>();
    const parked = [{ id: "event-alpha" }];

    // Calls 1-3: counter goes 0→1→2→3; event is eligible each time.
    const r1 = selectAndIncrementRetries(groupAttempts, parked, MAX_RETRIES_PER_EPOCH);
    expect(r1.map((e) => e.id)).toEqual(["event-alpha"]);
    expect(groupAttempts.get("event-alpha")).toBe(1);

    const r2 = selectAndIncrementRetries(groupAttempts, parked, MAX_RETRIES_PER_EPOCH);
    expect(r2.map((e) => e.id)).toEqual(["event-alpha"]);
    expect(groupAttempts.get("event-alpha")).toBe(2);

    const r3 = selectAndIncrementRetries(groupAttempts, parked, MAX_RETRIES_PER_EPOCH);
    expect(r3.map((e) => e.id)).toEqual(["event-alpha"]);
    expect(groupAttempts.get("event-alpha")).toBe(MAX_RETRIES_PER_EPOCH);

    // Call 4: counter === MAX_RETRIES_PER_EPOCH → NOT eligible. No retry.
    const r4 = selectAndIncrementRetries(groupAttempts, parked, MAX_RETRIES_PER_EPOCH);
    expect(r4).toHaveLength(0);
    // Counter must not increment beyond the cap.
    expect(groupAttempts.get("event-alpha")).toBe(MAX_RETRIES_PER_EPOCH);
  });

  /**
   * Case 2: epoch-reset semantics.
   *
   * After exhausting the budget in epoch N, simulate an epoch advance via
   * `groupAttempts.clear()` (exactly as `attachRetryOnEpochAdvance` does
   * in `retryAttempts.get(group.idStr)?.clear()`). Confirm the counter
   * resets and the next ingest call in epoch N+1 retries the event.
   */
  it("retries again in epoch N+1 after groupAttempts.clear() on epoch advance", () => {
    const groupAttempts = new Map<string, number>();
    const parked = [{ id: "event-beta" }];

    // Exhaust budget in epoch N.
    for (let i = 0; i < MAX_RETRIES_PER_EPOCH; i++) {
      selectAndIncrementRetries(groupAttempts, parked, MAX_RETRIES_PER_EPOCH);
    }
    expect(groupAttempts.get("event-beta")).toBe(MAX_RETRIES_PER_EPOCH);
    // Confirm exhausted.
    const exhausted = selectAndIncrementRetries(groupAttempts, parked, MAX_RETRIES_PER_EPOCH);
    expect(exhausted).toHaveLength(0);

    // Epoch advance: attachRetryOnEpochAdvance calls clear().
    groupAttempts.clear();
    expect(groupAttempts.get("event-beta")).toBeUndefined();

    // First drain in epoch N+1: counter reset, so event IS eligible.
    const r = selectAndIncrementRetries(groupAttempts, parked, MAX_RETRIES_PER_EPOCH);
    expect(r.map((e) => e.id)).toEqual(["event-beta"]);
    expect(groupAttempts.get("event-beta")).toBe(1);
  });

  /**
   * Case 3: per-group keying.
   *
   * Two groups with parked events of the same eventId have independent
   * `groupAttempts` maps. Simulating `retryAttempts.delete(groupA)` (by
   * removing the entry from the outer map) must NOT affect groupB's counters.
   */
  it("per-group keying: deleting groupA entry does not affect groupB counters", () => {
    const retryAttempts = new Map<string, Map<string, number>>();
    const groupA = "group-aaa";
    const groupB = "group-bbb";
    const eventId = "shared-event-id";

    const attemptsA = new Map<string, number>();
    const attemptsB = new Map<string, number>();
    retryAttempts.set(groupA, attemptsA);
    retryAttempts.set(groupB, attemptsB);

    const parked = [{ id: eventId }];

    // Increment groupA twice, groupB once.
    selectAndIncrementRetries(attemptsA, parked, MAX_RETRIES_PER_EPOCH);
    selectAndIncrementRetries(attemptsA, parked, MAX_RETRIES_PER_EPOCH);
    expect(attemptsA.get(eventId)).toBe(2);

    selectAndIncrementRetries(attemptsB, parked, MAX_RETRIES_PER_EPOCH);
    expect(attemptsB.get(eventId)).toBe(1);

    // Delete groupA (as refreshGroupSync does: retryAttempts.delete(groupId)).
    retryAttempts.delete(groupA);
    expect(retryAttempts.has(groupA)).toBe(false);

    // groupB's counters are unchanged.
    expect(retryAttempts.get(groupB)?.get(eventId)).toBe(1);

    // groupB can still drain independently up to MAX_RETRIES_PER_EPOCH.
    const bAttempts = retryAttempts.get(groupB)!;
    selectAndIncrementRetries(bAttempts, parked, MAX_RETRIES_PER_EPOCH);
    expect(bAttempts.get(eventId)).toBe(2);
  });
});
