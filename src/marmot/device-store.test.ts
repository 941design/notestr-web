import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const deviceNamesData = new Map<string, unknown>();
const invitedKeysData = new Map<string, unknown>();
const joinedGroupsData = new Map<string, unknown>();
const bootstrapCompletedData = new Map<string, unknown>();

vi.mock("./storage", () => ({
  deviceNamesStore: {
    async getItem(key: string) {
      return (deviceNamesData.get(key) as any) ?? null;
    },
    async setItem(key: string, value: unknown) {
      deviceNamesData.set(key, value);
      return value;
    },
    async removeItem(key: string) {
      deviceNamesData.delete(key);
    },
    async keys() {
      return Array.from(deviceNamesData.keys());
    },
  },
  invitedKeysStore: {
    async getItem(key: string) {
      return (invitedKeysData.get(key) as any) ?? null;
    },
    async setItem(key: string, value: unknown) {
      invitedKeysData.set(key, value);
      return value;
    },
    async removeItem(key: string) {
      invitedKeysData.delete(key);
    },
    async keys() {
      return Array.from(invitedKeysData.keys());
    },
  },
  joinedGroupsStore: {
    async getItem(key: string) {
      return (joinedGroupsData.get(key) as any) ?? null;
    },
    async setItem(key: string, value: unknown) {
      joinedGroupsData.set(key, value);
      return value;
    },
    async removeItem(key: string) {
      joinedGroupsData.delete(key);
    },
    async keys() {
      return Array.from(joinedGroupsData.keys());
    },
  },
  bootstrapCompletedStore: {
    async getItem(key: string) {
      return (bootstrapCompletedData.get(key) as any) ?? null;
    },
    async setItem(key: string, value: unknown) {
      bootstrapCompletedData.set(key, value);
      return value;
    },
    async removeItem(key: string) {
      bootstrapCompletedData.delete(key);
    },
    async clear() {
      bootstrapCompletedData.clear();
    },
    async keys() {
      return Array.from(bootstrapCompletedData.keys());
    },
  },
}));

import {
  clearInvitedKeysForGroup,
  defaultDeviceName,
  forgetBootstrapCompleted,
  forgetJoinedGroup,
  getDeviceMetadata,
  getDeviceName,
  isBootstrapCompleted,
  isGroupJoinedFromWelcome,
  listDevices,
  loadInvitedKeys,
  markBootstrapCompleted,
  markDeviceSeen,
  markGroupJoinedFromWelcome,
  persistInvitedKey,
  setDeviceName,
} from "./device-store";

// Arbitraries shared across properties.
//
// `clientIdArb` keeps the input space wide enough to exercise the slice(0, 6)
// branch in defaultDeviceName (long ids), one-char ids (shorter than the
// slice window), and Unicode (the trim mutant is meaningful only when
// surrounding whitespace exists). Avoid the empty string because
// `defaultDeviceName("")` returns `"device-"` which is technically valid
// but uninteresting and complicates the local-vs-non-local discrimination
// (the AND-short-circuit collapses when clientId === "" === localClientId).
const clientIdArb = fc.string({ minLength: 1, maxLength: 32 });

// Names with optional leading/trailing whitespace. The interior must contain
// at least one non-whitespace char so the post-trim string is non-empty —
// that lets the same arbitrary drive both the "rename to N is persisted"
// and "trim is observable" properties.
const nonEmptyNameArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s.trim().length > 0);

const whitespacePadArb = fc.stringMatching(/^[ \t]{0,4}$/);

const paddedNameArb = fc
  .tuple(whitespacePadArb, nonEmptyNameArb, whitespacePadArb)
  .map(([lead, body, trail]) => ({
    raw: `${lead}${body}${trail}`,
    trimmed: `${lead}${body}${trail}`.trim(),
  }));

// Whitespace-only strings (including empty). Drives the fallback-to-default
// behavior path for setDeviceName and markDeviceSeen's fallbackName option.
const whitespaceOnlyArb = fc.stringMatching(/^[ \t\n]*$/);

const groupIdArb = fc.string({ minLength: 1, maxLength: 20 });

describe("device-store", () => {
  beforeEach(() => {
    deviceNamesData.clear();
    invitedKeysData.clear();
    joinedGroupsData.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Example-based smoke tests (the original test suite).
  // -------------------------------------------------------------------------

  it("uses a friendly default name for the local device", () => {
    expect(defaultDeviceName("notestr-local", "notestr-local")).toBe(
      "this browser",
    );
  });

  it("persists a renamed device", async () => {
    await markDeviceSeen("device-123456", { localClientId: "other-device" });
    await setDeviceName("device-123456", "Work Laptop");

    expect(await getDeviceName("device-123456")).toBe("Work Laptop");
  });

  it("lists devices in name order", async () => {
    await setDeviceName("device-b", "Beta");
    await setDeviceName("device-a", "Alpha");

    const devices = await listDevices();
    expect(devices.map((device) => device.name)).toEqual(["Alpha", "Beta"]);
  });

  it("tracks invited keys per group", async () => {
    await persistInvitedKey("group-a:event-1");
    await persistInvitedKey("group-b:event-2");
    await clearInvitedKeysForGroup("group-a");

    expect(await loadInvitedKeys()).toEqual(["group-b:event-2"]);
  });

  // -------------------------------------------------------------------------
  // Property: defaultDeviceName output contract.
  //
  // Story: a per-browser device identifier surfaces in the UI as either a
  // recognisable "this browser" label (when it matches the locally-running
  // browser) or a short, deterministic synthetic name derived from the
  // first six characters of the clientId.
  //
  // (no AC; see BACKLOG finding device-store-default-name-contract)
  // Family C — output contract over arbitrary input.
  // -------------------------------------------------------------------------
  it("defaultDeviceName: returns 'this browser' iff localClientId === clientId, else 'device-<slot[0..6]>'", () => {
    fc.assert(
      fc.property(clientIdArb, clientIdArb, (clientId, other) => {
        // local match
        expect(defaultDeviceName(clientId, clientId)).toBe("this browser");

        // localClientId undefined → never "this browser"
        expect(defaultDeviceName(clientId, undefined)).toBe(
          `device-${clientId.slice(0, 6)}`,
        );

        // localClientId provided but different → not "this browser"
        if (other !== clientId) {
          expect(defaultDeviceName(clientId, other)).toBe(
            `device-${clientId.slice(0, 6)}`,
          );
        }
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Property: rename round-trip identity (Family B inverse).
  //
  // Story: when a user renames a device to a non-empty name, that name is
  // what they see when they later look up the device — independent of any
  // leading or trailing whitespace they happened to type.
  //
  // (no AC; see BACKLOG finding device-store-rename-roundtrip)
  // -------------------------------------------------------------------------
  it("setDeviceName then getDeviceName returns the trimmed name", async () => {
    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        paddedNameArb,
        async (clientId, { raw, trimmed }) => {
          deviceNamesData.clear();
          await setDeviceName(clientId, raw);
          const observed = await getDeviceName(clientId);
          expect(observed).toBe(trimmed);
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: whitespace-only rename falls back to the synthetic default
  // (Family B specificity).
  //
  // Story: a user cannot accidentally erase a device's recognisable label
  // by submitting whitespace — the system substitutes the deterministic
  // synthetic name instead.
  //
  // (no AC; see BACKLOG finding device-store-rename-roundtrip)
  // -------------------------------------------------------------------------
  it("setDeviceName: whitespace-only name resolves to defaultDeviceName(clientId)", async () => {
    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        whitespaceOnlyArb,
        async (clientId, blankName) => {
          deviceNamesData.clear();
          await setDeviceName(clientId, blankName);
          const observed = await getDeviceName(clientId);
          // setDeviceName falls back without a localClientId hint; the
          // observable name must match the corresponding default.
          expect(observed).toBe(defaultDeviceName(clientId));
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: getDeviceName fallback for unknown ids (Family B isolation).
  //
  // Story: looking up a device the local browser has never recorded yields
  // the same recognisable synthetic name a freshly-seen device would.
  //
  // (no AC; see BACKLOG finding device-store-rename-roundtrip)
  // -------------------------------------------------------------------------
  it("getDeviceName: unknown clientId resolves to defaultDeviceName(clientId, localClientId)", async () => {
    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        clientIdArb,
        async (clientId, localClientId) => {
          deviceNamesData.clear();
          const observed = await getDeviceName(clientId, localClientId);
          expect(observed).toBe(defaultDeviceName(clientId, localClientId));
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: markDeviceSeen create→re-see preserves firstSeen, advances
  // lastSeen (Family B idempotence + monotonicity).
  //
  // Story: every browser remembers the first time it learned about each
  // device and the most recent time it observed it; observing the same
  // device again never rewinds either timestamp.
  //
  // (no AC; see BACKLOG finding device-store-device-metadata-timestamps)
  // -------------------------------------------------------------------------
  it("markDeviceSeen: firstSeen is fixed at first sighting; lastSeen advances on re-seen", async () => {
    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        fc.integer({ min: 1, max: 60_000 }),
        async (clientId, deltaMs) => {
          deviceNamesData.clear();
          vi.useFakeTimers();
          const t0 = 1_700_000_000_000;
          vi.setSystemTime(t0);

          const first = await markDeviceSeen(clientId);
          expect(first.clientId).toBe(clientId);
          expect(first.firstSeen).toBe(t0);
          expect(first.lastSeen).toBe(t0);

          vi.setSystemTime(t0 + deltaMs);
          const second = await markDeviceSeen(clientId);

          // identity preserved
          expect(second.clientId).toBe(clientId);
          // firstSeen never advances after the first sighting
          expect(second.firstSeen).toBe(t0);
          // lastSeen advances to the new clock
          expect(second.lastSeen).toBe(t0 + deltaMs);
          // name is also preserved across the re-sighting
          expect(second.name).toBe(first.name);
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: markDeviceSeen returns the persisted record (Family B
  // round-trip via the real getter).
  //
  // Story: the value markDeviceSeen returns is the same record any later
  // reader will see — callers don't need a second read to obtain it.
  //
  // (no AC; see BACKLOG finding device-store-device-metadata-timestamps)
  // -------------------------------------------------------------------------
  it("markDeviceSeen: return value equals subsequent getDeviceMetadata", async () => {
    await fc.assert(
      fc.asyncProperty(clientIdArb, async (clientId) => {
        deviceNamesData.clear();
        const returned = await markDeviceSeen(clientId);
        const fetched = await getDeviceMetadata(clientId);
        expect(fetched).toEqual(returned);
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Property: fallbackName option is used when non-empty (Family B
  // specificity).
  //
  // Story: when a caller supplies a friendly fallback name as part of
  // recording a sighting, that name appears in the UI (after trimming) —
  // unless the caller's fallback is itself whitespace-only, in which case
  // the synthetic default takes over.
  //
  // (no AC; see BACKLOG finding device-store-rename-roundtrip)
  // -------------------------------------------------------------------------
  it("markDeviceSeen: fallbackName is honoured when non-empty, otherwise default name", async () => {
    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        paddedNameArb,
        async (clientId, { raw, trimmed }) => {
          deviceNamesData.clear();
          const created = await markDeviceSeen(clientId, {
            fallbackName: raw,
          });
          expect(created.name).toBe(trimmed);
          expect(await getDeviceName(clientId)).toBe(trimmed);
        },
      ),
    );

    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        whitespaceOnlyArb,
        clientIdArb,
        async (clientId, blank, localClientId) => {
          deviceNamesData.clear();
          const created = await markDeviceSeen(clientId, {
            fallbackName: blank,
            localClientId,
          });
          expect(created.name).toBe(
            defaultDeviceName(clientId, localClientId),
          );
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: setDeviceName preserves firstSeen across renames (Family B
  // isolation: renaming does not affect the first-sighting timestamp).
  //
  // Story: renaming a device doesn't make it look "newly discovered" —
  // its first-sighted timestamp is independent of its display name.
  //
  // (no AC; see BACKLOG finding device-store-device-metadata-timestamps)
  // -------------------------------------------------------------------------
  it("setDeviceName: rename preserves firstSeen, advances lastSeen", async () => {
    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        nonEmptyNameArb,
        fc.integer({ min: 1, max: 60_000 }),
        async (clientId, newName, deltaMs) => {
          deviceNamesData.clear();
          vi.useFakeTimers();
          const t0 = 1_700_000_000_000;
          vi.setSystemTime(t0);

          const created = await markDeviceSeen(clientId);
          const originalFirstSeen = created.firstSeen;

          vi.setSystemTime(t0 + deltaMs);
          await setDeviceName(clientId, newName);

          const fetched = await getDeviceMetadata(clientId);
          expect(fetched).not.toBeNull();
          expect(fetched!.firstSeen).toBe(originalFirstSeen);
          expect(fetched!.lastSeen).toBe(t0 + deltaMs);
          expect(fetched!.name).toBe(newName.trim());
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: setDeviceName on a never-seen device records firstSeen as
  // the current clock (Family B: the create branch of setDeviceName).
  //
  // Story: naming a device the browser has never seen before still records
  // when this browser first learned about it.
  //
  // (no AC; see BACKLOG finding device-store-device-metadata-timestamps)
  // -------------------------------------------------------------------------
  it("setDeviceName: new device records firstSeen === lastSeen === now()", async () => {
    await fc.assert(
      fc.asyncProperty(
        clientIdArb,
        nonEmptyNameArb,
        async (clientId, name) => {
          deviceNamesData.clear();
          vi.useFakeTimers();
          const t0 = 1_700_000_000_000;
          vi.setSystemTime(t0);

          await setDeviceName(clientId, name);
          const fetched = await getDeviceMetadata(clientId);
          expect(fetched).not.toBeNull();
          expect(fetched!.firstSeen).toBe(t0);
          expect(fetched!.lastSeen).toBe(t0);
          expect(fetched!.name).toBe(name.trim());
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: listDevices excludes vanished entries and sorts by name
  // (Family C output contract + monotonicity).
  //
  // Story: the device list never surfaces "phantom" rows for entries that
  // disappeared between enumeration and read, and devices appear in a
  // stable, name-sorted order users can scan.
  //
  // (no AC; see BACKLOG finding device-store-list-devices-contract)
  // -------------------------------------------------------------------------
  it("listDevices: skips null entries and returns results sorted by name", async () => {
    // Tampered store that exposes a key whose getItem yields null —
    // simulates the keys()/getItem() race the production filter guards.
    vi.resetModules();
    deviceNamesData.clear();

    // Seed two real devices and one "ghost" key.
    await setDeviceName("real-a", "Charlie");
    await setDeviceName("real-b", "Alpha");
    deviceNamesData.set("ghost-key", null);

    const devices = await listDevices();

    // No null leaks past the filter.
    for (const device of devices) {
      expect(device).not.toBeNull();
      expect(typeof device.clientId).toBe("string");
    }

    // Ghost is excluded.
    expect(devices.map((d) => d.clientId)).not.toContain("ghost-key");

    // Result is sorted by name (localeCompare).
    const names = devices.map((d) => d.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  // -------------------------------------------------------------------------
  // Property: clearInvitedKeysForGroup specificity (Family B independence).
  //
  // Story: clearing the invited-keys cache for one group never touches
  // entries for sibling groups.
  //
  // (no AC; see BACKLOG finding device-store-invited-keys-contract)
  // -------------------------------------------------------------------------
  it("clearInvitedKeysForGroup: removes only keys with the matching group prefix", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.string({ minLength: 1, maxLength: 8 }).filter(
            (s) => !s.includes(":"),
          ),
          { minLength: 2, maxLength: 4 },
        ),
        async (groupIds) => {
          invitedKeysData.clear();
          // Two keys per group.
          for (const g of groupIds) {
            await persistInvitedKey(`${g}:k1`);
            await persistInvitedKey(`${g}:k2`);
          }

          const target = groupIds[0];
          await clearInvitedKeysForGroup(target);

          const remaining = await loadInvitedKeys();

          // None of the target's keys remain.
          for (const key of remaining) {
            expect(key.startsWith(`${target}:`)).toBe(false);
          }

          // All sibling groups' keys remain.
          for (const g of groupIds.slice(1)) {
            expect(remaining).toContain(`${g}:k1`);
            expect(remaining).toContain(`${g}:k2`);
          }
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property: markGroupJoinedFromWelcome round-trip (Family B inverse pair).
  //
  // Story: once a browser records that it joined a group via a Welcome
  // message, it can later answer "did I join this from a Welcome?" with
  // a stable yes — and never confuses sibling groups.
  //
  // (no AC; see BACKLOG finding device-store-joined-groups-contract)
  // -------------------------------------------------------------------------
  it("markGroupJoinedFromWelcome then isGroupJoinedFromWelcome returns true; never-marked returns false", async () => {
    await fc.assert(
      fc.asyncProperty(groupIdArb, groupIdArb, async (marked, other) => {
        joinedGroupsData.clear();
        // Never-marked: false.
        expect(await isGroupJoinedFromWelcome(marked)).toBe(false);

        await markGroupJoinedFromWelcome(marked);
        expect(await isGroupJoinedFromWelcome(marked)).toBe(true);

        // Isolation: marking `marked` doesn't flip `other` (unless equal).
        if (other !== marked) {
          expect(await isGroupJoinedFromWelcome(other)).toBe(false);
        }
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Property: forgetJoinedGroup is the inverse of mark (Family B inverse).
  //
  // Story: after explicitly forgetting that the browser joined a group via
  // a Welcome, the system no longer reports it as joined-from-welcome.
  //
  // (no AC; see BACKLOG finding device-store-joined-groups-contract)
  // -------------------------------------------------------------------------
  it("forgetJoinedGroup undoes markGroupJoinedFromWelcome; forgetting an unmarked id is a no-op", async () => {
    await fc.assert(
      fc.asyncProperty(groupIdArb, async (groupId) => {
        joinedGroupsData.clear();

        // Forgetting an unmarked id leaves the state unchanged.
        await forgetJoinedGroup(groupId);
        expect(await isGroupJoinedFromWelcome(groupId)).toBe(false);

        // mark → forget → not-joined.
        await markGroupJoinedFromWelcome(groupId);
        await forgetJoinedGroup(groupId);
        expect(await isGroupJoinedFromWelcome(groupId)).toBe(false);

        // mark → forget → mark recovers the joined state.
        await markGroupJoinedFromWelcome(groupId);
        expect(await isGroupJoinedFromWelcome(groupId)).toBe(true);
      }),
    );
  });
});

// -------------------------------------------------------------------------
// Bootstrap-completed flag (markBootstrapCompleted / isBootstrapCompleted /
// forgetBootstrapCompleted)
//
// These three functions form the lifecycle of the per-group bootstrap flag.
// Correctness invariants:
//   (a) mark → is = true (round-trip)
//   (b) forget is the inverse of mark (forget → is = false)
//   (c) forget on an unmarked id is a no-op (no throw, is still false)
//   (d) separate group IDs are independent (marking one does not affect another)
//   (e) forgetBootstrapCompleted does not clear joinedGroupsStore (stores are isolated)
//   (f) re-join scenario: mark → forget → mark → is = true (flag is reusable)
// -------------------------------------------------------------------------
describe("bootstrap-completed flag", () => {
  afterEach(() => {
    bootstrapCompletedData.clear();
    joinedGroupsData.clear();
  });

  // (a) round-trip
  it("markBootstrapCompleted then isBootstrapCompleted returns true; unmarked group returns false", async () => {
    await fc.assert(
      fc.asyncProperty(groupIdArb, async (groupId) => {
        bootstrapCompletedData.clear();

        expect(await isBootstrapCompleted(groupId)).toBe(false);
        await markBootstrapCompleted(groupId);
        expect(await isBootstrapCompleted(groupId)).toBe(true);
      }),
    );
  });

  // (b) forget is the inverse of mark
  it("forgetBootstrapCompleted undoes markBootstrapCompleted; forgetting an unmarked id is a no-op", async () => {
    await fc.assert(
      fc.asyncProperty(groupIdArb, async (groupId) => {
        bootstrapCompletedData.clear();

        // Forgetting an unmarked id is a no-op (no throw).
        await forgetBootstrapCompleted(groupId);
        expect(await isBootstrapCompleted(groupId)).toBe(false);

        // mark → forget → false.
        await markBootstrapCompleted(groupId);
        await forgetBootstrapCompleted(groupId);
        expect(await isBootstrapCompleted(groupId)).toBe(false);
      }),
    );
  });

  // (d) store isolation between group IDs
  it("marking one group does not affect another group's flag", async () => {
    await fc.assert(
      fc.asyncProperty(
        groupIdArb,
        groupIdArb.filter((b) => b !== "group-a"),
        async (groupA, groupB) => {
          bootstrapCompletedData.clear();
          const id1 = "group-a";
          const id2 = groupA === id1 ? groupB : groupA;

          await markBootstrapCompleted(id1);
          expect(await isBootstrapCompleted(id1)).toBe(true);
          expect(await isBootstrapCompleted(id2)).toBe(false);
        },
      ),
    );
  });

  // (e) forgetBootstrapCompleted does not touch joinedGroupsStore
  it("forgetBootstrapCompleted does not clear the joined-from-welcome flag for the same group", async () => {
    const groupId = "test-group-isolation";
    await markGroupJoinedFromWelcome(groupId);
    await markBootstrapCompleted(groupId);

    await forgetBootstrapCompleted(groupId);

    // bootstrap flag cleared
    expect(await isBootstrapCompleted(groupId)).toBe(false);
    // joined-from-welcome flag untouched
    expect(await isGroupJoinedFromWelcome(groupId)).toBe(true);
  });

  // (f) re-join scenario: flag is reusable after forget
  it("re-join scenario: mark → forget → mark recovers completed state", async () => {
    const groupId = "rejoin-group";

    await markBootstrapCompleted(groupId);
    expect(await isBootstrapCompleted(groupId)).toBe(true);

    // Leave clears the flag.
    await forgetBootstrapCompleted(groupId);
    expect(await isBootstrapCompleted(groupId)).toBe(false);

    // Re-join and bootstrap again — flag can be set again.
    await markBootstrapCompleted(groupId);
    expect(await isBootstrapCompleted(groupId)).toBe(true);
  });
});
