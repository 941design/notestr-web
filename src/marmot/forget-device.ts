/**
 * forget-device.ts
 *
 * Imperative utilities for removing a device from all MLS groups.
 *
 * - forgetSelfDevice: removes this device's leaves, publishes kind-5 deletions,
 *   clears all local IDB stores, calls clearNip46Session(), then signs out.
 * - forgetSiblingDevice(client, pubkey, slot): removes another device's leaves
 *   from groups where the local user is admin, then marks the slot as forgotten.
 *
 * Boundary rules (architecture.md):
 *   - No NDK imports — kind-5 events published through client.network.publish.
 *   - No raw localStorage calls — NIP-46 cleanup via clearNip46Session().
 *   - No React imports.
 *   - No router.push / window.location calls — navigation delegated to onSignOut().
 *   - Sequential per-group calls (for...of, never Promise.all). Self-forget
 *     uses `group.leave()`; sibling-forget uses `removeLeafByIndex`.
 *
 * Architect decisions:
 *   D1 (IDB cleanup): indexedDB.deleteDatabase by stable name for
 *      notestr-key-packages, notestr-group-state, notestr-invite-store.
 *   D2 (kind-5 publish): client.network.publish(relays, signedEvent).
 *   D3 (epoch race): retry-once wrapper before bubbling.
 */

import {
  isAdmin,
  getGroupMembers,
  getKeyPackage,
  getKeyPackageIdentifier,
  getPubkeyLeafNodeIndexes,
  keyPackageFilters,
} from "@internet-privacy/marmot-ts";
import type { MarmotClient, MarmotGroup } from "@internet-privacy/marmot-ts";
import type { EventSigner } from "applesauce-core";
import {
  defaultKeyPackageEqualityConfig,
  nodeTypes,
} from "ts-mls";

import { removeLeafByIndex } from "./per-leaf-remove";
import { markSlotForgotten } from "./forgotten-slots";
import {
  clearIdentityStore,
  invitedKeysStore,
  joinedGroupsStore,
} from "./storage";
import { clearNip46Session } from "../lib/nostr";

// ---------------------------------------------------------------------------
// Epoch-race retry wrapper (Decision D3)
// ---------------------------------------------------------------------------

/**
 * Calls removeLeafByIndex and retries once if a stale-epoch error is thrown.
 *
 * removeLeafByIndex throws if another member commits to the group between the
 * leaf-index lookup and the commit attempt. A single retry covers the common
 * case of a single-step epoch advance during multi-group iteration. A second
 * failure bubbles to the caller so the UI can ask for a retry.
 *
 * @param group - The MarmotGroup to remove the leaf from.
 * @param leafIndex - The leaf index to remove.
 * @param recomputeLeafIndex - Optional callback to re-derive the leaf index
 *   after the epoch advance; if omitted the same index is retried.
 */
async function removeLeafWithRetry(
  group: MarmotGroup,
  leafIndex: number,
  recomputeLeafIndex?: () => Promise<number | null>,
): Promise<void> {
  try {
    await removeLeafByIndex(group, leafIndex);
  } catch (firstErr) {
    // Detect stale-epoch / epoch-mismatch errors from marmot-ts / ts-mls.
    const msg = firstErr instanceof Error ? firstErr.message.toLowerCase() : "";
    const isEpochError =
      msg.includes("epoch") ||
      msg.includes("stale") ||
      msg.includes("wrong epoch") ||
      msg.includes("epoch mismatch");

    if (!isEpochError) throw firstErr;

    // Re-derive the leaf index if the caller supplied a recompute callback.
    let retryIndex = leafIndex;
    if (recomputeLeafIndex) {
      const recomputed = await recomputeLeafIndex();
      if (recomputed === null) {
        // Leaf is no longer present after epoch advance — treat as success.
        return;
      }
      retryIndex = recomputed;
    }

    // Single retry — bubble on second failure.
    await removeLeafByIndex(group, retryIndex);
  }
}

// ---------------------------------------------------------------------------
// Leaf-index resolution helpers
// ---------------------------------------------------------------------------

/**
 * Returns the leaf node indexes in a group's ratchet tree whose credential
 * identity is the given Nostr pubkey.
 *
 * Self-leaves are resolved by credential identity rather than by KeyPackage
 * equality because `groups.create()` generates an ephemeral KeyPackage inline
 * (marmot-ts groups-manager) that is never persisted in the local
 * KeyPackageManager — `client.keyPackages.list()` therefore does not contain
 * the creator's own leaf KP. Credentials carry the raw Nostr pubkey and
 * uniquely identify the owner of every leaf this device controls. Thin wrapper
 * around `getPubkeyLeafNodeIndexes` so the call site reads in terms of
 * forget-device intent.
 */
function selfLeafIndexesForPubkey(
  group: MarmotGroup,
  pubkey: string,
): number[] {
  return getPubkeyLeafNodeIndexes(group.state, pubkey);
}

/**
 * Returns the leaf node indexes in a group's ratchet tree that correspond to
 * any of the given relay-fetched KP events (by compareKeyPackageToLeafNode).
 *
 * Used by forgetSiblingDevice after fetching the sibling's KP events from the relay.
 */
function siblingLeafIndexesForEvents(
  group: MarmotGroup,
  kpEvents: import("applesauce-core/helpers/event").NostrEvent[],
): number[] {
  const indexes: number[] = [];
  for (let nodeIndex = 0; nodeIndex < group.state.ratchetTree.length; nodeIndex++) {
    const node = group.state.ratchetTree[nodeIndex];
    if (!node || node.nodeType !== nodeTypes.leaf) continue;
    const leaf = node.leaf;
    for (const event of kpEvents) {
      try {
        const kp = getKeyPackage(event);
        if (
          defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode(kp, leaf)
        ) {
          indexes.push(Math.floor(nodeIndex / 2));
          break;
        }
      } catch {
        // Malformed KP event — skip
      }
    }
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Removes this device from all MLS groups, deletes its key packages from the
 * relay, clears all local IDB stores, and signs out.
 *
 * Step order (must not be reordered — AC-SELF-1 through AC-SIGNOUT-2):
 *   1. Self-leave proposals: for each group containing this user's leaf, call
 *      `group.leave()` to publish kind-445 Remove proposal events. RFC 9420
 *      §12.4 forbids a member from committing a Remove targeting their own
 *      leaf, so we publish proposals and let another admin commit them.
 *   2. Kind-5 publish: for each published KP event, publish a NIP-09 deletion.
 *   3. IDB cleanup: clear identity, key-packages, group-state, invite stores,
 *      invitedKeys, joinedGroups.
 *   4. NIP-46 cleanup: clearNip46Session().
 *   5. Sign out: call onSignOut().
 *
 * Per-group leave() calls are sequential (for...of + await). No Promise.all.
 * Kind-5 events are published one per KP entry (AC-DELETE-3).
 * Decision D2: published via client.network.publish, not raw NDK.
 * Decision D1: notestr-key-packages/group-state/invite-store deleted by name.
 *
 * @param client - The local MarmotClient instance.
 * @param signer - The user's identity key signer.
 * @param relays - Relay URLs for publishing kind-5 deletion events.
 * @param onSignOut - Callback to call after cleanup; performs navigation/state reset.
 */
export async function forgetSelfDevice(
  client: MarmotClient,
  signer: EventSigner,
  relays: string[],
  onSignOut: () => void,
): Promise<void> {
  // Resolve our identity pubkey up front — used both for leaf-by-credential
  // resolution (Step 1) and as the author field of kind-5 deletes (Step 2).
  const pubkey = await signer.getPublicKey();

  // Locally stored KPs drive the kind-5 deletion step. They are NOT used to
  // resolve our own leaves in groups: `groups.create()` injects an ephemeral
  // KP that never lands in this list. See selfLeafIndexesForPubkey above.
  const localKps = await client.keyPackages.list();

  // --- Step 1: Self-leave proposals (sequential, per group with a self-leaf) ---
  for (const group of client.groups.loaded) {
    if (selfLeafIndexesForPubkey(group, pubkey).length === 0) continue;
    await group.leave();
  }

  // --- Step 2: Kind-5 deletion events (one per published KP entry) ---
  for (const kp of localKps) {
    const published = kp.published ?? [];
    for (const publishedEvent of published) {
      const eventId = publishedEvent.id;
      if (!eventId) continue;
      const unsigned = {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["e", eventId]],
        content: "",
        pubkey,
      };
      const signed = await signer.signEvent(unsigned as Parameters<typeof signer.signEvent>[0]);
      await client.network.publish(relays, signed as import("applesauce-core/helpers/event").NostrEvent);
    }
  }

  // --- Step 3: IDB cleanup ---

  // 3a. Clear the exported stores (invitedKeys, joinedGroups, identity).
  await invitedKeysStore.clear();
  await joinedGroupsStore.clear();
  await clearIdentityStore();

  // 3b. Delete the three stores owned by MarmotClient's init() closure
  // (Decision D1: indexedDB.deleteDatabase by stable name).
  // These names are derived from createKVStore('key-packages'),
  // createKVStore('group-state'), and createInviteKVStore() ('invite-store').
  // They are already relied upon by the e2e cleanup fixture (KNOWN_IDB_NAMES).
  if (typeof indexedDB !== "undefined") {
    indexedDB.deleteDatabase("notestr-key-packages");
    indexedDB.deleteDatabase("notestr-group-state");
    indexedDB.deleteDatabase("notestr-invite-store");
  }

  // --- Step 4: NIP-46 cleanup (AC-SELF-4, AC-CLEANUP-3) ---
  clearNip46Session();

  // --- Step 5: Sign out (AC-SELF-5, AC-SIGNOUT-1) ---
  onSignOut();
}

/**
 * Removes a sibling device (identified by its slot string) from all groups
 * where the local user is admin, then marks the slot as forgotten.
 *
 * Only processes groups where `isAdmin(group.groupData, pubkey)` is true.
 * Groups with null groupData are skipped. Leaf removal is sequential (for...of).
 * After all removals, markSlotForgotten(slot) persists the slot to IDB.
 *
 * Leaf-to-slot mapping: fetches relay KP events for all group members, filters
 * by getKeyPackageIdentifier(event) === slot, then matches to ratchet tree leaves
 * via compareKeyPackageToLeafNode (per architecture.md Q3 resolution).
 *
 * @param client - The local MarmotClient instance.
 * @param pubkey - The local user's identity pubkey (used for isAdmin check).
 * @param slot - The slot identifier (d-tag value) of the device to forget.
 */
export async function forgetSiblingDevice(
  client: MarmotClient,
  pubkey: string,
  slot: string,
): Promise<void> {
  for (const group of client.groups.loaded) {
    const gd = group.groupData;
    // Guard: skip groups where local user is not admin or groupData is null.
    if (!gd || !isAdmin(gd, pubkey)) continue;

    // Fetch KP events for all group members from the group's relay set.
    const groupRelays = group.relays ?? [];
    let kpEvents: import("applesauce-core/helpers/event").NostrEvent[] = [];
    if (groupRelays.length > 0) {
      try {
        const members = getGroupMembers(group.state);
        if (members.length > 0) {
          kpEvents = await group.network.request(
            groupRelays,
            keyPackageFilters(members),
          );
        }
      } catch {
        // Network failure — skip this group rather than aborting the entire operation.
        // The slot will still be marked forgotten after the loop.
        continue;
      }
    }

    // Filter to events matching the target slot.
    const siblingEvents = kpEvents.filter(
      (event) => getKeyPackageIdentifier(event) === slot,
    );
    if (siblingEvents.length === 0) continue;

    // Find the leaf indexes corresponding to the sibling's KP events.
    const leafIndexes = siblingLeafIndexesForEvents(group, siblingEvents);

    // Remove each leaf sequentially.
    for (const leafIndex of leafIndexes) {
      await removeLeafWithRetry(group, leafIndex, async () => {
        // Re-derive after epoch advance: re-fetch KP events and re-match.
        const refreshedEvents = kpEvents.filter(
          (event) => getKeyPackageIdentifier(event) === slot,
        );
        const refreshedIndexes = siblingLeafIndexesForEvents(group, refreshedEvents);
        return refreshedIndexes[0] ?? null;
      });
    }
  }

  // Persist the slot to IDB so the auto-invite scan skips it (AC-SIBLING-3).
  await markSlotForgotten(slot);
}
