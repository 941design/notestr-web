/**
 * forget-device.test.ts
 *
 * Unit tests for forgetSelfDevice and forgetSiblingDevice.
 *
 * Coverage targets:
 *   AC-SELF-1..5, AC-SIBLING-1..3, AC-CLEANUP-1..4, AC-DELETE-1..3,
 *   AC-SIGNOUT-1..2, AC-UNIT-1..7
 *   Decision D3 (epoch-race retry wrapper)
 *   Q-ROBUSTNESS-1 (error propagation from removeLeafByIndex)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import of the tested module
// ---------------------------------------------------------------------------

vi.mock("@internet-privacy/marmot-ts", () => ({
  isAdmin: vi.fn(),
  // Return one member so the implementation enters the network.request branch.
  getGroupMembers: vi.fn(() => ["member-pubkey"]),
  getKeyPackage: vi.fn((event: { keyPackage: unknown }) => event.keyPackage),
  getKeyPackageIdentifier: vi.fn(
    (event: { _slot?: string }) => event._slot,
  ),
  keyPackageFilters: vi.fn(() => []),
}));

vi.mock("ts-mls", () => ({
  defaultKeyPackageEqualityConfig: {
    compareKeyPackageToLeafNode: vi.fn(
      (kp: { id: string }, leaf: { id: string }) => kp.id === leaf.id,
    ),
  },
  nodeTypes: { leaf: "leaf" },
}));

vi.mock("./per-leaf-remove", () => ({
  removeLeafByIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./forgotten-slots", () => ({
  markSlotForgotten: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./storage", () => ({
  clearIdentityStore: vi.fn().mockResolvedValue(undefined),
  invitedKeysStore: { clear: vi.fn().mockResolvedValue(undefined) },
  joinedGroupsStore: { clear: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../lib/nostr", () => ({
  clearNip46Session: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { isAdmin } from "@internet-privacy/marmot-ts";
import { removeLeafByIndex } from "./per-leaf-remove";
import { markSlotForgotten } from "./forgotten-slots";
import {
  clearIdentityStore,
  invitedKeysStore,
  joinedGroupsStore,
} from "./storage";
import { clearNip46Session } from "../lib/nostr";
import { forgetSelfDevice, forgetSiblingDevice } from "./forget-device";

// ---------------------------------------------------------------------------
// Helpers — build minimal mock objects
// ---------------------------------------------------------------------------

/**
 * Builds a ratchet tree node representing a leaf whose KP has the given id.
 * The node lives at nodeIndex; leaf index = floor(nodeIndex / 2).
 */
function makeLeafNode(id: string) {
  return { nodeType: "leaf" as const, leaf: { id } };
}

/**
 * Builds a minimal MarmotGroup mock for forgetSelfDevice tests.
 *
 * The ratchet tree contains one leaf node at nodeIndex 0 with the given kpId.
 * Leaf index = floor(0 / 2) = 0.
 */
function makeSelfGroup(kpId: string) {
  return {
    state: {
      ratchetTree: [makeLeafNode(kpId)],
    },
  } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;
}

/**
 * Builds a minimal MarmotGroup mock for forgetSiblingDevice tests.
 *
 * @param kpId - The id embedded in the leaf node (matched via compareKeyPackageToLeafNode).
 * @param adminResult - What isAdmin should return for this group's groupData.
 * @param slot - The slot string returned by getKeyPackageIdentifier for KP events in this group.
 */
function makeSiblingGroup(
  kpId: string,
  adminResult: boolean,
  slot: string,
) {
  return {
    groupData: { _adminResult: adminResult },
    state: {
      ratchetTree: [makeLeafNode(kpId)],
    },
    // Non-empty relays so the implementation enters the kpEvents fetch branch.
    relays: ["wss://relay.example"],
    network: {
      request: vi.fn().mockResolvedValue([
        // A fake KP event whose slot matches the target slot and whose kpId matches the leaf.
        { keyPackage: { id: kpId }, _slot: slot, id: "kp-event-1" },
      ]),
    },
  } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;
}

/**
 * Builds a minimal EventSigner mock.
 *
 * signEvent resolves to the unsigned event with a dummy sig appended.
 */
function makeSigner(pubkey = "test-pubkey") {
  return {
    getPublicKey: vi.fn().mockResolvedValue(pubkey),
    signEvent: vi.fn().mockImplementation(async (event: object) => ({
      ...event,
      sig: "dummy-sig",
      id: "signed-event-id",
    })),
  } as unknown as import("applesauce-core").EventSigner;
}

/**
 * Builds a minimal MarmotClient mock for forgetSelfDevice tests.
 *
 * @param groups - The MarmotGroup objects to populate client.groups.loaded.
 * @param keyPackages - What client.keyPackages.list() returns.
 */
function makeSelfClient(
  groups: ReturnType<typeof makeSelfGroup>[],
  keyPackages: Array<{
    publicPackage: { id: string } | null;
    published?: Array<{ id: string }>;
  }>,
) {
  return {
    groups: { loaded: groups },
    keyPackages: {
      list: vi.fn().mockResolvedValue(keyPackages),
    },
    network: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as import("@internet-privacy/marmot-ts").MarmotClient;
}

/**
 * Builds a minimal MarmotClient mock for forgetSiblingDevice tests.
 */
function makeSiblingClient(
  groups: ReturnType<typeof makeSiblingGroup>[],
) {
  return {
    groups: { loaded: groups },
  } as unknown as import("@internet-privacy/marmot-ts").MarmotClient;
}

// ---------------------------------------------------------------------------
// beforeEach — reset all mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// forgetSelfDevice tests
// ---------------------------------------------------------------------------

describe("forgetSelfDevice", () => {
  /**
   * Full happy-path: two groups each with one leaf matching our local KPs.
   *
   * AC-SELF-1, AC-SELF-2, AC-UNIT-1, AC-UNIT-2
   */
  it("calls removeLeafByIndex once per matching leaf across both groups (AC-SELF-1, AC-UNIT-2)", async () => {
    // Two groups, each with one leaf whose kpId matches a local key package.
    const group1 = makeSelfGroup("kp-a");
    const group2 = makeSelfGroup("kp-b");

    // Two local key packages — one per group leaf.
    const client = makeSelfClient([group1, group2], [
      { publicPackage: { id: "kp-a" }, published: [] },
      { publicPackage: { id: "kp-b" }, published: [] },
    ]);

    const signer = makeSigner();
    const onSignOut = vi.fn();

    await forgetSelfDevice(client, signer, ["wss://relay.example"], onSignOut);

    // One removeLeafByIndex call per group (leaf index 0 for each).
    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(1, group1, 0);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(2, group2, 0);
  });

  /**
   * A group whose ratchet tree contains two matching leaves:
   * both must be removed sequentially.
   *
   * AC-SELF-1, AC-SELF-2
   */
  it("removes all matching leaves in a single group sequentially", async () => {
    // Group with two leaf nodes at nodeIndex 0 and 2 → leaf indexes 0 and 1.
    const group = {
      state: {
        ratchetTree: [
          { nodeType: "leaf", leaf: { id: "kp-multi" } },
          null,
          { nodeType: "leaf", leaf: { id: "kp-multi" } },
        ],
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-multi" }, published: [] },
    ]);
    const signer = makeSigner();
    const onSignOut = vi.fn();

    await forgetSelfDevice(client, signer, [], onSignOut);

    // Two leaves matched → two sequential removeLeafByIndex calls.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(1, group, 0);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(2, group, 1);
  });

  /**
   * Kind-5 events are published once per published KP entry (not per unpublished).
   *
   * AC-SELF-3, AC-DELETE-1, AC-DELETE-2, AC-DELETE-3, AC-UNIT-3
   */
  it("publishes one kind-5 per published KP event id and skips unpublished entries (AC-SELF-3, AC-DELETE-3, AC-UNIT-3)", async () => {
    const group = makeSelfGroup("kp-x");
    const client = makeSelfClient([group], [
      {
        publicPackage: { id: "kp-x" },
        published: [{ id: "event-id-123" }],
      },
      {
        publicPackage: { id: "kp-y" },
        published: [], // No published entries — no kind-5 for this one.
      },
    ]);

    const signer = makeSigner("user-pubkey");
    const relays = ["wss://relay.example"];
    const onSignOut = vi.fn();

    await forgetSelfDevice(client, signer, relays, onSignOut);

    // Exactly one publish: for "event-id-123".
    expect(client.network.publish).toHaveBeenCalledTimes(1);

    const publishedEvent = (client.network.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];

    // AC-DELETE-2: kind-5, correct e-tag, correct pubkey.
    expect(publishedEvent.kind).toBe(5);
    expect(publishedEvent.tags).toContainEqual(["e", "event-id-123"]);
    expect(publishedEvent.content).toBe("");
    expect(publishedEvent.pubkey).toBe("user-pubkey");

    // AC-DELETE-1: published to the correct relays.
    const publishRelays = (client.network.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(publishRelays).toEqual(relays);
  });

  /**
   * Multiple published entries in one KP each get their own kind-5.
   *
   * AC-DELETE-3
   */
  it("publishes one kind-5 per published entry (multiple entries per KP)", async () => {
    const group = makeSelfGroup("kp-z");
    const client = makeSelfClient([group], [
      {
        publicPackage: { id: "kp-z" },
        published: [{ id: "ev-1" }, { id: "ev-2" }],
      },
    ]);

    await forgetSelfDevice(client, makeSigner(), [], vi.fn());

    expect(client.network.publish).toHaveBeenCalledTimes(2);
    const call1 = (client.network.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const call2 = (client.network.publish as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(call1.tags).toContainEqual(["e", "ev-1"]);
    expect(call2.tags).toContainEqual(["e", "ev-2"]);
  });

  /**
   * clearNip46Session() is called exactly once.
   *
   * AC-SELF-4, AC-CLEANUP-3, AC-UNIT-4
   */
  it("calls clearNip46Session() exactly once (AC-SELF-4, AC-CLEANUP-3, AC-UNIT-4)", async () => {
    const client = makeSelfClient([], []);
    await forgetSelfDevice(client, makeSigner(), [], vi.fn());

    expect(clearNip46Session).toHaveBeenCalledTimes(1);
  });

  /**
   * onSignOut callback is invoked after cleanup.
   *
   * AC-SELF-5, AC-SIGNOUT-1, AC-UNIT-5
   */
  it("calls onSignOut() exactly once after cleanup (AC-SELF-5, AC-SIGNOUT-1, AC-UNIT-5)", async () => {
    const client = makeSelfClient([], []);
    const onSignOut = vi.fn();

    await forgetSelfDevice(client, makeSigner(), [], onSignOut);

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  /**
   * IDB cleanup: clearIdentityStore, invitedKeysStore.clear, joinedGroupsStore.clear.
   *
   * AC-CLEANUP-1, AC-CLEANUP-4
   */
  it("clears identity store and invited/joined stores (AC-CLEANUP-1, AC-CLEANUP-4)", async () => {
    const client = makeSelfClient([], []);
    await forgetSelfDevice(client, makeSigner(), [], vi.fn());

    expect(clearIdentityStore).toHaveBeenCalledTimes(1);
    expect(invitedKeysStore.clear).toHaveBeenCalledTimes(1);
    expect(joinedGroupsStore.clear).toHaveBeenCalledTimes(1);
  });

  /**
   * IDB cleanup: indexedDB.deleteDatabase called with the three stable names.
   *
   * AC-CLEANUP-2 (D1: indexedDB.deleteDatabase by stable name)
   */
  it("deletes notestr-key-packages, notestr-group-state, notestr-invite-store via indexedDB.deleteDatabase (AC-CLEANUP-2, D1)", async () => {
    const mockDeleteDatabase = vi.fn().mockReturnValue({});
    vi.stubGlobal("indexedDB", { deleteDatabase: mockDeleteDatabase });

    const client = makeSelfClient([], []);
    await forgetSelfDevice(client, makeSigner(), [], vi.fn());

    expect(mockDeleteDatabase).toHaveBeenCalledWith("notestr-key-packages");
    expect(mockDeleteDatabase).toHaveBeenCalledWith("notestr-group-state");
    expect(mockDeleteDatabase).toHaveBeenCalledWith("notestr-invite-store");

    vi.unstubAllGlobals();
  });

  /**
   * Step ordering: leaf removal → kind-5 publish → IDB cleanup → onSignOut.
   *
   * AC-SELF-1, AC-CLEANUP-*, AC-SIGNOUT-1
   */
  it("enforces step order: leaf removal before kind-5, IDB cleanup after kind-5, onSignOut last", async () => {
    const callOrder: string[] = [];

    vi.mocked(removeLeafByIndex).mockImplementation(async () => {
      callOrder.push("removeLeaf");
    });

    const group = makeSelfGroup("kp-order");
    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-order" }, published: [{ id: "ev-order" }] },
    ]);

    vi.mocked(client.network.publish).mockImplementation(async () => {
      callOrder.push("publish");
    });
    vi.mocked(clearIdentityStore).mockImplementation(async () => {
      callOrder.push("clearIdentity");
    });
    vi.mocked(invitedKeysStore.clear).mockImplementation(async () => {
      callOrder.push("clearInvited");
    });
    vi.mocked(joinedGroupsStore.clear).mockImplementation(async () => {
      callOrder.push("clearJoined");
    });
    vi.mocked(clearNip46Session).mockImplementation(() => {
      callOrder.push("clearNip46");
    });

    const onSignOut = vi.fn(() => { callOrder.push("onSignOut"); });

    await forgetSelfDevice(client, makeSigner(), [], onSignOut);

    // Leaf removal must precede kind-5 publish.
    expect(callOrder.indexOf("removeLeaf")).toBeLessThan(callOrder.indexOf("publish"));
    // IDB cleanup must follow kind-5 publish.
    expect(callOrder.indexOf("publish")).toBeLessThan(callOrder.indexOf("clearIdentity"));
    // onSignOut must be last.
    expect(callOrder.indexOf("clearNip46")).toBeLessThan(callOrder.indexOf("onSignOut"));
    expect(callOrder.lastIndexOf("onSignOut")).toBe(callOrder.length - 1);
  });

  /**
   * Error propagation: if removeLeafByIndex throws (non-epoch), the error
   * bubbles out of forgetSelfDevice without proceeding to cleanup.
   *
   * Q-ROBUSTNESS-1
   */
  it("propagates a non-epoch error from removeLeafByIndex without cleanup (Q-ROBUSTNESS-1)", async () => {
    vi.mocked(removeLeafByIndex).mockRejectedValueOnce(new Error("network failure"));

    const group = makeSelfGroup("kp-fail");
    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-fail" }, published: [] },
    ]);
    const onSignOut = vi.fn();

    await expect(
      forgetSelfDevice(client, makeSigner(), [], onSignOut),
    ).rejects.toThrow("network failure");

    // Cleanup steps must NOT have run.
    expect(onSignOut).not.toHaveBeenCalled();
    expect(clearNip46Session).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Epoch-race retry wrapper (D3) — tests via forgetSelfDevice's leaf removal
// ---------------------------------------------------------------------------

describe("removeLeafWithRetry (D3 — epoch-race wrapper)", () => {
  /**
   * If removeLeafByIndex throws an epoch error on the first call, the wrapper
   * retries once and succeeds.
   */
  it("retries once on an epoch error and succeeds (D3)", async () => {
    vi.mocked(removeLeafByIndex)
      .mockRejectedValueOnce(new Error("stale epoch detected"))
      .mockResolvedValueOnce(undefined);

    const group = makeSelfGroup("kp-epoch");
    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-epoch" }, published: [] },
    ]);
    const onSignOut = vi.fn();

    // Should not throw — second attempt succeeds.
    await expect(
      forgetSelfDevice(client, makeSigner(), [], onSignOut),
    ).resolves.toBeUndefined();

    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  /**
   * If removeLeafByIndex throws an epoch error on both attempts, the wrapper
   * bubbles the second error to the caller.
   */
  it("bubbles the error when both attempts fail with an epoch error (D3)", async () => {
    const epochErr = new Error("epoch mismatch");
    vi.mocked(removeLeafByIndex)
      .mockRejectedValueOnce(epochErr)
      .mockRejectedValueOnce(epochErr);

    const group = makeSelfGroup("kp-epoch-fail");
    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-epoch-fail" }, published: [] },
    ]);

    await expect(
      forgetSelfDevice(client, makeSigner(), [], vi.fn()),
    ).rejects.toThrow("epoch mismatch");

    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
  });

  /**
   * If removeLeafByIndex throws a non-epoch error, the wrapper bubbles
   * immediately — no retry attempted.
   */
  it("does not retry on a non-epoch error — bubbles immediately (D3)", async () => {
    vi.mocked(removeLeafByIndex).mockRejectedValueOnce(new Error("fatal error"));

    const group = makeSelfGroup("kp-noe");
    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-noe" }, published: [] },
    ]);

    await expect(
      forgetSelfDevice(client, makeSigner(), [], vi.fn()),
    ).rejects.toThrow("fatal error");

    // No retry — called exactly once.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// forgetSiblingDevice tests
// ---------------------------------------------------------------------------

describe("forgetSiblingDevice", () => {
  /**
   * Happy path: one admin group with one matching leaf.
   *
   * AC-SIBLING-2, AC-SIBLING-3, AC-UNIT-6, AC-UNIT-7
   */
  it("removes matching leaves in admin groups and calls markSlotForgotten (AC-SIBLING-2/3, AC-UNIT-7)", async () => {
    const adminGroup = makeSiblingGroup("sibling-kp", true, "target-slot");

    vi.mocked(isAdmin).mockReturnValue(true);

    const client = makeSiblingClient([adminGroup]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    // One leaf matched in the admin group → one removeLeafByIndex call.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
    expect(removeLeafByIndex).toHaveBeenCalledWith(adminGroup, 0);

    // markSlotForgotten called with the target slot after all removals.
    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });

  /**
   * Skips groups where isAdmin returns false.
   *
   * AC-SIBLING-1, AC-UNIT-6
   */
  it("skips groups where isAdmin returns false and only processes admin groups (AC-SIBLING-1, AC-UNIT-6)", async () => {
    const adminGroup = makeSiblingGroup("admin-kp", true, "target-slot");
    const nonAdminGroup = makeSiblingGroup("nonadmin-kp", false, "target-slot");

    vi.mocked(isAdmin).mockImplementation(
      (gd: { _adminResult: boolean }) => gd._adminResult,
    );

    const client = makeSiblingClient([adminGroup, nonAdminGroup]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    // Only the admin group should have removeLeafByIndex called.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
    expect(removeLeafByIndex).toHaveBeenCalledWith(adminGroup, 0);

    // markSlotForgotten still called once.
    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });

  /**
   * Skips groups where groupData is null.
   *
   * AC-SIBLING-1
   */
  it("skips groups where groupData is null (AC-SIBLING-1)", async () => {
    const nullGroupDataGroup = {
      groupData: null,
      state: { ratchetTree: [{ nodeType: "leaf", leaf: { id: "kp-null" } }] },
      relays: [],
      network: { request: vi.fn() },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([nullGroupDataGroup]);

    await forgetSiblingDevice(client, "local-pubkey", "any-slot");

    expect(removeLeafByIndex).not.toHaveBeenCalled();
    // markSlotForgotten is still called (after the loop).
    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
  });

  /**
   * markSlotForgotten is called exactly once even when no admin groups match.
   *
   * AC-SIBLING-3
   */
  it("calls markSlotForgotten even when no groups qualify (AC-SIBLING-3)", async () => {
    vi.mocked(isAdmin).mockReturnValue(false);

    const nonAdminGroup = makeSiblingGroup("kp-x", false, "target-slot");
    const client = makeSiblingClient([nonAdminGroup]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    expect(removeLeafByIndex).not.toHaveBeenCalled();
    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });

  /**
   * Groups with no matching slot in their KP events are skipped.
   *
   * AC-SIBLING-2 (only matching leaves)
   */
  it("skips groups where no KP events match the target slot (AC-SIBLING-2)", async () => {
    // Make the group's network.request return events with a different slot.
    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: [{ nodeType: "leaf", leaf: { id: "other-kp" } }] },
      relays: ["wss://r"],
      network: {
        request: vi.fn().mockResolvedValue([
          { keyPackage: { id: "other-kp" }, _slot: "different-slot", id: "ev-1" },
        ]),
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    vi.mocked(isAdmin).mockReturnValue(true);

    const client = makeSiblingClient([group]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    // No matching slot → no removeLeafByIndex calls.
    expect(removeLeafByIndex).not.toHaveBeenCalled();
    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });

  /**
   * Multiple admin groups each with one matching leaf:
   * removeLeafByIndex is called once per qualifying group (sequentially).
   *
   * AC-SIBLING-2, Q-SPEC-6
   */
  it("calls removeLeafByIndex for matching leaves in each admin group (AC-SIBLING-2)", async () => {
    const group1 = makeSiblingGroup("sibling-kp-1", true, "target-slot");
    const group2 = makeSiblingGroup("sibling-kp-2", true, "target-slot");

    vi.mocked(isAdmin).mockReturnValue(true);

    const client = makeSiblingClient([group1, group2]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(1, group1, 0);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(2, group2, 0);

    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });
});
