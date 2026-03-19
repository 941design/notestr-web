import { getGroupMembers, type MarmotGroup } from "@internet-privacy/marmot-ts";

export function computeDetachedGroupIds(
  groups: MarmotGroup[],
  pubkey: string,
): Set<string> {
  const set = new Set<string>();
  for (const group of groups) {
    if (!group.state) continue;
    const members = getGroupMembers(group.state);
    if (!members.includes(pubkey)) {
      set.add(group.idStr);
    }
  }
  return set;
}
