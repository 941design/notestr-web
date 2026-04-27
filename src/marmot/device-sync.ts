import { useEffect, useRef } from "react";

import {
  getGroupMembers,
  getNostrGroupIdHex,
  InviteManager,
  isAdmin,
  deserializeApplicationData,
  type MarmotClient,
  type MarmotGroup,
  type Unsubscribable,
  getKeyPackage,
  getKeyPackageIdentifier,
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
  getSyncedGroupEventIds,
} from "./storage";
import {
  isGroupJoinedFromWelcome,
  loadInvitedKeys,
  markDeviceSeen,
  markGroupJoinedFromWelcome,
  persistInvitedKey,
} from "./device-store";
import { TASK_EVENT_KIND, type TaskEvent } from "../store/task-events";
import { appendEvent, loadEvents } from "../store/persistence";
import { replayEvents } from "../store/task-reducer";
import {
  createPendingRetryQueue,
  type PendingRetryQueue,
} from "./ingest-queue";

/** Custom kind for NIP-44 encrypted task snapshots sent outside MLS. */
export const TASK_SNAPSHOT_KIND = 30078;
/** Fixed `d` tag for replaceable task snapshot events. */
const SNAPSHOT_D_TAG = "notestr-task-snapshot";

/**
 * Reads the addressable slot identifier off a {@link ListedKeyPackage}.
 *
 * marmot-ts v0.5 has a runtime/type mismatch on this field — the static
 * type calls it `identifier`, but {@link KeyPackageManager.list} actually
 * emits the runtime field as `d`. We read both so we keep working past a
 * future upstream fix without churn here.
 */
function keyPackageSlot(
  kp: { identifier?: string } & Record<string, unknown>,
): string | undefined {
  const identifier = kp.identifier;
  if (typeof identifier === "string" && identifier.length > 0) {
    return identifier;
  }
  const legacyD = (kp as { d?: unknown }).d;
  if (typeof legacyD === "string" && legacyD.length > 0) {
    return legacyD;
  }
  return undefined;
}

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
  inviteReader: InviteManager,
  invite: Rumor,
): Promise<MarmotGroup | null> {
  try {
    const { group } = await client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    await inviteReader.markAsRead(invite.id);
    // Persist that this context is a joiner (not the creator) so the
    // auto-invite suppression survives KP rotations and page reloads.
    await markGroupJoinedFromWelcome(group.idStr);
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
  // Per-group stateChanged handlers for the retry-queue drain. Kept out
  // of appMsgHandlersRef because they have a different arity.
  const stateChangeHandlersRef = useRef(
    new Map<string, { group: MarmotGroup; handler: () => void }>(),
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
      // v0.5 exposes a long-lived InviteManager on the client (backed by
      // the inviteStore we wired up in client.tsx). Reusing it here means
      // the persisted "seen" set is shared with any other consumer of
      // client.invites — but we're the only consumer today.
      const inviteReader = client.invites;

      const onError = (err: Error, eventId: string) => {
        console.debug("[device-sync] invite decrypt error for", eventId, err);
      };
      inviteReader.on("error", onError);
      subs.push({
        unsubscribe(): void {
          inviteReader.off("error", onError);
        },
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

            // Historically we pre-seeded `syncedEventIds` here with every
            // kind-445 currently on the relay, marking them as "already
            // processed" without ever calling `ingest()` on them. The
            // rationale in the old comment was that the Welcome snapshot
            // already incorporates group state up to the invite epoch, so
            // re-ingesting those events would cause a "double epoch
            // advance and MLS key divergence."
            //
            // That rationale is wrong. ts-mls's `ingest()` explicitly
            // handles past-epoch commits as `skipped past-epoch`
            // (marmot-group.d.ts IngestResult / marmot-group.js sorting).
            // Re-ingesting is SAFE. And the pre-seed caused the exact
            // bug that multi-user.spec.ts:98 was fixmed for: if any
            // commits landed on the relay BETWEEN the Welcome being
            // built by the admin and the joiner actually processing it
            // (e.g. admin auto-invited a sibling device in the
            // background, or had any other backlog), the joiner would
            // silently mark them as seen and never catch up. The
            // admin's subsequent application messages, encrypted at
            // the later epoch, would then fail to decrypt on the
            // joiner forever.
            //
            // Fix: do not pre-seed. Let the normal `ingestGroupEvents`
            // path inside `syncGroup` apply every historical kind-445
            // through ts-mls, which correctly advances the state
            // epoch-by-epoch until the joiner catches up to the
            // admin. The retry queue added alongside this change
            // (src/marmot/ingest-queue.ts) catches any straggler
            // application messages that arrive before their
            // containing-epoch commit.
            //
            // The task snapshot (fetched below) remains the canonical
            // bootstrap for pre-join task state: MLS application
            // messages older than the joiner's Welcome epoch cannot be
            // recovered anyway because they're encrypted at epochs
            // whose keys the joiner never had.

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
    // Events that `ingest()` yielded as `unreadable` are parked here and
    // retried whenever the group's MLS epoch advances. See
    // `src/marmot/ingest-queue.ts` for the contract.
    const pendingRetry = new Map<string, PendingRetryQueue>();
    // Per-group mutex: two concurrent `ingestGroupEvents` calls on the
    // same group race on marmot-ts's `this.state` mutation, so every
    // call chains onto a single promise per group.
    const ingestLock = new Map<string, Promise<void>>();
    // Last-known epoch per group. Seeded from the group's initial
    // ClientState at subscribe time; updated every time `stateChanged`
    // fires. Only a strict `newEpoch > lastEpoch` transition triggers
    // retry-queue draining — within-epoch ratchet advances (every
    // `sendApplicationRumor`) would otherwise cause retry storms.
    const lastEpoch = new Map<string, bigint>();

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

    const getPendingRetryQueue = (groupId: string): PendingRetryQueue => {
      let queue = pendingRetry.get(groupId);
      if (!queue) {
        queue = createPendingRetryQueue({ maxSize: 200, maxAgeSec: 86400 });
        pendingRetry.set(groupId, queue);
      }
      return queue;
    };

    const ingestGroupEventsRaw = async (
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
      const retryQueue = getPendingRetryQueue(group.idStr);

      for await (const result of group.ingest(pending)) {
        const currentEpoch = group.state.groupContext.epoch.toString();
        const errorMessages =
          "errors" in result && Array.isArray(result.errors)
            ? result.errors.map((e) =>
                e instanceof Error ? `${e.name}: ${e.message}` : String(e),
              )
            : undefined;
        console.debug("[mls-receive:ingest-result]", {
          eventId: result.event.id?.slice(0, 12),
          kind: result.kind,
          groupEpoch: currentEpoch,
          reason: "reason" in result ? result.reason : undefined,
          errorMessages,
        });
        if (result.kind === "processed" || result.kind === "skipped") {
          processed.add(result.event.id);
          // Promotion: if this event was previously parked in the
          // retry queue, it's now readable — drop it.
          retryQueue.remove(result.event.id);
          continue;
        }

        if (result.kind === "rejected") {
          processed.add(result.event.id);
          retryQueue.remove(result.event.id);
          continue;
        }
        if (result.kind === "unreadable") {
          // Park the event for retry on the next epoch advance. The
          // queue dedupes by event id, so repeated re-ingests of the
          // same unreadable event don't inflate the queue.
          retryQueue.enqueue(result.event);
        }
      }

      if (processed.size === 0) return;

      syncedEventIds.set(group.idStr, new Set(mergeIds(seen, processed)));
      await addSyncedGroupEventIds(group.idStr, processed);
    };

    // Serialize concurrent ingest calls per group. Two concurrent calls
    // race on marmot-ts's internal `this.state` mutation, which produces
    // `desired gen in the past` errors and/or epoch divergence. The
    // lock chains every call onto the group's in-flight promise.
    const ingestGroupEvents = async (
      group: MarmotGroup,
      events: NostrEvent[],
    ): Promise<void> => {
      const prev = ingestLock.get(group.idStr) ?? Promise.resolve();
      const next = prev
        .catch(() => undefined)
        .then(() => ingestGroupEventsRaw(group, events));
      ingestLock.set(group.idStr, next);
      try {
        await next;
      } finally {
        // Clear the lock if we're still the tail of the chain.
        if (ingestLock.get(group.idStr) === next) {
          ingestLock.delete(group.idStr);
        }
      }
    };

    const attachRetryOnEpochAdvance = (group: MarmotGroup): void => {
      if (stateChangeHandlersRef.current.has(group.idStr)) return;

      const handler = () => {
        const newEpoch = group.state.groupContext.epoch;
        const prev = lastEpoch.get(group.idStr) ?? 0n;
        if (newEpoch <= prev) return; // within-epoch ratchet advance, no retry
        lastEpoch.set(group.idStr, newEpoch);

        const queue = pendingRetry.get(group.idStr);
        if (!queue) return;
        queue.prune();
        const snapshot = queue.snapshot();
        if (snapshot.length === 0) return;

        console.debug("[mls-receive:retry-on-epoch]", {
          groupId: group.idStr.slice(0, 8),
          newEpoch: newEpoch.toString(),
          pendingCount: snapshot.length,
        });

        // `ingestGroupEvents` goes through the lock, so concurrent
        // live-subscription ingests won't race with this retry pass.
        //
        // Note: the existing `syncedEventIds` filter inside
        // `ingestGroupEventsRaw` would short-circuit these events
        // because unreadable events are NOT added to `seen`. So this
        // pass re-enters the ts-mls ingest path for exactly those
        // events that previously failed to decrypt.
        void ingestGroupEvents(group, snapshot).catch((err) => {
          console.debug("[mls-receive:retry-failed]", err);
        });
      };

      stateChangeHandlersRef.current.set(group.idStr, { group, handler });
      group.on("stateChanged", handler);
    };

    // Persist task-related application messages so they survive regardless
    // of whether the TaskStoreProvider is mounted when the message arrives.
    const attachAppMsgListener = (group: MarmotGroup) => {
      if (appMsgHandlersRef.current.has(group.idStr)) return;

      const handler = (data: Uint8Array) => {
        try {
          const rumor: Rumor = deserializeApplicationData(data);
          console.debug("[mls-receive:app-msg-emit]", {
            groupId: group.idStr.slice(0, 8),
            rumorKind: rumor.kind,
            len: data.length,
          });
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
      attachRetryOnEpochAdvance(group);
      // Seed the last-known epoch so the very first stateChanged firing
      // doesn't look like a huge forward jump.
      lastEpoch.set(group.idStr, group.state.groupContext.epoch);

      const relaysForGroup = group.relays ?? relays;
      const hTag = nostrGroupId(group);
      const filter = { kinds: [445], "#h": [hTag] };

      try {
        const initialEvents = await client.network.request(relaysForGroup, [filter]);
        if (!mountedRef.current) return;
        console.debug("[mls-receive:sync-start]", {
          groupId: group.idStr.slice(0, 8),
          epoch: group.state.groupContext.epoch.toString(),
          preSeeded: syncedEventIds.get(group.idStr)?.size ?? 0,
          fetched: initialEvents.length,
        });
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
              console.debug("[mls-receive:live-in]", {
                eventId: event.id.slice(0, 12),
                author: event.pubkey.slice(0, 8),
                groupEpoch: group.state.groupContext.epoch.toString(),
              });
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
      const activeGroupIds = new Set(
        client.groups.loaded.map((group) => group.idStr),
      );

      for (const [groupId, sub] of groupSubs) {
        if (activeGroupIds.has(groupId)) continue;
        sub.unsubscribe();
        groupSubs.delete(groupId);
        syncedEventIds.delete(groupId);
        pendingRetry.delete(groupId);
        ingestLock.delete(groupId);
        lastEpoch.delete(groupId);
        const entry = appMsgHandlersRef.current.get(groupId);
        if (entry) {
          entry.group.off("applicationMessage", entry.handler);
          appMsgHandlersRef.current.delete(groupId);
        }
        const stateEntry = stateChangeHandlersRef.current.get(groupId);
        if (stateEntry) {
          stateEntry.group.off("stateChanged", stateEntry.handler);
          stateChangeHandlersRef.current.delete(groupId);
        }
      }

      for (const group of client.groups.loaded) {
        await syncGroup(group);
      }
    };

    // ── Effect 2: Auto-invite new devices ───────────────────────────
    const runKeyPackageSync = async () => {
      const knownEvents = new Map<string, NostrEvent>();
      const invited = new Set(await loadInvitedKeys());
      const pendingInvites = new Set<string>();

      // Re-reads local key packages every call so events from freshly
      // rotated/published key packages are not mistaken for foreign devices.
      // Tracks both event ids AND d slots: a rotation publishes a new event
      // BEFORE the event id is recorded locally, so the slot check is the
      // authoritative "this is one of my own devices" marker.
      const getLocalKnownIds = async (): Promise<{
        eventIds: Set<string>;
        slots: Set<string>;
      }> => {
        const currentLocal = await client.keyPackages.list();
        const eventIds = new Set(
          currentLocal.flatMap((kp) => (kp.published ?? []).map((e) => e.id)),
        );
        const slots = new Set(
          currentLocal
            .map((kp) => keyPackageSlot(kp))
            .filter((d): d is string => typeof d === "string" && d.length > 0),
        );
        return { eventIds, slots };
      };

      const isLocalDevice = (
        event: NostrEvent,
        local: { eventIds: Set<string>; slots: Set<string> },
      ): boolean => {
        if (local.eventIds.has(event.id)) return true;
        const slot = getKeyPackageIdentifier(event);
        if (slot && local.slots.has(slot)) return true;
        return false;
      };

      const initialLocal = await client.keyPackages.list();
      for (const keyPackage of initialLocal) {
        const slot = keyPackageSlot(keyPackage);
        if (slot) {
          await markDeviceSeen(slot, { localClientId: slot });
        }
      }

      // True iff this context joined the group via a Welcome message
      // (rather than creating it). Joiners must NOT auto-invite siblings
      // of their own pubkey: the creator's auto-invite already handles
      // sibling devices, and a second wave of invites from joiners would
      // just stack duplicate leaves for the same identity.
      //
      // The flag is checked from IDB on every call so it stays correct
      // after KP rotations have removed the in-tree proof from
      // `client.keyPackages.list()` (deprecated entries are excluded
      // from that listing).
      const isJoinerOfGroup = async (group: MarmotGroup): Promise<boolean> => {
        if (await isGroupJoinedFromWelcome(group.idStr)) return true;
        // Fallback: also derive from current key packages so the very
        // first invite-cycle (immediately after joinGroupFromWelcome,
        // before the IDB write may have settled) is correctly suppressed.
        const localPkgs = await client.keyPackages.list();
        for (const pkg of localPkgs) {
          if (!pkg.publicPackage) continue;
          for (const node of group.state.ratchetTree) {
            if (node?.nodeType !== nodeTypes.leaf) continue;
            if (
              defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode(
                pkg.publicPackage,
                node.leaf,
              )
            ) {
              return true;
            }
          }
        }
        return false;
      };

      const inviteToAllGroups = async (kpEvent: NostrEvent) => {
        const inviteeSlot = getKeyPackageIdentifier(kpEvent);
        const inviteePubkey = getKeyPackageNostrPubkey(kpEvent);

        if (inviteeSlot) {
          await markDeviceSeen(inviteeSlot);
        }

        for (const group of client.groups.loaded) {
          if (!mountedRef.current) return;
          const gd = group.groupData;
          if (!gd || !isAdmin(gd, pubkey)) continue;
          if (groupHasKeyPackageLeaf(group.state, kpEvent)) {
            continue;
          }

          // Joiner-suppression: if this device joined the group via
          // Welcome, the original creator is responsible for inviting
          // sibling devices. Re-inviting from a joiner just adds
          // duplicate leaves for the same identity.
          if (
            inviteePubkey === pubkey &&
            (await isJoinerOfGroup(group))
          ) {
            continue;
          }

          // Deduplication key: per group + device slot (stable across rotations).
          // Falls back to event id for legacy kind 443 events that lack a slot.
          // Without slot-level dedup, a rotated key package for the same device
          // would be treated as a fresh invitee and added as a duplicate leaf,
          // forming an infinite auto-invite loop across sibling devices.
          const dedupKey = `${group.idStr}:${inviteeSlot ?? kpEvent.id}`;
          if (invited.has(dedupKey) || pendingInvites.has(dedupKey)) continue;
          pendingInvites.add(dedupKey);

          try {
            // Sequential to avoid MLS epoch conflicts
            await group.inviteByKeyPackageEvent(kpEvent);
            invited.add(dedupKey);
            await persistInvitedKey(dedupKey);
          } catch (err) {
            console.debug(
              `[device-sync] auto-invite to ${group.idStr} failed:`,
              err,
            );
          } finally {
            pendingInvites.delete(dedupKey);
          }
        }
      };

      const syncKnownKeyPackages = async () => {
        // Wait for any in-flight join + post-join bookkeeping (e.g.
        // markGroupJoinedFromWelcome) to settle. Without this, the
        // synchronous "groupsUpdated" emitted from inside joinGroupFromWelcome
        // races our IDB writes and the joiner-suppression check sees a
        // stale empty flag, leading to a duplicate-invite cascade.
        if (joinBarrier) await joinBarrier;
        const local = await getLocalKnownIds();
        for (const event of knownEvents.values()) {
          if (!mountedRef.current) return;
          if (isLocalDevice(event, local)) continue;
          if (getKeyPackageNostrPubkey(event) !== pubkey) continue;
          await inviteToAllGroups(event);
        }
      };

      const handleKeyPackageEvent = async (event: NostrEvent) => {
        knownEvents.set(event.id, event);
        if (joinBarrier) await joinBarrier;
        const local = await getLocalKnownIds();
        if (isLocalDevice(event, local)) return;
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
      client.groups.on("updated", handleGroupsUpdated);
      subs.push({
        unsubscribe(): void {
          client.groups.off("updated", handleGroupsUpdated);
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

    client.groups.on("updated", handleGroupsUpdated);

    return () => {
      mountedRef.current = false;
      client.groups.off("updated", handleGroupsUpdated);
      for (const sub of subs) {
        sub.unsubscribe();
      }
      for (const entry of appMsgHandlersRef.current.values()) {
        entry.group.off("applicationMessage", entry.handler);
      }
      appMsgHandlersRef.current.clear();
      for (const entry of stateChangeHandlersRef.current.values()) {
        entry.group.off("stateChanged", entry.handler);
      }
      stateChangeHandlersRef.current.clear();
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
