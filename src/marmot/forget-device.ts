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
 *     publishes a targeted Remove proposal via `group.propose` (not
 *     `group.leave()`); sibling-forget uses `removeLeafByIndex`.
 *
 * Architect decisions:
 *   D1 (IDB cleanup): indexedDB.deleteDatabase by stable name for
 *      notestr-key-packages, notestr-group-state, notestr-invite-store.
 *   D2 (kind-5 publish): client.network.publish(relays, signedEvent).
 *   D3 (epoch race): retry-once wrapper before bubbling.
 *
 * Mutation-test residuals (Stryker 9.6.1, 2026-06-29 — score 0.94, 9 residuals).
 * Re-audited after the per-pubkey IDB partition change (Step 3b): that change
 * added 2 mutants, both killed — the partitioned deleteDatabase block is fully
 * covered. The 9 survivors below are unchanged and all classified equivalent —
 * do not chase further:
 *   - L102 StringLiteral fallback `""` (no coverage): only reached when firstErr
 *     is not an Error instance; any non-epoch string is observably identical.
 *   - L113 `if (recomputeLeafIndex)`: the no-callback branch is dead at every
 *     production call site (only forgetSiblingDevice uses removeLeafWithRetry,
 *     always with a callback).
 *   - L162 / L207 `<` off-by-one: index past length yields `undefined` node,
 *     filtered by the `!node` guard.
 *   - L212 `sig.length === ownSigKey.length`: MLS signaturePublicKey arrays
 *     are fixed-length (ed25519 / 32B); the guard is defensive against an
 *     MLS-impossible state.
 *   - L252 `own !== null ? filter : raw`: when null, `idx !== null` is always
 *     true for number indexes — the filter is a no-op.
 *   - L340 `kp.published ?? []` (no coverage): nullish branch still hits the
 *     falsy-id guard and emits nothing.
 *   - L413 `let kpEvents = []`: only observed on the empty-relays branch;
 *     downstream slot-filter yields [] for any seed value.
 *   - L423 `catch { continue }`: redundant with the trailing
 *     `if (siblingEvents.length === 0) continue`.
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
  defaultProposalTypes,
  getOwnLeafNode,
  nodeTypes,
} from "ts-mls";

import { removeLeafByIndex } from "./per-leaf-remove";
import { markSlotForgotten } from "./forgotten-slots";
import {
  bootstrapCompletedStore,
  clearIdentityStore,
  getActivePubkey,
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

/**
 * Returns the ratchet-tree leaf index of THIS device's own leaf in the group,
 * or null if it cannot be determined.
 *
 * The own leaf is identified by its MLS `signaturePublicKey`, which is unique
 * per device even when two devices share one Nostr pubkey. `getOwnLeafNode`
 * reads `state.privatePath.leafIndex` and works for both group creators
 * (ephemeral KP, never in `keyPackages.list()`) and joiners. We then walk the
 * ratchet tree to find the node whose signature key matches and convert the
 * node index to a leaf index.
 *
 * Returns null when `getOwnLeafNode` throws (`state.privatePath` absent) — a
 * degraded state that should not occur for a group this device belongs to. The
 * pubkey alone cannot identify a single device's leaf (a Nostr identity may own
 * several leaves in one group), which is exactly why credential/pubkey matching
 * is per-identity and the signature key is needed for per-device resolution.
 *
 * @param group - The group whose own leaf index to resolve.
 */
function ownLeafIndex(group: MarmotGroup): number | null {
  try {
    const ownLeaf = getOwnLeafNode(group.state);
    const ownSigKey = ownLeaf.signaturePublicKey;
    // Walk the ratchet tree to find the node index whose signature key matches.
    for (let ni = 0; ni < group.state.ratchetTree.length; ni++) {
      const node = group.state.ratchetTree[ni];
      if (!node || node.nodeType !== nodeTypes.leaf) continue;
      const sig = node.leaf.signaturePublicKey;
      if (
        sig.length === ownSigKey.length &&
        sig.every((b, i) => b === ownSigKey[i])
      ) {
        return Math.floor(ni / 2);
      }
    }
  } catch {
    // getOwnLeafNode throws if state.privatePath is absent (very unlikely in a
    // live group context). Treat as "own leaf unknown".
  }
  return null;
}

/**
 * Fallback leaf-index resolution for the case where the sibling has rotated
 * its KeyPackage after being admitted to the group.
 *
 * After KP rotation the relay holds a NEW KP event for the same slot, while
 * the ratchet tree still has the OLD leaf (committed from the original KP).
 * `compareKeyPackageToLeafNode` compares cryptographic material and therefore
 * returns false for the rotated pair — `siblingLeafIndexesForEvents` yields [].
 *
 * This function resolves the ambiguity by credential-identity: all ratchet tree
 * leaves for `siblingPubkey` are found, then the local admin's own leaf (same
 * pubkey when admin == sibling-npub) is excluded via {@link ownLeafIndex}.
 * The remaining leaf indexes belong to the sibling.
 *
 * @param group          - The group to search.
 * @param siblingPubkey  - The Nostr pubkey extracted from the sibling's KP events.
 */
function siblingLeafIndexesByPubkeyExcludingOwn(
  group: MarmotGroup,
  siblingPubkey: string,
): number[] {
  // All leaf indexes in the group for siblingPubkey (may include A1's own leaf
  // when A1 and the sibling share the same npub).
  const allForPubkey = getPubkeyLeafNodeIndexes(group.state, siblingPubkey);

  // Exclude the local admin's own leaf (same pubkey when admin == sibling-npub).
  const own = ownLeafIndex(group);
  return own !== null
    ? allForPubkey.filter((idx) => idx !== own)
    : allForPubkey;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Removes this device from all MLS groups, deletes its key packages from the
 * relay, clears all local IDB stores, and signs out.
 *
 * Step order (must not be reordered — AC-SELF-1 through AC-SIGNOUT-2):
 *   1. Self-leave proposals: for each group containing this user's leaf,
 *      publish a kind-445 Remove proposal targeting ONLY this device's own
 *      leaf. RFC 9420 §12.4 forbids a member from committing a Remove
 *      targeting their own leaf, so we publish a proposal (via
 *      `group.propose`, the same wire path as `group.leave()`) and let another
 *      admin commit it. We do NOT use `group.leave()`: it proposes a Remove for
 *      EVERY leaf bearing this Nostr pubkey, which would evict the user's other
 *      devices (sibling leaves) from the group too — a per-identity action
 *      behind a per-device button. See selfLeafIndexesForPubkey / ownLeafIndex.
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
  // Per-device, not per-identity. A member who shares one Nostr pubkey across
  // several devices has one ratchet-tree leaf PER device. We must propose a
  // Remove for ONLY this device's own leaf — `group.leave()` would propose one
  // Remove per leaf matching the pubkey (marmot-ts `proposeLeaveGroup`), evicting
  // the user's sibling devices too. RFC 9420 §12.4 forbids committing a Remove of
  // one's own leaf, so we publish a kind-445 *proposal* via `group.propose`
  // (same relay path as `leave()`, no self-commit) and let an admin commit it.
  for (const group of client.groups.loaded) {
    if (selfLeafIndexesForPubkey(group, pubkey).length === 0) continue;
    const leafIndex = ownLeafIndex(group);
    if (leafIndex === null) {
      // Degraded state: this device's own leaf could not be identified
      // (state.privatePath absent). Fall back to the pubkey-wide `leave()` so
      // the device still departs every group rather than silently staying in.
      // Should not happen for a live group this device is a member of.
      await group.leave();
      continue;
    }
    await group.propose(async () => ({
      proposalType: defaultProposalTypes.remove,
      remove: { removed: leafIndex },
    }));
    // Mirror group.leave()'s teardown: purge this group's local MLS state once
    // the departure proposal is published. group.leave() called destroy()
    // internally; group.propose() does not, so we do it here. Without this, a
    // failure in a later step (e.g. kind-5 publish) — or a reload before
    // Step 3's IDB wipe — could resurface state for a group we've already
    // announced leaving.
    await group.destroy();
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
  await bootstrapCompletedStore.clear();
  await clearIdentityStore();

  // 3b. Delete the three stores owned by MarmotClient's init() closure
  // (Decision D1: indexedDB.deleteDatabase by stable name).
  // The marmot IDB layer is partitioned per-pubkey (storage.ts), so the real
  // databases are `notestr-${pubkey}-${name}` — deleting the legacy origin-only
  // names would leave this device's private MLS state (key packages, group
  // state, invites) on disk after a self-forget. Delete the ACTIVE partition's
  // databases.
  const activePartition = getActivePubkey();
  if (typeof indexedDB !== "undefined" && activePartition) {
    indexedDB.deleteDatabase(`notestr-${activePartition}-key-packages`);
    indexedDB.deleteDatabase(`notestr-${activePartition}-group-state`);
    indexedDB.deleteDatabase(`notestr-${activePartition}-invite-store`);
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

    // Derive the sibling's Nostr pubkey from the matched KP events (all events
    // for the same slot share the same event.pubkey by MIP-00).
    const siblingPubkey = siblingEvents[0].pubkey;

    // Find the leaf indexes corresponding to the sibling's KP events.
    // Primary: match by KP event equality (exact cryptographic match).
    let leafIndexes = siblingLeafIndexesForEvents(group, siblingEvents);

    // Fallback: if the primary match returns nothing the sibling has rotated
    // its KP after being admitted — the relay now holds the NEW KP while the
    // ratchet tree still holds the OLD leaf. Re-derive by credential pubkey,
    // excluding the local admin's own leaf (needed when admin shares the same
    // npub, e.g. sibling-forget of a same-account device).
    if (leafIndexes.length === 0) {
      leafIndexes = siblingLeafIndexesByPubkeyExcludingOwn(group, siblingPubkey);
    }

    // Remove each leaf sequentially.
    for (const leafIndex of leafIndexes) {
      await removeLeafWithRetry(group, leafIndex, async () => {
        // Re-derive after epoch advance: re-fetch KP events and re-match.
        const refreshedEvents = kpEvents.filter(
          (event) => getKeyPackageIdentifier(event) === slot,
        );
        let refreshedIndexes = siblingLeafIndexesForEvents(group, refreshedEvents);
        if (refreshedIndexes.length === 0) {
          refreshedIndexes = siblingLeafIndexesByPubkeyExcludingOwn(group, siblingPubkey);
        }
        return refreshedIndexes[0] ?? null;
      });
    }
  }

  // Persist the slot to IDB so the auto-invite scan skips it (AC-SIBLING-3).
  await markSlotForgotten(slot);
}
