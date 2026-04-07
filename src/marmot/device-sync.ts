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
  getKeyPackage,
  getKeyPackageD,
  getKeyPackageNostrPubkey,
  keyPackageFilters,
} from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { EventSigner } from "applesauce-core";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  defaultKeyPackageEqualityConfig,
  nodeTypes,
  type ClientState,
} from "ts-mls";

import {
  addSyncedGroupEventIds,
  createInviteStore,
  getSyncedGroupEventIds,
} from "./storage";
import { loadInvitedKeys, markDeviceSeen, persistInvitedKey } from "./device-store";
import { TASK_EVENT_KIND, type TaskEvent } from "../store/task-events";
import { appendEvent, loadEvents } from "../store/persistence";
import { replayEvents } from "../store/task-reducer";

/** Custom kind for NIP-44 encrypted task snapshots sent outside MLS. */
export const TASK_SNAPSHOT_KIND = 30078;
/** Fixed `d` tag for replaceable task snapshot events. */
const SNAPSHOT_D_TAG = "notestr-task-snapshot";

function mergeIds(existing: Set<string>, incoming: Iterable<string>): string[] {
  for (const id of incoming) {
    existing.add(id);
  }

  return Array.from(existing);
}

export function groupHasKeyPackageLeaf(
  state: ClientState,
  keyPackageEvent: NostrEvent,
): boolean {
  const keyPackage = getKeyPackage(keyPackageEvent);

  return state.ratchetTree.some(
    (node) =>
      node?.nodeType === nodeTypes.leaf &&
      defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode(
        keyPackage,
        node.leaf,
      ),
  );
}

export async function joinFromWelcomeInvite(
  client: MarmotClient,
  inviteReader: InviteReader,
  invite: Rumor,
): Promise<MarmotGroup | null> {
  try {
    const { group } = await client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    await inviteReader.markAsRead(invite.id);
    return group;
  } catch (err) {
    console.debug("[device-sync] join from welcome failed:", err);
    await inviteReader.markAsRead(invite.id);
    return null;
  }
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
  // Stores { group instance, handler } keyed by group.idStr so we can call
  // group.off(handler) at cleanup time (the group is already absent from
  // client.groups at that point, so the instance must be retained here).
  const appMsgHandlersRef = useRef(
    new Map<string, { group: MarmotGroup; handler: (data: Uint8Array) => void }>(),
  );

  useEffect(() => {
    if (!client || !pubkey || relays.length === 0) return;

    mountedRef.current = true;
    const subs: Unsubscribable[] = [];

    // Barrier: resolves when the current join + pre-seed completes.
    // Set BEFORE joinGroupFromWelcome because that call fires the
    // synchronous "groupsUpdated" event which triggers syncGroup.
    let joinBarrier: Promise<void> | null = null;

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

          let resolveBarrier!: () => void;
          joinBarrier = new Promise<void>((r) => { resolveBarrier = r; });

          try {
            // Log key package state for debugging Welcome join failures
            const localKPs = await client.keyPackages.list();
            console.debug("[device-sync] local KPs:", localKPs.length,
              "unused:", localKPs.filter(p => !p.used).length,
              "refs:", localKPs.map(p => Array.from(p.keyPackageRef).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16)));

            const group = await joinFromWelcomeInvite(client, inviteReader, invite);
            if (!group) {
              continue;
            }

            // Pre-seed syncedEventIds with all relay events for this group.
            // The welcome already incorporates group state up to the invite
            // epoch — re-ingesting those events would cause a double epoch
            // advance and MLS key divergence.
            const relaysForGroup = group.relays ?? relays;
            const hTag = getNostrGroupIdHex(group.state);
            try {
              const existing = await client.network.request(relaysForGroup, [
                { kinds: [445], "#h": [hTag] },
              ]);
              const ids = new Set(existing.map((e) => e.id));
              syncedEventIds.set(group.idStr, ids);
              await addSyncedGroupEventIds(group.idStr, ids);
            } catch (err) {
              console.warn("[device-sync] pre-seed relay fetch failed:", err);
            }

            // Fetch task snapshot (NIP-44 encrypted, sent by inviter)
            await fetchTaskSnapshot(group);
          } finally {
            resolveBarrier();
            joinBarrier = null;
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

    /**
     * Fetch a NIP-44 encrypted task snapshot from the group admin.
     * Published as a replaceable event (kind 30078) with `#h` = group ID.
     */
    const fetchTaskSnapshot = async (group: MarmotGroup): Promise<void> => {
      const members = getGroupMembers(group.state);
      const hTag = nostrGroupId(group);
      const relaysForGroup = group.relays ?? relays;

      try {
        const events = await client.network.request(relaysForGroup, [
          {
            kinds: [TASK_SNAPSHOT_KIND],
            "#h": [hTag],
            "#p": [pubkey],
            limit: 1,
          },
        ]);
        if (events.length === 0) return;

        // Pick the most recent snapshot
        const event = events.sort(
          (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0),
        )[0];

        // Verify sender is a group member
        if (!members.includes(event.pubkey as string)) return;

        // Decrypt NIP-44 content
        const plaintext = await signer.nip44!.decrypt(
          event.pubkey as string,
          event.content as string,
        );
        const snapshot: TaskEvent = JSON.parse(plaintext);
        if (snapshot.type !== "task.snapshot") return;

        // Persist the snapshot
        await appendEvent(group.idStr, snapshot);
        console.debug(
          `[device-sync] loaded task snapshot for ${group.idStr.slice(0, 8)} (${(snapshot as any).tasks?.length ?? 0} tasks)`,
        );
      } catch (err) {
        console.debug("[device-sync] task snapshot fetch failed:", err);
      }
    };

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
        console.debug("[device-sync] ingest result:", result.kind, result.event.id?.slice(0, 12));
        if (result.kind === "processed" || result.kind === "skipped") {
          processed.add(result.event.id);
          continue;
        }

        if (result.kind === "rejected") {
          console.debug("[device-sync] rejected reason:", (result as any).reason);
          processed.add(result.event.id);
        }
        if (result.kind === "unreadable") {
          console.debug("[device-sync] unreadable errors:", (result as any).errors);
        }
        // "unreadable" events are NOT added — they may become decryptable later
      }

      if (processed.size === 0) return;

      syncedEventIds.set(group.idStr, new Set(mergeIds(seen, processed)));
      await addSyncedGroupEventIds(group.idStr, processed);
    };

    // Persist task-related application messages so they survive regardless
    // of whether the TaskStoreProvider is mounted when the message arrives.
    const attachAppMsgListener = (group: MarmotGroup) => {
      if (appMsgHandlersRef.current.has(group.idStr)) return;

      const handler = (data: Uint8Array) => {
        try {
          const rumor: Rumor = deserializeApplicationData(data);
          if (rumor.kind !== TASK_EVENT_KIND) return;
          const taskEvent: TaskEvent = JSON.parse(rumor.content);
          appendEvent(group.idStr, taskEvent).catch((err) => {
            console.warn("[device-sync] appendEvent failed:", err);
          });
        } catch (err) {
          console.debug("[device-sync] applicationMessage parse error:", err);
        }
      };

      appMsgHandlersRef.current.set(group.idStr, { group, handler });
      group.on("applicationMessage", handler);
    };

    const syncGroup = async (group: MarmotGroup): Promise<void> => {
      if (!mountedRef.current || groupSubs.has(group.idStr)) return;

      // Wait for any in-progress join + pre-seed to complete
      if (joinBarrier) await joinBarrier;

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
        const entry = appMsgHandlersRef.current.get(groupId);
        if (entry) {
          entry.group.off("applicationMessage", entry.handler);
          appMsgHandlersRef.current.delete(groupId);
        }
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
        localPackages.flatMap((kp) => (kp.published ?? []).map((e) => e.id)),
      );
      const knownEvents = new Map<string, NostrEvent>();
      const invited = new Set(await loadInvitedKeys());
      const pendingInvites = new Set<string>();

      for (const keyPackage of localPackages) {
        if (keyPackage.d) {
          await markDeviceSeen(keyPackage.d, { localClientId: keyPackage.d });
        }
      }

      const inviteToAllGroups = async (kpEvent: NostrEvent) => {
        const inviteeSlot = getKeyPackageD(kpEvent);

        if (inviteeSlot) {
          await markDeviceSeen(inviteeSlot);
        }

        for (const group of client.groups) {
          if (!mountedRef.current) return;
          const gd = group.groupData;
          if (!gd || !isAdmin(gd, pubkey)) continue;
          if (groupHasKeyPackageLeaf(group.state, kpEvent)) {
            continue;
          }

          const key = `${group.idStr}:${kpEvent.id}`;
          if (invited.has(key) || pendingInvites.has(key)) continue;
          pendingInvites.add(key);

          try {
            // Sequential to avoid MLS epoch conflicts
            await group.inviteByKeyPackageEvent(kpEvent);
            invited.add(key);
            await persistInvitedKey(key);
          } catch (err) {
            console.debug(
              `[device-sync] auto-invite to ${group.idStr} failed:`,
              err,
            );
          } finally {
            pendingInvites.delete(key);
          }
        }
      };

      const syncKnownKeyPackages = async () => {
        for (const event of knownEvents.values()) {
          if (!mountedRef.current) return;
          if (localEventIds.has(event.id)) continue;
          if (getKeyPackageNostrPubkey(event) !== pubkey) continue;
          await inviteToAllGroups(event);
        }
      };

      const handleKeyPackageEvent = async (event: NostrEvent) => {
        knownEvents.set(event.id, event);
        if (localEventIds.has(event.id)) return;
        if (getKeyPackageNostrPubkey(event) !== pubkey) return;

        try {
          await inviteToAllGroups(event);
        } catch (err) {
          console.debug("[device-sync] kp sync error:", err);
        }
      };

      try {
        const existing = await client.network.request(relays, keyPackageFilters([pubkey]));
        for (const event of existing) {
          knownEvents.set(event.id, event);
        }
        await syncKnownKeyPackages();
      } catch (err) {
        console.debug("[device-sync] initial kp sync failed:", err);
      }

      if (!mountedRef.current) return;
      const kpSub = client.network
        .subscription(relays, keyPackageFilters([pubkey]))
        .subscribe({
          next: async (event: NostrEvent) => {
            await handleKeyPackageEvent(event);
          },
        });
      subs.push(kpSub);

      const handleGroupsUpdated = async () => {
        await syncKnownKeyPackages();
      };
      client.on("groupsUpdated", handleGroupsUpdated);
      subs.push({
        unsubscribe(): void {
          client.off("groupsUpdated", handleGroupsUpdated);
        },
      });
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
      for (const entry of appMsgHandlersRef.current.values()) {
        entry.group.off("applicationMessage", entry.handler);
      }
      appMsgHandlersRef.current.clear();
    };
  }, [client, pubkey, relays, signer]);
}

/**
 * Publish a NIP-44 encrypted task snapshot for a specific invitee.
 * Uses a replaceable event (kind 30078) so only the latest snapshot
 * is stored on relays.
 */
export async function publishTaskSnapshot(
  groupId: string,
  groupHTag: string,
  inviteeHex: string,
  signer: EventSigner,
  network: MarmotClient["network"],
  relays: string[],
): Promise<void> {
  const events = await loadEvents(groupId);
  if (events.length === 0) return;

  const state = replayEvents(events);
  const tasks = Array.from(state.values());
  if (tasks.length === 0) return;

  const snapshot: TaskEvent = { type: "task.snapshot", tasks };
  const plaintext = JSON.stringify(snapshot);

  const signerPubkey = await signer.getPublicKey();
  const encrypted = await signer.nip44!.encrypt(inviteeHex, plaintext);

  const unsignedEvent = {
    kind: TASK_SNAPSHOT_KIND,
    content: encrypted,
    tags: [
      ["d", `${SNAPSHOT_D_TAG}:${groupHTag}:${inviteeHex}`],
      ["h", groupHTag],
      ["p", inviteeHex],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: signerPubkey,
  };

  const signed = await signer.signEvent(unsignedEvent);
  await network.publish(relays, signed);
  console.debug(
    `[device-sync] published task snapshot for ${groupId.slice(0, 8)} → ${inviteeHex.slice(0, 8)} (${tasks.length} tasks)`,
  );
}
