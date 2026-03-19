import { describe, it, expect, vi } from "vitest";
import { computeDetachedGroupIds } from "./detached-groups";

// Mock getGroupMembers from marmot-ts
vi.mock("@internet-privacy/marmot-ts", async () => {
  const actual = await vi.importActual("@internet-privacy/marmot-ts");
  return {
    ...actual,
    getGroupMembers: vi.fn((state: unknown) => {
      // State is used as a test fixture: array of pubkeys
      return state as string[];
    }),
  };
});

function fakeGroup(idStr: string, state: string[] | null) {
  return { idStr, state } as any;
}

describe("computeDetachedGroupIds", () => {
  const myPubkey = "pubkey-me";

  it("marks groups where pubkey is not a member", () => {
    const groups = [fakeGroup("group-1", ["pubkey-alice", "pubkey-bob"])];
    const result = computeDetachedGroupIds(groups, myPubkey);
    expect(result.has("group-1")).toBe(true);
  });

  it("does not mark groups where pubkey is a member", () => {
    const groups = [fakeGroup("group-2", ["pubkey-alice", myPubkey])];
    const result = computeDetachedGroupIds(groups, myPubkey);
    expect(result.has("group-2")).toBe(false);
  });

  it("skips groups with no state (does not mark as detached)", () => {
    const groups = [fakeGroup("group-3", null)];
    const result = computeDetachedGroupIds(groups, myPubkey);
    expect(result.has("group-3")).toBe(false);
  });

  it("handles empty groups array", () => {
    const result = computeDetachedGroupIds([], myPubkey);
    expect(result.size).toBe(0);
  });

  it("handles mixed groups correctly", () => {
    const groups = [
      fakeGroup("member-group", [myPubkey, "pubkey-bob"]),
      fakeGroup("detached-group", ["pubkey-alice"]),
      fakeGroup("no-state-group", null),
    ];
    const result = computeDetachedGroupIds(groups, myPubkey);
    expect(result.size).toBe(1);
    expect(result.has("detached-group")).toBe(true);
    expect(result.has("member-group")).toBe(false);
    expect(result.has("no-state-group")).toBe(false);
  });
});
