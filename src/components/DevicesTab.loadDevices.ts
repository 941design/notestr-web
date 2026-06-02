/**
 * DevicesTab.loadDevices.ts
 *
 * Pure device-loading logic extracted from DevicesTab's load effect so it can
 * be unit-tested in the repo's node/vitest idiom (no component-rendering stack).
 *
 * Data source: union of
 *   (a) client.keyPackages.list() — local IDB key packages
 *   (b) client.network.request(relays, keyPackageFilters([pubkey])) — relay-fetched
 *       kind-30443 events authored by the local pubkey
 *
 * The relay fetch is non-fatal: if it fails, we still return the local devices
 * and a `relayFetchError` flag so the caller can surface a visible warning
 * (the failure used to be swallowed silently).
 */

import {
  keyPackageFilters,
  getKeyPackageIdentifier,
} from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";

export type DeviceEntry = {
  /** Slot identifier (d-tag value of the kind-30443 event). */
  slot: string;
  /** Earliest published event's created_at, or 0 if unknown. */
  createdAt: number;
  /** True when this is the current device. */
  isLocal: boolean;
};

/** Minimal structural shape of the marmot client needed to load devices. */
export interface DeviceLoaderClient {
  keyPackages: {
    list: () => Promise<Array<{ identifier?: string; published?: NostrEvent[] } & Record<string, unknown>>>;
  };
  network: {
    request: (relays: string[], filters: unknown) => Promise<NostrEvent[]>;
  };
}

export interface LoadDevicesResult {
  entries: DeviceEntry[];
  /** True when the relay fetch failed; local devices are still returned. */
  relayFetchError: boolean;
}

function extractSlot(
  kp: { identifier?: string } & Record<string, unknown>,
): string | undefined {
  if (typeof kp.identifier === "string" && kp.identifier.length > 0) {
    return kp.identifier;
  }
  const d = (kp as { d?: unknown }).d;
  if (typeof d === "string" && d.length > 0) {
    return d;
  }
  return undefined;
}

export async function loadDevices(
  client: DeviceLoaderClient,
  pubkey: string,
  clientId: string,
  relays: string[],
): Promise<LoadDevicesResult> {
  // (a) Local key packages from IDB.
  const localKps = await client.keyPackages.list();

  // Build a map of slot → createdAt from local KPs.
  const slotMap = new Map<string, number>();

  for (const kp of localKps) {
    const slot = extractSlot(kp);
    if (!slot) continue;
    // Use the earliest published event's created_at as the "registered" time.
    const earliest = (kp.published ?? []).reduce(
      (min: number, ev: NostrEvent) => (ev.created_at < min ? ev.created_at : min),
      Infinity,
    );
    slotMap.set(slot, earliest === Infinity ? 0 : earliest);
  }

  // Always ensure our own clientId appears even if not yet in IDB
  // (e.g. client just initialised but not yet published).
  if (clientId && !slotMap.has(clientId)) {
    slotMap.set(clientId, 0);
  }

  // (b) Relay-fetched kind-30443 events authored by our pubkey.
  let relayFetchError = false;
  if (relays.length > 0) {
    try {
      const relayEvents = await client.network.request(
        relays,
        keyPackageFilters([pubkey]),
      );
      for (const event of relayEvents) {
        const slot =
          getKeyPackageIdentifier(event) ??
          event.tags.find((t) => t[0] === "d")?.[1];
        if (!slot) continue;
        if (!slotMap.has(slot) || slotMap.get(slot) === 0) {
          slotMap.set(slot, event.created_at ?? 0);
        }
      }
    } catch {
      // Relay fetch failure is non-fatal — we still return local devices, but
      // we flag it so the caller can warn that the list may be incomplete.
      relayFetchError = true;
    }
  }

  const entries: DeviceEntry[] = Array.from(slotMap.entries()).map(
    ([slot, createdAt]) => ({
      slot,
      createdAt,
      isLocal: slot === clientId,
    }),
  );

  // Sort: local device first, then by createdAt descending.
  entries.sort((a, b) => {
    if (a.isLocal && !b.isLocal) return -1;
    if (!a.isLocal && b.isLocal) return 1;
    return b.createdAt - a.createdAt;
  });

  return { entries, relayFetchError };
}
