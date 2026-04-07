import { describe, expect, it, vi } from "vitest";

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

import { groupHasKeyPackageLeaf, joinFromWelcomeInvite } from "./device-sync";

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
