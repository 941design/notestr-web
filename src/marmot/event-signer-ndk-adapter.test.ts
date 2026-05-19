import { describe, it, expect, vi } from "vitest";
import type { EventSigner } from "applesauce-core";
import { EventSignerNdkAdapter } from "./event-signer-ndk-adapter";

// Canonical EventSigner stub — mirrors the pattern in forget-device.test.ts:131-139.
function makeSigner(pubkey = "test-pubkey") {
  return {
    getPublicKey: vi.fn().mockResolvedValue(pubkey),
    signEvent: vi.fn().mockImplementation(async (event: object) => ({
      ...event,
      sig: "dummy-sig",
      id: "signed-event-id",
    })),
  } as unknown as EventSigner;
}

const HEX_PUBKEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("EventSignerNdkAdapter", () => {
  it("pubkey getter synchronously returns the hex pubkey passed at construction", () => {
    const adapter = new EventSignerNdkAdapter(makeSigner(HEX_PUBKEY), HEX_PUBKEY);
    expect(adapter.pubkey).toBe(HEX_PUBKEY);
  });

  it("blockUntilReady() resolves to an NDKUser whose pubkey matches the construction hex", async () => {
    const adapter = new EventSignerNdkAdapter(makeSigner(HEX_PUBKEY), HEX_PUBKEY);
    const user = await adapter.blockUntilReady();
    expect(user.pubkey).toBe(HEX_PUBKEY);
  });

  it("user() resolves to an NDKUser whose pubkey matches the construction hex", async () => {
    const adapter = new EventSignerNdkAdapter(makeSigner(HEX_PUBKEY), HEX_PUBKEY);
    const user = await adapter.user();
    expect(user.pubkey).toBe(HEX_PUBKEY);
  });

  it("userSync getter returns an NDKUser whose pubkey matches the construction hex", () => {
    const adapter = new EventSignerNdkAdapter(makeSigner(HEX_PUBKEY), HEX_PUBKEY);
    expect(adapter.userSync.pubkey).toBe(HEX_PUBKEY);
  });

  it("sign() delegates to wrapped EventSigner.signEvent and returns only the sig string", async () => {
    const signer = makeSigner(HEX_PUBKEY);
    const adapter = new EventSignerNdkAdapter(signer, HEX_PUBKEY);
    const eventTemplate = {
      kind: 22242,
      created_at: 0,
      tags: [],
      content: "challenge",
      pubkey: HEX_PUBKEY,
    };
    const result = await adapter.sign(eventTemplate as any);
    expect(typeof result).toBe("string");
    expect(result).toBe("dummy-sig");
    expect(signer.signEvent).toHaveBeenCalledWith(eventTemplate);
  });

  it("encrypt() throws an explicit error (not implemented)", async () => {
    const adapter = new EventSignerNdkAdapter(makeSigner(HEX_PUBKEY), HEX_PUBKEY);
    await expect(adapter.encrypt()).rejects.toThrow("not implemented");
  });

  it("decrypt() throws an explicit error (not implemented)", async () => {
    const adapter = new EventSignerNdkAdapter(makeSigner(HEX_PUBKEY), HEX_PUBKEY);
    await expect(adapter.decrypt()).rejects.toThrow("not implemented");
  });
});
