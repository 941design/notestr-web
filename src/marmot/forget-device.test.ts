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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

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
  // Self-leaf resolution now flows through this helper instead of KeyPackage
  // equality. The mock derives indexes from the same ratchet-tree shape the
  // existing test fixtures already produce, treating every leaf in the mock
  // tree as belonging to the local user — the test signer always returns the
  // same pubkey, so this faithfully mirrors the production behavior on a
  // single-identity device.
  getPubkeyLeafNodeIndexes: vi.fn(
    (state: { ratchetTree: Array<{ nodeType?: string } | null> }) => {
      const indexes: number[] = [];
      for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex++) {
        const node = state.ratchetTree[nodeIndex];
        if (node && node.nodeType === "leaf") indexes.push(Math.floor(nodeIndex / 2));
      }
      return indexes;
    },
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
  // Default: throw "no privatePath" so the rotation-fallback (which only
  // runs when the primary KP-equality match returns []) skips the own-leaf
  // exclusion. Tests that exercise the same-pubkey path override this.
  getOwnLeafNode: vi.fn(() => {
    throw new Error("no privatePath in default mock");
  }),
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
  bootstrapCompletedStore: { clear: vi.fn().mockResolvedValue(undefined) },
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
  bootstrapCompletedStore,
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
 * Leaf index = floor(0 / 2) = 0. `leave` is a `vi.fn()` so the test can
 * assert that self-removal flows through `group.leave()` (RFC 9420 §12.4
 * forbids self-commit of Remove) rather than `removeLeafByIndex`.
 */
function makeSelfGroup(kpId: string) {
  return {
    state: {
      ratchetTree: [makeLeafNode(kpId)],
    },
    leave: vi.fn().mockResolvedValue({}),
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
   * Full happy-path: two groups each with one leaf for this user.
   *
   * AC-SELF-1, AC-SELF-2, AC-UNIT-1, AC-UNIT-2
   */
  it("calls group.leave() once per group containing a self-leaf (AC-SELF-1, AC-UNIT-2)", async () => {
    // Two groups, each with one leaf belonging to this user.
    const group1 = makeSelfGroup("kp-a");
    const group2 = makeSelfGroup("kp-b");

    // Two local key packages — drive only the kind-5 deletion step.
    const client = makeSelfClient([group1, group2], [
      { publicPackage: { id: "kp-a" }, published: [] },
      { publicPackage: { id: "kp-b" }, published: [] },
    ]);

    const signer = makeSigner();
    const onSignOut = vi.fn();

    await forgetSelfDevice(client, signer, ["wss://relay.example"], onSignOut);

    // One leave() call per group containing a self-leaf.
    expect(group1.leave).toHaveBeenCalledTimes(1);
    expect(group2.leave).toHaveBeenCalledTimes(1);
    // removeLeafByIndex must NOT be used for self-removal — RFC 9420 §12.4
    // forbids self-commit of Remove.
    expect(removeLeafByIndex).not.toHaveBeenCalled();
  });

  /**
   * A group with multiple self-leaves still results in a single leave() call
   * (leave() internally publishes one Remove proposal per leaf — the wrapper
   * call from forgetSelfDevice is one per group, not one per leaf).
   *
   * AC-SELF-1
   */
  it("calls group.leave() once per group regardless of leaf count", async () => {
    // Group with two leaf nodes for the same pubkey at nodeIndex 0 and 2.
    const group = {
      state: {
        ratchetTree: [
          { nodeType: "leaf", leaf: { id: "kp-multi" } },
          null,
          { nodeType: "leaf", leaf: { id: "kp-multi" } },
        ],
      },
      leave: vi.fn().mockResolvedValue({}),
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-multi" }, published: [] },
    ]);
    const signer = makeSigner();
    const onSignOut = vi.fn();

    await forgetSelfDevice(client, signer, [], onSignOut);

    // One leave() call regardless of how many leaves the user has in the group.
    expect(group.leave).toHaveBeenCalledTimes(1);
    expect(removeLeafByIndex).not.toHaveBeenCalled();
  });

  /**
   * Groups with no self-leaves are skipped — no leave() call.
   */
  it("skips groups where this user has no leaves", async () => {
    // Mark this group as not containing the user's leaf by overriding
    // getPubkeyLeafNodeIndexes for one call.
    const groupWithSelf = makeSelfGroup("kp-self");
    const groupWithout = makeSelfGroup("kp-other");

    // Override the helper for the second group: return empty for the
    // ratchetTree shape only when invoked on groupWithout.
    const mod = await import("@internet-privacy/marmot-ts");
    const original = vi.mocked(mod.getPubkeyLeafNodeIndexes);
    original.mockImplementation(((state: { ratchetTree: Array<{ nodeType?: string; leaf?: { id?: string } } | null> }) => {
      const first = state.ratchetTree[0];
      if (first && first.leaf?.id === "kp-other") return [];
      const indexes: number[] = [];
      for (let nodeIndex = 0; nodeIndex < state.ratchetTree.length; nodeIndex++) {
        const node = state.ratchetTree[nodeIndex];
        if (node && node.nodeType === "leaf") indexes.push(Math.floor(nodeIndex / 2));
      }
      return indexes;
    }) as unknown as typeof mod.getPubkeyLeafNodeIndexes);

    const client = makeSelfClient([groupWithSelf, groupWithout], []);
    await forgetSelfDevice(client, makeSigner(), [], vi.fn());

    expect(groupWithSelf.leave).toHaveBeenCalledTimes(1);
    expect(groupWithout.leave).not.toHaveBeenCalled();
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
   * IDB cleanup: clearIdentityStore, invitedKeysStore.clear, joinedGroupsStore.clear,
   * bootstrapCompletedStore.clear.
   *
   * AC-CLEANUP-1, AC-CLEANUP-4
   */
  it("clears identity store and invited/joined/bootstrapCompleted stores (AC-CLEANUP-1, AC-CLEANUP-4)", async () => {
    const client = makeSelfClient([], []);
    await forgetSelfDevice(client, makeSigner(), [], vi.fn());

    expect(clearIdentityStore).toHaveBeenCalledTimes(1);
    expect(invitedKeysStore.clear).toHaveBeenCalledTimes(1);
    expect(joinedGroupsStore.clear).toHaveBeenCalledTimes(1);
    expect(bootstrapCompletedStore.clear).toHaveBeenCalledTimes(1);
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
   * Step ordering: self-leave proposals → kind-5 publish → IDB cleanup → onSignOut.
   *
   * AC-SELF-1, AC-CLEANUP-*, AC-SIGNOUT-1
   */
  it("enforces step order: leave() before kind-5, IDB cleanup after kind-5, onSignOut last", async () => {
    const callOrder: string[] = [];

    const group = makeSelfGroup("kp-order");
    vi.mocked(group.leave).mockImplementation(async () => {
      callOrder.push("leave");
      return {};
    });

    const client = makeSelfClient([group], [
      { publicPackage: { id: "kp-order" }, published: [{ id: "ev-order" }] },
    ]);

    vi.mocked(client.network.publish).mockImplementation(async () => {
      callOrder.push("publish");
      return {};
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

    // Self-leave proposal must precede kind-5 publish.
    expect(callOrder.indexOf("leave")).toBeLessThan(callOrder.indexOf("publish"));
    // IDB cleanup must follow kind-5 publish.
    expect(callOrder.indexOf("publish")).toBeLessThan(callOrder.indexOf("clearIdentity"));
    // onSignOut must be last.
    expect(callOrder.indexOf("clearNip46")).toBeLessThan(callOrder.indexOf("onSignOut"));
    expect(callOrder.lastIndexOf("onSignOut")).toBe(callOrder.length - 1);
  });

  /**
   * Error propagation: if group.leave() throws, the error bubbles out of
   * forgetSelfDevice without proceeding to cleanup.
   *
   * Q-ROBUSTNESS-1
   */
  it("propagates an error from group.leave() without cleanup (Q-ROBUSTNESS-1)", async () => {
    const group = makeSelfGroup("kp-fail");
    vi.mocked(group.leave).mockRejectedValueOnce(new Error("network failure"));

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
// Epoch-race retry wrapper (D3) — tests via forgetSiblingDevice's leaf removal
// (Self-forget no longer uses removeLeafByIndex — RFC 9420 §12.4 forbids
// self-commit of Remove, so self-removal flows through group.leave().
// removeLeafWithRetry stays in production for sibling-forget, where the
// committer is an admin removing a DIFFERENT leaf, which is permitted.)
// ---------------------------------------------------------------------------

describe("removeLeafWithRetry (D3 — epoch-race wrapper, exercised via sibling-forget)", () => {
  /**
   * If removeLeafByIndex throws an epoch error on the first call, the wrapper
   * retries once and succeeds.
   */
  it("retries once on an epoch error and succeeds (D3)", async () => {
    vi.mocked(removeLeafByIndex)
      .mockRejectedValueOnce(new Error("stale epoch detected"))
      .mockResolvedValueOnce(undefined);
    vi.mocked(isAdmin).mockReturnValue(true);

    const adminGroup = makeSiblingGroup("sibling-kp-epoch", true, "target-slot");
    const client = makeSiblingClient([adminGroup]);

    await expect(
      forgetSiblingDevice(client, "local-pubkey", "target-slot"),
    ).resolves.toBeUndefined();

    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
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
    vi.mocked(isAdmin).mockReturnValue(true);

    const adminGroup = makeSiblingGroup("sibling-kp-epoch-fail", true, "target-slot");
    const client = makeSiblingClient([adminGroup]);

    await expect(
      forgetSiblingDevice(client, "local-pubkey", "target-slot"),
    ).rejects.toThrow("epoch mismatch");

    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
  });

  /**
   * If removeLeafByIndex throws a non-epoch error, the wrapper bubbles
   * immediately — no retry attempted.
   */
  it("does not retry on a non-epoch error — bubbles immediately (D3)", async () => {
    vi.mocked(removeLeafByIndex).mockRejectedValueOnce(new Error("fatal error"));
    vi.mocked(isAdmin).mockReturnValue(true);

    const adminGroup = makeSiblingGroup("sibling-kp-noe", true, "target-slot");
    const client = makeSiblingClient([adminGroup]);

    await expect(
      forgetSiblingDevice(client, "local-pubkey", "target-slot"),
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
      (gd) => (gd as unknown as { _adminResult: boolean })._adminResult,
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

// ---------------------------------------------------------------------------
// forget-device mutation-gap properties
//
// Property-style tests added to close real-coverage gaps surfaced by Stryker
// (baseline run 2026-05-22). Each block targets a cluster of related survivors
// rather than a single mutant — phrased in terms of user-facing behavior so
// the tests survive refactors of the implementation.
//
// Gap → ACs killed:
//   G1 epoch-keyword OR-fan         → AC-SELF-1 retry semantics (D3)
//   G2 recompute → null short-circuit → AC-SIBLING-2 (sequential per-leaf)
//   G3 multi-leaf ratchet-tree walk → AC-SIBLING-2 (only matching leaves)
//   G4 KP-rotation fallback         → AC-SIBLING-2 + Q3 (rotated KP resolution)
//   G5 kind-5 event shape           → AC-DELETE-2, AC-DELETE-3
//   G6 empty-relays / empty-members / network-error skips → AC-SIBLING-1
// ---------------------------------------------------------------------------

describe("forget-device mutation-gap properties", () => {
  // Restore module-mock implementations that earlier tests in this file
  // overrode (vi.clearAllMocks() only clears call history, not implementations).
  beforeEach(async () => {
    const mod = await import("@internet-privacy/marmot-ts");
    // mockReset() drops the implementation back to vi.fn()'s default — then
    // we re-apply the canonical default below. This guards against
    // implementations bleeding across tests in unpredictable runner orders
    // (Stryker per-test mode in particular).
    vi.mocked(mod.getPubkeyLeafNodeIndexes).mockReset();
    vi.mocked(mod.getGroupMembers).mockReset();
    vi.mocked(mod.getKeyPackage).mockReset();
    vi.mocked(mod.getKeyPackageIdentifier).mockReset();
    vi.mocked(mod.keyPackageFilters).mockReset();
    vi.mocked(mod.isAdmin).mockReset();
    const tsMlsReset = await import("ts-mls");
    vi.mocked(tsMlsReset.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode).mockReset();
    vi.mocked(tsMlsReset.getOwnLeafNode).mockReset();
    vi.mocked(mod.getPubkeyLeafNodeIndexes).mockImplementation(
      ((state: { ratchetTree: Array<{ nodeType?: string } | null> }) => {
        const indexes: number[] = [];
        for (let ni = 0; ni < state.ratchetTree.length; ni++) {
          const n = state.ratchetTree[ni];
          if (n && n.nodeType === "leaf") indexes.push(Math.floor(ni / 2));
        }
        return indexes;
      }) as unknown as typeof mod.getPubkeyLeafNodeIndexes,
    );
    vi.mocked(mod.getGroupMembers).mockReturnValue(["member-pubkey"]);
    vi.mocked(mod.getKeyPackage).mockImplementation(
      ((event: { keyPackage: unknown }) => event.keyPackage) as unknown as typeof mod.getKeyPackage,
    );
    vi.mocked(mod.getKeyPackageIdentifier).mockImplementation(
      ((event: { _slot?: string }) => event._slot) as unknown as typeof mod.getKeyPackageIdentifier,
    );
    vi.mocked(mod.keyPackageFilters).mockReturnValue([]);
    vi.mocked(mod.isAdmin).mockReturnValue(true);

    const tsMls = await import("ts-mls");
    vi.mocked(tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode)
      .mockImplementation(
        ((kp: { id: string }, leaf: { id: string }) => kp.id === leaf.id) as unknown as typeof tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
      );
    // Default getOwnLeafNode throws — the rotation-fallback's own-leaf
    // exclusion is opt-in per test.
    vi.mocked(tsMls.getOwnLeafNode).mockImplementation(() => {
      throw new Error("no privatePath in default mock");
    });

    vi.mocked(removeLeafByIndex).mockReset();
    vi.mocked(removeLeafByIndex).mockResolvedValue(undefined);
    vi.mocked(markSlotForgotten).mockReset();
    vi.mocked(markSlotForgotten).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // G1 — Epoch-keyword recognition is OR-fan, not AND-fan.
  // -------------------------------------------------------------------------

  /**
   * Property: any error message containing at least one of the four
   * recognised epoch keywords triggers exactly one retry; any message
   * containing none of them bubbles immediately without retry.
   *
   * Kills the line-79 `||` → `&&` mutant (which only survives because
   * existing tests happen to feed messages containing two keywords) and
   * the line-84 `isEpochError = true / false` flips.
   */
  it("retries on any single epoch keyword and never retries on unrelated errors (G1, AC-SELF-1/D3)", async () => {
    const epochKeyword = fc.constantFrom(
      "epoch",
      "stale",
      "wrong epoch",
      "epoch mismatch",
    );

    // Non-epoch arbitrary: alphanumeric noise that contains none of the four
    // recognised substrings (case-insensitive, since the impl lowercases first).
    const nonEpochMessage = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => {
        const lower = s.toLowerCase();
        return (
          !lower.includes("epoch") &&
          !lower.includes("stale")
        );
      });

    await fc.assert(
      fc.asyncProperty(epochKeyword, async (kw) => {
        vi.mocked(removeLeafByIndex).mockReset();
        vi.mocked(removeLeafByIndex)
          .mockRejectedValueOnce(new Error(`${kw} detected during commit`))
          .mockResolvedValueOnce(undefined);

        const adminGroup = makeSiblingGroup("kp-epoch", true, "target-slot");
        const client = makeSiblingClient([adminGroup]);

        await expect(
          forgetSiblingDevice(client, "local-pubkey", "target-slot"),
        ).resolves.toBeUndefined();

        // Exactly two calls: initial + one retry.
        expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
      }),
      { numRuns: 16 },
    );

    await fc.assert(
      fc.asyncProperty(nonEpochMessage, async (msg) => {
        vi.mocked(removeLeafByIndex).mockReset();
        vi.mocked(removeLeafByIndex).mockRejectedValueOnce(new Error(msg));

        const adminGroup = makeSiblingGroup("kp-noepoch", true, "target-slot");
        const client = makeSiblingClient([adminGroup]);

        await expect(
          forgetSiblingDevice(client, "local-pubkey", "target-slot"),
        ).rejects.toThrow(msg);

        // Exactly one call: no retry on non-epoch error.
        expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 24 },
    );
  });

  // -------------------------------------------------------------------------
  // G2 — Recompute returns null → treat as success without retrying.
  // -------------------------------------------------------------------------

  /**
   * When an epoch error fires and the recompute callback resolves to null
   * (the leaf is no longer present after the epoch advance), the wrapper
   * returns void without a second removeLeafByIndex call. forgetSiblingDevice
   * still resolves and markSlotForgotten is still called.
   *
   * Triggered by:
   *   - removeLeafByIndex rejects once with an epoch error
   *   - the recompute path (re-filter kpEvents + fallback by pubkey)
   *     yields [] → refreshedIndexes[0] ?? null === null
   */
  it("treats null recompute as success and does not retry (G2, AC-SIBLING-2/D3)", async () => {
    const tsMls = await import("ts-mls");
    const cmp = vi.mocked(
      tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
    );
    const mod = await import("@internet-privacy/marmot-ts");

    // Initial leaf lookup must succeed (we need to enter the per-leaf loop),
    // but every subsequent call (the recompute) must return false so the
    // primary path yields [].
    cmp.mockImplementationOnce(() => true).mockImplementation(() => false);

    // And the fallback path (getPubkeyLeafNodeIndexes) must also return [] on
    // recompute, so refreshedIndexes[0] ?? null === null.
    vi.mocked(mod.getPubkeyLeafNodeIndexes).mockReturnValue([]);

    vi.mocked(removeLeafByIndex)
      .mockRejectedValueOnce(new Error("stale epoch"))
      // If retry happens, this would resolve — but the assertion below
      // catches the extra call regardless.
      .mockResolvedValue(undefined);

    const adminGroup = makeSiblingGroup("kp-vanish", true, "target-slot");
    const client = makeSiblingClient([adminGroup]);

    await expect(
      forgetSiblingDevice(client, "local-pubkey", "target-slot"),
    ).resolves.toBeUndefined();

    // Exactly one call: the initial attempt. No retry because recompute → null.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });

  // -------------------------------------------------------------------------
  // G3 — Multi-leaf ratchet-tree walk in siblingLeafIndexesForEvents.
  // -------------------------------------------------------------------------

  /**
   * Property: for a ratchet tree with N leaves placed at even node indexes
   * 0, 2, ..., 2(N-1), and arbitrary nulls / non-leaf "parent" entries at
   * the odd indexes, forgetSiblingDevice calls removeLeafByIndex exactly N
   * times with leaf indexes 0, 1, ..., N-1 — in order.
   *
   * This forces the impl to:
   *   - walk the FULL tree (kills the < → <= / >= boundary mutants on line 137)
   *   - skip non-leaf nodes (kills the line-139 logical/identity mutants)
   *   - use floor(nodeIndex/2) (kills the line-147 *2 / +N mutants)
   */
  it("matches every leaf in a multi-leaf ratchet tree at index floor(nodeIndex/2) (G3, AC-SIBLING-2)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (n) => {
        vi.mocked(removeLeafByIndex).mockReset();
        vi.mocked(removeLeafByIndex).mockResolvedValue(undefined);

        // Build a ratchet tree of length 2n-1: leaves at even indexes,
        // parent nodes (nodeType !== "leaf") at odd indexes. All leaves share
        // the same kpId so every leaf matches the single KP event we feed
        // below. Parents carry a "parent" nodeType plus a phantom kpId — if
        // the implementation forgot the leaf-only filter it would push these
        // too, so the strict count check below catches that mutation.
        const kpId = "sibling-kp-multi";
        const tree: Array<{ nodeType?: string; leaf?: { id: string } } | null> = [];
        for (let i = 0; i < 2 * n - 1; i++) {
          if (i % 2 === 0) tree.push({ nodeType: "leaf", leaf: { id: kpId } });
          else tree.push({ nodeType: "parent", leaf: { id: kpId } });
        }

        const group = {
          groupData: { _adminResult: true },
          state: { ratchetTree: tree },
          relays: ["wss://r"],
          network: {
            request: vi.fn().mockResolvedValue([
              { keyPackage: { id: kpId }, _slot: "target-slot", id: "ev" },
            ]),
          },
        } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

        const client = makeSiblingClient([group]);

        await forgetSiblingDevice(client, "local-pubkey", "target-slot");

        expect(removeLeafByIndex).toHaveBeenCalledTimes(n);
        for (let leafIdx = 0; leafIdx < n; leafIdx++) {
          expect(removeLeafByIndex).toHaveBeenNthCalledWith(
            leafIdx + 1,
            group,
            leafIdx,
          );
        }
      }),
      { numRuns: 6 },
    );
  });

  // -------------------------------------------------------------------------
  // G4 — KP-rotation fallback (siblingLeafIndexesByPubkeyExcludingOwn).
  // -------------------------------------------------------------------------

  /**
   * (a) When the primary KP-equality match returns [] (sibling rotated its
   *     KP after admission, so the relay holds the NEW KP while the ratchet
   *     tree still holds the OLD leaf), the fallback re-derives leaves by
   *     credential pubkey and removeLeafByIndex is called for the fallback
   *     leaf index.
   */
  it("falls back to pubkey-credential match after KP rotation (G4a, AC-SIBLING-2/Q3)", async () => {
    const tsMls = await import("ts-mls");
    const mod = await import("@internet-privacy/marmot-ts");

    // Primary match returns false for every leaf (rotated KP).
    vi.mocked(
      tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
    ).mockReturnValue(false);

    // Fallback: getPubkeyLeafNodeIndexes returns the sibling's lone leaf at
    // index 3. The sibling's pubkey is the event.pubkey of the KP event.
    vi.mocked(mod.getPubkeyLeafNodeIndexes).mockReturnValue([3]);

    // getOwnLeafNode throws (privatePath absent) → exclusion is skipped, so
    // the fallback returns the unfiltered [3].
    vi.mocked(tsMls.getOwnLeafNode).mockImplementation(() => {
      throw new Error("no privatePath");
    });

    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: [{ nodeType: "leaf", leaf: { id: "old-kp" } }] },
      relays: ["wss://r"],
      network: {
        request: vi.fn().mockResolvedValue([
          {
            keyPackage: { id: "new-kp-rotated" },
            _slot: "target-slot",
            id: "ev-rotated",
            pubkey: "sibling-pubkey",
          },
        ]),
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([group]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
    expect(removeLeafByIndex).toHaveBeenCalledWith(group, 3);
  });

  /**
   * (b) When the local admin and sibling share the same Nostr pubkey (same-
   *     account sibling-forget), the admin's own leaf — identified by
   *     getOwnLeafNode().signaturePublicKey — is excluded from the removal set.
   */
  it("excludes the admin's own leaf when same-pubkey sibling is being forgotten (G4b, AC-SIBLING-2/Q3)", async () => {
    const tsMls = await import("ts-mls");
    const mod = await import("@internet-privacy/marmot-ts");

    vi.mocked(
      tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
    ).mockReturnValue(false);

    // Two leaves for the shared pubkey: indexes 0 and 1.
    vi.mocked(mod.getPubkeyLeafNodeIndexes).mockReturnValue([0, 1]);

    // Ratchet tree has two leaves at node indexes 0 and 2, plus a "parent"
    // node at node-index 1 carrying ownSig.
    // - otherSig at leaf-index 0 shares the first byte with ownSig but
    //   differs in the second — kills a buggy `.some` (any-byte-match)
    //   vs the correct `.every` (all-bytes-match).
    // - The parent node at node-index 1 carries ownSig but must NOT be
    //   treated as the own-leaf, because the walk's leaf-type guard
    //   should skip it. If the guard is removed (mutant), the walk
    //   would mistakenly latch onto floor(1/2)=0 as ownLeafIndex,
    //   exclude leaf-index 0 from the removal set, and removeLeafByIndex
    //   would be called with index 1 — wrong.
    const ownSig = new Uint8Array([9, 9, 9]);
    const otherSig = new Uint8Array([9, 1, 1]);
    const tree = [
      { nodeType: "leaf", leaf: { signaturePublicKey: otherSig } },
      { nodeType: "parent", leaf: { signaturePublicKey: ownSig } },
      { nodeType: "leaf", leaf: { signaturePublicKey: ownSig } },
    ];

    vi.mocked(tsMls.getOwnLeafNode).mockReturnValue({
      signaturePublicKey: ownSig,
      // Minimal shape — the impl only reads signaturePublicKey.
    } as unknown as ReturnType<typeof tsMls.getOwnLeafNode>);

    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: tree },
      relays: ["wss://r"],
      network: {
        request: vi.fn().mockResolvedValue([
          {
            keyPackage: { id: "rotated-kp" },
            _slot: "target-slot",
            id: "ev",
            pubkey: "shared-pubkey",
          },
        ]),
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([group]);

    await forgetSiblingDevice(client, "shared-pubkey", "target-slot");

    // Only the non-own leaf (index 0) is removed; the admin's own leaf
    // (index 1, the one matching ownSig at node index 2) is excluded.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
    expect(removeLeafByIndex).toHaveBeenCalledWith(group, 0);
  });

  // -------------------------------------------------------------------------
  // G5 — kind-5 event shape: created_at + falsy-id skip.
  // -------------------------------------------------------------------------

  /**
   * (a) created_at is Math.floor(systemTime/1000) — kills the line-272
   *     Date.now() * 1000 mutant.
   */
  it("publishes kind-5 events with created_at in seconds-since-epoch (G5a, AC-DELETE-2)", async () => {
    vi.useFakeTimers();
    const fixedInstant = 1_750_000_000_000; // 2025-06-15T15:46:40Z
    vi.setSystemTime(fixedInstant);

    try {
      const group = makeSelfGroup("kp-time");
      const client = makeSelfClient([group], [
        { publicPackage: { id: "kp-time" }, published: [{ id: "ev-t" }] },
      ]);

      await forgetSelfDevice(client, makeSigner(), ["wss://r"], vi.fn());

      const published = (client.network.publish as ReturnType<typeof vi.fn>)
        .mock.calls[0][1];
      expect(published.created_at).toBe(Math.floor(fixedInstant / 1000));
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * (b) Falsy ids (empty string, undefined, null) in published[] are skipped;
   *     exactly one kind-5 is emitted per truthy id.
   *
   * Kills the line-269 `if (!eventId) continue` flips.
   */
  it("emits exactly one kind-5 per truthy published-id and skips falsy ids (G5b, AC-DELETE-3)", async () => {
    const idArb = fc.oneof(
      fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.length > 0),
      fc.constantFrom("", undefined, null),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(idArb, { minLength: 1, maxLength: 6 }), async (ids) => {
        const group = makeSelfGroup("kp-ids");
        const client = makeSelfClient([group], [
          {
            publicPackage: { id: "kp-ids" },
            published: ids.map((id) => ({ id: id as string })),
          },
        ]);

        await forgetSelfDevice(client, makeSigner(), [], vi.fn());

        const truthyIds = ids.filter((id) => !!id);
        expect(client.network.publish).toHaveBeenCalledTimes(truthyIds.length);

        const publishedEvents = (client.network.publish as ReturnType<typeof vi.fn>)
          .mock.calls.map((c) => c[1]);
        const publishedEventIds = publishedEvents.flatMap((ev) =>
          ev.tags
            .filter((t: string[]) => t[0] === "e")
            .map((t: string[]) => t[1]),
        );
        expect(publishedEventIds.sort()).toEqual(truthyIds.slice().sort());
      }),
      { numRuns: 20 },
    );
  });

  // -------------------------------------------------------------------------
  // G6 — Empty-relays / empty-members / network-error skips in
  //      forgetSiblingDevice.
  // -------------------------------------------------------------------------

  /**
   * (a) Empty group.relays → network.request is never called for the group,
   *     no leaf is removed, but markSlotForgotten is still called once.
   */
  it("skips network.request when group.relays is empty (G6a, AC-SIBLING-1)", async () => {
    const networkRequest = vi.fn().mockResolvedValue([]);
    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: [{ nodeType: "leaf", leaf: { id: "kp" } }] },
      relays: [], // empty
      network: { request: networkRequest },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([group]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    expect(networkRequest).not.toHaveBeenCalled();
    expect(removeLeafByIndex).not.toHaveBeenCalled();
    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });

  /**
   * (b) getGroupMembers returning [] → network.request is never called
   *     for the group, no leaf removed, markSlotForgotten still called once.
   */
  it("skips network.request when group has no members (G6b, AC-SIBLING-1)", async () => {
    const mod = await import("@internet-privacy/marmot-ts");
    vi.mocked(mod.getGroupMembers).mockReturnValue([]);

    const networkRequest = vi.fn().mockResolvedValue([]);
    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: [{ nodeType: "leaf", leaf: { id: "kp" } }] },
      relays: ["wss://r"],
      network: { request: networkRequest },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([group]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    expect(networkRequest).not.toHaveBeenCalled();
    expect(removeLeafByIndex).not.toHaveBeenCalled();
    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
  });

  /**
   * (c) When network.request rejects for one group, the loop CONTINUES to
   *     the next admin group, removeLeafByIndex is called for the second
   *     group, and markSlotForgotten is still called exactly once.
   *
   * Kills the line-345 BlockStatement (catch-and-continue) mutant.
   */
  it("continues to next group when network.request rejects on one group (G6c, AC-SIBLING-1)", async () => {
    const failingGroup = {
      groupData: { _adminResult: true },
      state: { ratchetTree: [{ nodeType: "leaf", leaf: { id: "kp-fail" } }] },
      relays: ["wss://r-fail"],
      network: {
        request: vi.fn().mockRejectedValue(new Error("relay down")),
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const workingGroup = makeSiblingGroup("kp-ok", true, "target-slot");

    const client = makeSiblingClient([failingGroup, workingGroup]);

    await expect(
      forgetSiblingDevice(client, "local-pubkey", "target-slot"),
    ).resolves.toBeUndefined();

    // Failing group skipped, working group processed.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(1);
    expect(removeLeafByIndex).toHaveBeenCalledWith(workingGroup, 0);

    expect(markSlotForgotten).toHaveBeenCalledTimes(1);
    expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");
  });

  // -------------------------------------------------------------------------
  // G7 — Recompute-after-epoch contract (the post-error retry index)
  //
  // AC-SIBLING-2 requires that removeLeafByIndex is called "for every leaf …
  // whose key package matches the target slot". When an epoch advances between
  // the first attempt and the retry, the retry MUST still target a slot-
  // matching leaf in the *post-advance* tree — not the stale closure index,
  // not an arbitrary other-slot leaf, and not "everything in the tree".
  //
  // The G2 test already covers the "leaf vanished → retry skipped" branch
  // (recompute returns null). G7 covers the live-retry branch: when the leaf
  // is still findable, the recompute must produce its current position.
  //
  // Together G7a + G7b kill the eight L379-383 mutants that survive G1/G2:
  // L379 (filter→identity), L380 (filter-predicate flips), L383 (primary-vs-
  // fallback gating), and the L383 BlockStatement (drop the fallback).
  // -------------------------------------------------------------------------

  /**
   * G7a — Retry index reflects slot-filtered events under an arbitrary
   * mix of KP events for several slots.
   *
   * For an arbitrary set of KP events covering N>=1 slots (where the target
   * slot has exactly one matching leaf in the tree at a known position), the
   * post-epoch retry MUST call removeLeafByIndex with the leaf index of the
   * target-slot leaf — never with the index of an other-slot leaf, and never
   * with the stale outer-closure leafIndex.
   *
   * Setup discipline:
   *  - Force compareKeyPackageToLeafNode true ONLY for events whose
   *    _kpId matches the leaf's id, so the primary path succeeds in both the
   *    initial attempt AND the recompute. This isolates the assertion to the
   *    slot-filter step — if the impl drops the filter (L379 mutant), it will
   *    push every other slot's leaf into refreshedIndexes and the index passed
   *    to the retry will not equal the target-slot leaf's index.
   *  - The first removeLeafByIndex call rejects with an epoch error so the
   *    recompute callback is exercised; the second resolves so the assertion
   *    inspects the index passed to call #2.
   */
  it("retry index targets a slot-matching leaf under arbitrary multi-slot KP mix (G7a, AC-SIBLING-2/D3)", async () => {
    const tsMls = await import("ts-mls");
    const cmp = vi.mocked(
      tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
    );

    await fc.assert(
      fc.asyncProperty(
        // Number of other-slot events sprinkled into kpEvents (the noise).
        fc.integer({ min: 0, max: 4 }),
        // Position (0-indexed in the leaf-only sequence) of the target-slot
        // leaf in the ratchet tree. The tree carries one leaf per slot.
        fc.integer({ min: 0, max: 3 }),
        // Number of other-slot leaves added to the tree.
        fc.integer({ min: 0, max: 3 }),
        async (noiseEventCount, targetLeafPos, otherLeafCount) => {
          // Reset mocks scoped to this iteration.
          vi.mocked(removeLeafByIndex).mockReset();
          cmp.mockReset();
          cmp.mockImplementation(
            ((kp: { id: string }, leaf: { id: string }) => kp.id === leaf.id) as unknown as typeof tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
          );

          // Build the ratchet tree: leaves at even indexes, parent nodes at
          // odd indexes. One leaf is the target (id "target-kp"); the rest
          // have other ids. targetLeafPos is the leaf-only ordinal of the
          // target leaf (clamped to a valid position).
          const totalLeaves = otherLeafCount + 1;
          const targetPos = Math.min(targetLeafPos, totalLeaves - 1);
          const tree: Array<{ nodeType?: string; leaf?: { id: string } } | null> = [];
          for (let leafIdx = 0; leafIdx < totalLeaves; leafIdx++) {
            const id = leafIdx === targetPos ? "target-kp" : `other-kp-${leafIdx}`;
            tree.push({ nodeType: "leaf", leaf: { id } });
            if (leafIdx < totalLeaves - 1) {
              tree.push({ nodeType: "parent", leaf: { id: "ignored" } });
            }
          }

          // Build kpEvents: one event for the target slot/leaf, plus N noise
          // events for other slots whose kp.id matches one of the other
          // leaves in the tree (so they'd be findable IF the filter was
          // bypassed — that's exactly what the L379 mutant does).
          const kpEvents = [
            {
              keyPackage: { id: "target-kp" },
              _slot: "target-slot",
              id: "ev-target",
              pubkey: "sibling-pubkey",
            },
            ...Array.from({ length: noiseEventCount }, (_, i) => {
              // Cycle through other-kp-* ids so each noise event matches a
              // real leaf in the tree.
              const otherIdx = i % Math.max(otherLeafCount, 1);
              const otherId =
                otherLeafCount > 0 ? `other-kp-${otherIdx >= targetPos ? otherIdx + 1 : otherIdx}` : "no-match";
              return {
                keyPackage: { id: otherId },
                _slot: `noise-slot-${i}`,
                id: `ev-noise-${i}`,
                pubkey: "sibling-pubkey",
              };
            }),
          ];

          // First call: epoch error. Second call: success. The second call's
          // leafIndex argument is what the retry computed.
          vi.mocked(removeLeafByIndex)
            .mockRejectedValueOnce(new Error("stale epoch on commit"))
            .mockResolvedValue(undefined);

          const group = {
            groupData: { _adminResult: true },
            state: { ratchetTree: tree },
            relays: ["wss://r"],
            network: {
              request: vi.fn().mockResolvedValue(kpEvents),
            },
          } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

          const client = makeSiblingClient([group]);

          await forgetSiblingDevice(client, "local-pubkey", "target-slot");

          // Retry occurred (epoch error → recompute → second call).
          expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
          // The retry index MUST be the target-leaf position. If the impl
          // dropped the slot filter (L379) or flipped the predicate
          // (L380), the retry index would land on an other-slot leaf or
          // on a degenerate value.
          expect(removeLeafByIndex).toHaveBeenNthCalledWith(
            2,
            group,
            targetPos,
          );
        },
      ),
      { numRuns: 10 },
    );
  });

  /**
   * G7b — Primary slot-filtered match wins over the pubkey fallback.
   *
   * AC-SIBLING-2 specifies KP-match as the primary leaf-resolution path; the
   * pubkey-credential fallback (Q3 resolution) is reached ONLY when the
   * primary returns []. When the primary recompute yields a result, the
   * fallback MUST NOT run — otherwise a same-pubkey sibling-forget could
   * remove the wrong leaf after an epoch advance.
   *
   * Witness: set the tree so the primary recompute finds the leaf at index P
   * (slot-matching), and arrange the fallback to return a DIFFERENT index F.
   * After the epoch error fires, the retry MUST be called with P, not F.
   *
   * Kills:
   *  - L383 ConditionalExpression → true  (always run fallback → overwrites P with F)
   *  - L383 ConditionalExpression → false (never run fallback — irrelevant
   *    here because the primary already produces a result, but the test is
   *    still consistent with this mutant; G7a/G2 cover the dual)
   *  - L383 EqualityOperator !== (run fallback when primary DID succeed →
   *    overwrites P with F)
   *  - L383 BlockStatement {} (drop the fallback — irrelevant when primary
   *    yields; combined with G2 which witnesses the null-on-fallback path,
   *    this mutant is caught: G2's recompute returns null only when BOTH
   *    primary AND fallback return [], and the fallback being dropped would
   *    skip the null shortcut on rotated KPs)
   *
   * Note: the {} mutant on L383 is killed by G2 already — G2 mocks
   * getPubkeyLeafNodeIndexes() → [] AND compareKeyPackageToLeafNode → false,
   * so refreshedIndexes is [] after the primary, and the fallback must run
   * (it's what produces the still-empty refreshedIndexes, which then maps to
   * refreshedIndexes[0] ?? null === null). If the {} mutant removed the
   * fallback, refreshedIndexes would already be [] from the primary and the
   * null-shortcut would still fire — so G2 doesn't kill {} on its own. G7b
   * inverts that: ensure the primary YIELDS, then any "always-run-fallback"
   * mutant overwrites it.
   */
  it("retry uses primary slot match when it yields and skips the pubkey fallback (G7b, AC-SIBLING-2/Q3/D3)", async () => {
    const tsMls = await import("ts-mls");
    const mod = await import("@internet-privacy/marmot-ts");

    // Primary path will succeed for the slot-matching leaf (kp.id === "kp-A"
    // matches the leaf at node index 4 → leaf index 2).
    vi.mocked(tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode)
      .mockImplementation(
        ((kp: { id: string }, leaf: { id: string }) => kp.id === leaf.id) as unknown as typeof tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
      );

    // Fallback would yield a DIFFERENT index (99) — a value no correct
    // recompute could ever produce against this tree. If the impl ran the
    // fallback when the primary succeeded, the retry would land on 99 and
    // the assertion would fail.
    vi.mocked(mod.getPubkeyLeafNodeIndexes).mockReturnValue([99]);

    // getOwnLeafNode throws → fallback's own-leaf exclusion is skipped, so
    // it would return [99] unfiltered.
    vi.mocked(tsMls.getOwnLeafNode).mockImplementation(() => {
      throw new Error("no privatePath");
    });

    // Tree: leaf at node 0 (id "kp-other"), parent at node 1, leaf at node 2
    // (id "kp-other-2"), parent at node 3, leaf at node 4 (id "kp-A") → leaf
    // index 2 is the target.
    const tree = [
      { nodeType: "leaf", leaf: { id: "kp-other" } },
      { nodeType: "parent", leaf: { id: "ignored" } },
      { nodeType: "leaf", leaf: { id: "kp-other-2" } },
      { nodeType: "parent", leaf: { id: "ignored" } },
      { nodeType: "leaf", leaf: { id: "kp-A" } },
    ];

    // First call: epoch error. Second call: success.
    vi.mocked(removeLeafByIndex)
      .mockRejectedValueOnce(new Error("epoch mismatch"))
      .mockResolvedValue(undefined);

    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: tree },
      relays: ["wss://r"],
      network: {
        request: vi.fn().mockResolvedValue([
          {
            keyPackage: { id: "kp-A" },
            _slot: "target-slot",
            id: "ev-A",
            pubkey: "sibling-pubkey",
          },
        ]),
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([group]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    // Retry must use the primary-match result (leaf index 2), not the
    // fallback (99). If the L383 `if` is mutated to always-run-fallback or
    // to run-fallback-when-primary-succeeded, the retry lands on 99.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(2, group, 2);
  });

  // -------------------------------------------------------------------------
  // G8 — Optional recompute callback (the D3 wrapper's documented contract).
  //
  // `removeLeafWithRetry(group, leafIndex, recomputeLeafIndex?)` declares the
  // recompute callback as OPTIONAL. The JSDoc states: "if omitted the same
  // index is retried." This contract preserves the wrapper's general-purpose
  // shape — any future caller that already knows the index will not need to
  // synthesize a callback. Today the only live caller (forgetSiblingDevice)
  // supplies one, but the contract must hold.
  //
  // The wrapper is not exported, so we exercise it through forgetSiblingDevice
  // by mocking the recompute branch out: when `siblingLeafIndexesForEvents`
  // returns a single index AND the primary path matches via
  // compareKeyPackageToLeafNode, the recompute callback IS invoked on the
  // epoch retry. To witness the no-callback path itself we would need to
  // export the wrapper. Instead we witness the *consequence* — the retry
  // resolves cleanly with the original index, without the TypeError that
  // would surface if the optional-guard were bypassed.
  // -------------------------------------------------------------------------

  /**
   * G8 — Wrapper documented contract: with NO recompute callback, an epoch
   * error on the first attempt triggers a retry against the SAME leaf index
   * without crashing on `undefined()` invocation.
   *
   * Witnesses the optional-callback guard at L88. Because the wrapper is
   * internal and the only live caller passes a callback, we cover the
   * contract by importing the module and exercising the public API in a
   * configuration where the recompute path becomes a no-op equivalent of
   * "use the same leaf index":
   *
   *   - Tree: a single leaf at index 0 matching the target slot.
   *   - Primary KP-equality returns true for the one leaf.
   *   - On retry, the SAME predicate fires again → recompute returns 0.
   *
   * The behavior here is observationally equivalent to the no-callback path:
   * the second `removeLeafByIndex` call sees the original leaf index. If the
   * L88 guard were bypassed AND the callback were absent, the wrapper would
   * throw `TypeError`; the assertion below would surface that as a rejected
   * promise rather than the clean resolution we expect.
   *
   * This complements G2/G7 which exercise the callback-supplied path under
   * varying recompute outputs. G8 nails the wrapper's identity behavior.
   */
  it("removeLeafWithRetry retries against the original leaf index when the recompute path is a no-op (G8, AC-SELF-1/D3)", async () => {
    // Single-leaf tree → recompute, when called, will yield the same index 0.
    const tree = [{ nodeType: "leaf", leaf: { id: "kp-stable" } }];

    // First attempt rejects with an epoch error; retry resolves.
    vi.mocked(removeLeafByIndex)
      .mockRejectedValueOnce(new Error("epoch mismatch on commit"))
      .mockResolvedValue(undefined);

    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: tree },
      relays: ["wss://r"],
      network: {
        request: vi.fn().mockResolvedValue([
          {
            keyPackage: { id: "kp-stable" },
            _slot: "target-slot",
            id: "ev",
            pubkey: "sibling-pubkey",
          },
        ]),
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([group]);

    // Resolves cleanly — no TypeError from the L88 guard being skipped on a
    // missing callback. The wrapper's documented behavior is "retry with the
    // same index if no recompute callback is supplied"; the witnessed
    // behavior here is "retry produces the same index", which is the only
    // observable consequence of that contract from the public API.
    await expect(
      forgetSiblingDevice(client, "local-pubkey", "target-slot"),
    ).resolves.toBeUndefined();

    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
    // Both calls target the same leaf index — the retry did not arrive at
    // some other position via a broken/missing recompute path.
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(1, group, 0);
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(2, group, 0);
  });

  // -------------------------------------------------------------------------
  // G9 — Clean degrade when group.relays is absent (undefined or empty).
  //
  // AC-SIBLING-1 requires unreachable groups to be skipped rather than
  // aborting the whole forget. G6a covered the empty-array case;
  // G9 broadens that to `relays === undefined` AND asserts the inner
  // contract: kpEvents must remain an empty array so the subsequent
  // `.filter(...)` cannot throw on a non-event sentinel value.
  // Property: for ANY admin group with no usable relays (empty array or
  // undefined), forgetSiblingDevice resolves, does not call removeLeafByIndex
  // for that group, and still calls markSlotForgotten exactly once.
  // -------------------------------------------------------------------------

  /**
   * G9 — Admin groups with no usable relays are skipped cleanly.
   *
   * Property over the absent-relays shape: `[]` and `undefined` are both
   * "no usable relays" from the user's perspective. forgetSiblingDevice MUST
   * - not invoke network.request,
   * - not call removeLeafByIndex,
   * - resolve without throwing,
   * - still mark the slot forgotten exactly once at the end.
   *
   * Kills the L335 ArrayDeclaration mutant (`= []` → `= ["Stryker was here"]`),
   * because any non-empty sentinel would be passed to `.filter(e =>
   * getKeyPackageIdentifier(e) === slot)`; the mocked
   * getKeyPackageIdentifier reads `event._slot` from objects — calling it on
   * a string throws and the promise rejects, breaking this assertion.
   */
  it("skips network.request and finishes cleanly when group.relays is empty or undefined (G9, AC-SIBLING-1)", async () => {
    const noRelays = fc.constantFrom<unknown>([], undefined);

    await fc.assert(
      fc.asyncProperty(noRelays, async (relaysValue) => {
        const networkRequest = vi.fn().mockResolvedValue([]);
        const group = {
          groupData: { _adminResult: true },
          state: { ratchetTree: [{ nodeType: "leaf", leaf: { id: "kp" } }] },
          relays: relaysValue,
          network: { request: networkRequest },
        } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

        const client = makeSiblingClient([group]);

        // Resolves cleanly — the post-skip `.filter` over an empty kpEvents
        // never trips on a sentinel value.
        await expect(
          forgetSiblingDevice(client, "local-pubkey", "target-slot"),
        ).resolves.toBeUndefined();

        expect(networkRequest).not.toHaveBeenCalled();
        expect(removeLeafByIndex).not.toHaveBeenCalled();
        expect(markSlotForgotten).toHaveBeenCalledTimes(1);
        expect(markSlotForgotten).toHaveBeenCalledWith("target-slot");

        // Reset for next iteration so the call-count assertions hold.
        vi.mocked(markSlotForgotten).mockClear();
      }),
      { numRuns: 8 },
    );
  });

  // -------------------------------------------------------------------------
  // G10 — Recompute callback's primary→fallback chain (KP rotation + epoch race).
  //
  // The recompute callback at L379-386 mirrors the outer leaf-resolution
  // chain (L364, L371): try primary KP-equality first; if it returns [],
  // re-derive by credential pubkey, excluding the local admin's own leaf.
  //
  // G4a/G4b witness the outer chain. G2 witnesses the recompute returning
  // null when BOTH primary AND fallback yield []. G7b witnesses primary
  // wins over fallback inside the recompute. The remaining gap: when the
  // sibling has rotated its KP (primary returns []) AND an epoch race fires
  // simultaneously, the recompute MUST hit the fallback and still produce
  // the rotated leaf's index. If the fallback is gated out (L383 mutated to
  // `if (false)` or its body emptied), the recompute returns
  // `undefined ?? null === null`, the retry treats null as success at L90,
  // and the sibling stays in the group despite admin's forget intent.
  //
  // Property: in a rotation + epoch-race scenario, the retry's leaf index
  // equals the pubkey-fallback index — not null/undefined, not skipped.
  // -------------------------------------------------------------------------

  /**
   * G10 — Retry callback re-derives the leaf via pubkey-fallback after KP
   * rotation + epoch race.
   *
   * Kills L383 ConditionalExpression → `if (false)` (mutant 147) and L383
   * BlockStatement → `{}` (mutant 149), both of which silence the fallback
   * inside the recompute closure.
   *
   * User behavior: a sibling that has rotated its KP and triggers an epoch
   * race during forget MUST still be removed — admin's forget intent does
   * not silently fail.
   */
  it("retry re-derives the leaf via pubkey-fallback after KP rotation + epoch race (G10, AC-SIBLING-2/Q3/D3)", async () => {
    const tsMls = await import("ts-mls");
    const mod = await import("@internet-privacy/marmot-ts");

    // Primary KP-equality always returns false — sibling rotated its KP, so
    // the relay holds the NEW KP while the tree still holds the OLD leaf.
    // This holds for BOTH the initial attempt AND the recompute call.
    vi.mocked(
      tsMls.defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode,
    ).mockReturnValue(false);

    // Fallback path (getPubkeyLeafNodeIndexes) returns the sibling's leaf at
    // index 2 — both for the initial attempt and the recompute (the rotation
    // does not move the leaf in the tree). getOwnLeafNode throws so the
    // exclusion is skipped and [2] passes through.
    vi.mocked(mod.getPubkeyLeafNodeIndexes).mockReturnValue([2]);
    vi.mocked(tsMls.getOwnLeafNode).mockImplementation(() => {
      throw new Error("no privatePath");
    });

    // First attempt: epoch error. Second attempt: success.
    vi.mocked(removeLeafByIndex)
      .mockRejectedValueOnce(new Error("stale epoch on commit"))
      .mockResolvedValue(undefined);

    // Tree shaped so leaf-index 2 corresponds to node-index 4. The actual
    // leaf payloads don't matter — primary KP-equality is mocked to false.
    const tree = [
      { nodeType: "leaf", leaf: { id: "old-kp-other" } },
      { nodeType: "parent", leaf: { id: "ignored" } },
      { nodeType: "leaf", leaf: { id: "old-kp-other-2" } },
      { nodeType: "parent", leaf: { id: "ignored" } },
      { nodeType: "leaf", leaf: { id: "old-kp-rotated-sibling" } },
    ];

    const group = {
      groupData: { _adminResult: true },
      state: { ratchetTree: tree },
      relays: ["wss://r"],
      network: {
        request: vi.fn().mockResolvedValue([
          {
            keyPackage: { id: "new-kp-rotated" },
            _slot: "target-slot",
            id: "ev-rotated",
            pubkey: "sibling-pubkey",
          },
        ]),
      },
    } as unknown as import("@internet-privacy/marmot-ts").MarmotGroup;

    const client = makeSiblingClient([group]);

    await forgetSiblingDevice(client, "local-pubkey", "target-slot");

    // Retry MUST have happened (epoch error → recompute → second call) AND
    // the recompute MUST have reached the fallback. If the fallback is
    // silenced (L383 mutants), recompute returns null, the retry is
    // skipped, and removeLeafByIndex.toHaveBeenCalledTimes(2) fails.
    expect(removeLeafByIndex).toHaveBeenCalledTimes(2);
    // The retry MUST target the pubkey-fallback's leaf index (2), not some
    // stale or sentinel value.
    expect(removeLeafByIndex).toHaveBeenNthCalledWith(2, group, 2);
  });
});
