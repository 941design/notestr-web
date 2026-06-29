/**
 * nostr.pure.test.ts — behavioral properties for the pure / localStorage helpers
 * in src/lib/nostr.ts.
 *
 * Covers: setSavedAuthMethod, getSavedAuthMethod, clearNip46Session,
 * hasNip46Session, npubToHex, hexToNpub, shortenPubkey, getNip07Signer.
 *
 * The three localStorage-key-name constants (NIP46_LOCAL_KEY, NIP46_PAYLOAD,
 * AUTH_METHOD_KEY) are not exported; their correctness is verified indirectly
 * by asserting on the exact string keys written to / removed from localStorage.
 *
 * Test environment: vitest node (no built-in localStorage or window).
 * Both globals are stubbed per-test via vi.stubGlobal.
 *
 * vi.hoisted initialises mock functions before vi.mock factory hoisting runs.
 */

import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions — must precede vi.mock so the factory can close over them
// ---------------------------------------------------------------------------

const { mockDecode, mockNpubEncode } = vi.hoisted(() => ({
  mockDecode: vi
    .fn<(nip19: string) => { type: string; data: string }>()
    .mockReturnValue({
      type: "npub",
      data: "deadbeef1234",
    }),
  mockNpubEncode: vi
    .fn<(hex: string) => string>()
    .mockReturnValue("npub1testvalue"),
}));

// ---------------------------------------------------------------------------
// Module mocks (mirrors nostr.test.ts conventions)
// ---------------------------------------------------------------------------

vi.mock("@/config/relays", () => ({ NDK_CONNECT_TIMEOUT_MS: 5000 }));
vi.mock("@nostr-dev-kit/ndk", () => ({
  default: class NDK {},
  NDKNip46Signer: { nostrconnect: () => ({ nostrConnectUri: "" }) },
  NDKPrivateKeySigner: {},
  NDKUser: class NDKUser {},
}));
vi.mock("nostr-tools/nip19", () => ({
  decode: (...args: unknown[]) => mockDecode(...(args as [string])),
  npubEncode: (...args: unknown[]) => mockNpubEncode(...(args as [string])),
}));
vi.mock("nostr-tools/pure", () => ({ getEventHash: () => "" }));

// ---------------------------------------------------------------------------
// Imports — after mocks so the mocked modules are injected
// ---------------------------------------------------------------------------

import {
  clearNip46Session,
  getNip07Signer,
  getSavedAuthMethod,
  hasNip46Session,
  hexToNpub,
  npubToHex,
  setSavedAuthMethod,
  shortenPubkey,
} from "./nostr";

// ---------------------------------------------------------------------------
// localStorage stub — isolated per test
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
  // Restore default decode/encode return values after resetAllMocks wipes them.
  mockDecode.mockReturnValue({ type: "npub", data: "deadbeef1234" });
  mockNpubEncode.mockReturnValue("npub1testvalue");

  storage = makeStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. localStorage key-name contract
//
// NIP46_LOCAL_KEY, NIP46_PAYLOAD, and AUTH_METHOD_KEY are private constants.
// If any is mutated to "" all three slots alias to the same key, silently
// corrupting session state. Each function must use a distinct key name.
// ---------------------------------------------------------------------------

describe("localStorage key-name contract (regression guard against constant mutation)", () => {
  it("setSavedAuthMethod writes to the key 'notestr-auth-method'", () => {
    setSavedAuthMethod("nip07");
    expect(storage._store.has("notestr-auth-method")).toBe(true);
    expect(storage._store.get("notestr-auth-method")).toBe("nip07");
  });

  it("setSavedAuthMethod(null) removes exactly 'notestr-auth-method'", () => {
    storage._store.set("notestr-auth-method", "nip07");
    setSavedAuthMethod(null);
    expect(storage._store.has("notestr-auth-method")).toBe(false);
  });

  it("clearNip46Session removes the key 'notestr-nip46-local-key'", () => {
    storage._store.set("notestr-nip46-local-key", "privkey");
    clearNip46Session();
    expect(storage._store.has("notestr-nip46-local-key")).toBe(false);
  });

  it("clearNip46Session removes the key 'notestr-nip46-payload'", () => {
    storage._store.set("notestr-nip46-payload", "some_payload");
    clearNip46Session();
    expect(storage._store.has("notestr-nip46-payload")).toBe(false);
  });

  it("hasNip46Session reads 'notestr-nip46-payload' — not any other key", () => {
    // A different NIP-46 key must not trigger hasNip46Session.
    storage._store.set("notestr-nip46-local-key", "present");
    expect(hasNip46Session()).toBe(false);

    storage._store.set("notestr-nip46-payload", "payload");
    expect(hasNip46Session()).toBe(true);
  });

  it("all three keys are distinct — no two functions use the same storage slot", () => {
    // Write all three kinds of data independently and verify isolation.
    setSavedAuthMethod("nip07");
    storage._store.set("notestr-nip46-local-key", "localpriv");
    storage._store.set("notestr-nip46-payload", "pl");

    // Three distinct keys must be present.
    expect(storage._store.size).toBeGreaterThanOrEqual(3);
    expect(storage._store.has("notestr-auth-method")).toBe(true);
    expect(storage._store.has("notestr-nip46-local-key")).toBe(true);
    expect(storage._store.has("notestr-nip46-payload")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. setSavedAuthMethod / getSavedAuthMethod — round-trip + discriminant
//
// No AC in current epics; Bucket 2 (spec-gap filed separately).
// User story: the app must recall which authentication method the user chose so
// it can reconnect automatically on next load.
// ---------------------------------------------------------------------------

describe("setSavedAuthMethod / getSavedAuthMethod", () => {
  it("round-trip: setting 'nip07' then reading back returns 'nip07'", () => {
    setSavedAuthMethod("nip07");
    expect(getSavedAuthMethod()).toBe("nip07");
  });

  it("round-trip: setting 'nip46' then reading back returns 'nip46'", () => {
    setSavedAuthMethod("nip46");
    expect(getSavedAuthMethod()).toBe("nip46");
  });

  it("null removes the stored method; getSavedAuthMethod returns null", () => {
    setSavedAuthMethod("nip07");
    setSavedAuthMethod(null);
    expect(getSavedAuthMethod()).toBe(null);
  });

  it("overwriting nip07 with nip46 reflects the latest value", () => {
    setSavedAuthMethod("nip07");
    setSavedAuthMethod("nip46");
    expect(getSavedAuthMethod()).toBe("nip46");
  });

  it("returns null when nothing has been stored", () => {
    expect(getSavedAuthMethod()).toBe(null);
  });

  it("property: only 'nip07' and 'nip46' are valid auth methods — any other stored string reads back as null", () => {
    // Mutation targets: LogicalOperator (|| → &&), EqualityOperator (!== on each arm),
    // ConditionalExpression. A single property that covers all four.
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== "nip07" && s !== "nip46"),
        (arbitrary) => {
          storage._store.set("notestr-auth-method", arbitrary);
          expect(getSavedAuthMethod()).toBe(null);
          storage._store.delete("notestr-auth-method");
        },
      ),
    );
  });

  it("property: both valid values round-trip correctly for any localStorage state prefix", () => {
    // Ensures neither method value is hard-coded (StringLiteral mutation guard).
    fc.assert(
      fc.property(
        fc.constantFrom("nip07" as const, "nip46" as const),
        fc.string(), // noise in other keys
        (method, noise) => {
          storage._store.set("unrelated-key", noise);
          setSavedAuthMethod(method);
          const result = getSavedAuthMethod();
          expect(result).toBe(method);
          storage._store.delete("notestr-auth-method");
          storage._store.delete("unrelated-key");
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. clearNip46Session — atomic cleanup, conditional auth-method removal
//
// epic-forget-this-device:AC-CLEANUP-3
// "`forgetSelfDevice` MUST call `clearNip46Session()` … to atomically clear
// `notestr-nip46-payload`, `notestr-nip46-local-key`, and (when
// `auth-method === 'nip46'`) `notestr-auth-method`."
// ---------------------------------------------------------------------------

describe("clearNip46Session (epic-forget-this-device:AC-CLEANUP-3)", () => {
  it("removes both the local-key and the payload", () => {
    storage._store.set("notestr-nip46-local-key", "privkey");
    storage._store.set("notestr-nip46-payload", "payload");
    clearNip46Session();
    expect(storage._store.has("notestr-nip46-local-key")).toBe(false);
    expect(storage._store.has("notestr-nip46-payload")).toBe(false);
  });

  it("clears auth-method when it is 'nip46'", () => {
    setSavedAuthMethod("nip46");
    storage._store.set("notestr-nip46-payload", "payload");
    clearNip46Session();
    expect(getSavedAuthMethod()).toBe(null);
  });

  it("does NOT clear auth-method when it is 'nip07' (AC-CLEANUP-3 specificity)", () => {
    // If clearNip46Session incorrectly applied the EqualityOperator mutation
    // (!== instead of ===), it would wrongly wipe a nip07 auth method.
    setSavedAuthMethod("nip07");
    storage._store.set("notestr-nip46-payload", "payload");
    clearNip46Session();
    expect(getSavedAuthMethod()).toBe("nip07");
  });

  it("is safe to call when the store is empty (no throw)", () => {
    expect(() => clearNip46Session()).not.toThrow();
    expect(getSavedAuthMethod()).toBe(null);
  });

  it("property: after clearNip46Session the payload and local-key are always absent", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }), // payload
        fc.string({ minLength: 1 }), // local-key
        fc.constantFrom("nip07" as const, "nip46" as const, null),
        (payload, localKey, priorMethod) => {
          storage._store.set("notestr-nip46-payload", payload);
          storage._store.set("notestr-nip46-local-key", localKey);
          setSavedAuthMethod(priorMethod);
          clearNip46Session();
          expect(storage._store.has("notestr-nip46-payload")).toBe(false);
          expect(storage._store.has("notestr-nip46-local-key")).toBe(false);
          // Cleanup for next iteration
          storage._store.delete("notestr-auth-method");
        },
      ),
    );
  });

  it("property: auth-method after clearNip46Session is null iff prior method was nip46", () => {
    const cases = [
      { prior: "nip07" as const, expectAfter: "nip07" },
      { prior: "nip46" as const, expectAfter: null },
      { prior: null, expectAfter: null },
    ];
    for (const { prior, expectAfter } of cases) {
      storage.clear();
      setSavedAuthMethod(prior);
      storage._store.set("notestr-nip46-payload", "p");
      clearNip46Session();
      expect(getSavedAuthMethod()).toBe(expectAfter);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. hasNip46Session — reflects NIP-46 payload presence
//
// No AC; Bucket 2. User story: the app must detect whether a saveable NIP-46
// session exists so it can offer "restore session" on startup.
// ---------------------------------------------------------------------------

describe("hasNip46Session", () => {
  it("returns false when no payload is stored", () => {
    expect(hasNip46Session()).toBe(false);
  });

  it("returns true when a payload is stored", () => {
    storage._store.set("notestr-nip46-payload", "any_payload");
    expect(hasNip46Session()).toBe(true);
  });

  it("returns false after clearNip46Session removes the payload", () => {
    storage._store.set("notestr-nip46-payload", "payload");
    clearNip46Session();
    expect(hasNip46Session()).toBe(false);
  });

  it("property: result truthfully mirrors the NIP-46 payload store for arbitrary payload strings", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (payload) => {
        storage._store.delete("notestr-nip46-payload");
        expect(hasNip46Session()).toBe(false);

        storage._store.set("notestr-nip46-payload", payload);
        expect(hasNip46Session()).toBe(true);

        storage._store.delete("notestr-nip46-payload");
        expect(hasNip46Session()).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. shortenPubkey — output contract over arbitrary string input
//
// No AC; Bucket 2. User story: pubkeys are displayed as an abbreviated form
// (first 8 + "…" + last 4) for readability in the UI.
// ---------------------------------------------------------------------------

describe("shortenPubkey", () => {
  it("returns first-8 + '...' + last-4 for a typical hex pubkey", () => {
    const pubkey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(shortenPubkey(pubkey)).toBe("01234567...cdef");
  });

  it("property: output is always slice(0,8) + '...' + slice(-4) for any string ≥ 12 chars", () => {
    // Mutation targets: MethodExpression (slice removed), StringLiteral ("..." → ""),
    // UnaryOperator (-4 → +4). One property kills the entire cluster.
    fc.assert(
      fc.property(fc.string({ minLength: 12 }), (pubkey) => {
        expect(shortenPubkey(pubkey)).toBe(
          pubkey.slice(0, 8) + "..." + pubkey.slice(-4),
        );
      }),
    );
  });

  it("the result always contains the '...' separator", () => {
    // Covers StringLiteral mutation ("..." → ""). Complements the output-contract
    // property above without splitting on the separator (which is fragile when
    // the first-8-chars slice itself contains dots).
    const pubkey = "deadbeef01234567";
    expect(shortenPubkey(pubkey)).toContain("...");
    expect(shortenPubkey(pubkey).length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// 6. npubToHex — type guard + delegation
//
// No AC; Bucket 2. User story: the app must convert npub-encoded identifiers to
// raw hex before use in MLS or NDK APIs; feeding a non-npub bech32 (e.g. an
// naddr or nsec) must be rejected with a clear error.
// ---------------------------------------------------------------------------

describe("npubToHex", () => {
  it("returns the hex data field when decode reports type 'npub'", () => {
    mockDecode.mockReturnValue({ type: "npub", data: "deadbeef" });
    expect(npubToHex("npub1whatever")).toBe("deadbeef");
  });

  it("throws when decode returns a type other than 'npub'", () => {
    mockDecode.mockReturnValue({ type: "naddr", data: "something" });
    expect(() => npubToHex("naddr1whatever")).toThrow(/Expected npub/);
  });

  it("property: throws for any non-npub type and the error message names that type", () => {
    // Mutation targets: EqualityOperator (!== → ===), ConditionalExpression (true/false).
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((t) => t !== "npub"),
        (wrongType) => {
          mockDecode.mockReturnValue({ type: wrongType, data: "" });
          expect(() => npubToHex("any")).toThrow(wrongType);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. hexToNpub — delegation to npubEncode, must return a value
//
// No AC; Bucket 2. User story: hex pubkeys must be convertible to npub format
// for display in the UI and in nostr protocol fields.
// ---------------------------------------------------------------------------

describe("hexToNpub", () => {
  it("returns the value produced by npubEncode", () => {
    mockNpubEncode.mockReturnValue("npub1encodedvalue");
    const result = hexToNpub("deadbeef".repeat(8));
    expect(result).toBe("npub1encodedvalue");
  });

  it("property: result is always the value returned by npubEncode for arbitrary hex input", () => {
    // Mutation target: BlockStatement (body emptied → returns undefined).
    fc.assert(
      fc.property(fc.hexaString({ minLength: 64, maxLength: 64 }), (hex) => {
        const encoded = `npub1${hex.slice(0, 8)}`;
        mockNpubEncode.mockReturnValue(encoded);
        expect(hexToNpub(hex)).toBe(encoded);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. getNip07Signer — window.nostr guard
//
// No AC; Bucket 2. User story: the app must detect and use a NIP-07 browser
// extension when present, and degrade gracefully (offer only NIP-46) when absent.
// ---------------------------------------------------------------------------

describe("getNip07Signer", () => {
  beforeEach(() => {
    // Provide a minimal window object so the window.nostr check in getNip07Signer
    // does not throw ReferenceError in the node test environment.
    vi.stubGlobal("window", { nostr: undefined });
  });

  it("returns null when window.nostr is absent", () => {
    // window is stubbed above with nostr: undefined — falsy check returns null.
    expect(getNip07Signer()).toBe(null);
  });

  it("returns the window.nostr object when it is present", () => {
    const fakeNostr = { signEvent: vi.fn(), getPublicKey: vi.fn() };
    vi.stubGlobal("window", { nostr: fakeNostr });
    expect(getNip07Signer()).toBe(fakeNostr);
  });

  it("property: returns null for any falsy window.nostr value", () => {
    // Mutation targets: BooleanLiteral (!window.nostr → window.nostr),
    // ConditionalExpression (guard → always-true / always-false).
    const falsyValues = [undefined, null, 0, "", false] as const;
    for (const falsy of falsyValues) {
      vi.stubGlobal("window", { nostr: falsy });
      expect(getNip07Signer()).toBe(null);
    }
  });

  it("property: always returns the exact window.nostr object (identity, not a copy) when truthy", () => {
    fc.assert(
      fc.property(fc.boolean(), (addExtra) => {
        const fakeNostr = addExtra
          ? { signEvent: vi.fn(), getPublicKey: vi.fn(), extra: true }
          : { signEvent: vi.fn(), getPublicKey: vi.fn() };
        vi.stubGlobal("window", { nostr: fakeNostr });
        vi.stubGlobal("localStorage", storage);
        const result = getNip07Signer();
        expect(result).toBe(fakeNostr);
      }),
    );
  });
});
