import { useEffect, useRef } from "react";

import {
  getGroupMembers,
  getNostrGroupIdHex,
  InviteReader,
  isAdmin,
  deserializeApplicationData,
  type MarmotClient,
  type MarmotGroup,
  type Unsubscribable,
  getKeyPackageNostrPubkey,
} from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { EventSigner } from "applesauce-core";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import {
  addSyncedGroupEventIds,
  createInviteStore,
  getSyncedGroupEventIds,
} from "./storage";
import { TASK_EVENT_KIND, type TaskEvent } from "../store/task-events";
import { appendEvent } from "../store/persistence";

function mergeIds(existing: Set<string>, incoming: Iterable<string>): string[] {
  for (const id of incoming) {
    existing.add(id);
  }

  return Array.from(existing);
}

function groupHasMember(group: MarmotGroup, pubkey: string): boolean {
  return getGroupMembers(group.state).some(
    (memberPubkey) => memberPubkey === pubkey,
  );
}

/** Get the Nostr group ID used in kind 445 event `#h` tags. */
function nostrGroupId(group: MarmotGroup): string {
  return getNostrGroupIdHex(group.state);
}

/**
 * Background hook that handles two complementary device-sync flows:
 *
 * 1. **Receive Welcomes** — fetch & subscribe to kind-1059 gift wraps,
 *    decrypt them, and join groups this device was invited to.
 *
 * 2. **Auto-invite new devices** — watch for kind-443 key packages from
 *    the same pubkey. When a KP from another device appears, invite it
 *    to every group where we are admin.
 */
export function useDeviceSync(
  client: MarmotClient | null,
  pubkey: string,
  relays: string[],
  signer: EventSigner,
) {
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!client || !pubkey || relays.length === 0) return;

    mountedRef.current = true;
    const subs: Unsubscribable[] = [];

    // ── Effect 1: Receive Welcomes ──────────────────────────────────
    const runWelcomeSync = async () => {
      const store = createInviteStore();
      const inviteReader = new InviteReader({ signer, store });

      inviteReader.on("error", (err, eventId) => {
        console.debug("[device-sync] invite decrypt error for", eventId, err);
      });

      const processUnread = async () => {
        const unread = await inviteReader.getUnread();
        for (const invite of unread) {
          if (!mountedRef.current) return;
          try {
            const { group } = await client.joinGroupFromWelcome({
              welcomeRumor: invite,
            });
            await inviteReader.markAsRead(invite.id);
            try {
              await group.selfUpdate();
            } catch {
              // selfUpdate may fail if epoch changed; non-fatal
            }
          } catch (err) {
            // "no matching key package" = Welcome for another device → skip
            console.debug("[device-sync] join from welcome failed:", err);
            await inviteReader.markAsRead(invite.id);
          }
        }
      };

      // One-shot: fetch existing gift wraps
      try {
        const events = await client.network.request(relays, [
          { kinds: [1059], "#p": [pubkey] },
        ]);
        if (!mountedRef.current) return;
        await inviteReader.ingestEvents(events);
        await inviteReader.decryptGiftWraps();
        await processUnread();
      } catch (err) {
        console.warn("[device-sync] initial welcome fetch failed:", err);
      }

      // Ongoing: subscribe for new gift wraps
      if (!mountedRef.current) return;
      const welcomeSub = client.network
        .subscription(relays, [{ kinds: [1059], "#p": [pubkey] }])
        .subscribe({
          next: async (event: NostrEvent) => {
            try {
              const isNew = await inviteReader.ingestEvent(event);
              if (isNew) {
                await inviteReader.decryptGiftWraps();
                await processUnread();
              }
            } catch (err) {
              console.debug("[device-sync] welcome event error:", err);
            }
          },
        });
      subs.push(welcomeSub);
    };

    // ── Effect 1.5: Sync group traffic ──────────────────────────────
    const groupSubs = new Map<string, Unsubscribable>();
    const syncedEventIds = new Map<string, Set<string>>();

    const ingestGroupEvents = async (
      group: MarmotGroup,
      events: NostrEvent[],
    ): Promise<void> => {
      const seen =
        syncedEventIds.get(group.idStr) ??
        new Set(await getSyncedGroupEventIds(group.idStr));
      syncedEventIds.set(group.idStr, seen);

      const pending = events.filter((event) => !seen.has(event.id));
      if (pending.length === 0) return;

      const processed = new Set<string>();

      for await (const result of group.ingest(pending)) {
        if (result.kind === "processed" || result.kind === "skipped") {
          processed.add(result.event.id);
          continue;
        }

        if (result.kind === "rejected") {
          processed.add(result.event.id);
        }
      }

      if (processed.size === 0) return;

      syncedEventIds.set(group.idStr, new Set(mergeIds(seen, processed)));
      await addSyncedGroupEventIds(group.idStr, processed);
    };

    // Persist task-related application messages so they survive regardless
    // of whether the TaskStoreProvider is mounted when the message arrives.
    const appMsgListeners = new Set<string>();
    const attachAppMsgListener = (group: MarmotGroup) => {
      if (appMsgListeners.has(group.idStr)) return;
      appMsgListeners.add(group.idStr);

      group.on("applicationMessage", (data: Uint8Array) => {
        try {
          const rumor: Rumor = deserializeApplicationData(data);
          if (rumor.kind !== TASK_EVENT_KIND) return;
          const taskEvent: TaskEvent = JSON.parse(rumor.content);
          appendEvent(group.idStr, taskEvent).catch(() => {});
        } catch {
          // Not a task event or malformed — ignore
        }
      });
    };

    const syncGroup = async (group: MarmotGroup): Promise<void> => {
      if (!mountedRef.current || groupSubs.has(group.idStr)) return;

      attachAppMsgListener(group);

      const relaysForGroup = group.relays ?? relays;
      const hTag = nostrGroupId(group);
      const filter = { kinds: [445], "#h": [hTag] };

      try {
        const initialEvents = await client.network.request(relaysForGroup, [filter]);
        if (!mountedRef.current) return;
        await ingestGroupEvents(group, initialEvents);
      } catch (err) {
        console.debug(`[device-sync] initial group sync failed for ${group.idStr}:`, err);
      }

      if (!mountedRef.current) return;

      const groupSub = client.network
        .subscription(relaysForGroup, [filter])
        .subscribe({
          next: async (event: NostrEvent) => {
            try {
              await ingestGroupEvents(group, [event]);
            } catch (err) {
              console.debug(
                `[device-sync] live group sync failed for ${group.idStr}:`,
                err,
              );
            }
          },
        });

      groupSubs.set(group.idStr, groupSub);
      subs.push(groupSub);
    };

    const refreshGroupSync = async () => {
      const activeGroupIds = new Set(client.groups.map((group) => group.idStr));

      for (const [groupId, sub] of groupSubs) {
        if (activeGroupIds.has(groupId)) continue;
        sub.unsubscribe();
        groupSubs.delete(groupId);
        syncedEventIds.delete(groupId);
      }

      for (const group of client.groups) {
        await syncGroup(group);
      }
    };

    // ── Effect 2: Auto-invite new devices ───────────────────────────
    const runKeyPackageSync = async () => {
      // Build set of local KP published event IDs
      const localPackages = await client.keyPackages.list();
      const localEventIds = new Set(
        localPackages.flatMap((kp) => kp.published.map((e) => e.id)),
      );

      const invited = new Set<string>(); // "groupId:kpEventId"

      const inviteToAllGroups = async (kpEvent: NostrEvent) => {
        const inviteePubkey = getKeyPackageNostrPubkey(kpEvent);

        for (const group of client.groups) {
          if (!mountedRef.current) return;
          const gd = group.groupData;
          if (!gd || !isAdmin(gd, pubkey)) continue;
          if (groupHasMember(group, inviteePubkey)) {
            console.debug(
              `[device-sync] skipping auto-invite for ${group.idStr}: ${inviteePubkey} is already a member`,
            );
            continue;
          }

          const key = `${group.idStr}:${kpEvent.id}`;
          if (invited.has(key)) continue;
          invited.add(key);

          try {
            // Sequential to avoid MLS epoch conflicts
            await group.inviteByKeyPackageEvent(kpEvent);
          } catch (err) {
            console.debug(
              `[device-sync] auto-invite to ${group.idStr} failed:`,
              err,
            );
          }
        }
      };

      if (!mountedRef.current) return;
      const kpSub = client.network
        .subscription(relays, [{ kinds: [443], authors: [pubkey] }])
        .subscribe({
          next: async (event: NostrEvent) => {
            // Skip our own KP events
            if (localEventIds.has(event.id)) return;
            try {
              await inviteToAllGroups(event);
            } catch (err) {
              console.debug("[device-sync] kp sync error:", err);
            }
          },
        });
      subs.push(kpSub);
    };

    // Launch both flows
    runWelcomeSync();
    refreshGroupSync();
    runKeyPackageSync();

    const handleGroupsUpdated = () => {
      refreshGroupSync().catch((err) => {
        console.debug("[device-sync] group sync refresh failed:", err);
      });
    };

    client.on("groupsUpdated", handleGroupsUpdated);

    return () => {
      mountedRef.current = false;
      client.off("groupsUpdated", handleGroupsUpdated);
      for (const sub of subs) {
        sub.unsubscribe();
      }
    };
  }, [client, pubkey, relays, signer]);
}
