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
import type { Filter } from "applesauce-core/helpers/filter";
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
import { loadForgottenSlots } from "./forgotten-slots";
import { appendFailedWelcome, pruneOlderThan, type FailedWelcomeRecord } from "./failed-welcomes";
import { TASK_EVENT_KIND, type TaskEvent } from "../store/task-events";
import { appendEvent } from "../store/persistence";
import {
  createPendingRetryQueue,
  type PendingRetryQueue,
} from "./ingest-queue";
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

function clearExpectedPublishesForHTag(hTag: string): void {
  expectedPublishByHTag.delete(hTag);
  dispatchPublishInFlightByHTag.delete(hTag);
  windowKind445State.delete(hTag);
}

/**
 * Per-event drain-on-ingest retry cap (Solution B, AC-B-2, AC-B-3).
 * Three retries per event per epoch. Counters reset on epoch advance
 * so a transient race that exhausts the budget in epoch N can still
 * recover when a fresh commit advances to epoch N+1.
 * See Design Decision 4 in specs/epic-mls-live-delivery-race/spec.md.
 */
export const MAX_RETRIES_PER_EPOCH = 3;

/**
 * Given the per-group retry-attempt map and a snapshot of parked events,
 * returns the subset eligible for the next drain-on-ingest attempt
 * (those whose count is still below `maxRetries`) and mutates `groupAttempts`
 * to increment each eligible event's counter.
 *
 * Pure function (operates on caller-supplied maps) so it can be unit-tested
 * independently of the React hook closure. The caller is responsible for
 * storing the mutated map back into `retryAttempts`.
 *
 * @param groupAttempts - mutable inner map for the group (eventId → count)
 * @param parked        - snapshot of events currently in the retry queue
 * @param maxRetries    - cap; events at or above this count are excluded
 * @returns array of events eligible for retry (their counts have been incremented)
 */
export function selectAndIncrementRetries(
  groupAttempts: Map<string, number>,
  parked: readonly { id: string }[],
  maxRetries: number,
): { id: string }[] {
  const eligible = parked.filter(
    (e) => (groupAttempts.get(e.id) ?? 0) < maxRetries,
  );
  for (const e of eligible) {
    groupAttempts.set(e.id, (groupAttempts.get(e.id) ?? 0) + 1);
  }
  return eligible;
}

/**
 * Subscribe-first since-bridge overlap window in seconds (Solution A).
 *
 * Sized for end-user clock skew, not the dev host — mobile and desktop
 * clocks routinely drift tens of seconds without active NTP sync.
 * 60 s provides ~60 000× margin against the macOS sub-second concern
 * noted in GAP-5. The dedup guard inside `ingestGroupEventsRaw`
 * (`syncedEventIds`) collapses any duplicate events introduced by the
 * overlap.  See Design Decision 3 in specs/epic-mls-live-delivery-race/spec.md.
 */
const OVERLAP_SECONDS = 60;

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

    // AC-LOG-5: prune failed-welcome records older than 30 days once per mount.
    pruneOlderThan(30 * 86400 * 1000).catch(console.error);

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
            // Fix: do not pre-seed. Let the normal `ingestGroupEvents`
            // path inside `syncGroup` apply every historical kind-445
            // through ts-mls, which correctly advances the state
            // epoch-by-epoch until the joiner catches up to the
            // admin. The retry queue added alongside this change
            // (src/marmot/ingest-queue.ts) catches any straggler
            // application messages that arrive before their
            // containing-epoch commit.
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
    // Per-event-per-epoch retry budget for the drain-on-ingest path
    // (Solution B). Outer key: groupId; inner key: kind-445 eventId;
    // value: number of drain-on-ingest attempts within the current epoch.
    // Reset on epoch advance (attachRetryOnEpochAdvance) so a transient
    // race that exhausts the budget within epoch N can still recover when
    // a fresh commit advances to epoch N+1. Dropped wholesale for a group
    // in refreshGroupSync alongside pendingRetry.delete. See Design
    // Decision 4 in specs/epic-mls-live-delivery-race/spec.md.
    const retryAttempts = new Map<string, Map<string, number>>();

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

      mlsTrace.record({
        kind: "ingest-call",
        t: Date.now(),
        groupId: group.idStr,
        eventIds: pending.map((e) => e.id),
        epoch: group.state.groupContext.epoch.toString(),
      });

      for await (const result of group.ingest(pending)) {
        const epochBefore = group.state.groupContext.epoch.toString();
        const reason =
          "reason" in result && typeof result.reason === "string"
            ? result.reason
            : undefined;
        // epochAfter is read AFTER the handler has run. For `processed`
        // commits this is one ahead; for application messages it's
        // unchanged.
        const epochAfter = group.state.groupContext.epoch.toString();
        mlsTrace.record({
          kind: "ingest-result",
          t: Date.now(),
          groupId: group.idStr,
          eventId: result.event.id,
          result: result.kind,
          reason,
          epochBefore,
          epochAfter,
        });

        if (result.kind === "processed" || result.kind === "skipped") {
          // GAP-2 sender-side `publish-task` is emitted on the publish
          // path (network.ts), NOT here. marmot-ts intentionally yields
          // `kind: "skipped", reason: "self-echo"` for the sender's own
          // kind-445 round-trip (`#sentEventIds.delete(...)` in
          // `MarmotGroup.ingest`), so the `applicationMessage` listener
          // never fires for own messages. The bridge sits at
          // `consumeExpectedPublishForKind445` instead.
          processed.add(result.event.id);
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
          mlsTrace.record({
            kind: "queue-enqueue",
            t: Date.now(),
            groupId: group.idStr,
            eventId: result.event.id,
            queueSize: retryQueue.snapshot().length,
          });
        }
      }

      if (processed.size === 0) return;

      syncedEventIds.set(group.idStr, new Set(mergeIds(seen, processed)));
      await addSyncedGroupEventIds(group.idStr, processed);

      // ── Solution B: drain the retry queue on ingest activity ────────
      // Triggered whenever at least one event was successfully processed
      // in this ingest call. Parked events that have not yet exhausted
      // their per-epoch retry budget (MAX_RETRIES) are re-attempted via
      // the lock-protected ingestGroupEvents path. Events at the cap are
      // left in the queue; they become eligible again after the next
      // epoch advance (retryAttempts.get(groupId)?.clear() in the
      // stateChanged handler). See AC-B-1, AC-B-2, AC-B-3.
      const parked = retryQueue.snapshot();
      if (parked.length > 0) {
        let groupAttempts = retryAttempts.get(group.idStr);
        if (!groupAttempts) {
          groupAttempts = new Map<string, number>();
          retryAttempts.set(group.idStr, groupAttempts);
        }
        const fresh = selectAndIncrementRetries(
          groupAttempts,
          parked,
          MAX_RETRIES_PER_EPOCH,
        ) as NostrEvent[];
        if (fresh.length > 0) {
          mlsTrace.record({
            kind: "queue-drain",
            t: Date.now(),
            groupId: group.idStr,
            trigger: "ingest-activity",
            entries: fresh.length,
          });
          // Re-enter via the lock so we serialise with any concurrent
          // live-subscription ingest call (AC-B-1 serialisation contract).
          void ingestGroupEvents(group, fresh).catch((err) => {
            console.debug("[mls-receive:drain-on-ingest-failed]", err);
          });
        }
      }
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
        mlsTrace.record({
          kind: "epoch-change",
          t: Date.now(),
          groupId: group.idStr,
          from: prev.toString(),
          to: newEpoch.toString(),
        });
        lastEpoch.set(group.idStr, newEpoch);
        // Reset per-event drain-on-ingest retry counters on epoch advance
        // (AC-B-2a). This ensures an event that exhausted its budget
        // within epoch N can be retried again after a fresh commit
        // advances to epoch N+1 (see Design Decision 4 in spec.md).
        // Must run BEFORE queue.prune() and the epoch-advance drain.
        retryAttempts.get(group.idStr)?.clear();

        const queue = pendingRetry.get(group.idStr);
        if (!queue) return;
        queue.prune();
        const snapshot = queue.snapshot();
        if (snapshot.length === 0) return;

        mlsTrace.record({
          kind: "queue-drain",
          t: Date.now(),
          groupId: group.idStr,
          trigger: "epoch-advance",
          entries: snapshot.length,
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
      // filter is a factory so callers can opt-in to a `since` bound without
      // duplicating the rest of the filter shape.
      const filter = (since?: number): Filter => ({
        kinds: [445],
        "#h": [hTag],
        ...(since != null ? { since } : {}),
      });

      // t0 anchors the since-bridge cutover: the persistent subscription
      // opens with `since: t0 - OVERLAP_SECONDS`, the historical request
      // covers all time (no since/until).
      const t0 = Math.floor(Date.now() / 1000);

      // Closure-scoped cutover state — one set per syncGroup call, so
      // concurrent syncs for different groups each have an independent
      // buffer and flag (AC-A-1b).
      const liveBuffer: NostrEvent[] = [];
      let cutoverComplete = false;

      // AC-HOOK-5: `sub-event` is recorded here (not in network.ts) so
      // the trace can carry the group epoch at receipt. The `subId` is
      // independent of the network adapter's own `subId`; the diagnostic
      // harness reads `sub-event` records directly.
      const groupSubId = crypto.randomUUID();

      // ── Step 1: Open the persistent subscription FIRST (zero gap). ──
      // While `cutoverComplete` is false, incoming events go into
      // `liveBuffer` instead of the ingest pipeline. This guarantees:
      //   a) no kind-445 published during the historical fetch is missed,
      //   b) historical events are always ingested before buffered live events.
      // The `since: t0 - OVERLAP_SECONDS` filter means the subscription
      // replays the last 60 s of relay history, which the dedupe guard
      // inside `ingestGroupEventsRaw` collapses without double-processing.
      const groupSub = client.network
        .subscription(relaysForGroup, [filter(t0 - OVERLAP_SECONDS)])
        .subscribe({
          next: async (event: NostrEvent) => {
            mlsTrace.record({
              kind: "sub-event",
              t: Date.now(),
              subId: groupSubId,
              eventId: event.id,
              createdAt: event.created_at ?? 0,
              epoch: group.state.groupContext.epoch.toString(),
            });
            if (!cutoverComplete) {
              // Historical fetch still in flight — park the event.
              liveBuffer.push(event);
              return;
            }
            // Cutover complete — ingest directly through the lock-protected
            // path (AC-A-6).
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

      // Register before the async request so teardown in refreshGroupSync
      // can unsubscribe even if the await below never resolves.
      groupSubs.set(group.idStr, groupSub);
      subs.push(groupSub);

      // ── Step 2: Historical one-shot request (full history, no since). ──
      try {
        const initialEvents = await client.network.request(relaysForGroup, [filter()]);
        if (!mountedRef.current) return;
        await ingestGroupEvents(group, initialEvents);
      } catch (err) {
        console.debug(`[device-sync] initial group sync failed for ${group.idStr}:`, err);
      }

      if (!mountedRef.current) return;

      // ── Step 3: Cutover — drain the buffer then flip the flag. ──
      // Sort in created_at order so commits precede application messages
      // as much as possible (same-second ties are handled by Solution B's
      // drain-on-ingest retry). Events already processed in step 2 are
      // filtered by syncedEventIds inside ingestGroupEventsRaw (AC-A-4).
      const buffered = liveBuffer.splice(0).sort(
        (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0),
      );
      // Flip BEFORE the await so any live event that arrives while the
      // buffer drain is in flight goes straight to ingestGroupEvents
      // rather than into the (now-empty) buffer.
      cutoverComplete = true;
      if (buffered.length > 0) {
        try {
          await ingestGroupEvents(group, buffered);
        } catch (err) {
          console.debug(
            `[device-sync] buffer drain failed for ${group.idStr}:`,
            err,
          );
        }
      }
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
        retryAttempts.delete(groupId);
        ingestLock.delete(groupId);
        lastEpoch.delete(groupId);
        const entry = appMsgHandlersRef.current.get(groupId);
        // Clear any pending publish expectations for this group.
        // We need the hTag to look up the FIFO; derive it from the group
        // we still hold a reference to via the appMsgHandlers entry.
        if (entry) clearExpectedPublishesForHTag(nostrGroupId(entry.group));
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
      // AC-INVITE-4: remove the forgotten-slots cache refresh listener using
      // the same refreshForgotten reference captured in addEventListener above.
      window.removeEventListener("notestr:forgotten-slots-changed", refreshForgotten);
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

