import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeDetachedGroupIds } from "./detached-groups";
import { shouldRunProbe } from "./probe-gate";

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

// AC-OBS-3: signin-time probe gating via lastProbeAt
describe("signin-time probe — shouldRunProbe gating", () => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs probe when lastProbeAt is absent (null)", () => {
    // AC-OBS-3a: no stored key → probe must run
    const result = shouldRunProbe(null);
    expect(result).toBe(true);
  });

  it("runs probe when lastProbeAt is more than 24 hours ago", () => {
    // AC-OBS-3b: stale probe → probe must run
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    // lastProbeAt is 25 hours ago (well beyond 24h threshold)
    const stale = now - ONE_DAY_MS - 60_000;
    const result = shouldRunProbe(stale);
    expect(result).toBe(true);
  });

  it("runs probe when lastProbeAt is exactly 24 hours ago (boundary)", () => {
    // Exactly at the 24h mark: Date.now() - lastProbeAt === PROBE_INTERVAL_MS
    // The condition is >=, so this should run.
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const boundary = now - ONE_DAY_MS;
    const result = shouldRunProbe(boundary);
    expect(result).toBe(true);
  });

  it("does NOT run probe when lastProbeAt is within the last 24 hours", () => {
    // AC-OBS-3c: fresh probe → probe must NOT run
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    // lastProbeAt is 1 hour ago (well within 24h)
    const fresh = now - 60 * 60 * 1000;
    const result = shouldRunProbe(fresh);
    expect(result).toBe(false);
  });

  it("does NOT run probe when lastProbeAt is just one second ago", () => {
    // Very fresh probe — definitely must not run again
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const veryFresh = now - 1000;
    const result = shouldRunProbe(veryFresh);
    expect(result).toBe(false);
  });
});
