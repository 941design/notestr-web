# Architecture: MLS Leaf Identity UX

## Paradigm

Functional core + imperative shell with hexagonal seams at external boundaries.

- **Functional core** (`src/marmot/*.ts`, no React): pure async functions over IDB, network, and marmot-ts APIs.
- **Imperative shell** (`src/marmot/client.tsx`, `device-sync.ts`): React hooks + subscriptions that wire the core to NDK and IDB lifecycle events.
- **Presentation layer** (`src/components/`): React components that consume marmot state exclusively via `useMarmot()`. No direct marmot module imports except `forgetSelfDevice` from `forget-device.ts`.

## Module Map

| Module | Status | Purpose | Location |
|--------|--------|---------|----------|
| `failed-welcomes.ts` | NEW | IDB log of join failures + DOM event dispatch | `src/marmot/failed-welcomes.ts` |
| `device-sync.ts` | MODIFIED | Wire join-failure and decrypt-failure into failed-welcomes log | `src/marmot/device-sync.ts:410-428, 484-492` |
| `client.tsx` | MODIFIED | Background signin-time probe after init; expose `lastProbeAt` | `src/marmot/client.tsx:243-289` |
| `nostr.ts` | MODIFIED | Replace NIP-46 perms placeholder | `src/lib/nostr.ts:167` |
| `page.tsx` | MODIFIED | Forget-on-signout confirmation flow | `app/page.tsx:222-234` |
| `PendingInvitations.tsx` | NEW | React component: list failed welcomes with recovery prompts + dismiss | `src/components/PendingInvitations.tsx` |
| `IdentityPanel.tsx` | NEW | React component: clientId, KP slot, sibling slots, explainer | `src/components/IdentityPanel.tsx` |
| `SettingsModal.tsx` | MODIFIED | Add "Pending Invitations" and "Identity" tabs | `src/components/SettingsModal.tsx:53-114` |
| `storage.ts` | MODIFIED | Add `notestr-failed-welcomes` store export (or in `failed-welcomes.ts`) | `src/marmot/storage.ts` |
| `cleanup.ts` | MODIFIED | Add `notestr-failed-welcomes` to `KNOWN_IDB_NAMES` | `e2e/fixtures/cleanup.ts:16-28` |

## Boundary Rules

- `failed-welcomes.ts` is a pure marmot module: **no React imports**, no `"use client"`, no NDK imports.
- All IDB access via `createKVStore` imported from `./storage` — never direct `idb-keyval`.
- `device-sync.ts` may import `failed-welcomes.ts` (pure module, no circular dependency risk).
- `client.tsx` may import `failed-welcomes.ts` for the probe and the `pruneOlderThan` mount call.
- Components (`PendingInvitations.tsx`, `IdentityPanel.tsx`) consume data exclusively via `useMarmot()`. Exception: `PendingInvitations.tsx` may import `loadFailedWelcomes` / `forgetFailedWelcome` from `@/marmot/failed-welcomes` (same pattern as `DevicesTab` importing `forgetSelfDevice` from `@/marmot/forget-device`).
- No toast library. Banner/inline patterns only (consistent with `DevicesTab.tsx:274-288`).

## Seams (Cross-Story Dependencies)

| Seam | Producer | Consumer |
|------|----------|---------|
| `loadFailedWelcomes()` | S1 (`failed-welcomes.ts`) | S2 (`PendingInvitations.tsx`), S4 (probe) |
| `forgetFailedWelcome()` | S1 | S2 (dismiss button) |
| `appendFailedWelcome()` | S1 | S1 (device-sync.ts wiring) |
| `pruneOlderThan()` | S1 | S1 (client.tsx mount) |
| `notestr:failed-welcomes-changed` DOM event | S1 | S2 (panel refresh) |
| `forgetSelfDevice()` | pre-existing (`forget-device.ts`) | S6 (`page.tsx`) |

## Implementation Constraints

### Critical ordering in `joinFromWelcomeInvite` (device-sync.ts:424-427)
`appendFailedWelcome()` MUST be called **before** `inviteReader.markAsRead(invite.id)`. After mark-as-read, the invite is consumed and will not be replayed on page refresh.

### `giftWrapEventId` field — requires architect verification
At `joinFromWelcomeInvite` catch time, the outer kind-1059 gift-wrap event ID is NOT available. Only `invite.id` (the Rumor's ID) is accessible. At `inviteReader.on("error")`, the actual gift-wrap event ID IS available as `eventId: string`. The architect must verify whether `invite.id` in the join-failure path corresponds to the gift-wrap event ID (some invite managers store entries by gift-wrap ID), or whether a different unique key must be used for the join-failure records. AC-LOG-3's "unique by `giftWrapEventId`" uniqueness invariant must be satisfied regardless of which ID is used — use the invite's marking ID (`invite.id`) for dedup.

### `client.readInviteGroupInfo(invite)` — GroupInfo extraction
Inside the `joinFromWelcomeInvite` catch block, `client.readInviteGroupInfo(invite)` can be called to extract group name and relays WITHOUT joining. This is the source for `groupId` and the human-readable group name in the log entry and recovery prompt.

### Signin-time probe must not block `loading: false`
The probe runs as a background IIFE after `setState({ loading: false })` at `client.tsx:243`. It must not `await` inside the main init sequence. Gate on `lastProbeAt` stored in `notestr-identity` IDB store (key: `"lastProbeAt"`).

### `createKVStore` — no shared versioned DB
Each store gets its own IndexedDB instance via `createKVStore`. The `notestr-failed-welcomes` store should be added in `failed-welcomes.ts` itself (following the `forgotten-slots.ts` pattern) rather than in `storage.ts`.

### No global toast — use inline banner for signin-time prompt
The one-time probe result ("You have N invitations...") must use an inline state variable in `MarmotProvider` or a banner component, not a toast library. The pattern in `DevicesTab.tsx:274-288` is the reference.

### NIP-46 perms — verify kind set at implementation time
The spec lists a candidate set. The architect must `grep 'signEvent\|nip44' src/` (excluding tests and type defs) to confirm the complete set before writing the final string. NDK's internal AUTH (kind 22242) goes through the signer even without an explicit `signer.signEvent` call in app code — it must be in the perms.

### Forget-on-signout — AsyncConfirmation pattern
`handleDisconnect` is currently synchronous. Adding `forgetSelfDevice` requires it to become async (or to use a confirmation dialog that async-resolves). The `AlertDialog` pattern from `DevicesTab.tsx:350-384` is the reference for the two-path confirmation UI.
