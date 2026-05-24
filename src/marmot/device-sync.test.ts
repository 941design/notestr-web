import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock persistence so publishTaskStateSync does not hit real IDB.
vi.mock("../store/persistence", () => ({
  loadEvents: vi.fn().mockResolvedValue([]),
  appendEvent: vi.fn().mockResolvedValue(undefined),
  saveEvents: vi.fn().mockResolvedValue(undefined),
  clearEvents: vi.fn().mockResolvedValue(undefined),
}));

// Mock task-reducer so replayEvents can be controlled per test.
vi.mock("../store/task-reducer", () => ({
  replayEvents: vi.fn().mockReturnValue(new Map()),
  applyEvent: vi.fn(),
}));

vi.mock("@internet-privacy/marmot-ts", () => ({
  getKeyPackage: vi.fn((event: any) => event.keyPackage),
  getKeyPackageIdentifier: vi.fn((event: any) => event._slot as string | undefined),
}));

vi.mock("ts-mls", () => ({
  defaultKeyPackageEqualityConfig: {
    compareKeyPackageToLeafNode: vi.fn(
      (keyPackage: { id: string }, leaf: { id: string }) => keyPackage.id === leaf.id,
    ),
  },
  nodeTypes: { leaf: "leaf" },
}));

// Mock failed-welcomes so joinFromWelcomeInvite's appendFailedWelcome call
// does not hit real IDB (which is unavailable in the vitest node environment).
vi.mock("./failed-welcomes", () => ({
  appendFailedWelcome: vi.fn().mockResolvedValue(undefined),
  forgetFailedWelcome: vi.fn().mockResolvedValue(undefined),
  loadFailedWelcomes: vi.fn().mockResolvedValue([]),
  pruneOlderThan: vi.fn().mockResolvedValue(undefined),
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
  fetchAndApplyTaskBootstrap,
  groupHasKeyPackageLeaf,
  isSlotForgotten,
  joinFromWelcomeInvite,
  MAX_RETRIES_PER_EPOCH,
  publishTaskStateSync,
  removeExpectedPublishByRumorId,
  selectAndIncrementRetries,
} from "./device-sync";
import { replayEvents } from "../store/task-reducer";
import { loadEvents } from "../store/persistence";
import type { Task, TaskStateSyncPayload } from "../store/task-events";

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

/**
 * AC-INVITE-2 / AC-INVITE-3 — isSlotForgotten predicate
 *
 * isSlotForgotten(event, forgottenSlots) is the shared guard used by both
 * syncKnownKeyPackages (continue guard, AC-INVITE-2) and handleKeyPackageEvent
 * (early-return guard, AC-INVITE-3). Testing the predicate exercises both
 * insertion points' logic without needing the React hook to run.
 *
 * getKeyPackageIdentifier is mocked at the top of this file to return
 * event._slot, so we can set the slot on test events directly.
 */
describe("AC-INVITE-* — isSlotForgotten (forgotten-slot skip predicate)", () => {
  function makeKpEvent(slot: string | undefined): { _slot: string | undefined; id: string; kind: number } {
    return { _slot: slot, id: `kp-${slot ?? "no-slot"}`, kind: 30443 };
  }

  it("returns true when the event slot is in the forgotten set (AC-INVITE-2/3 skip path)", () => {
    const forgottenSlots = new Set(["slot-abc"]);
    const event = makeKpEvent("slot-abc");
    expect(isSlotForgotten(event as any, forgottenSlots)).toBe(true);
  });

  it("returns false when the event slot is NOT in the forgotten set (invite proceeds)", () => {
    const forgottenSlots = new Set(["slot-abc"]);
    const event = makeKpEvent("slot-xyz");
    expect(isSlotForgotten(event as any, forgottenSlots)).toBe(false);
  });

  it("returns false when forgottenSlots is empty (new-user no-op path, Q-ROBUSTNESS-1)", () => {
    const forgottenSlots = new Set<string>();
    const event = makeKpEvent("slot-abc");
    expect(isSlotForgotten(event as any, forgottenSlots)).toBe(false);
  });

  it("returns false when getKeyPackageIdentifier returns undefined (legacy kind-443 no-slot events)", () => {
    const forgottenSlots = new Set(["does-not-matter"]);
    const event = makeKpEvent(undefined);
    // getKeyPackageIdentifier returns undefined → predicate must return false
    // so legacy KPs are not silently suppressed by a set that cannot match them.
    expect(isSlotForgotten(event as any, forgottenSlots)).toBe(false);
  });

  it("handles multiple forgotten slots — skips each independently (Q-TEST_COVERAGE-1)", () => {
    const forgottenSlots = new Set(["slot-a", "slot-b", "slot-c"]);
    expect(isSlotForgotten(makeKpEvent("slot-a") as any, forgottenSlots)).toBe(true);
    expect(isSlotForgotten(makeKpEvent("slot-b") as any, forgottenSlots)).toBe(true);
    expect(isSlotForgotten(makeKpEvent("slot-d") as any, forgottenSlots)).toBe(false);
  });

  it("correctly reflects Set mutation — simulates refreshForgotten updating the cache (Q-ROBUSTNESS-2)", () => {
    // Start with empty set (like the initial state before loadForgottenSlots resolves).
    let forgottenSlots = new Set<string>();
    const event = makeKpEvent("slot-newly-forgotten");

    // Before the DOM event fires and refreshForgotten is called: not skipped.
    expect(isSlotForgotten(event as any, forgottenSlots)).toBe(false);

    // Simulate refreshForgotten: reassign the Set reference as the live code does.
    forgottenSlots = new Set(["slot-newly-forgotten"]);

    // After refresh: correctly skipped.
    expect(isSlotForgotten(event as any, forgottenSlots)).toBe(true);
  });
});

/**
 * AC-13 — publishTaskStateSync: fire-and-forget publish helper.
 *
 * Tests verify that:
 * - Errors during publish are caught, logged, and NOT propagated.
 * - Missing nip44 support causes an early return without calling publish.
 * - Only non-deleted tasks (those present in the replayed TaskState Map)
 *   are included in the published payload.
 */
describe("publishTaskStateSync (AC-13)", () => {
  const mockReplayEvents = replayEvents as ReturnType<typeof vi.fn>;
  const mockLoadEvents = loadEvents as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadEvents.mockResolvedValue([]);
    mockReplayEvents.mockReturnValue(new Map());
  });

  it("catches and logs errors without rethrowing (relay publish throws)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const signer = {
      nip44: {
        encrypt: vi.fn().mockResolvedValue("encrypted-payload"),
        decrypt: vi.fn(),
      },
      signEvent: vi.fn().mockResolvedValue({ id: "signed-event", kind: 30078 }),
      getPublicKey: vi.fn().mockResolvedValue("aabbccdd"),
    };
    const client = {
      network: {
        publish: vi.fn().mockRejectedValue(new Error("relay unavailable")),
      },
    };

    // Must resolve, not reject — error is caught internally.
    await expect(
      publishTaskStateSync("group1", "inviteepubkey", signer as any, client as any, []),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[task-sync] publishTaskStateSync failed"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("catches and logs errors without rethrowing (nip44 encrypt throws)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const signer = {
      nip44: {
        encrypt: vi.fn().mockRejectedValue(new Error("nip44 error")),
        decrypt: vi.fn(),
      },
      signEvent: vi.fn(),
      getPublicKey: vi.fn().mockResolvedValue("aabbccdd"),
    };
    const client = { network: { publish: vi.fn() } };

    await expect(
      publishTaskStateSync("group1", "pubkey1", signer as any, client as any, []),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[task-sync] publishTaskStateSync failed"),
      expect.any(Error),
    );
    // publish was never reached.
    expect(client.network.publish).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("skips publish when signer has no nip44 support", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const signer = {
      // no nip44 property
      getPublicKey: vi.fn(),
      signEvent: vi.fn(),
    };
    const client = { network: { publish: vi.fn() } };

    await expect(
      publishTaskStateSync("group1", "pubkey1", signer as any, client as any, []),
    ).resolves.toBeUndefined();

    expect(client.network.publish).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[task-sync] signer does not support NIP-44"),
    );
    consoleSpy.mockRestore();
  });

  it("includes only non-deleted tasks (deleted tasks are absent from TaskState map)", async () => {
    // The reducer removes deleted tasks from the map entirely.
    // Simulate a state with one live task and one that was deleted (absent from map).
    const liveTask = {
      id: "task-live",
      title: "Live task",
      description: "",
      status: "open" as const,
      assignee: null,
      createdBy: "aabbccdd",
      createdAt: 1000,
      updatedAt: 1000,
      updatedBy: "aabbccdd",
    };
    mockReplayEvents.mockReturnValue(new Map([["task-live", liveTask]]));

    const capturedPayloads: string[] = [];
    const signer = {
      nip44: {
        encrypt: vi.fn().mockImplementation((_pubkey: string, plaintext: string) => {
          capturedPayloads.push(plaintext);
          return Promise.resolve("encrypted");
        }),
        decrypt: vi.fn(),
      },
      signEvent: vi.fn().mockResolvedValue({ id: "signed", kind: 30078 }),
      getPublicKey: vi.fn().mockResolvedValue("aabbccdd"),
    };
    const client = { network: { publish: vi.fn().mockResolvedValue(undefined) } };

    await publishTaskStateSync("group1", "inviteepubkey", signer as any, client as any, []);

    expect(capturedPayloads).toHaveLength(1);
    const payload = JSON.parse(capturedPayloads[0]);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0].id).toBe("task-live");
    // Verify deleted-task-id is absent from the payload.
    expect(payload.tasks.some((t: { id: string }) => t.id === "task-deleted")).toBe(false);
  });

  it("uses groupId as the d-tag (MLS idStr, not nostr group hex)", async () => {
    const signer = {
      nip44: {
        encrypt: vi.fn().mockResolvedValue("encrypted"),
        decrypt: vi.fn(),
      },
      signEvent: vi.fn().mockResolvedValue({ id: "signed", kind: 30078 }),
      getPublicKey: vi.fn().mockResolvedValue("aabbccdd"),
    };
    const client = { network: { publish: vi.fn().mockResolvedValue(undefined) } };
    const groupId = "deadbeef1234";
    const inviteePubkey = "cafebabe5678";

    await publishTaskStateSync(groupId, inviteePubkey, signer as any, client as any, []);

    const signedArg = (signer.signEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dTagEntry = signedArg.tags.find((t: string[]) => t[0] === "d");
    expect(dTagEntry).toBeDefined();
    expect(dTagEntry[1]).toBe(`notestr:task-sync:${groupId}:${inviteePubkey}`);
    expect(signedArg.kind).toBe(30078);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchAndApplyTaskBootstrap — S3 unit tests
// Covers: AC-2 (CRDT LWW), AC-4 (graceful degradation), AC-5 (idempotence
// guard), AC-6 (empty payload safe), AC-7 (bootstrap/live commute),
// AC-8 (multi-inviter convergence), AC-12 (manually-joined skip)
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    description: "",
    status: "open",
    assignee: null,
    createdBy: "aabbccdd",
    createdAt: 1000,
    updatedAt: 1000,
    updatedBy: "aabbccdd",
    ...overrides,
  };
}

function makeRelayEvent(
  pubkey: string,
  content: string,
): { id: string; pubkey: string; content: string; kind: number; tags: string[][]; created_at: number; sig: string } {
  return {
    id: "relay-event-1",
    pubkey,
    content,
    kind: 30078,
    tags: [["d", "notestr:task-sync:group1:ownpubkey"]],
    created_at: 1000,
    sig: "",
  };
}

function makeValidPayload(
  groupId: string,
  tasks: Task[],
): TaskStateSyncPayload {
  return {
    version: 1,
    type: "task.state_sync",
    groupId,
    tasks,
    syncedAt: 1000,
    inviterPubkey: "inviterpubkey",
  };
}

describe("fetchAndApplyTaskBootstrap (S3 — AC-2/4/5/6/7/8/12)", () => {
  const GROUP_ID = "group1";
  const OWN_PUBKEY = "ownpubkey";
  const INVITER_PUBKEY = "inviterpubkey";

  // Test 1: client=null → returns [] immediately (AC-12 guard)
  it("returns [] immediately when client is null", async () => {
    const signer = { nip44: { decrypt: vi.fn() } };
    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      null,
      [],
      new Map(),
    );
    expect(result).toEqual([]);
    expect(signer.nip44.decrypt).not.toHaveBeenCalled();
  });

  // Test 2: no signer.nip44 → returns []
  it("returns [] and logs error when signer has no nip44", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const signer = { signEvent: vi.fn() }; // no nip44
    const client = { network: { request: vi.fn() } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
    expect(client.network.request).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[task-sync] signer does not support NIP-44"),
    );
    consoleSpy.mockRestore();
  });

  // Test 3: empty relay result → returns []  (AC-4, AC-6)
  it("returns [] when relay returns no events", async () => {
    const signer = { nip44: { decrypt: vi.fn() } };
    const client = { network: { request: vi.fn().mockResolvedValue([]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
    expect(signer.nip44.decrypt).not.toHaveBeenCalled();
  });

  // Test 4: decryption failure on event → skipped, returns []
  it("skips events where decryption throws and returns []", async () => {
    const signer = {
      nip44: { decrypt: vi.fn().mockRejectedValue(new Error("decrypt failed")) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted-garbage");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
  });

  // Test 5: invalid payload (wrong version) → skipped
  it("skips events with invalid payload (wrong version)", async () => {
    const badPayload = { version: 2, type: "task.state_sync", groupId: GROUP_ID, tasks: [] };
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(badPayload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
  });

  // Test 6: payload.tasks = [] → returns [] (AC-6 — cannot wipe state)
  it("returns [] for empty tasks array — cannot wipe existing state (AC-6)", async () => {
    const existingTask = makeTask({ id: "existing-task", updatedBy: "aabbccdd", updatedAt: 999 });
    const currentState = new Map([["existing-task", existingTask]]);

    const payload = makeValidPayload(GROUP_ID, []); // empty tasks
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      currentState,
    );

    expect(result).toEqual([]);
  });

  // Test 7: task not in store → returns task.created event (FWW)
  it("returns task.created for task not in currentState (FWW)", async () => {
    const newTask = makeTask({ id: "new-task", updatedAt: 500, updatedBy: "inviterpubkey" });
    const payload = makeValidPayload(GROUP_ID, [newTask]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(), // empty currentState
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "task.created", task: newTask });
  });

  // Test 8: LWW — payload.updatedAt > existing → returns task.created (AC-2)
  it("accepts incoming task when updatedAt is newer than existing (LWW win)", async () => {
    const existing = makeTask({ id: "t1", updatedAt: 100, updatedBy: "aabbccdd" });
    const currentState = new Map([["t1", existing]]);
    const incoming = makeTask({ id: "t1", updatedAt: 200, updatedBy: "aabbccdd" }); // newer

    const payload = makeValidPayload(GROUP_ID, [incoming]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      currentState,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "task.created", task: incoming });
  });

  // Test 9: LWW — payload.updatedAt < existing → skips (LWW loss) (AC-2)
  it("skips incoming task when updatedAt is older than existing (LWW loss)", async () => {
    const existing = makeTask({ id: "t1", updatedAt: 200, updatedBy: "aabbccdd" });
    const currentState = new Map([["t1", existing]]);
    const incoming = makeTask({ id: "t1", updatedAt: 100, updatedBy: "aabbccdd" }); // older

    const payload = makeValidPayload(GROUP_ID, [incoming]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      currentState,
    );

    expect(result).toEqual([]);
  });

  // Test 10: equal updatedAt, lower updatedBy wins (AC-2 tie-break)
  it("accepts task when equal updatedAt and incoming updatedBy < existing (tie-break win)", async () => {
    const existing = makeTask({ id: "t1", updatedAt: 100, updatedBy: "bbb" });
    const currentState = new Map([["t1", existing]]);
    const incoming = makeTask({ id: "t1", updatedAt: 100, updatedBy: "aaa" }); // 'aaa' < 'bbb'

    const payload = makeValidPayload(GROUP_ID, [incoming]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      currentState,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "task.created", task: incoming });
  });

  // Test 11: equal updatedAt, higher updatedBy → skips (tie-breaker loss)
  it("skips task when equal updatedAt and incoming updatedBy > existing (tie-break loss)", async () => {
    const existing = makeTask({ id: "t1", updatedAt: 100, updatedBy: "aaa" });
    const currentState = new Map([["t1", existing]]);
    const incoming = makeTask({ id: "t1", updatedAt: 100, updatedBy: "bbb" }); // 'bbb' > 'aaa'

    const payload = makeValidPayload(GROUP_ID, [incoming]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      currentState,
    );

    expect(result).toEqual([]);
  });

  // Test 12: relay throws → caught, returns [] (AC-4 graceful degradation)
  it("returns [] when relay request throws (AC-4 graceful degradation)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const signer = { nip44: { decrypt: vi.fn() } };
    const client = {
      network: { request: vi.fn().mockRejectedValue(new Error("network timeout")) },
    };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[task-sync] fetchAndApplyTaskBootstrap failed"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  // Test 13: AC-7 — bootstrap/live events commute
  // (a) live event arrived first (higher updatedAt in currentState) → bootstrap skips
  it("AC-7a: bootstrap skips task when live event already set a higher updatedAt", async () => {
    // Simulate: live event arrived and set T1.updatedAt = 101
    const liveVersion = makeTask({ id: "T1", updatedAt: 101, updatedBy: "livepubkey" });
    const currentState = new Map([["T1", liveVersion]]);

    // Bootstrap payload has T1 with older updatedAt = 100
    const bootstrapVersion = makeTask({ id: "T1", updatedAt: 100, updatedBy: "inviterpubkey" });
    const payload = makeValidPayload(GROUP_ID, [bootstrapVersion]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      currentState,
    );

    expect(result).toEqual([]); // bootstrap lost — existing (live) wins
  });

  // (b) bootstrap arrives first (empty currentState) → bootstrap accepts
  it("AC-7b: bootstrap accepts task when currentState is empty (bootstrap arrives first)", async () => {
    const bootstrapTask = makeTask({ id: "T1", updatedAt: 100, updatedBy: "inviterpubkey" });
    const payload = makeValidPayload(GROUP_ID, [bootstrapTask]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(), // empty — bootstrap arrives first
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "task.created", task: bootstrapTask });
  });

  // Test 14: AC-8 — multi-inviter convergence (two payloads commute)
  // Both A-then-C and C-then-A must converge to 'aaa' winning the tie-break
  it("AC-8: two payloads from different inviters converge regardless of order", async () => {
    const taskFromA = makeTask({ id: "T1", updatedAt: 50, updatedBy: "aaa" });
    const taskFromC = makeTask({ id: "T1", updatedAt: 50, updatedBy: "bbb" });

    // Simulate applying A first: empty currentState, A wins (FWW)
    // Then apply C with currentState containing A's version
    const payloadA = makeValidPayload(GROUP_ID, [taskFromA]);
    const payloadC = makeValidPayload(GROUP_ID, [taskFromC]);

    // Order A → C
    async function applyOrderAC() {
      const stateAfterA = new Map([["T1", taskFromA]]);

      const signerAC = {
        nip44: {
          decrypt: vi.fn()
            .mockResolvedValueOnce(JSON.stringify(payloadA)) // first call: event from A
            .mockResolvedValueOnce(JSON.stringify(payloadC)), // second call: event from C
        },
      };
      const eventA = { ...makeRelayEvent("aaa", "enc-a"), id: "event-a" };
      const eventC = { ...makeRelayEvent("bbb", "enc-c"), id: "event-c" };
      const clientAC = { network: { request: vi.fn().mockResolvedValue([eventA, eventC]) } };

      // Apply both events with empty currentState
      const results = await fetchAndApplyTaskBootstrap(
        GROUP_ID,
        OWN_PUBKEY,
        signerAC as any,
        clientAC as any,
        [],
        new Map(),
      );
      // Both events for T1 are processed: first A wins (FWW, empty store).
      // Then C is processed against the accumulated state-so-far...
      // BUT fetchAndApplyTaskBootstrap processes both against the original
      // currentState=new Map() — C also sees empty state and would insert too.
      // The caller must apply events sequentially. The CRDT gate here processes
      // against currentState at call time, not against intermediate results.
      // So with empty currentState, BOTH A and C win the FWW gate.
      // The last one written via appendEvent overwrites... but since the reducer
      // uses LWW on applyEvent(task.created), the winner is determined by the
      // reducer's own merge. This is the design: fetchAndApplyTaskBootstrap
      // returns synthetic events; the reducer + appendEvent + replayEvents
      // produces the final state. What we can verify here is the CRDT gate
      // logic itself: when currentState already has T1 from A, C with same
      // timestamp and higher updatedBy loses.
      void results; // Acknowledge that with empty currentState both may be inserted

      // Now simulate a second call (applying C against state that already has A)
      const signerC = {
        nip44: {
          decrypt: vi.fn().mockResolvedValueOnce(JSON.stringify(payloadC)),
        },
      };
      const clientC = { network: { request: vi.fn().mockResolvedValue([eventC]) } };

      const resultsC = await fetchAndApplyTaskBootstrap(
        GROUP_ID,
        OWN_PUBKEY,
        signerC as any,
        clientC as any,
        [],
        stateAfterA, // C sees A's version already in state
      );
      return resultsC; // C should lose: same updatedAt, 'bbb' > 'aaa'
    }

    // Order C → A
    async function applyOrderCA() {
      const stateAfterC = new Map([["T1", taskFromC]]);

      const signerA = {
        nip44: {
          decrypt: vi.fn().mockResolvedValueOnce(JSON.stringify(payloadA)),
        },
      };
      const eventA = { ...makeRelayEvent("aaa", "enc-a"), id: "event-a" };
      const clientA = { network: { request: vi.fn().mockResolvedValue([eventA]) } };

      const resultsA = await fetchAndApplyTaskBootstrap(
        GROUP_ID,
        OWN_PUBKEY,
        signerA as any,
        clientA as any,
        [],
        stateAfterC, // A sees C's version already in state
      );
      return resultsA; // A should win: same updatedAt, 'aaa' < 'bbb'
    }

    const [resultC_afterA, resultA_afterC] = await Promise.all([
      applyOrderAC(),
      applyOrderCA(),
    ]);

    // In order A→C: applying C against state-with-A produces [] (C loses)
    expect(resultC_afterA).toEqual([]);
    // In order C→A: applying A against state-with-C produces [task from A] (A wins)
    expect(resultA_afterC).toHaveLength(1);
    expect(resultA_afterC[0]).toEqual({ type: "task.created", task: taskFromA });
  });

  // Test 15: uses correct d-tag filter (AC-9 architecture check)
  it("queries relay with correct d-tag and kind filter", async () => {
    const signer = { nip44: { decrypt: vi.fn() } };
    const client = { network: { request: vi.fn().mockResolvedValue([]) } };
    const groupId = "deadbeef";
    const ownPubkey = "cafebabe";

    await fetchAndApplyTaskBootstrap(
      groupId,
      ownPubkey,
      signer as any,
      client as any,
      ["wss://relay.example.com"],
      new Map(),
    );

    expect(client.network.request).toHaveBeenCalledWith(
      ["wss://relay.example.com"],
      [expect.objectContaining({
        kinds: [30078],
        "#d": [`notestr:task-sync:${groupId}:${ownPubkey}`],
      })],
    );
  });

  // Test 16: invalid JSON (non-object payload) → skipped
  it("skips events where decrypted content is not a valid JSON object", async () => {
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue("not-json!!!") },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
  });

  // Test 17: groupId mismatch in payload → skipped
  it("skips events where payload.groupId does not match the requested groupId", async () => {
    const payload = makeValidPayload("different-group", [makeTask()]);
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "encrypted");
    const client = { network: { request: vi.fn().mockResolvedValue([event]) } };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID, // different from payload.groupId
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
  });

  // Test 18: payload without tasks array → skipped (P2 fix: malformed payload guard)
  it("skips events where payload.tasks is not an array (malformed payload)", async () => {
    const badPayload = { version: 1, type: "task.state_sync", groupId: GROUP_ID, tasks: "not-an-array" };
    const signer = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(badPayload)) },
    };
    const goodPayload = makeValidPayload(GROUP_ID, [makeTask({ id: "good-task" })]);
    const signerBoth = {
      nip44: {
        decrypt: vi.fn()
          .mockResolvedValueOnce(JSON.stringify(badPayload))
          .mockResolvedValueOnce(JSON.stringify(goodPayload)),
      },
    };
    const event1 = { ...makeRelayEvent(INVITER_PUBKEY, "enc-bad"), id: "event-bad" };
    const event2 = { ...makeRelayEvent(INVITER_PUBKEY, "enc-good"), id: "event-good" };
    const client = { network: { request: vi.fn().mockResolvedValue([event1, event2]) } };

    // The bad event should be skipped; the good event should still be processed.
    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signerBoth as any,
      client as any,
      [],
      new Map(),
    );

    // Good event's task should still come through — bad event did not abort the whole fetch.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "task.created", task: expect.objectContaining({ id: "good-task" }) });

    // Standalone: single bad event → returns []
    const signerSingle = {
      nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(badPayload)) },
    };
    const clientSingle = { network: { request: vi.fn().mockResolvedValue([event1]) } };
    const result2 = await fetchAndApplyTaskBootstrap(
      GROUP_ID, OWN_PUBKEY, signer as any, clientSingle as any, [], new Map(),
    );
    expect(result2).toEqual([]);
  });

  // Test 19: accumulated-state fix — two relay events with same task produce deterministic result
  // regardless of delivery order (P1 fix from Codex review)
  it("uses accumulated accepted state across relay events — same task from two events, LWW wins (not relay order)", async () => {
    // Two relay events both contain T1: one with updatedBy='aaa', one with 'bbb'.
    // updatedAt is equal, so 'aaa' should win (tie-break, lower string wins).
    // Without the accumulator fix, BOTH would push task.created events since
    // each sees currentState=empty, making final result relay-order-dependent.
    const taskFromA = makeTask({ id: "T1", updatedAt: 50, updatedBy: "aaa" });
    const taskFromB = makeTask({ id: "T1", updatedAt: 50, updatedBy: "bbb" });

    const payloadA = makeValidPayload(GROUP_ID, [taskFromA]);
    const payloadB = makeValidPayload(GROUP_ID, [taskFromB]);

    // Order: event-A first, event-B second
    const signerAB = {
      nip44: {
        decrypt: vi.fn()
          .mockResolvedValueOnce(JSON.stringify(payloadA)) // event-A first
          .mockResolvedValueOnce(JSON.stringify(payloadB)), // event-B second
      },
    };
    const eventA = { ...makeRelayEvent("aaa", "enc-a"), id: "event-a" };
    const eventB = { ...makeRelayEvent("bbb", "enc-b"), id: "event-b" };
    const clientAB = { network: { request: vi.fn().mockResolvedValue([eventA, eventB]) } };

    const resultAB = await fetchAndApplyTaskBootstrap(
      GROUP_ID, OWN_PUBKEY, signerAB as any, clientAB as any, [], new Map(),
    );

    // A-then-B: A wins first (FWW), B arrives with same updatedAt, 'bbb' > 'aaa' → A still wins.
    // Exactly one task.created should be emitted for the winning task.
    expect(resultAB).toHaveLength(1);
    expect(resultAB[0]).toEqual({ type: "task.created", task: taskFromA });

    // Order: event-B first, event-A second — must converge to the same result.
    const signerBA = {
      nip44: {
        decrypt: vi.fn()
          .mockResolvedValueOnce(JSON.stringify(payloadB)) // event-B first
          .mockResolvedValueOnce(JSON.stringify(payloadA)), // event-A second
      },
    };
    const clientBA = { network: { request: vi.fn().mockResolvedValue([eventB, eventA]) } };

    const resultBA = await fetchAndApplyTaskBootstrap(
      GROUP_ID, OWN_PUBKEY, signerBA as any, clientBA as any, [], new Map(),
    );

    // B wins FWW (first seen), then A arrives with same updatedAt, 'aaa' < 'bbb' → A replaces B.
    // After the fix, events are generated AFTER the full loop so each task ID appears exactly
    // once: the final winner. Both orders must converge to exactly one event for taskFromA.
    expect(resultBA).toHaveLength(1);
    expect(resultBA[0]).toEqual({ type: "task.created", task: taskFromA });
  });

  // Test 20: deferred event generation — two relay events with DIFFERENT tasks each
  // produce exactly one task.created each (no interference between task IDs).
  it("emits one task.created per unique task ID even when tasks appear across multiple relay events", async () => {
    const taskX = makeTask({ id: "X", updatedAt: 10, updatedBy: "aaa" });
    const taskY = makeTask({ id: "Y", updatedAt: 20, updatedBy: "bbb" });
    const payloadWithX = makeValidPayload(GROUP_ID, [taskX]);
    const payloadWithY = makeValidPayload(GROUP_ID, [taskY]);

    const signer = {
      nip44: {
        decrypt: vi.fn()
          .mockResolvedValueOnce(JSON.stringify(payloadWithX))
          .mockResolvedValueOnce(JSON.stringify(payloadWithY)),
      },
    };
    const client = {
      network: { request: vi.fn().mockResolvedValue([makeRelayEvent(INVITER_PUBKEY, "enc-x"), makeRelayEvent(INVITER_PUBKEY, "enc-y")]) },
    };

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID, OWN_PUBKEY, signer as any, client as any, [], new Map(),
    );

    expect(result).toHaveLength(2);
    const ids = result.map((e) => (e as any).task.id).sort();
    expect(ids).toEqual(["X", "Y"]);
  });

  // Test 21: deferred event generation prevents FWW-in-replay from picking the
  // wrong winner when the same task appears in multiple relay events.
  // Without the fix (emitting task.created mid-loop), relay order loser-then-
  // winner would produce [task.created(loser), task.created(winner)]; the reducer's
  // FWW semantics would then persist the loser (first written). With the fix,
  // events are generated after the full loop, so only task.created(winner) is
  // emitted regardless of relay delivery order.
  it("emits only the LWW winner when same task ID appears in multiple relay events (loser-first order)", async () => {
    const taskWinner = makeTask({ id: "T1", updatedAt: 100, updatedBy: "aaa" });
    const taskLoser  = makeTask({ id: "T1", updatedAt: 50,  updatedBy: "bbb" });

    // Relay delivers loser-first, winner-second — the adversarial order.
    const payloadLoser  = makeValidPayload(GROUP_ID, [taskLoser]);
    const payloadWinner = makeValidPayload(GROUP_ID, [taskWinner]);

    const signer = {
      nip44: {
        decrypt: vi.fn()
          .mockResolvedValueOnce(JSON.stringify(payloadLoser))
          .mockResolvedValueOnce(JSON.stringify(payloadWinner)),
      },
    };
    const client = {
      network: {
        request: vi.fn().mockResolvedValue([
          makeRelayEvent(INVITER_PUBKEY, "enc-loser"),
          makeRelayEvent(INVITER_PUBKEY, "enc-winner"),
        ]),
      },
    };

    const events = await fetchAndApplyTaskBootstrap(
      GROUP_ID, OWN_PUBKEY, signer as any, client as any, [], new Map(),
    );

    // Exactly one task.created — the winner — despite loser arriving first.
    // Persisting this array and replaying it via the FWW reducer will correctly
    // yield taskWinner because the loser never appears in the output at all.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "task.created", task: taskWinner });
    // No event for the loser in the output.
    expect(events.every((e) => (e as any).task.updatedAt === 100)).toBe(true);
  });
});
