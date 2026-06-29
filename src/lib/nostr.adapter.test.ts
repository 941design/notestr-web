/**
 * nostr.adapter.test.ts — behavioral properties for the async / NDK-adapter
 * functions in src/lib/nostr.ts.
 *
 * Covers:
 *   bridgeNip46ToEventSigner — tested indirectly via connectBunker, which
 *     is the only exported caller. Gaps: cipher-protocol routing (nip44/nip04
 *     strings), getPublicKey delegation, signEvent assembly.
 *   connectBunker — session-key continuity, auth-method persistence.
 *   restoreNip46Session — absent-payload guard, error recovery.
 *   startNostrConnect — cancel-flag state machine.
 *
 * No AC exists for any of these behaviors (Bucket 2 — spec-gap findings
 * should be filed; see audit summary). Each property description is the
 * user-story level, not the implementation level.
 *
 * vi.hoisted initialises mock factories before vi.mock hoisting runs.
 */

import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock instances — must precede vi.mock so factories can close over them
// ---------------------------------------------------------------------------

const {
  mockNDKConnect,
  mockGetEventHash,
  mockNip46Instance,
  mockNostrConnectInstance,
  mockBunkerFn,
  mockFromPayloadFn,
  mockNostrConnectFn,
} = vi.hoisted(() => {
  // Reusable NIP-46 signer returned by NDKNip46Signer.bunker / fromPayload
  const mockNip46Instance = {
    getPublicKey: vi.fn<() => Promise<string>>().mockResolvedValue("aabbccddeeff0011"),
    sign: vi.fn<(event: unknown) => Promise<string>>().mockResolvedValue("sig123abc"),
    encrypt: vi
      .fn<(user: unknown, text: string, type: string) => Promise<string>>()
      .mockImplementation((_user, text, type) =>
        Promise.resolve(`encrypted:${type}:${text}`),
      ),
    decrypt: vi
      .fn<(user: unknown, text: string, type: string) => Promise<string>>()
      .mockImplementation((_user, text, type) =>
        Promise.resolve(`decrypted:${type}:${text}`),
      ),
    blockUntilReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    localSigner: { privateKey: "localPrivKey123" },
    toPayload: vi.fn<() => string>().mockReturnValue("payload123"),
  };

  // Signer returned by NDKNip46Signer.nostrconnect (cancel tests need a
  // separate instance so blockUntilReady can be overridden per-test)
  const mockNostrConnectInstance = {
    nostrConnectUri: "nostrconnect://test?relay=wss%3A%2F%2Frelay.example",
    getPublicKey: vi.fn<() => Promise<string>>().mockResolvedValue("aabbccddeeff0011"),
    sign: vi.fn<(event: unknown) => Promise<string>>().mockResolvedValue("sig456def"),
    encrypt: vi
      .fn<(user: unknown, text: string, type: string) => Promise<string>>()
      .mockImplementation((_user, text, type) =>
        Promise.resolve(`encrypted:${type}:${text}`),
      ),
    decrypt: vi
      .fn<(user: unknown, text: string, type: string) => Promise<string>>()
      .mockImplementation((_user, text, type) =>
        Promise.resolve(`decrypted:${type}:${text}`),
      ),
    blockUntilReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    localSigner: { privateKey: "localPrivKey456" },
    toPayload: vi.fn<() => string>().mockReturnValue("payload456"),
  };

  const mockNDKConnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockGetEventHash = vi.fn<(event: unknown) => string>().mockReturnValue("hash001");
  const mockBunkerFn = vi.fn().mockReturnValue(mockNip46Instance);
  const mockFromPayloadFn = vi.fn<() => Promise<typeof mockNip46Instance>>().mockResolvedValue(
    mockNip46Instance,
  );
  const mockNostrConnectFn = vi.fn().mockReturnValue(mockNostrConnectInstance);

  return {
    mockNDKConnect,
    mockGetEventHash,
    mockNip46Instance,
    mockNostrConnectInstance,
    mockBunkerFn,
    mockFromPayloadFn,
    mockNostrConnectFn,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/config/relays", () => ({ NDK_CONNECT_TIMEOUT_MS: 5000 }));

vi.mock("@nostr-dev-kit/ndk", () => ({
  default: class NDK {
    connect = () => mockNDKConnect();
  },
  NDKNip46Signer: {
    bunker: (...args: unknown[]) => mockBunkerFn(...args),
    fromPayload: () => mockFromPayloadFn(),
    nostrconnect: (...args: unknown[]) => mockNostrConnectFn(...args),
  },
  NDKPrivateKeySigner: {},
  NDKUser: class NDKUser {
    constructor(public opts: { pubkey: string }) {}
  },
}));

vi.mock("nostr-tools/nip19", () => ({
  decode: () => ({ type: "npub", data: "" }),
  npubEncode: () => "",
}));

vi.mock("nostr-tools/pure", () => ({
  getEventHash: (event: unknown) => mockGetEventHash(event),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so injected versions are used
// ---------------------------------------------------------------------------

import {
  clearNip46Session,
  connectBunker,
  getSavedAuthMethod,
  hasNip46Session,
  restoreNip46Session,
  setSavedAuthMethod,
  startNostrConnect,
} from "./nostr";

// ---------------------------------------------------------------------------
// localStorage stub — isolated per test (mirrors nostr.pure.test.ts)
// ---------------------------------------------------------------------------

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    _store: store,
  };
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  vi.resetAllMocks();

  // Restore default implementations after vi.resetAllMocks() wipes them.
  mockNDKConnect.mockResolvedValue(undefined);
  mockGetEventHash.mockReturnValue("hash001");

  mockNip46Instance.getPublicKey.mockResolvedValue("aabbccddeeff0011");
  mockNip46Instance.sign.mockResolvedValue("sig123abc");
  mockNip46Instance.encrypt.mockImplementation(
    (_user: unknown, text: string, type: string) =>
      Promise.resolve(`encrypted:${type}:${text}`),
  );
  mockNip46Instance.decrypt.mockImplementation(
    (_user: unknown, text: string, type: string) =>
      Promise.resolve(`decrypted:${type}:${text}`),
  );
  mockNip46Instance.blockUntilReady.mockResolvedValue(undefined);
  mockNip46Instance.toPayload.mockReturnValue("payload123");

  mockNostrConnectInstance.getPublicKey.mockResolvedValue("aabbccddeeff0011");
  mockNostrConnectInstance.sign.mockResolvedValue("sig456def");
  mockNostrConnectInstance.encrypt.mockImplementation(
    (_user: unknown, text: string, type: string) =>
      Promise.resolve(`encrypted:${type}:${text}`),
  );
  mockNostrConnectInstance.decrypt.mockImplementation(
    (_user: unknown, text: string, type: string) =>
      Promise.resolve(`decrypted:${type}:${text}`),
  );
  mockNostrConnectInstance.blockUntilReady.mockResolvedValue(undefined);
  mockNostrConnectInstance.toPayload.mockReturnValue("payload456");

  mockBunkerFn.mockReturnValue(mockNip46Instance);
  mockFromPayloadFn.mockResolvedValue(mockNip46Instance);
  mockNostrConnectFn.mockReturnValue(mockNostrConnectInstance);

  storage = makeStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. bridgeNip46ToEventSigner — NIP cipher-protocol routing
//
// No AC (Bucket 2). User story: when the app encrypts or decrypts content via
// a remote NIP-46 signer, it must use the cipher protocol the caller requested
// (nip44 vs nip04). Routing the wrong cipher silently sends data to the wrong
// decryption path on the receiving end.
//
// bridgeNip46ToEventSigner is private; tested via connectBunker (its only
// exported caller), which wires up the adapter and returns conn.signer.
// ---------------------------------------------------------------------------

describe("EventSigner adapter — cipher-protocol dispatch (via connectBunker)", () => {
  it("nip44.encrypt routes to nip46.encrypt with the 'nip44' type string", async () => {
    const conn = await connectBunker("bunker://test", []);
    await conn.signer.nip44!.encrypt("pubkey123", "hello");
    expect(mockNip46Instance.encrypt).toHaveBeenCalledWith(
      expect.any(Object),
      "hello",
      "nip44",
    );
  });

  it("nip44.decrypt routes to nip46.decrypt with the 'nip44' type string", async () => {
    const conn = await connectBunker("bunker://test", []);
    await conn.signer.nip44!.decrypt("pubkey123", "ciphertext");
    expect(mockNip46Instance.decrypt).toHaveBeenCalledWith(
      expect.any(Object),
      "ciphertext",
      "nip44",
    );
  });

  it("nip04.encrypt routes to nip46.encrypt with the 'nip04' type string", async () => {
    const conn = await connectBunker("bunker://test", []);
    await conn.signer.nip04!.encrypt("pubkey123", "hello");
    expect(mockNip46Instance.encrypt).toHaveBeenCalledWith(
      expect.any(Object),
      "hello",
      "nip04",
    );
  });

  it("nip04.decrypt routes to nip46.decrypt with the 'nip04' type string", async () => {
    const conn = await connectBunker("bunker://test", []);
    await conn.signer.nip04!.decrypt("pubkey123", "ciphertext");
    expect(mockNip46Instance.decrypt).toHaveBeenCalledWith(
      expect.any(Object),
      "ciphertext",
      "nip04",
    );
  });

  it("property: cipher dispatch is stable over arbitrary pubkeys and content", async () => {
    // Kills the nip44/nip04 string-literal cluster in one shot. The third
    // argument to nip46.encrypt/decrypt must always match what the caller
    // requested — any mutation of those string literals is caught here.
    const conn = await connectBunker("bunker://test", []);

    await fc.assert(
      fc.asyncProperty(
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        fc.string(),
        async (pubkey, content) => {
          mockNip46Instance.encrypt.mockClear();
          mockNip46Instance.decrypt.mockClear();

          await conn.signer.nip44!.encrypt(pubkey, content);
          expect(mockNip46Instance.encrypt.mock.calls[0]?.[2]).toBe("nip44");

          mockNip46Instance.encrypt.mockClear();
          await conn.signer.nip04!.encrypt(pubkey, content);
          expect(mockNip46Instance.encrypt.mock.calls[0]?.[2]).toBe("nip04");

          await conn.signer.nip44!.decrypt(pubkey, content);
          expect(mockNip46Instance.decrypt.mock.calls[0]?.[2]).toBe("nip44");

          mockNip46Instance.decrypt.mockClear();
          await conn.signer.nip04!.decrypt(pubkey, content);
          expect(mockNip46Instance.decrypt.mock.calls[0]?.[2]).toBe("nip04");
        },
      ),
      { numRuns: 25 },
    );
  });

  it("nip44 and nip04 cipher objects are present on the returned EventSigner", async () => {
    // Kills the ObjectLiteral → {} mutations on the nip44 / nip04 objects.
    const conn = await connectBunker("bunker://test", []);
    expect(typeof conn.signer.nip44?.encrypt).toBe("function");
    expect(typeof conn.signer.nip44?.decrypt).toBe("function");
    expect(typeof conn.signer.nip04?.encrypt).toBe("function");
    expect(typeof conn.signer.nip04?.decrypt).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 2. bridgeNip46ToEventSigner — signing and pubkey delegation
//
// No AC (Bucket 2). User story: signing events and looking up the public key
// must delegate to the remote NIP-46 signer, not perform local operations.
// An empty signEvent body would return undefined, breaking all callers that
// expect a signed event object.
// ---------------------------------------------------------------------------

describe("EventSigner adapter — signing and pubkey delegation (via connectBunker)", () => {
  it("getPublicKey() returns exactly what the NIP-46 signer returns", async () => {
    mockNip46Instance.getPublicKey.mockResolvedValue("deadbeef00112233");
    const conn = await connectBunker("bunker://test", []);
    expect(await conn.signer.getPublicKey()).toBe("deadbeef00112233");
    expect(mockNip46Instance.getPublicKey).toHaveBeenCalled();
  });

  it("signEvent returns a complete event whose sig comes from nip46.sign()", async () => {
    mockNip46Instance.sign.mockResolvedValue("mysig9876");
    const conn = await connectBunker("bunker://test", []);
    const event = await conn.signer.signEvent({
      kind: 1,
      content: "hello",
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    // sig must be set from nip46.sign(), not left as initial ""
    expect(event.sig).toBe("mysig9876");
    expect(mockNip46Instance.sign).toHaveBeenCalled();
  });

  it("signEvent returns a complete event whose id comes from getEventHash()", async () => {
    mockGetEventHash.mockReturnValue("eventid_abc");
    const conn = await connectBunker("bunker://test", []);
    const event = await conn.signer.signEvent({
      kind: 1,
      content: "test",
      tags: [],
      created_at: 0,
    });
    expect(event.id).toBe("eventid_abc");
    expect(mockGetEventHash).toHaveBeenCalled();
  });

  it("signEvent returns a full event object (not undefined)", async () => {
    // Kills the BlockStatement → {} empty-body mutation on signEvent.
    const conn = await connectBunker("bunker://test", []);
    const event = await conn.signer.signEvent({
      kind: 1,
      content: "",
      tags: [],
      created_at: 0,
    });
    expect(event).toBeDefined();
    expect(typeof event.sig).toBe("string");
    expect(typeof event.id).toBe("string");
    expect(typeof event.pubkey).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 3. restoreNip46Session — absent-payload guard
//
// No AC (Bucket 2). User story: when no saved NIP-46 session exists (the
// app is fresh or was previously cleared), restoreNip46Session must return
// null immediately — it must not attempt a network connection with an absent
// or undefined payload.
// ---------------------------------------------------------------------------

describe("restoreNip46Session — absent-payload guard", () => {
  it("returns null when no payload is in localStorage", async () => {
    const result = await restoreNip46Session(["wss://relay.example"]);
    expect(result).toBeNull();
  });

  it("does not call NDKNip46Signer.fromPayload when no payload is stored", async () => {
    await restoreNip46Session([]);
    expect(mockFromPayloadFn).not.toHaveBeenCalled();
  });

  it("property: absent payload always yields null regardless of other localStorage state", async () => {
    // Kills the !payload guard mutations (BooleanLiteral and ConditionalExpression).
    // The presence of unrelated localStorage keys must not cause a false positive.
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        async (unrelatedKey, unrelatedValue) => {
          storage._store.clear();
          storage._store.set(unrelatedKey.replace(/^notestr-nip46-payload$/, "_"), unrelatedValue);
          // notestr-nip46-payload is deliberately absent

          const result = await restoreNip46Session([]);
          expect(result).toBeNull();
          expect(mockFromPayloadFn).not.toHaveBeenCalled();
          mockFromPayloadFn.mockClear();
        },
      ),
      { numRuns: 25 },
    );
  });

  it("proceeds to restore when a payload IS present", async () => {
    // Inverse: with a valid payload, the function attempts the restore.
    storage._store.set("notestr-nip46-payload", "valid-payload");
    const result = await restoreNip46Session([]);
    expect(result).not.toBeNull();
    expect(mockFromPayloadFn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. restoreNip46Session — error recovery
//
// No AC (Bucket 2). User story: when session restoration fails (expired token,
// relay unreachable), the app must clear the stale session data so the user
// can sign in fresh. Leaving stale data in place would cause every subsequent
// app load to attempt (and fail) the broken restore.
// ---------------------------------------------------------------------------

describe("restoreNip46Session — error recovery", () => {
  it("clears session data and returns null when restoration throws", async () => {
    storage._store.set("notestr-nip46-payload", "stale-payload");
    storage._store.set("notestr-nip46-local-key", "stale-key");
    setSavedAuthMethod("nip46");

    mockFromPayloadFn.mockRejectedValueOnce(new Error("Session expired"));

    const result = await restoreNip46Session([]);

    expect(result).toBeNull();
    // clearNip46Session() must have been called — verify via its observable effects
    expect(hasNip46Session()).toBe(false);
    expect(storage._store.has("notestr-nip46-local-key")).toBe(false);
    expect(getSavedAuthMethod()).toBeNull();
  });

  it("does NOT throw to the caller when restoration fails (returns null, not an exception)", async () => {
    storage._store.set("notestr-nip46-payload", "bad-payload");
    mockFromPayloadFn.mockRejectedValueOnce(new Error("Network error"));

    await expect(restoreNip46Session([])).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. restoreNip46Session / connectBunker — auth-method persistence
//
// No AC (Bucket 2). User story: after a successful NIP-46 connection, the app
// must remember the auth method so it can reconnect automatically on next load.
// setSavedAuthMethod("") (the string-literal mutation) would record an invalid
// method and getSavedAuthMethod() would return null, breaking auto-reconnect.
// ---------------------------------------------------------------------------

describe("auth-method persistence after successful NIP-46 operations", () => {
  it("connectBunker sets the auth method to 'nip46'", async () => {
    await connectBunker("bunker://test", ["wss://relay.example"]);
    expect(getSavedAuthMethod()).toBe("nip46");
  });

  it("restoreNip46Session sets the auth method to 'nip46' after successful restore", async () => {
    storage._store.set("notestr-nip46-payload", "valid-payload");
    const result = await restoreNip46Session([]);
    expect(result).not.toBeNull();
    expect(getSavedAuthMethod()).toBe("nip46");
  });

  it("connectBunker returns a connection with the pubkey from the remote signer", async () => {
    mockNip46Instance.getPublicKey.mockResolvedValue("cafe0102030405");
    const conn = await connectBunker("bunker://test", []);
    expect(conn.pubkey).toBe("cafe0102030405");
    expect(conn.signer).toBeDefined();
    expect(conn.nip46Signer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. connectBunker — session-key continuity
//
// No AC (Bucket 2). User story: when reconnecting to a bunker for which a
// local key was previously generated, the app must reuse that key so the
// remote signer recognises the session. Dropping the key (the ?? → && mutation)
// forces a new key to be generated, causing the remote signer to treat the
// connection as a fresh authorisation request.
// ---------------------------------------------------------------------------

describe("connectBunker — session-key continuity", () => {
  it("passes the stored local key verbatim to NDKNip46Signer.bunker", async () => {
    storage._store.set("notestr-nip46-local-key", "existingKey_abc123");
    await connectBunker("bunker://test", []);
    const thirdArg = mockBunkerFn.mock.calls[0]?.[2];
    expect(thirdArg).toBe("existingKey_abc123");
  });

  it("passes undefined (not null) as the key when no local key is stored", async () => {
    // localStorage.getItem returns null for absent keys; ?? undefined converts it
    // to undefined. The && mutation would leave null, which differs from undefined.
    await connectBunker("bunker://test", []);
    const thirdArg = mockBunkerFn.mock.calls[0]?.[2];
    expect(thirdArg).toBeUndefined();
  });

  it("property: the exact stored key string is always passed through without transformation", async () => {
    // Guards against any operator mutation that changes how the stored key is
    // forwarded (e.g. ?? → && makes the arg `undefined` even when a key exists).
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 128 }).filter((s) => s.length > 0),
        async (storedKey) => {
          storage._store.set("notestr-nip46-local-key", storedKey);
          mockBunkerFn.mockClear();

          await connectBunker("bunker://test", []);

          const thirdArg = mockBunkerFn.mock.calls[0]?.[2];
          storage._store.delete("notestr-nip46-local-key");
          expect(thirdArg).toBe(storedKey);
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// 7. startNostrConnect — cancel-flag state machine
//
// No AC (Bucket 2). User story: when the user dismisses the QR dialog before
// completing a nostrconnect:// authorisation, the app must reject the pending
// connection promise. Failing to reject (or pre-rejecting without cancel)
// either leaves the app in an indeterminate auth state or blocks a valid
// connection.
//
// The cancel flag is a simple 2-state machine: false → true (cancel called).
// Properties: (a) default state is false (no pre-rejection), (b) calling
// cancel() once sets the flag to true, (c) the flag is checked after
// blockUntilReady so even an already-resolved signer respects the cancel.
// ---------------------------------------------------------------------------

describe("startNostrConnect — cancel-flag state machine", () => {
  it("connection resolves when cancel() is never called", async () => {
    // Kills: let cancelled = false → true (pre-cancelled); if (cancelled) → if (true).
    const { connection } = startNostrConnect("wss://relay.example", [
      "wss://relay.example",
    ]);
    const conn = await connection;
    expect(conn.pubkey).toBe("aabbccddeeff0011");
    expect(conn.signer).toBeDefined();
  });

  it("connection rejects with a 'Cancelled' error when cancel() is called before ready", async () => {
    // Kills: cancel body → {}; cancelled = true → false; if (cancelled) → if (false).
    //
    // cancel() is called synchronously (before any await in this test), which
    // means it runs before the async IIFE's first continuation. The IIFE then
    // checks `cancelled` after its awaits complete and finds it true.
    const { connection, cancel } = startNostrConnect("wss://relay.example", [
      "wss://relay.example",
    ]);
    cancel();
    await expect(connection).rejects.toThrow(/Cancelled/i);
  });

  it("cancel() with a deferred blockUntilReady: flag is seen after signer responds", async () => {
    // Extra coverage for the deferred case: blockUntilReady does not resolve
    // until we explicitly trigger it, then the flag is re-checked.
    let resolveReady!: () => void;
    mockNostrConnectInstance.blockUntilReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    );

    const { connection, cancel } = startNostrConnect("wss://relay.example", []);
    cancel(); // flag set before blockUntilReady resolves
    resolveReady(); // let the IIFE proceed — it will find cancelled = true

    await expect(connection).rejects.toThrow(/Cancelled/i);
  });

  it("not calling cancel() on a deferred signer produces a successful connection", async () => {
    let resolveReady!: () => void;
    mockNostrConnectInstance.blockUntilReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    );

    const { connection } = startNostrConnect("wss://relay.example", []);
    resolveReady(); // no cancel() call — connection should succeed

    const conn = await connection;
    expect(conn.pubkey).toBe("aabbccddeeff0011");
  });

  it("uri is available immediately (before the connection promise resolves)", () => {
    // Kills ObjectLiteral → {} on the return value of startNostrConnect.
    const { uri } = startNostrConnect("wss://relay.example", []);
    expect(typeof uri).toBe("string");
    expect(uri.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. restoreNip46Session — returned connection fields
//
// No AC (Bucket 2). User story: on a successful restore the returned object
// must carry the pubkey, signer, and nip46Signer so the caller can wire them
// into the application context. An empty return object would silently break
// every caller that destructures these fields.
// ---------------------------------------------------------------------------

describe("restoreNip46Session — returned connection fields on success", () => {
  it("returns a connection object with pubkey, signer, and nip46Signer populated", async () => {
    // Kills ObjectLiteral → {} on the return statement (line 147).
    mockNip46Instance.getPublicKey.mockResolvedValue("1122334455aabbcc");
    storage._store.set("notestr-nip46-payload", "valid-payload");

    const result = await restoreNip46Session([]);

    expect(result?.pubkey).toBe("1122334455aabbcc");
    expect(result?.signer).toBeDefined();
    expect(result?.nip46Signer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. startNostrConnect — session-key continuity and auth-method persistence
//
// No AC (Bucket 2). User story: startNostrConnect, like connectBunker, must
// reuse any existing local key to avoid forcing re-authorisation, and must
// set the auth method to 'nip46' after the signer is established so
// auto-reconnect on next load works correctly.
// ---------------------------------------------------------------------------

describe("startNostrConnect — session-key continuity and auth-method persistence", () => {
  it("passes the stored local key to NDKNip46Signer.nostrconnect when one is present", async () => {
    // Kills LogicalOperator ?? → && on line 181 (stored key is dropped when
    // the mutation makes the expression always evaluate to undefined).
    storage._store.set("notestr-nip46-local-key", "savedKey_for_nostrconnect");
    startNostrConnect("wss://relay.example", []);
    const thirdArg = mockNostrConnectFn.mock.calls[0]?.[2];
    expect(thirdArg).toBe("savedKey_for_nostrconnect");
  });

  it("sets the auth method to 'nip46' after a successful nostrconnect session", async () => {
    // Kills StringLiteral setSavedAuthMethod("nip46") → setSavedAuthMethod("") on line 200.
    const { connection } = startNostrConnect("wss://relay.example", [
      "wss://relay.example",
    ]);
    await connection;
    expect(getSavedAuthMethod()).toBe("nip46");
  });
});
