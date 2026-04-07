import { deviceNamesStore, invitedKeysStore } from "./storage";

export interface DeviceMetadata {
  clientId: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
}

function now(): number {
  return Date.now();
}

export function defaultDeviceName(
  clientId: string,
  localClientId?: string,
): string {
  if (localClientId && clientId === localClientId) {
    return "this browser";
  }

  return `device-${clientId.slice(0, 6)}`;
}

function normalizeDeviceName(name: string): string {
  return name.trim();
}

export async function getDeviceMetadata(
  clientId: string,
): Promise<DeviceMetadata | null> {
  return deviceNamesStore.getItem(clientId);
}

export async function markDeviceSeen(
  clientId: string,
  options: {
    localClientId?: string;
    fallbackName?: string;
  } = {},
): Promise<DeviceMetadata> {
  const existing = await getDeviceMetadata(clientId);
  const timestamp = now();

  if (existing) {
    const updated: DeviceMetadata = {
      ...existing,
      lastSeen: timestamp,
    };
    await deviceNamesStore.setItem(clientId, updated);
    return updated;
  }

  const created: DeviceMetadata = {
    clientId,
    name:
      normalizeDeviceName(options.fallbackName ?? "") ||
      defaultDeviceName(clientId, options.localClientId),
    firstSeen: timestamp,
    lastSeen: timestamp,
  };
  await deviceNamesStore.setItem(clientId, created);
  return created;
}

export async function getDeviceName(
  clientId: string,
  localClientId?: string,
): Promise<string> {
  const existing = await getDeviceMetadata(clientId);
  return existing?.name ?? defaultDeviceName(clientId, localClientId);
}

export async function setDeviceName(
  clientId: string,
  name: string,
): Promise<void> {
  const existing = await getDeviceMetadata(clientId);
  const normalized = normalizeDeviceName(name);
  const timestamp = now();
  const next: DeviceMetadata = {
    clientId,
    name: normalized || defaultDeviceName(clientId),
    firstSeen: existing?.firstSeen ?? timestamp,
    lastSeen: timestamp,
  };
  await deviceNamesStore.setItem(clientId, next);
}

export async function listDevices(): Promise<DeviceMetadata[]> {
  const keys = await deviceNamesStore.keys();
  const devices = await Promise.all(keys.map((key) => getDeviceMetadata(key)));
  return devices
    .filter((device): device is DeviceMetadata => device !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadInvitedKeys(): Promise<string[]> {
  return invitedKeysStore.keys();
}

export async function persistInvitedKey(key: string): Promise<void> {
  await invitedKeysStore.setItem(key, true);
}

export async function clearInvitedKeysForGroup(groupId: string): Promise<void> {
  const keys = await invitedKeysStore.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(`${groupId}:`))
      .map((key) => invitedKeysStore.removeItem(key)),
  );
}
