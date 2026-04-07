import { beforeEach, describe, expect, it, vi } from "vitest";

const deviceNamesData = new Map<string, unknown>();
const invitedKeysData = new Map<string, unknown>();

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
}));

import {
  clearInvitedKeysForGroup,
  defaultDeviceName,
  getDeviceName,
  listDevices,
  markDeviceSeen,
  persistInvitedKey,
  loadInvitedKeys,
  setDeviceName,
} from "./device-store";

describe("device-store", () => {
  beforeEach(() => {
    deviceNamesData.clear();
    invitedKeysData.clear();
  });

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
});
