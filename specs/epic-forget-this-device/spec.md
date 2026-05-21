# Forget This Device

## Problem

When a user stops using a device — clears browser data, switches browsers, retires a laptop, factory-resets a phone — the device's MLS leaves and key packages stay live indefinitely:

- The device's leaf is still in every group it was invited to. Other members of those groups continue to encrypt application messages for that leaf, even though no one will ever decrypt them.
- The device's key package (kind 30443, `d=notestr-<uuid>`) is still on the relay until its `Lifetime.not_after` passes — typically weeks. Any sibling device of the same npub running the auto-invite scan will treat it as "an active sibling I should invite into every group I admin" and issue an MLS commit per ghost on every group create.

Concretely: a user who reinstalls / reauthenticates the web app every few days can pile up dozens of ghost slots within a month. Each ghost survives until its lifetime expires, and each one costs one wasted MLS commit per group create per online sibling. The auto-invite path has no built-in pruning — `device-sync.ts:725` iterates every KP under the user's pubkey and tries to invite each one.

This came out of an e2e debugging session (2026-04-30) where 147 stale KPs accumulated under a shared test bunker key over many `make dev` sessions, exhausting `selectGroup`'s 60s timeout in `multi-device-cross-npub.spec.ts` (TP-80). The same mechanism applies in production at slower rates.

There is no user-facing "I'm done with this device" flow today. The only related primitive is `forgetLeafByIndex` (admin-removes-a-leaf-from-one-group), which is not user-facing and addresses only the leaf-side of the problem.

## Solution

Add a user-facing "Forget this device" action that performs the full decommission of one of the user's own devices:

1. **Leaf removal across all groups.** For every MLS group the user is in, propose+commit a `Remove` for each leaf belonging to the target device's slot. Reuses the existing per-leaf primitive (`removeLeafByIndex`) but iterates all groups.
2. **Key package deletion on the relay.** Publish a NIP-09 (kind 5) deletion event referencing the target device's currently-active key-package event id, so newly-running siblings will not see the ghost on subsequent relay scans.
3. **Local cleanup.** Drop the device's entry from local IDB stores (clientId, key packages, invited-keys cache). On self-forget specifically, sign the user out and clear the NIP-46 session payload.

Two scopes:

- **Self-forget** ("forget THIS device, the one I'm using"): the local user signs the deletion, removes their own leaves, and signs out. Strongest decommission because the local device's signing key is available.
- **Sibling-forget** ("forget THAT other device of mine"): a sibling device performs the leaf removal for the target device's leaves in groups where the sibling is admin. KP deletion via NIP-09 is **not possible** here — only the bunker can sign for the user, but the device that holds the corresponding KP secrets is the one being forgotten. Best-effort: leaves are removed; the ghost KP remains on the relay until its `Lifetime.not_after` passes.

## Scope

### In Scope

- A "Devices" view in the Settings modal (the same modal the bunker badge / share QR moved into in commit `c066632`) that lists all of the user's own devices currently visible to the local client. Source of truth: union of (a) the local clientId, (b) every kind-30443 KP event on the relay signed by the local pubkey.
- Each row shows: a user-friendly device name (default `device-<slot[8..14]>`), the slot identifier, the KP's `created_at`, a "this device" badge for the local clientId, and a destructive "Forget" action.
- Self-forget flow:
  - Confirmation dialog explaining what will happen ("removes this device from all your groups and signs you out").
  - For each group in `client.groups.loaded`, call the per-leaf forget for every leaf whose KP matches the local clientId.
  - Publish a kind-5 deletion event tagging the local clientId's currently-published KP event id(s). Use the existing `client.keyPackages.list()` to enumerate.
  - Clear local IDB: identity store (`clientId`), key-packages store, invited-keys cache, joined-groups cache, NIP-46 session payload in localStorage.
  - Redirect to the sign-in page.
- Sibling-forget flow:
  - Confirmation dialog explaining the partial nature ("removes this device from your groups; its key package on the relay will expire on its own in ~28 days").
  - For each group in `client.groups.loaded` where the local user is admin, remove every leaf matching the target slot via `removeLeafByIndex`.
  - Mark the target slot as "forgotten" in a new local IDB store (`forgotten-slots`) keyed by `slot`. The auto-invite scan in `device-sync.ts` reads this store and skips matching events on every iteration.
- E2E test `e2e/tests/forget-device-self.spec.ts` covering self-forget: A authenticates, creates a group, invites B, B joins, A self-forgets, assert: A's leaf is gone from B's group view and A's KP event has a kind-5 deletion published.
- E2E test `e2e/tests/forget-device-sibling.spec.ts` covering sibling-forget: A1 + A2 + B in one group, A1 sibling-forgets A2, assert: A2's leaf is gone, A2 stops receiving group messages, A1's `forgotten-slots` store contains A2's slot.

### Out of Scope

- Device renaming UI. The auto-derived `device-<slot[8..14]>` label is sufficient for v1; renaming can come later.
- Cross-pubkey "forget someone else's device". Admins targeting a third party's device is the existing per-leaf admin remove flow (see `epic-multi-device-sync`); this epic is about a user managing **their own** devices.
- Auto-decommission heuristics (e.g. "stop trying to invite slots whose KP `created_at` is more than N days old without a recent activity signal"). That's a separate followup; this epic only covers explicit user action.
- Server-mediated KP catalogs / MIP-level slot registration. Discussed in `e2e-findings.md` as option (E) but is a Marmot protocol extension, not a notestr feature.
- Recovering from a partial failure. If self-forget gets through 3 of 5 group-leaf-removals and then the network drops, we leave the local user in an inconsistent state; v1 just surfaces the error and asks them to retry. A robust resume path is a v2 concern.

## Design Decisions

1. **Self-forget signs the user out.** The cleanest semantics: forgetting your current device means you no longer have access from this browser. Anything else leaves the local IDB in a state where the app would happily re-publish a fresh KP under a new slot, defeating the purpose.
2. **Sibling-forget cannot delete the sibling's KP from the relay.** NIP-09 kind-5 events must be signed by the same key that signed the target. The bunker holds the user's identity key but not the per-device init keys; a kind-5 from the user's identity key would not satisfy a relay's NIP-09 enforcement (relays MUST verify `e`-tag references match `pubkey`, which they would in this case actually — the same pubkey signs all of a user's KPs). **Open question, see `marmot-researcher` validation** below; if NIP-09 by the user's identity key against any of their own KP event ids is honored by strfry / common relays, sibling-forget can also publish the deletion. If not, ghost KP must wait for lifetime expiry.
3. **A `forgotten-slots` IDB store is the local-only mitigation for the sibling case.** Even if relays ignore our deletion, every other device the user runs locally can know "we decided slot X is dead, never invite it again". The auto-invite scan reads this store and skips matching events.
4. **Local clientId is non-removable directly; self-forget is the only path.** Showing a "Forget" button on the device labelled "this device" without making it sign-out-and-clear would put the app into an inconsistent state where local IDB still claims to be that clientId but the relay shows the KP deleted.
5. **Confirmation dialogs use destructive-button styling.** Both flows are irrecoverable from the local app's perspective — the self-forget signs you out; the sibling-forget removes someone's leaves in groups they may rely on.
6. **No optimistic UI.** Both flows are slow (one MLS commit per leaf per group). Show a progress indicator listing each group as the leaf-removal lands.
7. **`forgotten-slots` is the *only* state-coupling the auto-invite path acquires.** We do not change the slot generation, the dedup scheme, or the lifetime check — those are orthogonal questions tracked separately. This epic is purely about giving users an explicit decommission lever.

## Technical Approach

### New: `src/marmot/forgotten-slots.ts`

```ts
import { createKVStore } from "./storage";

const forgottenStore = createKVStore<true>("forgotten-slots");

export async function markSlotForgotten(slot: string): Promise<void> {
  await forgottenStore.setItem(slot, true);
}

export async function loadForgottenSlots(): Promise<Set<string>> {
  const all = await forgottenStore.getAllKeys?.() ?? [];
  return new Set(all);
}
```

### Update: `src/marmot/device-sync.ts` (auto-invite scan)

In `runKeyPackageSync`, load forgotten slots once on mount and refresh on a custom DOM event:

```ts
let forgottenSlots = await loadForgottenSlots();
const refreshForgotten = async () => { forgottenSlots = await loadForgottenSlots(); };
window.addEventListener("notestr:forgotten-slots-changed", refreshForgotten);
```

In `syncKnownKeyPackages` and `handleKeyPackageEvent`, skip events whose slot is in `forgottenSlots`:

```ts
const slot = getKeyPackageIdentifier(event);
if (slot && forgottenSlots.has(slot)) continue;
```

### New: `src/marmot/forget-device.ts`

Two top-level functions: `forgetSelfDevice(client, signer, relays)` and `forgetSiblingDevice(client, slot)`.

`forgetSelfDevice`:
1. Enumerate groups: `client.groups.loaded`.
2. For each group, find leaves matching local clientId (existing helper `getPubkeyLeafNodeIndexes` or the slot-based equivalent).
3. For each leaf, call `removeLeafByIndex(group, idx)`. Sequential to avoid epoch races.
4. Enumerate published KP events: `client.keyPackages.list()` filtered to `published.length > 0`. For each event id, build a kind-5 NIP-09 event and publish via `client.network.publish(relays, ...)`.
5. Clear IDB: `identityStore.clear()`, key-packages clear, invited-keys clear, joined-groups clear, `localStorage.removeItem('notestr-nip46-payload')`.
6. Reload to `/`.

`forgetSiblingDevice`:
1. Enumerate groups where local user is admin.
2. For each group, find leaves matching `slot` (lookup via `getKeyPackageIdentifier` against group state's leaves' KP refs — verify with marmot-researcher).
3. Remove each leaf via `removeLeafByIndex`. Sequential.
4. `markSlotForgotten(slot)` and dispatch `notestr:forgotten-slots-changed` so the auto-invite scan refreshes immediately.
5. (Optional, see decision #2) Attempt kind-5 deletion of the sibling's KP event ids.

### UI: Settings modal Devices tab

Reuse the modal structure introduced in `c066632`. New tab "Devices" alongside existing Bunker / Share QR. Renders a list:

```tsx
{devices.map(d => (
  <DeviceRow
    key={d.slot}
    name={d.name}
    slot={d.slot}
    createdAt={d.createdAt}
    isLocal={d.slot === localClientId}
    onForget={() => d.isLocal ? confirmSelfForget() : confirmSiblingForget(d.slot)}
  />
))}
```

`devices` is computed from `client.keyPackages.list()` (own KPs in IDB) ∪ relay-fetched KPs filtered by `pubkey`.

### Test additions

- Unit test: `forget-device.test.ts` mocks a 2-group MarmotClient and asserts `forgetSelfDevice` calls `removeLeafByIndex` once per matching leaf and publishes one kind-5 per published KP event id.
- E2E `forget-device-self.spec.ts` and `forget-device-sibling.spec.ts` per Scope above.

## Open Questions for Validation

1. **NIP-09 enforcement on common relays.** Is a kind-5 signed by the user's identity key against an `e`-tag pointing at any of that user's own KP events (kind 30443 or 443) honored by strfry, the relay we use? Need empirical check.
2. **MLS protocol-level: can a removed leaf publish its own kind-5 for its KP?** The leaf's MLS init keypair is independent of the user's Nostr identity key. The KP *event* is signed by the user's identity key (kind 443/30443 are Nostr events, not MLS structures). So in theory yes, the same identity key can sign a kind-5 for any of the user's KP events. The marmot-researcher should validate.
3. **Slot lookup against group state's ratchet tree.** Does marmot-ts expose a clean way to map a `slot` (d-tag) to a `leafIndex`, or do we have to walk the tree comparing KP refs ourselves? `getPubkeyLeafNodeIndexes` works for pubkey; we may need to do a per-KP comparison via `defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode`.
4. **Concurrent epoch advances during multi-group leaf removal.** If a self-forget loops over 5 groups and another member commits to one of them mid-loop, that group's epoch advances and our removal proposal becomes stale. Need to either (a) re-fetch state per group before each removal (already done implicitly by `removeLeafByIndex` if it operates on the live state), or (b) wrap each per-group operation in a retry-on-stale-epoch helper.

The marmot-researcher agent has been engaged to capture related findings and verify items #2 and #3 against the marmot-ts source.

## Amendments

### 2026-05-18 — AC-E2E-11 "A2 leaf absent" clarification

**AC-E2E-11** original text "A2's leaf is absent" was ambiguous in a multi-device context where A1 and A2 share the same pubkey. "Absent" means A2's individual leaf node is removed; A1's leaf for the same pubkey remains. The correct assertion is `leafIndexesFor(page, groupId, pubkeyA)` returning `toHaveLength(1)`, not `toHaveLength(0)`. The AC was amended to make this explicit. (S7 post-implementation verification question Q-POSTIMPL-1.)

### 2026-05-18 — AC-INVITE-1 placement clarification

**AC-INVITE-1** original text said "Inside the `runKeyPackageSync` closure" — too literal. The architect correctly placed the `forgottenSlots` variable in the parent `useDeviceSync` effect body scope (not inside the `runKeyPackageSync` sub-function), so both `runKeyPackageSync` and the cleanup function can close over it. The AC was amended to reflect this: "in the `useDeviceSync` hook body... accessible to `runKeyPackageSync` (via closure)... and to the cleanup function (via closure)". The behavior is unchanged; the wording now matches the implementation. (Examiner flag from S2 retrospective.)

### 2026-05-21 — AC-UNIT-2 updated to match self-forget protocol fix

**AC-UNIT-2** originally mandated asserting `removeLeafByIndex` per matching leaf. The bug fix in bug run "self-forget-no-mls-propagation" replaced `removeLeafByIndex` with `group.leave()` for the self-forget path (RFC 9420 §12.4 forbids self-commit of Remove; marmot-ts implements this via `proposeLeaveGroup` → kind-445 proposal events). The AC was amended to: assert `group.leave()` called once per group containing a self-leaf; assert `removeLeafByIndex` is NOT called on the self-forget path; add a required test case for the no-op branch (groups where `getPubkeyLeafNodeIndexes` returns `[]`). The implementation already matches the amended AC — unit suite passes 184/184 with these assertions. (Bug run result.json: `tests_added[0]` and `tests_added[1]`.)
