/**
 * DevicesTab.loadDevices.test.ts
 *
 * Regression test for the bug "DevicesTab relay-fetch failure degrades
 * silently": a failing relay fetch used to be swallowed by a bare `catch {}`,
 * so the device list fell back to local-only with no visible signal. The fix
 * surfaces a `relayFetchError` flag that the component renders as a warning.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@internet-privacy/marmot-ts", () => ({
  keyPackageFilters: vi.fn(() => []),
  getKeyPackageIdentifier: vi.fn(
    (event: { _slot?: string }) => event._slot,
  ),
}));

import { loadDevices, type DeviceLoaderClient } from "./DevicesTab.loadDevices";

const RELAYS = ["wss://relay.example"];

function makeClient(opts: {
  local?: Array<{ identifier?: string; published?: { created_at: number }[] }>;
  relay?: () => Promise<unknown[]>;
}): DeviceLoaderClient {
  return {
    keyPackages: {
      list: vi.fn(async () => (opts.local ?? []) as never),
    },
    network: {
      request: vi.fn(opts.relay ?? (async () => [])) as never,
    },
  };
}

describe("loadDevices relay-fetch failure", () => {
  it("flags relayFetchError when the relay request rejects (bug: was silent)", async () => {
    const client = makeClient({
      local: [{ identifier: "local-slot", published: [{ created_at: 100 }] }],
      relay: async () => {
        throw new Error("relay unreachable");
      },
    });

    const { entries, relayFetchError } = await loadDevices(
      client,
      "pubkey",
      "local-slot",
      RELAYS,
    );

    // The failure must be visible to the caller — this is the regression.
    expect(relayFetchError).toBe(true);
    // Non-fatal policy: local devices still render.
    expect(entries.map((e) => e.slot)).toContain("local-slot");
  });

  it("does not flag relayFetchError on a successful relay fetch", async () => {
    const client = makeClient({
      local: [{ identifier: "local-slot", published: [{ created_at: 100 }] }],
      relay: async () => [
        { _slot: "remote-slot", created_at: 200, tags: [] },
      ],
    });

    const { entries, relayFetchError } = await loadDevices(
      client,
      "pubkey",
      "local-slot",
      RELAYS,
    );

    expect(relayFetchError).toBe(false);
    expect(entries.map((e) => e.slot).sort()).toEqual([
      "local-slot",
      "remote-slot",
    ]);
  });

  it("does not flag relayFetchError when there are no relays to query", async () => {
    const client = makeClient({
      local: [{ identifier: "local-slot" }],
    });

    const { relayFetchError } = await loadDevices(
      client,
      "pubkey",
      "local-slot",
      [],
    );

    expect(relayFetchError).toBe(false);
  });
});
