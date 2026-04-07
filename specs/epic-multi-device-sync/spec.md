# Multi-Device Sync (Same npub on Web + CLI)

## Problem

When a user authenticates two different notestr clients (e.g. notestr-web in a browser and notestr-cli on a laptop) against the same NIP-46 bunker, groups created on one client never become visible to the other, and tasks never sync across them. This contradicts the "same identity, multiple devices" expectation users bring from every other Nostr client.

The blocker is in `src/marmot/device-sync.ts`. The auto-invite flow that the file's docstring describes — "Auto-invite new devices: watch for kind-443/30443 key packages from the same pubkey and invite them to every group where we are admin" — is short-circuited by a guard that treats the inviter's *own* leaf as evidence that the candidate device is "already a member":

```ts
// device-sync.ts:367
if (groupHasMember(group, inviteePubkey)) {
  continue;
}
```

`groupHasMember` (defined at `device-sync.ts:40-44`) calls `getGroupMembers(state).some(p => p === pubkey)` and `getGroupMembers` in `@internet-privacy/marmot-ts/core/group-members.js:9-17` returns a deduped `Set` of pubkeys. There is no way for that check to distinguish "my laptop's leaf is in the group" from "any leaf with my pubkey is in the group", so any kind-30443 KeyPackage from the same pubkey is treated as already-seated and skipped.

The Marmot Protocol explicitly supports multiple MLS leaves with the same credential identity (one per device). marmot-ts already exposes the correct primitives — `getPubkeyLeafNodes(state, pubkey)`, `getPubkeyLeafNodeIndexes(state, pubkey)`, and a per-leaf `defaultProposalTypes.remove` proposal type. We're not using them. The only protocol-level evidence that multi-leaf-per-identity is the intended pattern is `client/group/proposals/remove-member.js`, where `proposeRemoveUser(pubkey)` literally produces "one ProposalRemove per leaf index" — i.e. the protocol assumes there *can* be multiple leaves for one pubkey.

## Solution

1. Replace the pubkey-based auto-invite guard with a per-leaf identity check based on the candidate KeyPackage's slot identifier (`d` tag / `clientId`) and its underlying KeyPackageRef.
2. Surface "devices" as a first-class concept in the GroupManager UI: show every leaf the current user owns in the selected group, with a user-friendly device name, the slot identifier, and a "this device" marker.
3. Allow per-device removal that targets a single leaf index, not the whole pubkey, so a user can revoke an old laptop without losing access on their phone.
4. Verify the welcome self-echo path: when the web auto-invites another device, the kind-1059 welcome it publishes will also reach its own `{ kinds: [1059], "#p": [pubkey] }` subscription. Confirm `joinGroupFromWelcome` fails gracefully when the matching private KP is not in the local store (it should — we don't have the other device's init key).

## Scope

### In Scope

- Fix the `device-sync.ts:367` guard so kind-30443 events from the same pubkey but a different `d`/`clientId` slot trigger `inviteByKeyPackageEvent` exactly once per `(group, KP event id)`.
- Track invitations in a persisted Set (IndexedDB) keyed by `(group.idStr, kpEvent.id)` so a page reload does not re-issue invites the user has already sent.
- Add a `DeviceList` component rendered inside `GroupManager.tsx` for the selected group, listing every leaf whose credential identity matches the current pubkey. Each row shows: device name, slot id, and a "this device" badge for the leaf matching the local `clientId`.
- Persist user-supplied device names in a new IndexedDB store `device-names`, keyed by `clientId` (slot identifier), with sensible defaults like `"this browser"` for the local clientId and `device-<slot[..6]>` for unknown slots.
- Add a per-leaf "Forget device" action that emits a single `defaultProposalTypes.remove` proposal targeting that leaf's index, commits, and publishes the result.
- Confirm the welcome self-echo path is graceful: write a unit test that feeds a same-pubkey welcome through `joinGroupFromWelcome` with no matching local KP and asserts it throws a known error class without corrupting state.
- Add an E2E test `e2e/tests/multi-device-sync.spec.ts` that opens two browser contexts, authenticates both via the bunker fixture sharing one pubkey, creates a group in context A, and asserts the group becomes visible and interactive in context B without manual action.

### Out of Scope

- The `detached-groups.ts` logic. It dedupes by pubkey, which remains the correct check for "this user is in this group at all" — multi-leaf membership does not change that.
- Cross-pubkey device discovery (i.e. inviting someone else's other device). Still goes through the existing manual invite flow.
- A standalone "Devices" settings page. Device management lives inside the per-group sidebar in this epic; a global page is a follow-up.
- Implementing MIP-06 External Commit pairing. We use the implicit multi-leaf pattern that already works.

## Design Decisions

1. **Slot identity is the source of truth, not pubkey.** The `MarmotClientOptions.clientId` value (already wired up at `client.tsx:103-111` via `getOrCreateClientId()`) becomes the canonical per-device identifier. Two leaves are the "same device" iff they share a `clientId`.
2. **Don't change marmot-ts.** All required primitives are already exported. We only patch our own `device-sync.ts` and add a new `device-store.ts` helper for naming + invite-tracking persistence.
3. **Auto-invite is fire-and-forget but idempotent.** Persist `(groupId, kpEventId)` pairs we've already invited so a page reload doesn't issue duplicate commits at the same epoch.
4. **Naming defaults to a stable, descriptive slug, not a UUID.** When a leaf's `clientId` is unknown to the local store, derive a short label from the slot's first 6 hex chars: `device-a3f9c1`. The user can rename it later.
5. **The leave button in the per-device list is destructive but local only.** Per-leaf remove emits a Remove proposal whose target is one leaf index. It does **not** call the existing `client.leaveGroup` or `proposeRemoveUser` paths, both of which target every leaf for the pubkey.
6. **The current device is non-removable from the device list.** The cleaner exit for "I want this device out" is `client.leaveGroup`, which removes every leaf you own in that group. Forgetting your own seat would leave you in an inconsistent local state.
7. **Welcome self-echo handling is verification-only.** The current `joinGroupFromWelcome` failure mode (no matching KP → throw, caught in `device-sync.ts:135`) is correct; we just add a regression test so future refactors don't break it.

## Technical Approach

### `src/marmot/device-sync.ts`

Replace the pubkey-based guard at line 367 with a per-leaf slot check:

```ts
import {
  getPubkeyLeafNodes,
  getKeyPackageNostrPubkey,
  getKeyPackageD,           // verify export; fall back to local helper
  isAdmin,
} from "@internet-privacy/marmot-ts";
import {
  loadInvitedKeys,
  persistInvitedKey,
} from "./device-store";

// Persisted across page reloads. Key shape: `${groupId}:${kpEventId}`.
const invited = new Set<string>(await loadInvitedKeys());

const inviteToAllGroups = async (kpEvent: NostrEvent) => {
  const inviteePubkey = getKeyPackageNostrPubkey(kpEvent);
  const inviteeSlot = getKeyPackageD(kpEvent);  // d tag from kind 30443

  for (const group of client.groups) {
    if (!mountedRef.current) return;
    const gd = group.groupData;
    if (!gd || !isAdmin(gd, pubkey)) continue;

    // Skip if a leaf for the same pubkey AND same slot already exists.
    // Per-leaf comparison via slot identifier (clientId / d-tag) instead
    // of the legacy pubkey-only check that blocked self-invite.
    if (inviteeSlot && hasLeafWithSlot(group.state, inviteePubkey, inviteeSlot)) {
      continue;
    }

    const invitedKey = `${group.idStr}:${kpEvent.id}`;
    if (invited.has(invitedKey)) continue;
    invited.add(invitedKey);
    await persistInvitedKey(invitedKey);

    try {
      await group.inviteByKeyPackageEvent(kpEvent);
    } catch (err) {
      console.debug(
        `[device-sync] auto-invite to ${group.idStr} failed:`,
        err,
      );
    }
  }
};

function hasLeafWithSlot(
  state: ClientState,
  pubkey: string,
  slot: string,
): boolean {
  const leaves = getPubkeyLeafNodes(state, pubkey);
  return leaves.some((leaf) => getLeafSlotId(leaf) === slot);
}
```

`getLeafSlotId` is the canonical accessor for the slot identifier on a `LeafNode`. If marmot-ts does not yet expose it publicly on the addressable-key-packages branch, we add a thin wrapper in `src/marmot/leaf-slot.ts` that reaches into the leaf's capabilities/extensions where the addressable-KP encoding lives. A safe fallback is to compare HPKE init key hashes, which are guaranteed unique per KP — verification of the public surface happens during implementation.

The legacy `groupHasMember(group, inviteePubkey)` helper is removed. The `runWelcomeSync` path is unchanged: it already handles the self-echo case by failing the `joinGroupFromWelcome` call when no matching local KP exists, and our regression test will lock that behavior in.

### `src/marmot/device-store.ts` (new)

Per-clientId device naming and invite tracking, persisted in IndexedDB.

```ts
export interface DeviceMetadata {
  clientId: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
}

export async function getDeviceName(clientId: string): Promise<string>;
export async function setDeviceName(clientId: string, name: string): Promise<void>;
export async function listDevices(): Promise<DeviceMetadata[]>;

// Invite-tracking: Set<`${groupId}:${kpEventId}`>
export async function loadInvitedKeys(): Promise<string[]>;
export async function persistInvitedKey(key: string): Promise<void>;
export async function clearInvitedKeysForGroup(groupId: string): Promise<void>;
```

Backed by two new IndexedDB stores: `device-names`, `invited-keys`. Add the corresponding `createKVStore<...>` calls in `src/marmot/storage.ts` alongside the existing `group-state`, `key-packages`, `group-sync`, and `clientId` stores.

### `src/components/DeviceList.tsx` (new)

```tsx
interface DeviceListProps {
  group: MarmotGroup;
  pubkey: string;
  localClientId: string;
}

export function DeviceList({ group, pubkey, localClientId }: DeviceListProps) {
  const leaves = useMemo(
    () => getPubkeyLeafNodes(group.state, pubkey),
    [group.state, pubkey],
  );
  const [names, setNames] = useState<Map<string, string>>(new Map());
  // ...load names from device-store on mount
  // ...render rows; rename via inline edit; remove via per-leaf-remove
  return (
    <section aria-label="Your devices" data-testid="device-list">
      <h3>Your devices</h3>
      <ul>
        {leaves.map((leaf) => {
          const slot = getLeafSlotId(leaf);
          const isLocal = slot === localClientId;
          const name = names.get(slot ?? "") ?? defaultDeviceName(slot);
          return (
            <li key={slot} data-testid="device-row" data-local={isLocal}>
              <span>{name}</span>
              <span className="text-xs text-muted">slot: {slot?.slice(0, 6)}…</span>
              {isLocal ? (
                <span className="badge">this device</span>
              ) : (
                <button onClick={() => removeLeafByIndex(group, leafIndexOf(leaf))}>
                  Forget
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

Mounted inside `GroupManager.tsx` between the existing member list and the invite form, so it lives next to the per-group context the user already understands.

### `src/marmot/per-leaf-remove.ts` (new)

```ts
import { defaultProposalTypes } from "ts-mls";
import type { MarmotGroup } from "@internet-privacy/marmot-ts";

/**
 * Build and commit a Remove proposal targeting one specific leaf index.
 * Mirrors marmot-ts's proposeRemoveUser but without the
 * getPubkeyLeafNodeIndexes loop — caller passes the exact leaf to remove.
 */
export async function removeLeafByIndex(
  group: MarmotGroup,
  leafIndex: number,
): Promise<void> {
  return group.commit({
    extraProposals: [
      async () => ({
        proposalType: defaultProposalTypes.remove,
        remove: { removed: leafIndex },
      }),
    ],
  });
}
```

### `src/marmot/storage.ts`

Add the two new stores alongside the existing `getOrCreateClientId()` helper at lines 70-76:

```ts
export const deviceNamesStore = createKVStore<string>("device-names");
export const invitedKeysStore = createKVStore<true>("invited-keys");
```

### Tests

- `src/marmot/device-sync.test.ts` (new): unit tests for `hasLeafWithSlot` covering 0/1/many leaves of the same pubkey, and a regression test that ensures auto-invite proceeds when the slot differs.
- `src/marmot/per-leaf-remove.test.ts` (new): mock `MarmotGroup`, verify proposal shape (one Remove proposal with `removed: <leafIndex>`).
- `src/marmot/device-store.test.ts` (new): IndexedDB read/write via `fake-indexeddb`.
- `e2e/tests/multi-device-sync.spec.ts` (new): two browser contexts sharing one bunker pubkey, see the project verification plan.

### E2E fixture additions

`e2e/fixtures/bunker.mjs` already authorizes one ephemeral NIP-46 client per Playwright context. Extend it with a helper that authorizes a *second* client against the same bunker pubkey, so the test can spin up two contexts that share an identity but produce distinct local `clientId` values. The hardcoded `E2E_BUNKER_PRIVATE_KEY` and `E2E_BUNKER_URL` from `MEMORY.md` continue to work.

## Acceptance Criteria

1. When two browser contexts authenticate against the same NIP-46 bunker (same pubkey, distinct local `clientId`), and context A creates a group, context B automatically becomes a member of that group within ≤10s without any manual action.
2. The auto-invite is idempotent: reloading context A does not re-issue the invite (no duplicate kind-445 commits at the same epoch). Verified by counting kind-445 events for the group's `#h` tag on the relay before and after a reload.
3. The selected group's sidebar shows a "Your devices" list (`data-testid="device-list"`) containing one row per leaf whose credential identity matches the current pubkey, with the local `clientId` clearly marked as "this device" via a badge.
4. Device names persist across page reloads via the `device-names` IndexedDB store. Renaming a device in context A is visible in context A on reload (cross-context name sync is out of scope).
5. Clicking "Forget" on a non-local device row emits a single `defaultProposalTypes.remove` proposal targeting that leaf index, commits it, and the device disappears from the list on both contexts within ≤5s.
6. Forgetting a device does NOT remove the user's other leaves from the group; the local context remains a fully functional member, and the existing member list still shows the user's pubkey exactly once.
7. Welcome self-echo handling: when context A auto-invites context B, context A's own kind-1059 subscription receives the welcome but does not throw uncaught and does not corrupt local state. Verified by a unit test feeding a same-pubkey welcome with no matching local KP through `joinGroupFromWelcome` and asserting the catch path at `device-sync.ts:135` runs.
8. The pre-existing `epic-identity-scoped-group-and-task-visibility` detached-groups behavior continues to work — switching to a completely different pubkey still grays out groups where the new pubkey has no leaves at all. `e2e/tests/multi-user.spec.ts` continues to pass unchanged.
9. All existing E2E tests in `e2e/tests/` continue to pass (`auth.spec.ts`, `groups.spec.ts`, `tasks.spec.ts`, `members.spec.ts`, `task-sync.spec.ts`, `multi-user.spec.ts`, `identity-visibility.spec.ts`, `group-relays.spec.ts`).
10. `npm run lint` and `npm test` both pass; no new TypeScript errors in `tsc --noEmit`.
