import { bootstrapCompletedStore, deviceNamesStore, invitedKeysStore, joinedGroupsStore } from "./storage";

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

/**
 * Records that the local context joined the given group via a Welcome
 * message (i.e. it is not the originating creator). Survives page reloads
 * via IndexedDB so the auto-invite logic can suppress sibling-device
 * invites even after key-package rotations have removed the proof from
 * the live KP list.
 */
export async function markGroupJoinedFromWelcome(groupId: string): Promise<void> {
  await joinedGroupsStore.setItem(groupId, true);
}

export async function isGroupJoinedFromWelcome(groupId: string): Promise<boolean> {
  return (await joinedGroupsStore.getItem(groupId)) === true;
}

export async function forgetJoinedGroup(groupId: string): Promise<void> {
  await joinedGroupsStore.removeItem(groupId);
}

/**
 * Records that the task-state bootstrap for this group completed successfully
 * (i.e. fetchAndApplyTaskBootstrap returned at least one task). Once marked,
 * the bootstrap is never re-attempted on subsequent loads, regardless of the
 * local event-log length. This decouples the "bootstrap done" signal from
 * events.length so a relay-propagation race cannot permanently suppress
 * bootstrap when live task events arrive before kind-30078 does.
 */
export async function markBootstrapCompleted(groupId: string): Promise<void> {
  await bootstrapCompletedStore.setItem(groupId, true);
}

export async function isBootstrapCompleted(groupId: string): Promise<boolean> {
  return (await bootstrapCompletedStore.getItem(groupId)) === true;
}

/**
 * Clears the bootstrap-completed flag for a group. Call this whenever the
 * local membership of the group is reset (leave, self-forget) so that a
 * future re-invite to the same group.idStr triggers a fresh bootstrap fetch
 * rather than silently skipping it.
 */
export async function forgetBootstrapCompleted(groupId: string): Promise<void> {
  await bootstrapCompletedStore.removeItem(groupId);
}
