import { useEffect, useRef } from "react";

import {
  getGroupMembers,
  InviteManager,
  isAdmin,
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
  isGroupJoinedFromWelcome,
  loadInvitedKeys,
  markDeviceSeen,
  markGroupJoinedFromWelcome,
  persistInvitedKey,
} from "./device-store";
import { loadForgottenSlots } from "./forgotten-slots";
import { appendFailedWelcome, pruneOlderThan, type FailedWelcomeRecord } from "./failed-welcomes";
import { TASK_STATE_SYNC_KIND, type Task, type TaskStateSyncPayload } from "../store/task-events";
import type { TaskEvent } from "../store/task-events";
import type { TaskState } from "../store/task-reducer";
import { taskWinsOver } from "../domain/task-crdt";
import { loadAcceptedEvents } from "../persistence/raw-event-log-store";
import { buildProjection, replayOrder } from "../domain/task-projector";
import { mlsTrace } from "./mls-trace";

/**
 * Sender-side own-publish tracker for the `publish-task` trace event.
 *
 * GAP-2 (per the epic spec, baked into stories.json): `sendApplicationRumor`
 * does not return the kind-445 relay event id, so a sender-side bridge
 * from `rumor.id` (known at dispatch time) to the kind-445 `eventId` is
 * needed. The first attempt at this bridge tried to consume on the
 * receiver-side `applicationMessage` path, but that path is unreachable
 * for the sender's own messages: marmot-ts intentionally suppresses
 * self-echo (`#sentEventIds.delete(...)` in `MarmotGroup.ingest`, yielding
 * `kind: "skipped", reason: "self-echo"` and never firing
 * `applicationMessage`). The implementation here uses the publish path
 * instead, which sees the kind-445 NostrEvent (`event.id` = the kind-445
 * relay event id) at the moment marmot-ts calls
 * `network.publish(relays, applicationEvent)`.
 *
 * Mechanism: `task-store.tsx:dispatch` registers an expected publish via
 * {@link enqueueExpectedPublish} BEFORE `sendApplicationRumor`. The
 * registration is keyed by the group's `#h` tag (the nostr group id hex,
 * not the marmot idStr) and uses a per-hTag FIFO so back-to-back dispatches
 * stay correctly ordered. The network adapter's `publish()` calls
 * {@link consumeExpectedPublishForKind445} on every event; when the
 * event is a kind-445 with a matching `#h`, the front of that hTag's FIFO
 * is dequeued and a `publish-task` trace event is emitted with both the
 * rumorId (from the registration) and the kind-445 `eventId` (from the
 * event marmot-ts is publishing).
 *
 * Per-group ordering is guaranteed because marmot-ts's
 * `sendApplicationRumor` is internally serialized (it advances the MLS
 * state which can't interleave per group), so the publish call sequence
 * matches the registration sequence within a single hTag's FIFO.
 *
 * GAP-1 (rumor.id is the canonical correlator): there is no `TaskEvent.id`
 * field. The `taskEventId` slot in the `publish-task` trace is populated
 * from `rumor.id` so the field name from spec.md § Trace event shape
 * stays stable, but is semantically a rumor identifier.
 */
interface ExpectedPublish {
  rumorId: string;
  groupId: string;
  taskEventId: string;
  dispatchedAt: number;
}

const expectedPublishByHTag = new Map<string, ExpectedPublish[]>();

/**
 * Per-hTag counter incremented while a dispatch's `sendApplicationRumor`
 * is on the call stack. Combined with {@link windowKind445State} below,
 * this is the discriminator that ensures `publish-task` is emitted ONLY
 * when we can be sure the kind-445 we observed is the one our dispatch
 * sent — not a concurrent commit/proposal publish from auto-invite or
 * per-leaf-remove.
 *
 * Why this matters: marmot-ts publishes kind-445 events from FOUR call
 * sites (verified by grep on marmot-group.js:232 createCommit, :338
 * proposal, :400 sendApplicationRumor, :532 createCommit-with-welcomes
 * — all use the same GROUP_EVENT_KIND=445 with the same `#h` group tag,
 * confirmed at marmot-ts/dist/core/protocol.js:43 GROUP_EVENT_KIND=445).
 * If an auto-invite or per-leaf-remove flow's `createCommit` publishes
 * a kind-445 between our `beginDispatchPublishWindow` and the matching
 * `endDispatchPublishWindow`, the count of kind-445s seen in window
 * exceeds 1 and we emit NOTHING (rather than guess wrong) — the
 * dispatched task simply has no `publish-task` trace event for that
 * round. S3's classifier handles missing `publish-task` records by
 * classifying that test as `unknown`, which AC-DIAG-3 / AC-REPORT-3
 * already cover.
 *
 * Why "no emit" instead of "best guess": S4 is a decision gate;
 * emitting a wrong `publish-task` would silently misroute the F-class
 * verdict for the affected test (e.g. lookup against the wrong kind-445
 * eventId on the receiver side classifies F1 when reality is F3).
 * Better to lose a publish-task than emit a wrong one.
 */
const dispatchPublishInFlightByHTag = new Map<string, number>();

/**
 * Per-hTag tally of kind-445 publishes observed while a dispatch
 * window is open. The first observed event is held tentatively in
 * `firstEvent`; the dequeue + `publish-task` emit is deferred to
 * {@link endDispatchPublishWindow} so we can disambiguate by total
 * count. If exactly 1 kind-445 fired in the window, that one IS our
 * own application-rumor publish (the per-group dispatch mutex in
 * task-store.tsx ensures no other dispatch is in flight on this
 * hTag, and our publish is guaranteed to fire before
 * `endDispatchPublishWindow` runs in the dispatch's `finally`). If 2
 * or more fired, an auto-invite/proposal commit interleaved and we
 * cannot distinguish; the parked FIFO entry is dropped without emit.
 */
const windowKind445State = new Map<
  string,
  { count: number; firstEvent: NostrEvent | null }
>();

export function enqueueExpectedPublish(
  hTag: string,
  rumorId: string,
  groupId: string,
  taskEventId: string,
): void {
  const existing = expectedPublishByHTag.get(hTag);
  const entry: ExpectedPublish = {
    rumorId,
    groupId,
    taskEventId,
    dispatchedAt: Date.now(),
  };
  if (existing) {
    existing.push(entry);
  } else {
    expectedPublishByHTag.set(hTag, [entry]);
  }
}

/**
 * Removes a parked entry by rumorId after a `sendApplicationRumor`
 * failure. Without this, a thrown publish (e.g. `createGroupEvent`
 * threw on epoch divergence) would leave its expectation parked, and
 * the next successful publish on the same hTag would emit a
 * `publish-task` with the WRONG kind-445 eventId.
 */
export function removeExpectedPublishByRumorId(
  hTag: string,
  rumorId: string,
): void {
  const queue = expectedPublishByHTag.get(hTag);
  if (!queue) return;
  const idx = queue.findIndex((e) => e.rumorId === rumorId);
  if (idx === -1) return;
  queue.splice(idx, 1);
  if (queue.length === 0) expectedPublishByHTag.delete(hTag);
}

/**
 * Bracket a dispatch's `sendApplicationRumor` call to scope the
 * consumer. Used by `task-store.tsx:dispatch`:
 *   beginDispatchPublishWindow(hTag);
 *   try { await send(...); } finally { endDispatchPublishWindow(hTag); }
 *
 * Initializes the kind-445 tally for the window so the consumer can
 * count without dequeueing. The deferred dequeue + emit happens in
 * {@link endDispatchPublishWindow} when the count is unambiguous.
 */
export function beginDispatchPublishWindow(hTag: string): void {
  const prev = dispatchPublishInFlightByHTag.get(hTag) ?? 0;
  dispatchPublishInFlightByHTag.set(hTag, prev + 1);
  // Only initialize the tally on the first nesting level. Re-entry on
  // an already-open window (shouldn't happen with the per-group
  // dispatch mutex, but defensive) leaves the existing tally alone.
  if (!windowKind445State.has(hTag)) {
    windowKind445State.set(hTag, { count: 0, firstEvent: null });
  }
}

export function endDispatchPublishWindow(hTag: string): void {
  const cur = dispatchPublishInFlightByHTag.get(hTag) ?? 0;
  if (cur > 1) {
    dispatchPublishInFlightByHTag.set(hTag, cur - 1);
    return; // still nested, decide later
  }
  dispatchPublishInFlightByHTag.delete(hTag);

  const state = windowKind445State.get(hTag);
  windowKind445State.delete(hTag);

  // Decide: emit, drop, or leave-parked based on how many kind-445s
  // were observed in this window.
  if (!state) return;
  const queue = expectedPublishByHTag.get(hTag);
  const front = queue?.[0];

  if (state.count === 1 && state.firstEvent && front) {
    // Unambiguous: exactly one kind-445 fired during our window. The
    // mutex guarantees no other of OUR dispatches is in flight on this
    // hTag, and our publish is guaranteed to have fired by now (it's
    // awaited inside the window). So this one event IS our publish.
    queue!.shift();
    if (queue!.length === 0) expectedPublishByHTag.delete(hTag);
    mlsTrace.record({
      kind: "publish-task",
      t: Date.now(),
      groupId: front.groupId,
      taskEventId: front.taskEventId,
      rumorId: front.rumorId,
      eventId: state.firstEvent.id,
      createdAt: state.firstEvent.created_at ?? 0,
    });
    return;
  }

  if (state.count > 1 && front) {
    // Ambiguous: a commit/proposal publish from auto-invite or
    // per-leaf-remove interleaved with our application-rumor publish.
    // We cannot tell which kind-445 was ours without decrypting.
    // Emit nothing for this dispatch and drop the parked entry so the
    // next dispatch on the same hTag isn't poisoned. S3's classifier
    // will see no `publish-task` for this rumorId and classify the
    // affected test as `unknown` (per AC-DIAG-3 / AC-REPORT-3).
    queue!.shift();
    if (queue!.length === 0) expectedPublishByHTag.delete(hTag);
    return;
  }

  // count === 0: our publish never fired (e.g. createApplicationMessage
  // threw before reaching network.publish). The dispatch's catch has
  // already called removeExpectedPublishByRumorId, so the FIFO front
  // for THIS rumor is already gone — `front` here would be a different
  // entry from a future dispatch (impossible with the mutex but
  // theoretically) or undefined. Either way, leave it alone.
}

/**
 * Called by {@link NdkNetworkAdapter.publish} for every event it
 * publishes. Counts kind-445 events fired during an open dispatch
 * window WITHOUT immediately dequeueing. The dequeue + `publish-task`
 * emit is deferred to {@link endDispatchPublishWindow} so we can
 * disambiguate the our-publish-vs-commit-interleaved case by total
 * count. See comment on {@link dispatchPublishInFlightByHTag} for
 * the full rationale.
 */
export function consumeExpectedPublishForKind445(event: NostrEvent): void {
  if (event.kind !== 445) return;
  const hTagEntry = event.tags.find(
    (tag): tag is [string, string, ...string[]] =>
      Array.isArray(tag) && tag[0] === "h" && typeof tag[1] === "string",
  );
  if (!hTagEntry) return;
  const hTag = hTagEntry[1];
  if ((dispatchPublishInFlightByHTag.get(hTag) ?? 0) === 0) return;
  const state = windowKind445State.get(hTag);
  if (!state) return;
  state.count++;
  if (state.count === 1) state.firstEvent = event;
  // Do not dequeue here. The decision is deferred to
  // endDispatchPublishWindow once the total count is known.
}

/**
 * Reads the addressable slot identifier off a {@link ListedKeyPackage}.
 *
 * marmot-ts v0.5 has a runtime/type mismatch on this field — the static
 * type calls it `identifier`, but {@link KeyPackageManager.list} actually
 * emits the runtime field as `d`. We read both so we keep working past a
 * future upstream fix without churn here.
 *
 * Exported for the dual-read pinning test (device-sync.test.ts): the
 * `d`-fallback is load-bearing against the marmot-ts runtime/type mismatch
 * and must not be simplified away on the assumption the fork is "fixed" —
 * a regression there would silently break device loading with no tsc error.
 */
export function keyPackageSlot(
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

/**
 * Returns true if the KP event's slot identifier is in the forgotten-slots
 * Set, meaning the auto-invite scan should skip this device.
 *
 * Exported for unit testing. Both `syncKnownKeyPackages` and
 * `handleKeyPackageEvent` use this predicate before calling `inviteToAllGroups`.
 *
 * Returns false (do NOT skip) when `getKeyPackageIdentifier` returns undefined
 * (legacy kind-443 events without a slot), so the existing invite behavior is
 * preserved for events that predate the slot scheme.
 */
export function isSlotForgotten(
  event: NostrEvent,
  forgottenSlots: Set<string>,
): boolean {
  const slot = getKeyPackageIdentifier(event);
  return slot !== undefined && forgottenSlots.has(slot);
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

    // Extract groupId best-effort (may fail if the Welcome is malformed).
    let groupId: string | null = null;
    try {
      if ("readInviteGroupInfo" in client) {
        const groupInfo = await (client as MarmotClient).readInviteGroupInfo(invite);
        if (groupInfo != null) {
          groupId = Buffer.from(groupInfo.groupContext.groupId).toString("hex");
        }
      }
    } catch {
      // Extraction is best-effort; ignore errors here.
    }

    // Classify the failure reason from the error message.
    const errMsg = err instanceof Error ? err.message : String(err);
    let failureReason: string;
    if (/[Nn]o matching/i.test(errMsg)) {
      failureReason = "no_matching_kp";
    } else if (/ciphersuite/i.test(errMsg)) {
      failureReason = "ciphersuite_mismatch";
    } else {
      failureReason = "unknown";
    }

    const record: FailedWelcomeRecord = {
      recordedAt: Date.now(),
      giftWrapEventId: invite.id,
      innerKind: invite.kind ?? 444,
      innerCreatedAt: invite.created_at ?? 0,
      inviterPubkey: invite.pubkey ?? null,
      groupId,
      kpRef: null,
      failureReason,
      failureDetail: errMsg,
    };

    // AC-LOG-1: appendFailedWelcome BEFORE markAsRead.
    await appendFailedWelcome(record);
    await inviteReader.markAsRead(invite.id);
    return null;
  }
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

    // AC-LOG-5: prune failed-welcome records older than 30 days once per mount.
    pruneOlderThan(30 * 86400 * 1000).catch(console.error);

    // Barrier: resolves when the current join + post-join bookkeeping
    // completes. Set BEFORE joinGroupFromWelcome because that call fires
    // the synchronous "groupsUpdated" event, which `runKeyPackageSync`'s
    // own `client.groups.on("updated", ...)` listener (below) reacts to —
    // awaiting this barrier keeps its post-join IDB reads
    // (isGroupJoinedFromWelcome / joiner-suppression) from racing the
    // in-flight join's own writes.
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
        // AC-LOG-2: log decrypt failures. Handler is synchronous; fire-and-forget.
        appendFailedWelcome({
          recordedAt: Date.now(),
          giftWrapEventId: eventId,
          innerKind: 0,
          innerCreatedAt: 0,
          inviterPubkey: null,
          groupId: null,
          kpRef: null,
          failureReason: "decrypt_failed",
          failureDetail: err.message,
        }).catch(console.error);
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
            // Fix: do not pre-seed. Let the normal ingest path apply every
            // historical kind-445 through ts-mls, which correctly advances
            // the state epoch-by-epoch until the joiner catches up to the
            // admin. CUTOVER (S12): that normal ingest path is now entirely
            // the engine's job (src/integration/marmot-adapter.ts's
            // `catchUp()`/`openLive()`, driven by
            // src/engine/receive-engine.ts) — this file no longer runs its
            // own group-ingest driver or retry queue; the engine's own
            // deferred-retry-on-epoch-advance (fsm.md L8) is the straggler-
            // application-message backstop this comment used to attribute to
            // `src/marmot/ingest-queue.ts`.
            //
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

    // ── Effect 2: Auto-invite new devices ───────────────────────────
    // refreshForgotten is declared here (outside runKeyPackageSync) so its
    // reference is stable and can be passed to both addEventListener and
    // removeEventListener in the effect cleanup (AC-INVITE-4).
    let forgottenSlots = new Set<string>();
    const refreshForgotten = async () => {
      forgottenSlots = await loadForgottenSlots();
    };
    window.addEventListener("notestr:forgotten-slots-changed", refreshForgotten);

    const runKeyPackageSync = async () => {
      // Initialize the in-memory forgotten-slots cache before the sync loop
      // runs (AC-INVITE-1). The cache is shared across syncKnownKeyPackages
      // and handleKeyPackageEvent calls via the outer closure.
      forgottenSlots = await loadForgottenSlots();

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
            // Sequential to avoid MLS epoch conflicts. Invite AND publish the
            // task-state snapshot as one unit (shared with the manual-invite
            // path): a sibling device auto-added at a later MLS epoch cannot
            // decrypt pre-join kind-445 traffic, so without the snapshot it
            // would start from an empty board.
            await inviteAndPublishSnapshot(
              group,
              kpEvent,
              inviteePubkey,
              signer,
              client,
              relays,
            );
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

        // Collapse to one event per slot, preferring the freshest (highest
        // created_at). The raw `knownEvents` Map is keyed by event id, so
        // both old and rotated events for the same `d` slot coexist after a
        // sibling rotates its KeyPackage. Map iteration is insertion order, so
        // the oldest event would win without this collapse. The resulting stale
        // Welcome would target a KP the invitee has since rotated and can no
        // longer enumerate during decrypt — marmot-ts `list()` semantics
        // exclude deprecated entries, so the invitee's joinGroupFromWelcome
        // call throws "no_matching_kp" and the Welcome is silently dropped.
        //
        // Mirrors the freshness sort at GroupManager.tsx:165-170 (manual
        // invite path).
        const latestBySlot = new Map<string, NostrEvent>();
        for (const event of knownEvents.values()) {
          const slot = getKeyPackageIdentifier(event) ?? event.id;
          const prev = latestBySlot.get(slot);
          if (!prev || (event.created_at ?? 0) > (prev.created_at ?? 0)) {
            latestBySlot.set(slot, event);
          }
        }

        for (const event of latestBySlot.values()) {
          if (!mountedRef.current) return;
          if (isLocalDevice(event, local)) continue;
          if (getKeyPackageNostrPubkey(event) !== pubkey) continue;
          // AC-INVITE-2: skip KP events whose slot the user has forgotten.
          if (isSlotForgotten(event, forgottenSlots)) continue;
          await inviteToAllGroups(event);
        }
      };

      const handleKeyPackageEvent = async (event: NostrEvent) => {
        knownEvents.set(event.id, event);
        if (joinBarrier) await joinBarrier;
        const local = await getLocalKnownIds();
        if (isLocalDevice(event, local)) return;
        if (getKeyPackageNostrPubkey(event) !== pubkey) return;
        // AC-INVITE-3: skip live KP events whose slot the user has forgotten.
        if (isSlotForgotten(event, forgottenSlots)) return;

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

    // Launch both flows. CUTOVER (S12): the group-ingest driver (historical
    // fetch + live subscription + retry-drain + persistence-side message
    // listener) that used to run here as "Effect 1.5" is retired -- the
    // engine (src/engine/receive-engine.ts, driven via
    // src/integration/marmot-adapter.ts) is now the SOLE ingest driver and
    // receive path for this group. There is therefore no
    // `refreshGroupSync()` call here anymore, and no top-level
    // `client.groups.on("updated", ...)` listener for it either.
    runWelcomeSync();
    runKeyPackageSync();

    return () => {
      mountedRef.current = false;
      // AC-INVITE-4: remove the forgotten-slots cache refresh listener using
      // the same refreshForgotten reference captured in addEventListener above.
      window.removeEventListener("notestr:forgotten-slots-changed", refreshForgotten);
      for (const sub of subs) {
        sub.unsubscribe();
      }
    };
  }, [client, pubkey, relays, signer]);
}

/**
 * Fetches kind-30078 task state sync events from the relay for the given
 * group and own pubkey, decrypts them (NIP-44), validates the payload, and
 * applies a CRDT LWW/FWW merge gate against the caller-supplied currentState.
 *
 * Returns an array of synthetic `task.created` TaskEvents for tasks that won
 * the CRDT gate. These events should be persisted via `appendEvent` by the
 * caller and then re-read to rebuild state. The function is non-fatal: any
 * error (relay unavailable, decryption failure, JSON parse error) is caught
 * and logged, and the function returns `[]` so the caller gracefully
 * degrades to empty state.
 *
 * CRDT merge semantics (applied per task in each payload):
 *   - Task NOT in currentState → insert (FWW: first-write-wins for new tasks)
 *   - Task in currentState, payload.updatedAt > existing.updatedAt → accept (LWW)
 *   - Task in currentState, payload.updatedAt === existing.updatedAt,
 *     payload.task.updatedBy < existing.updatedBy → accept (deterministic tie-break)
 *   - Otherwise: existing wins → skip
 *
 * @param groupId      - group.idStr (MLS hex ID, used as IDB key and d-tag component)
 * @param ownPubkey    - hex pubkey of the new member (used to construct the d-tag)
 * @param signer       - EventSigner with optional nip44 capability
 * @param client       - MarmotClient; if null, returns [] immediately (AC-12)
 * @param relays       - relay URLs to query
 * @param currentState - current in-memory TaskState used for CRDT gate comparisons
 */
export async function fetchAndApplyTaskBootstrap(
  groupId: string,
  ownPubkey: string,
  signer: EventSigner,
  client: MarmotClient | null,
  relays: string[],
  currentState: TaskState,
): Promise<TaskEvent[]> {
  if (!client) return [];
  if (!signer.nip44) {
    console.error("[task-sync] signer does not support NIP-44; cannot fetch bootstrap");
    return [];
  }
  try {
    const dTag = `notestr:task-sync:${groupId}:${ownPubkey}`;
    const events = await client.network.request(relays, [
      { kinds: [TASK_STATE_SYNC_KIND], "#d": [dTag], limit: 10 },
    ]);

    // Author-authenticity gate. NIP-44 decryptability is NOT authorization —
    // any Nostr key can encrypt a task-sync payload to our pubkey and publish
    // it under this #d tag, so the membership of the *author* is what
    // authorizes a merge. `memberPubkeys` is the current MLS member set; each
    // relay event is filtered against it below. The production call path
    // (task-store load for a welcome-joined group) always has the group loaded,
    // so this is the security-relevant fail-closed path. If the group cannot be
    // resolved (only reachable by an uninitialised/bare client, never by an
    // attacker who cannot touch our own client state) we log and leave
    // `memberPubkeys` null, which disables only the filter — not the rest of
    // the merge — preserving behaviour for that unreachable-in-prod case.
    const group = client.groups?.loaded?.find((g) => g.idStr === groupId);
    const memberPubkeys = group?.state ? getGroupMembers(group.state) : null;
    if (!memberPubkeys) {
      console.warn(
        "[task-sync] bootstrap: group unavailable; cannot verify snapshot author membership",
      );
    }

    // `accepted` tracks the per-task winner across ALL relay events in this
    // fetch, seeded from the caller-supplied currentState. Updating it on every
    // win (rather than only comparing against the seed) ensures that a second
    // relay event carrying the same task ID is evaluated against the already-
    // accepted version rather than the original seed — relay-order independence.
    const accepted = new Map<string, Task>(currentState);

    // `wonFromBootstrap` records the final winning Task for each ID that beat
    // currentState. It is written inside the loop but events are generated
    // ONLY after all relay events are processed, so each task ID produces
    // exactly one synthetic task.created event regardless of how many relay
    // events contained that ID. Without this deferred approach, processing
    // order A→B then B→A could emit two task.created events for the same ID;
    // the reducer's FWW semantics would then pick whichever was written first
    // to IDB, re-introducing relay-order dependence.
    const wonFromBootstrap = new Map<string, Task>();

    for (const event of events) {
      // Reject snapshots whose author is not a current group member (checked
      // before decryption — author membership, not decryptability, authorizes
      // the merge). Skipped only when membership is unverifiable (see above).
      if (memberPubkeys && !memberPubkeys.includes(event.pubkey)) {
        console.debug("[task-sync] skipping bootstrap snapshot from non-member author");
        continue;
      }
      let payload: TaskStateSyncPayload;
      try {
        const plaintext = await signer.nip44.decrypt(event.pubkey, event.content);
        const parsed = JSON.parse(plaintext) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          (parsed as TaskStateSyncPayload).version !== 1 ||
          (parsed as TaskStateSyncPayload).type !== "task.state_sync" ||
          (parsed as TaskStateSyncPayload).groupId !== groupId ||
          !Array.isArray((parsed as TaskStateSyncPayload).tasks)
        ) {
          console.debug("[task-sync] skipping invalid payload");
          continue;
        }
        payload = parsed as TaskStateSyncPayload;
      } catch {
        // Decryption failed or JSON parse failed — skip this event
        continue;
      }

      // CRDT merge gate: FWW for tasks not yet seen, LWW (updatedAt) for
      // existing, deterministic tie-break delegated to the shared
      // taskWinsOver authority (src/domain/task-crdt.ts).
      for (const task of payload.tasks) {
        const existing = accepted.get(task.id);
        const wins = !existing || taskWinsOver(task, existing);
        if (wins) {
          accepted.set(task.id, task);
          wonFromBootstrap.set(task.id, task);
        }
      }
    }

    // Emit exactly one task.created per winning task — deferred so the gate
    // above can override earlier relay events before committing to an event.
    const syntheticEvents: TaskEvent[] = Array.from(wonFromBootstrap.values()).map(
      (task) => ({ type: "task.created" as const, task }),
    );

    console.debug(
      `[task-sync] bootstrap: ${syntheticEvents.length} tasks from ${events.length} relay events`,
    );
    return syntheticEvents;
  } catch (err) {
    // Non-fatal: relay error, network error, etc.
    console.error("[task-sync] fetchAndApplyTaskBootstrap failed (non-fatal):", err);
    return [];
  }
}

/**
 * Publishes a kind-30078 task state sync event to the relay after a
 * successful invite, so the new member can bootstrap task state on join.
 *
 * The payload is NIP-44 encrypted to the invitee's pubkey. All errors
 * are caught internally and logged — this function is fire-and-forget
 * and NEVER propagates. The invite flow always completes successfully
 * regardless of whether this publish succeeds.
 *
 * CUTOVER (S12): the local task-state read was rewired from the retired
 * `src/store/persistence.ts`/`task-reducer.ts` legacy log+reducer pair to
 * the durable engine store — `raw-event-log-store.ts`'s
 * `loadAcceptedEvents` plus `task-projector.ts`'s `buildProjection`/
 * `replayOrder` — a delegation substitution only (same "read local
 * persisted task state" contract, new source), required because the
 * legacy log this function used to read is gone.
 *
 * @param groupId           - group.idStr (MLS hex ID used for IDB keys and d-tag)
 * @param inviteePubkeyHex  - hex pubkey of the invited member
 * @param signer            - EventSigner with optional nip44 capability
 * @param client            - MarmotClient for network publish
 * @param relays            - relay URLs to publish to
 */
export async function publishTaskStateSync(
  groupId: string,
  inviteePubkeyHex: string,
  signer: EventSigner,
  client: MarmotClient,
  relays: string[],
): Promise<void> {
  try {
    if (!signer.nip44) {
      console.error("[task-sync] signer does not support NIP-44; skipping publish");
      return;
    }

    // 1. Load and rebuild task state from the durable accepted-event log
    const acceptedEvents = await loadAcceptedEvents(groupId);
    const taskState = buildProjection(replayOrder(acceptedEvents));

    // 2. Build payload — deleted tasks are already removed from the map by the projector
    const ownPubkey = await signer.getPublicKey();
    const tasks: Task[] = Array.from(taskState.values());
    const payload: TaskStateSyncPayload = {
      version: 1,
      type: "task.state_sync",
      groupId,
      tasks,
      syncedAt: Math.floor(Date.now() / 1000),
      inviterPubkey: ownPubkey,
    };

    // 3. NIP-44 encrypt to invitee
    const ciphertext = await signer.nip44.encrypt(
      inviteePubkeyHex,
      JSON.stringify(payload),
    );

    // 4. Build and sign kind-30078 event
    const dTag = `notestr:task-sync:${groupId}:${inviteePubkeyHex}`;
    const unsigned = {
      kind: TASK_STATE_SYNC_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", dTag]],
      content: ciphertext,
      pubkey: ownPubkey,
    };
    const signed = await signer.signEvent(unsigned);

    // 5. Publish
    await client.network.publish(relays, signed);
    console.debug(
      "[task-sync] published task state sync for",
      inviteePubkeyHex,
      "tasks:",
      tasks.length,
    );
  } catch (err) {
    // Non-fatal: log and continue. New member gracefully degrades to empty state.
    console.error("[task-sync] publishTaskStateSync failed (non-fatal):", err);
  }
}

/**
 * Invites a key package into a group and then publishes the task-state
 * snapshot for the invitee, as a single unit.
 *
 * This pairing is the contract that keeps a newly-added member's board in
 * sync. A member admitted at a later MLS epoch cannot decrypt the group's
 * pre-join kind-445 traffic (MLS forward secrecy), so the kind-30078
 * snapshot is the ONLY way it learns about tasks that existed before it
 * joined. Both invite paths — the manual invite in GroupManager and the
 * automatic sibling-device invite in useDeviceSync — MUST route through
 * this helper so they can never drift. (They previously did drift: the
 * auto-invite path omitted the snapshot, leaving auto-added sibling
 * devices starting from an empty board.)
 *
 * The invite is awaited (callers depend on it having completed and on the
 * epoch having advanced). The snapshot publish is fire-and-forget:
 * publishTaskStateSync catches and logs its own errors and never throws,
 * so a failed snapshot never fails the invite. The snapshot is published
 * only after the invite resolves, so a rejected invite publishes nothing.
 *
 * @param group             - the MLS group to invite into
 * @param kpEvent           - the invitee's key-package event
 * @param inviteePubkeyHex  - hex pubkey of the invited member (NIP-44 target)
 * @param signer            - EventSigner with optional nip44 capability
 * @param client            - MarmotClient for network publish
 * @param relays            - relay URLs to publish to
 */
export async function inviteAndPublishSnapshot(
  group: MarmotGroup,
  kpEvent: NostrEvent,
  inviteePubkeyHex: string,
  signer: EventSigner,
  client: MarmotClient,
  relays: string[],
): Promise<void> {
  await group.inviteByKeyPackageEvent(kpEvent);
  void publishTaskStateSync(group.idStr, inviteePubkeyHex, signer, client, relays);
}

