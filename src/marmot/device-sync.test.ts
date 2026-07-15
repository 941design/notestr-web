import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock raw-event-log-store so publishTaskStateSync does not hit real IDB
// (S12 cutover: publishTaskStateSync's local-state read moved off the
// retired src/store/persistence.ts onto this durable engine store).
vi.mock("../persistence/raw-event-log-store", () => ({
  loadAcceptedEvents: vi.fn().mockResolvedValue([]),
  appendFact: vi.fn(),
  loadFacts: vi.fn(),
  appendAcceptedEvent: vi.fn(),
  clearRawAndAcceptedLogs: vi.fn(),
}));

// Mock task-projector so buildProjection's Task map output can be
// controlled per test (mirrors the pre-S12 replayEvents mock).
vi.mock("../domain/task-projector", () => ({
  buildProjection: vi.fn().mockReturnValue(new Map()),
  replayOrder: vi.fn((events: unknown[]) => events),
}));

vi.mock("@internet-privacy/marmot-ts", () => ({
  getKeyPackage: vi.fn((event: any) => event.keyPackage),
  getKeyPackageIdentifier: vi.fn((event: any) => event._slot as string | undefined),
  // Bootstrap author-membership gate reads the member set off the group state.
  // The mock returns whatever `_members` the test stamped on the mock state.
  getGroupMembers: vi.fn((state: any) => state?._members ?? []),
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
  inviteAndPublishSnapshot,
  isSlotForgotten,
  joinFromWelcomeInvite,
  keyPackageSlot,
  publishTaskStateSync,
  removeExpectedPublishByRumorId,
} from "./device-sync";
import { buildProjection } from "../domain/task-projector";
import { loadAcceptedEvents } from "../persistence/raw-event-log-store";
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
  const mockBuildProjection = buildProjection as ReturnType<typeof vi.fn>;
  const mockLoadAcceptedEvents = loadAcceptedEvents as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAcceptedEvents.mockResolvedValue([]);
    mockBuildProjection.mockReturnValue(new Map());
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

  it("includes only non-deleted tasks (deleted tasks are absent from the projection map)", async () => {
    // The projector removes deleted tasks from the map entirely.
    // Simulate a projection with one live task and one that was deleted (absent from map).
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
    mockBuildProjection.mockReturnValue(new Map([["task-live", liveTask]]));

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

/**
 * inviteAndPublishSnapshot — the shared invite+snapshot helper.
 *
 * Regression coverage for the same-identity divergence bug: the auto-invite
 * path used to call inviteByKeyPackageEvent WITHOUT publishing the task-state
 * snapshot, so a sibling device added at a later MLS epoch started from an
 * empty board. Both invite paths now route through this helper, so the
 * invite-then-snapshot pairing is asserted in one place.
 *
 * The end-to-end cross-implementation reproduction (web → CLI sibling, LINK2)
 * lives in the parent workspace's e2e/same-identity.spec.ts and cannot run
 * from notestr-web alone. These unit tests guard the web-side contract: a
 * successful invite is always followed by a snapshot publish, and a rejected
 * invite publishes nothing.
 */
describe("inviteAndPublishSnapshot", () => {
  const mockBuildProjection = buildProjection as ReturnType<typeof vi.fn>;
  const mockLoadAcceptedEvents = loadAcceptedEvents as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAcceptedEvents.mockResolvedValue([]);
    mockBuildProjection.mockReturnValue(new Map());
  });

  function makeSigner() {
    return {
      nip44: {
        encrypt: vi.fn().mockResolvedValue("encrypted-payload"),
        decrypt: vi.fn(),
      },
      // Echo the unsigned event back so the published event carries the d-tag.
      signEvent: vi.fn().mockImplementation((unsigned: unknown) => unsigned),
      getPublicKey: vi.fn().mockResolvedValue("ownpubkey"),
    };
  }

  it("publishes the task-state snapshot after a successful invite", async () => {
    const group = {
      idStr: "group-mls-id",
      inviteByKeyPackageEvent: vi.fn().mockResolvedValue(undefined),
    };
    const signer = makeSigner();
    const publish = vi.fn().mockResolvedValue(undefined);
    const client = { network: { publish } };
    const kpEvent = { id: "kp-event-1" };

    await inviteAndPublishSnapshot(
      group as any,
      kpEvent as any,
      "siblingpubkey",
      signer as any,
      client as any,
      ["wss://relay"],
    );

    expect(group.inviteByKeyPackageEvent).toHaveBeenCalledWith(kpEvent);

    // The snapshot publish is fire-and-forget (not awaited by the helper),
    // so wait for the async chain to settle.
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    const publishedEvent = publish.mock.calls[0][1] as {
      kind: number;
      tags: string[][];
    };
    expect(publishedEvent.kind).toBe(30078);
    const dTag = publishedEvent.tags.find((t) => t[0] === "d");
    expect(dTag?.[1]).toBe("notestr:task-sync:group-mls-id:siblingpubkey");
  });

  it("publishes nothing when the invite rejects", async () => {
    const group = {
      idStr: "group-mls-id",
      inviteByKeyPackageEvent: vi
        .fn()
        .mockRejectedValue(new Error("epoch conflict")),
    };
    const signer = makeSigner();
    const publish = vi.fn().mockResolvedValue(undefined);
    const client = { network: { publish } };

    await expect(
      inviteAndPublishSnapshot(
        group as any,
        { id: "kp-event-1" } as any,
        "siblingpubkey",
        signer as any,
        client as any,
        ["wss://relay"],
      ),
    ).rejects.toThrow("epoch conflict");

    // Give any (erroneously) scheduled publish a chance to run, then assert
    // it never happened — the snapshot must only follow a successful invite.
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
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

  // A client whose group resolves to a member set — exercises the production
  // (fail-closed) author-authenticity gate path, unlike the bare-client tests
  // below which leave membership unverifiable (filter disabled).
  function clientWithMembers(
    events: unknown[],
    members: string[],
  ): { network: { request: ReturnType<typeof vi.fn> }; groups: { loaded: unknown[] } } {
    return {
      network: { request: vi.fn().mockResolvedValue(events) },
      groups: { loaded: [{ idStr: GROUP_ID, state: { _members: members } }] },
    };
  }

  // SECURITY: author-membership gate (finding fetch-task-bootstrap-no-mls-author-check)
  it("merges a snapshot authored by a current group member", async () => {
    const signer = {
      nip44: {
        decrypt: vi
          .fn()
          .mockResolvedValue(JSON.stringify(makeValidPayload(GROUP_ID, [makeTask()]))),
      },
    };
    const event = makeRelayEvent(INVITER_PUBKEY, "enc");
    const client = clientWithMembers([event], [INVITER_PUBKEY, OWN_PUBKEY]);

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "task.created" });
  });

  it("rejects a snapshot authored by a non-member without decrypting it", async () => {
    const signer = { nip44: { decrypt: vi.fn() } };
    // Author is NOT in the member set — an attacker who NIP-44-encrypted a
    // payload to our pubkey and published it under the #d tag.
    const event = makeRelayEvent("attackerpubkey", "enc");
    const client = clientWithMembers([event], [INVITER_PUBKEY, OWN_PUBKEY]);

    const result = await fetchAndApplyTaskBootstrap(
      GROUP_ID,
      OWN_PUBKEY,
      signer as any,
      client as any,
      [],
      new Map(),
    );

    expect(result).toEqual([]);
    // Membership is checked before decryption — the untrusted payload is never
    // even decrypted, let alone merged.
    expect(signer.nip44.decrypt).not.toHaveBeenCalled();
  });

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
import fc from "fast-check";
import { appendFailedWelcome } from "./failed-welcomes";

// ─────────────────────────────────────────────────────────────────────────────
// GAP-A: removeExpectedPublishByRumorId — FIFO queue semantics
//
// Root cause: existing tests only ever have a single entry in the FIFO when
// remove is called, so the "no-op on non-existent hTag / idx===-1 guard /
// queue-empty cleanup" branches were unexercised.
//
// User story: when a dispatch fails before its publish reaches the network,
// the failed rumor's FIFO entry is cleaned up so the NEXT dispatch's publish
// is correctly attributed — never to a stale entry from a prior failure.
// ─────────────────────────────────────────────────────────────────────────────
describe("removeExpectedPublishByRumorId — FIFO queue semantics (GAP-A)", () => {
  beforeEach(() => {
    mockRecordedEvents.length = 0;
  });

  it("is a no-op when called for an hTag that was never registered (missing-hTag guard)", () => {
    const hTag = crypto.randomUUID();
    // Never enqueued — must not throw and must leave unrelated state intact.
    expect(() => removeExpectedPublishByRumorId(hTag, "rumor-x")).not.toThrow();
  });

  it("is a no-op when the rumorId is absent from the queue (idx === -1 guard), leaving existing entries intact", () => {
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-present", "group-1", "rumor-present");

    // Remove a rumorId that was never enqueued — the "present" entry must survive.
    removeExpectedPublishByRumorId(hTag, "rumor-not-here");

    // The surviving entry should still match in the next dispatch window.
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-A", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter((e) => e.kind === "publish-task");
    expect(publishTaskRecords).toHaveLength(1);
    expect(publishTaskRecords[0]).toMatchObject({ rumorId: "rumor-present" });
  });

  it("removes a specific entry from a multi-entry FIFO, leaving the remaining entry as head", () => {
    // Simulate two back-to-back dispatches queuing up before either window closes.
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-first", "group-1", "rumor-first");
    enqueueExpectedPublish(hTag, "rumor-second", "group-1", "rumor-second");

    // The first dispatch fails before publish — remove its entry.
    removeExpectedPublishByRumorId(hTag, "rumor-first");

    // Second dispatch succeeds: one kind-445 fires → must match rumor-second.
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-B", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter((e) => e.kind === "publish-task");
    expect(publishTaskRecords).toHaveLength(1);
    expect(publishTaskRecords[0]).toMatchObject({
      rumorId: "rumor-second",
      eventId: "event-B",
    });
  });

  it("cleans up the hTag map entry after removing the sole queued rumor (queue-empty cleanup guard)", () => {
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-only", "group-1", "rumor-only");

    // Remove the only entry — map should be empty / cleaned up.
    removeExpectedPublishByRumorId(hTag, "rumor-only");

    // A subsequent window with a kind-445 fires into an empty FIFO → no emit.
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-X", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter((e) => e.kind === "publish-task");
    expect(publishTaskRecords).toHaveLength(0);
  });

  it("does NOT clean up the hTag entry when FIFO still has remaining entries after removal", () => {
    // Two entries; remove the first; the second must still be serviceable.
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-a", "group-1", "rumor-a");
    enqueueExpectedPublish(hTag, "rumor-b", "group-1", "rumor-b");

    removeExpectedPublishByRumorId(hTag, "rumor-a");

    // Open window, fire one event → the remaining head (rumor-b) must match.
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-C", hTag));
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter((e) => e.kind === "publish-task");
    expect(publishTaskRecords).toHaveLength(1);
    expect(publishTaskRecords[0]).toMatchObject({ rumorId: "rumor-b" });
  });

  it("FIFO ordering: second enqueue appends to existing queue (not overwrite) — first-in first-out attribution", () => {
    // Verifies the 'if (existing) existing.push(entry)' branch at line 156 of
    // device-sync.ts. If push were replaced by set (overwrite), the first
    // rumor would be lost and the second would steal its publish attribution.
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-A", "group-1", "rumor-A");
    enqueueExpectedPublish(hTag, "rumor-B", "group-1", "rumor-B"); // must APPEND, not overwrite

    // First dispatch window: the first enqueued rumor is the head of the FIFO.
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-1", hTag));
    endDispatchPublishWindow(hTag);

    const firstBatch = mockRecordedEvents.filter((e) => e.kind === "publish-task");
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]).toMatchObject({ rumorId: "rumor-A", eventId: "event-1" });

    mockRecordedEvents.length = 0;

    // Second dispatch window: rumor-B is now the head (rumor-A was dequeued).
    beginDispatchPublishWindow(hTag);
    consumeExpectedPublishForKind445(makeKind445Event("event-2", hTag));
    endDispatchPublishWindow(hTag);

    const secondBatch = mockRecordedEvents.filter((e) => e.kind === "publish-task");
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0]).toMatchObject({ rumorId: "rumor-B", eventId: "event-2" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP-B: consumeExpectedPublishForKind445 — event filter validation
//
// Root cause: all existing test events are well-formed kind-445 events with
// valid #h tags. The kind-check and tag-structure filter were unexercised
// destructively. Tests below verify that non-445 and malformed-tag events
// are silently ignored and do NOT count as a publish-window observation.
// ─────────────────────────────────────────────────────────────────────────────
describe("consumeExpectedPublishForKind445 — event filter validation (GAP-B)", () => {
  beforeEach(() => {
    mockRecordedEvents.length = 0;
  });

  it("ignores events whose kind is not 445 — no publish-task emitted from the window", () => {
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);

    // A non-445 event with a valid-looking #h tag must be treated as invisible.
    consumeExpectedPublishForKind445({
      id: "note-event",
      kind: 1,
      pubkey: "deadbeef",
      created_at: 1000,
      tags: [["h", hTag]],
      content: "",
      sig: "",
    } as any);

    // Close without a real kind-445 — count === 0 → no publish-task, entry left parked.
    endDispatchPublishWindow(hTag);

    const publishTaskRecords = mockRecordedEvents.filter((e) => e.kind === "publish-task");
    expect(publishTaskRecords).toHaveLength(0);
  });

  it("ignores kind-445 events with no tags (tag filter: no #h present)", () => {
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);

    consumeExpectedPublishForKind445({
      id: "no-tags-event",
      kind: 445,
      pubkey: "deadbeef",
      created_at: 1000,
      tags: [],
      content: "",
      sig: "",
    } as any);

    endDispatchPublishWindow(hTag);

    expect(mockRecordedEvents.filter((e) => e.kind === "publish-task")).toHaveLength(0);
  });

  it("ignores kind-445 events where tags are present but no tag has key 'h'", () => {
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);

    consumeExpectedPublishForKind445({
      id: "wrong-tag-key",
      kind: 445,
      pubkey: "deadbeef",
      created_at: 1000,
      tags: [["e", hTag], ["p", "somepubkey"]],  // 'e' and 'p', no 'h'
      content: "",
      sig: "",
    } as any);

    endDispatchPublishWindow(hTag);

    expect(mockRecordedEvents.filter((e) => e.kind === "publish-task")).toHaveLength(0);
  });

  it("ignores kind-445 events where #h tag value is not a string", () => {
    const hTag = crypto.randomUUID();
    enqueueExpectedPublish(hTag, "rumor-1", "group-1", "rumor-1");
    beginDispatchPublishWindow(hTag);

    consumeExpectedPublishForKind445({
      id: "non-string-h-tag",
      kind: 445,
      pubkey: "deadbeef",
      created_at: 1000,
      tags: [["h"]],  // tag[1] is undefined
      content: "",
      sig: "",
    } as any);

    endDispatchPublishWindow(hTag);

    expect(mockRecordedEvents.filter((e) => e.kind === "publish-task")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP-C: joinFromWelcomeInvite — failure reason classification
//
// Root cause: only one error scenario existed; failureReason was never
// asserted. The ciphersuite_mismatch and unknown branches were unexercised.
// Tests below verify the three classification paths and that
// appendFailedWelcome is called with the correct failureReason.
// (no AC in the specs — spec-gap; the behavior is observable and matters for
// diagnostics surfaced to the user in the failed-welcome log.)
// ─────────────────────────────────────────────────────────────────────────────
describe("joinFromWelcomeInvite — failure reason classification (GAP-C)", () => {
  const mockAppendFailedWelcome = appendFailedWelcome as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies errors matching /[Nn]o matching/i as no_matching_kp", async () => {
    const client = {
      joinGroupFromWelcome: vi.fn().mockRejectedValue(
        new Error("No matching KeyPackage found in local store."),
      ),
    } as any;
    const inviteReader = { markAsRead: vi.fn().mockResolvedValue(undefined) } as any;

    await joinFromWelcomeInvite(client, inviteReader, { id: "invite-nm" } as any);

    expect(mockAppendFailedWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "no_matching_kp" }),
    );
  });

  it("classifies errors matching /ciphersuite/i as ciphersuite_mismatch", async () => {
    const client = {
      joinGroupFromWelcome: vi.fn().mockRejectedValue(
        new Error("Unsupported ciphersuite MLS_128_DHKEMP256_AES128GCM_SHA256_P256"),
      ),
    } as any;
    const inviteReader = { markAsRead: vi.fn().mockResolvedValue(undefined) } as any;

    await joinFromWelcomeInvite(client, inviteReader, { id: "invite-cs" } as any);

    expect(mockAppendFailedWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "ciphersuite_mismatch" }),
    );
  });

  it("classifies errors matching neither pattern as unknown", async () => {
    const client = {
      joinGroupFromWelcome: vi.fn().mockRejectedValue(
        new Error("Internal epoch mismatch — cannot advance"),
      ),
    } as any;
    const inviteReader = { markAsRead: vi.fn().mockResolvedValue(undefined) } as any;

    await joinFromWelcomeInvite(client, inviteReader, { id: "invite-unk" } as any);

    expect(mockAppendFailedWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: "unknown" }),
    );
  });

  it("records the failing invite's gift-wrap event id in the failure record", async () => {
    const client = {
      joinGroupFromWelcome: vi.fn().mockRejectedValue(new Error("No matching key")),
    } as any;
    const inviteReader = { markAsRead: vi.fn().mockResolvedValue(undefined) } as any;

    await joinFromWelcomeInvite(
      client,
      inviteReader,
      { id: "gift-wrap-abc123" } as any,
    );

    expect(mockAppendFailedWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ giftWrapEventId: "gift-wrap-abc123" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP-D: fetchAndApplyTaskBootstrap — payload validation with non-empty tasks
//
// Root cause: the existing "wrong version" test uses tasks:[], so a mutant that
// bypasses the version check still returns [] (no tasks to process). The
// individual OR-chain validation clauses needed tests with non-empty task
// arrays to make bypasses detectable.
// ─────────────────────────────────────────────────────────────────────────────
describe("fetchAndApplyTaskBootstrap — payload validation clauses with non-empty tasks (GAP-D)", () => {
  const GID = "group-gapd";
  const OPK = "ownpubkey-gapd";
  const IPK = "inviterpubkey-gapd";

  function makeClientD(events: unknown[]) {
    return { network: { request: vi.fn().mockResolvedValue(events) } };
  }

  it("rejects wrong-version payload even when tasks are non-empty (version check not bypassed)", async () => {
    const nonEmptyTask = makeTask({ id: "t-version", updatedAt: 100 });
    const badPayload = { version: 2, type: "task.state_sync", groupId: GID, tasks: [nonEmptyTask] };
    const signer = { nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(badPayload)) } };
    const event = { ...makeRelayEvent(IPK, "enc"), id: "ev-ver" };
    const client = makeClientD([event]);

    const result = await fetchAndApplyTaskBootstrap(GID, OPK, signer as any, client as any, [], new Map());

    expect(result).toEqual([]);
  });

  it("rejects wrong-type payload even when tasks are non-empty (type field check)", async () => {
    const nonEmptyTask = makeTask({ id: "t-type", updatedAt: 100 });
    const badPayload = { version: 1, type: "task.created", groupId: GID, tasks: [nonEmptyTask] };
    const signer = { nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(badPayload)) } };
    const event = { ...makeRelayEvent(IPK, "enc"), id: "ev-type" };
    const client = makeClientD([event]);

    const result = await fetchAndApplyTaskBootstrap(GID, OPK, signer as any, client as any, [], new Map());

    expect(result).toEqual([]);
  });

  it("rejects a decrypted JSON null payload (null check: typeof null === 'object')", async () => {
    // JSON.parse("null") === null; typeof null === "object" so the null guard is required.
    const signer = { nip44: { decrypt: vi.fn().mockResolvedValue("null") } };
    const event = { ...makeRelayEvent(IPK, "enc"), id: "ev-null" };
    const client = makeClientD([event]);

    const result = await fetchAndApplyTaskBootstrap(GID, OPK, signer as any, client as any, [], new Map());

    expect(result).toEqual([]);
  });

  it("rejects a decrypted JSON primitive (string) payload (typeof !== 'object' check)", async () => {
    // JSON.parse('"hello"') === "hello"; typeof "hello" === "string", not "object".
    const signer = { nip44: { decrypt: vi.fn().mockResolvedValue('"hello"') } };
    const event = { ...makeRelayEvent(IPK, "enc"), id: "ev-str" };
    const client = makeClientD([event]);

    const result = await fetchAndApplyTaskBootstrap(GID, OPK, signer as any, client as any, [], new Map());

    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP-E: CRDT updatedByDevice tie-break (third level)
//        epic-new-member-task-state-sync:AC-2 (CRDT convergence) /
//        AC-8 (multi-inviter convergence)
//
// Root cause: no test had equal updatedAt AND equal updatedBy with differing
// updatedByDevice values. The third tie-break level and its ??"" defaulting
// for undefined were uncovered.
// ─────────────────────────────────────────────────────────────────────────────
describe("fetchAndApplyTaskBootstrap — CRDT updatedByDevice tie-break (GAP-E / AC-2, AC-8)", () => {
  const GID_E = "group-gape";
  const OPK_E = "ownpubkey-gape";
  const IPK_E = "inviterpubkey-gape";

  function makeSignerE(tasks: Task[]) {
    const payload: TaskStateSyncPayload = {
      version: 1,
      type: "task.state_sync",
      groupId: GID_E,
      tasks,
      syncedAt: 1000,
      inviterPubkey: IPK_E,
    };
    return { nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) } };
  }

  function makeClientE() {
    return { network: { request: vi.fn().mockResolvedValue([makeRelayEvent(IPK_E, "enc")]) } };
  }

  it("incoming wins when updatedByDevice is strictly less (third tie-break win — AC-2)", async () => {
    const existing = { ...makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }), updatedByDevice: "device-b" } as Task;
    const incoming = { ...makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }), updatedByDevice: "device-a" } as Task; // "a" < "b"
    const currentState = new Map([["t1", existing]]);

    const result = await fetchAndApplyTaskBootstrap(
      GID_E, OPK_E, makeSignerE([incoming]) as any, makeClientE() as any, [], currentState,
    );

    expect(result).toHaveLength(1);
    expect((result[0] as any).task.updatedByDevice).toBe("device-a");
  });

  it("existing wins when incoming updatedByDevice is strictly greater (third tie-break loss — AC-2)", async () => {
    const existing = { ...makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }), updatedByDevice: "device-a" } as Task;
    const incoming = { ...makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }), updatedByDevice: "device-b" } as Task; // "b" > "a"
    const currentState = new Map([["t1", existing]]);

    const result = await fetchAndApplyTaskBootstrap(
      GID_E, OPK_E, makeSignerE([incoming]) as any, makeClientE() as any, [], currentState,
    );

    expect(result).toEqual([]);
  });

  it("existing wins on complete tie (equal updatedByDevice values → no override)", async () => {
    const existing = { ...makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }), updatedByDevice: "device-x" } as Task;
    const incoming = { ...makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }), updatedByDevice: "device-x" } as Task;
    const currentState = new Map([["t1", existing]]);

    const result = await fetchAndApplyTaskBootstrap(
      GID_E, OPK_E, makeSignerE([incoming]) as any, makeClientE() as any, [], currentState,
    );

    expect(result).toEqual([]);
  });

  it("treats undefined updatedByDevice as '' for tie-break purposes (?? '' defaulting)", async () => {
    // existing has no updatedByDevice (undefined → ""); incoming also "".
    // "" < "" is false → existing wins.
    const existing = makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }); // no updatedByDevice
    const incoming = { ...makeTask({ id: "t1", updatedAt: 100, updatedBy: "same" }), updatedByDevice: "" } as Task;
    const currentState = new Map([["t1", existing]]);

    const result = await fetchAndApplyTaskBootstrap(
      GID_E, OPK_E, makeSignerE([incoming]) as any, makeClientE() as any, [], currentState,
    );

    expect(result).toEqual([]);
  });

  // Property (Family B — metamorphic: commutativity of the third tie-break).
  // For any pair of distinct device IDs, the winner of the tie-break is the
  // same regardless of which relay event is processed first.
  // epic-new-member-task-state-sync:AC-8 (multi-inviter convergence)
  it("third tie-break is deterministic regardless of relay-event delivery order (fast-check / AC-8)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (deviceA, deviceB) => {
          fc.pre(deviceA !== deviceB);

          const winner = deviceA < deviceB ? deviceA : deviceB;
          const loser = deviceA < deviceB ? deviceB : deviceA;

          const taskWinner = { ...makeTask({ id: "T1", updatedAt: 50, updatedBy: "same" }), updatedByDevice: winner } as Task;
          const taskLoser = { ...makeTask({ id: "T1", updatedAt: 50, updatedBy: "same" }), updatedByDevice: loser } as Task;

          const payloadW: TaskStateSyncPayload = { version: 1, type: "task.state_sync", groupId: GID_E, tasks: [taskWinner], syncedAt: 1000, inviterPubkey: IPK_E };
          const payloadL: TaskStateSyncPayload = { version: 1, type: "task.state_sync", groupId: GID_E, tasks: [taskLoser], syncedAt: 1000, inviterPubkey: IPK_E };

          // Order 1: winner event arrives first
          const signerWL = { nip44: { decrypt: vi.fn().mockResolvedValueOnce(JSON.stringify(payloadW)).mockResolvedValueOnce(JSON.stringify(payloadL)) } };
          const clientWL = { network: { request: vi.fn().mockResolvedValue([makeRelayEvent(IPK_E, "enc-w"), makeRelayEvent(IPK_E, "enc-l")]) } };
          const resultWL = await fetchAndApplyTaskBootstrap(GID_E, OPK_E, signerWL as any, clientWL as any, [], new Map());

          // Order 2: loser event arrives first
          const signerLW = { nip44: { decrypt: vi.fn().mockResolvedValueOnce(JSON.stringify(payloadL)).mockResolvedValueOnce(JSON.stringify(payloadW)) } };
          const clientLW = { network: { request: vi.fn().mockResolvedValue([makeRelayEvent(IPK_E, "enc-l"), makeRelayEvent(IPK_E, "enc-w")]) } };
          const resultLW = await fetchAndApplyTaskBootstrap(GID_E, OPK_E, signerLW as any, clientLW as any, [], new Map());

          // Both orders must converge to exactly one task.created for the winner.
          expect(resultWL).toHaveLength(1);
          expect(resultLW).toHaveLength(1);
          expect((resultWL[0] as any).task.updatedByDevice).toBe(winner);
          expect((resultLW[0] as any).task.updatedByDevice).toBe(winner);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// Targeted test for the specific surviving mutant at line 1441:
//   ConditionalExpression: `task.updatedBy === existing.updatedBy` → `true`
//
// All GAP-E tests above use updatedBy: "same" for both sides, making
// the `=== "same"` check trivially true. The mutation replaces that check
// with `true`, which is indistinguishable when both sides are equal.
//
// This test uses *different* updatedBy values so the level-3 tie-break
// (updatedByDevice) should NEVER fire — the winner is determined solely
// by updatedAt and updatedBy (level 2). The mutation would incorrectly
// allow the device-ID tie-break to fire, producing a wrong winner.
describe("fetchAndApplyTaskBootstrap — CRDT level-2 gate guards level-3 (line 1441 mutant)", () => {
  const GID_M = "group-m1441";
  const OPK_M = "ownpubkey-m1441";
  const IPK_M = "inviterpubkey-m1441";

  it("existing wins at level-2 (higher updatedBy); level-3 device tie-break must NOT fire", async () => {
    // existing.updatedBy = "aaa" wins level-2 (lower pubkey wins), so
    // existing is already the winner. The incoming task has a higher updatedBy
    // ("bbb" > "aaa") and a lower updatedByDevice ("device-a" < "device-z").
    // The mutation (`task.updatedBy === → true`) would incorrectly trigger the
    // device tie-break and let incoming win via updatedByDevice, which is wrong.
    const existing = {
      ...makeTask({ id: "t2", updatedAt: 50, updatedBy: "aaa" }),
      updatedByDevice: "device-z",
    } as Task;
    const incoming = {
      ...makeTask({ id: "t2", updatedAt: 50, updatedBy: "bbb" }),
      updatedByDevice: "device-a",  // lower device ID — MUST NOT win
    } as Task;
    const currentState = new Map([["t2", existing]]);

    const payload: TaskStateSyncPayload = {
      version: 1, type: "task.state_sync", groupId: GID_M,
      tasks: [incoming], syncedAt: 1000, inviterPubkey: IPK_M,
    };
    const signer = { nip44: { decrypt: vi.fn().mockResolvedValue(JSON.stringify(payload)) } };
    const client = { network: { request: vi.fn().mockResolvedValue([makeRelayEvent(IPK_M, "enc")]) } };

    const result = await fetchAndApplyTaskBootstrap(GID_M, OPK_M, signer as any, client as any, [], currentState);

    // existing wins (updatedBy "aaa" < "bbb"); result must be empty.
    expect(result).toEqual([]);
  });
});

// keyPackageSlot — dual-read contract pinning (backlog: marmot-ts-fork-types-lag).
//
// marmot-ts v0.5 has a runtime/type mismatch: the static type calls the slot
// field `identifier`, but KeyPackageManager.list() emits it at runtime as `d`.
// keyPackageSlot reads BOTH. This guard is invisible to the type system, so a
// future "the fork is fixed now" simplification that drops the `d` fallback —
// or an upstream rename — would silently break device loading with no tsc
// error. These tests fail loudly if the dual-read or its precedence regresses.
describe("keyPackageSlot — dual-read slot resolution (fork runtime/type mismatch)", () => {
  it("returns the typed `identifier` field when present", () => {
    expect(keyPackageSlot({ identifier: "slot-A" })).toBe("slot-A");
  });

  it("falls back to the runtime `d` field when `identifier` is absent", () => {
    expect(keyPackageSlot({ d: "slot-D" })).toBe("slot-D");
  });

  it("prefers `identifier` over `d` when both are present", () => {
    // Precedence is load-bearing: once the fork ships the typed field, it must
    // win so we don't read a stale duplicate `d`.
    expect(keyPackageSlot({ identifier: "slot-A", d: "slot-D" })).toBe("slot-A");
  });

  it("treats an empty-string `identifier` as absent and falls back to `d`", () => {
    // The `length > 0` guard, not mere presence, gates the fallback.
    expect(keyPackageSlot({ identifier: "", d: "slot-D" })).toBe("slot-D");
  });

  it("returns undefined when neither field carries a non-empty string", () => {
    expect(keyPackageSlot({})).toBeUndefined();
    expect(keyPackageSlot({ identifier: "", d: "" })).toBeUndefined();
    expect(keyPackageSlot({ identifier: undefined, d: undefined })).toBeUndefined();
  });

  it("ignores non-string field values rather than coercing them", () => {
    // Defends the `typeof === "string"` guard: a numeric/object `d` must not
    // be returned as a slot id.
    expect(keyPackageSlot({ d: 123 as unknown as string })).toBeUndefined();
    expect(
      keyPackageSlot({ identifier: 0 as unknown as string, d: "slot-D" }),
    ).toBe("slot-D");
  });
});
