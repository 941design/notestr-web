import type { MarmotGroup } from "@internet-privacy/marmot-ts";

/** Strips the `wss://` or `ws://` prefix from a relay URL. */
export function abbreviateRelay(url: string): string {
  return url.replace(/^wss?:\/\//, "");
}

/** Returns true if the string is a valid ws:// or wss:// URL. */
export function isValidRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

/** Returns the group's relays, falling back to the provided default. */
export function getGroupRelays(
  group: MarmotGroup,
  fallback: string[],
): string[] {
  const relays = group.relays;
  return relays && relays.length > 0 ? relays : fallback;
}

/** Returns the deduplicated union of all group relays plus the fallback set. */
export function computeAllGroupRelays(
  groups: MarmotGroup[],
  fallback: string[],
): string[] {
  const set = new Set<string>(fallback);
  for (const group of groups) {
    for (const relay of getGroupRelays(group, fallback)) {
      set.add(relay);
    }
  }
  return Array.from(set);
}
