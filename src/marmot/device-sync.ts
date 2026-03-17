import { useEffect, useRef } from "react";

import {
  InviteReader,
  isAdmin,
  type MarmotClient,
  type Unsubscribable,
} from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { EventSigner } from "applesauce-core";

import { createInviteStore } from "./storage";

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

    // ── Effect 2: Auto-invite new devices ───────────────────────────
    const runKeyPackageSync = async () => {
      // Build set of local KP published event IDs
      const localPackages = await client.keyPackages.list();
      const localEventIds = new Set(
        localPackages.flatMap((kp) => kp.published.map((e) => e.id)),
      );

      const invited = new Set<string>(); // "groupId:kpEventId"

      const inviteToAllGroups = async (kpEvent: NostrEvent) => {
        for (const group of client.groups) {
          if (!mountedRef.current) return;
          const gd = group.groupData;
          if (!gd || !isAdmin(gd, pubkey)) continue;

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
    runKeyPackageSync();

    return () => {
      mountedRef.current = false;
      for (const sub of subs) {
        sub.unsubscribe();
      }
    };
  }, [client, pubkey, relays, signer]);
}
