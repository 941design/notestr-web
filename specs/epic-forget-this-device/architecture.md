# Architecture — epic-forget-this-device

Operational architecture document for the epic. Read by every downstream agent
(planner, architect, examiners). Source of truth for module map, boundary
rules, and implementation constraints.

## Paradigm

**Modular monolith**, Next.js 15 App Router + React 19+ SPA. Application is
delivered as a PWA (single client page at `app/page.tsx`); there is no server
component layer. The MLS-on-Nostr protocol stack is encapsulated in `src/marmot/`
behind a React context (`MarmotContext`) and a small set of hook entry points
(`useMarmot()`, `useGroup()`). All IDB persistence flows through a single
factory in `src/marmot/storage.ts` (`createKVStore<T>`).

The marmot module owns all distributed-state concerns. UI code does NOT speak
Nostr directly and does NOT touch IDB directly — it calls into top-level marmot
utilities (e.g. `removeLeafByIndex`, `publishTaskSnapshot`) or imperative
methods on the `client` instance surfaced via `useMarmot()`.

## Module map (modules this epic touches or creates)

### Creates

- **`src/marmot/forget-device.ts`** (new) — Top-level imperative utilities:
  `forgetSelfDevice(client, signer, relays, onSignOut)` and
  `forgetSiblingDevice(client, slot)`. Pattern matches existing
  `per-leaf-remove.ts` and `device-sync.ts` exported actions: plain async
  functions receiving `client`/`signer`/`relays` as arguments. No React
  dependency.
- **`src/marmot/forgotten-slots.ts`** (new) OR additions to existing
  `src/marmot/device-store.ts` — the architect picks one. Owns the
  `notestr-forgotten-slots` IDB store and exposes `markSlotForgotten(slot)`,
  `loadForgottenSlots(): Promise<Set<string>>`, and dispatches the
  `notestr:forgotten-slots-changed` DOM event on writes. The store name and
  callable names are load-bearing for the e2e test hooks.

### Touches (existing files modified)

- **`src/marmot/storage.ts`** — Add `clearIdentityStore()` (or export the
  file-private `identityStore`) so `forgetSelfDevice` can wipe the local
  `clientId` entry. Architect picks the export shape.
- **`src/marmot/client.tsx`** — `keyPackageStore`, `groupStateStore`,
  `inviteStore` are currently local variables inside `init()` (lines
  162–164). The architect decides between three resolutions: (a) lift to
  module scope and export, (b) add a `clearLocalState()` method on
  `MarmotClient` upstream, (c) delete the IDB databases by their stable
  names (`notestr-key-packages`, `notestr-group-state`,
  `notestr-invite-store`) from `forgetSelfDevice` using `indexedDB.deleteDatabase`.
  Decision must be recorded in the story's `architecture.json` per-story
  contract.
- **`src/marmot/device-sync.ts`** — Add `forgottenSlots` in-memory cache
  inside the `runKeyPackageSync` closure (line ~1026). Add the
  `window.addEventListener("notestr:forgotten-slots-changed", refreshForgotten)`
  listener with matching `removeEventListener` cleanup. Insert the
  `if (slot && forgottenSlots.has(slot)) continue;` guard at:
  - `syncKnownKeyPackages`, line 1164 (after `isLocalDevice` + pubkey guards,
    before `inviteToAllGroups`)
  - `handleKeyPackageEvent`, line 1174-1176 (matching insertion point)
- **`src/components/SettingsModal.tsx`** — Add `<Tabs>` structure via
  `src/components/ui/tabs.tsx`. Existing content becomes "Connection" tab
  (or similar). New "Devices" tab calls `useMarmot()` to get `client`,
  `signer`, `relays`, `clientId`, plus a new `onSignOut` callback prop.
- **`app/page.tsx`** — Pass `onSignOut={handleDisconnect}` into
  `<SettingsModal>` so the self-forget flow can trigger sign-out.
- **`e2e/fixtures/cleanup.ts`** — Add `"notestr-forgotten-slots"` to
  `KNOWN_IDB_NAMES` (line 16-25). This is load-bearing: without it
  `clearAppState()` silently leaves the new IDB across tests, breaking
  relay-state-independence on the second run.
- **`src/types/notestr-test-hooks.d.ts`** — Add
  `__notestrTestForgottenSlots` window hook signature.
- **`src/marmot/client.tsx`** — Add the matching `__notestrTestForgottenSlots`
  test hook implementation inside the `if (process.env.NEXT_PUBLIC_E2E === "1")`
  block (existing test-hooks block near the test-forget-leaf hook).

### Reuses (unchanged)

- **`src/marmot/per-leaf-remove.ts`** — `removeLeafByIndex(group, leafIndex)`.
  Both forget flows call this per matching leaf, sequentially (no
  `Promise.all` — epoch races).
- **`src/lib/nostr.ts`** — `clearNip46Session()`. Self-forget MUST call this
  (not raw `localStorage.removeItem`) to clear all three NIP-46 keys
  atomically.
- **`src/components/DeviceList.tsx`** — Unchanged. The existing single-group
  sibling-forget UI continues to work. The new Settings "Devices" tab is a
  *different* surface with a different data source (relay-fetched
  kind-30443 events ∪ local clientId).
- **`e2e/fixtures/two-party.ts`** — `authenticate`, `pinClientSlot`,
  `createGroup`, `inviteByNpub`, `selectGroup`, `leafIndexesFor`,
  `forgetLeafByIndex`, `currentGroupId`, `getPubkeyHex`, `settle`.
- **`e2e/fixtures/ndk-subscriber.ts`** — `openNdkSubscriber` for asserting
  on published kind-5 deletion events from outside the browser.

## Boundary rules

1. **No direct imports across module boundaries.** Cross-module access only
   through declared seam contracts. UI never imports from
   `src/marmot/internal/*`; UI uses `useMarmot()` or top-level exports from
   `src/marmot/*.ts`.
2. **No raw `localStorage.*` outside `src/lib/nostr.ts`.** NIP-46 keys are
   managed exclusively by `clearNip46Session()` / `restoreNip46Session()` /
   `connectBunker()`.
3. **No raw `idb-keyval` outside `src/marmot/storage.ts` and
   `src/store/persistence.ts`.** All new IDB stores go through
   `createKVStore<T>`.
4. **No raw NDK outside `src/marmot/network.ts` and the existing
   `client.tsx:322-335` kind-5 helper.** The new kind-5 publish path either
   replicates the existing inlined pattern OR extracts a helper through
   `client.network.publish(relays, signedEvent)`. Architect picks one and
   documents.
5. **No `applicationMessage` listeners outside `device-sync.ts` and
   `task-store.tsx`** — out of scope for this epic; these are existing
   conventions, not changes.
6. **Sign-out is owned by `app/page.tsx`.** `forgetSelfDevice` accepts an
   `onSignOut` callback rather than calling `handleDisconnect` directly or
   triggering a redirect itself.
7. **`removeLeafByIndex` calls are sequential per group iteration.** Awaited
   in a `for...of` loop, never `Promise.all`. Reason: epoch races within a
   group are real, and parallel proposals will conflict.

## Seams

Three cross-story seams identified by Planner Mode 2 (full contracts live in
`stories.json#seams`):

| Seam name | Producer | Consumer(s) | Contract summary |
|-----------|----------|-------------|------------------|
| `ForgottenSlotsAPI` | S1 (`forgotten-slots.ts`) | S2 (`device-sync.ts`), S3 (`forget-device.ts`) | `markSlotForgotten(slot)` writes to `notestr-forgotten-slots` IDB + dispatches `notestr:forgotten-slots-changed`; `loadForgottenSlots()` returns `Set<string>` via `forgottenStore.keys()`. |
| `ForgetDeviceAPI` | S3 (`forget-device.ts`) | S4 (`SettingsModal.tsx`) | `forgetSelfDevice(client, signer, relays, onSignOut)` and `forgetSiblingDevice(client, pubkey, slot)`. Sequential per-leaf `removeLeafByIndex`, kind-5 publish for self, `clearNip46Session()` and `onSignOut()` for self, `isAdmin(groupData, pubkey)` guard for sibling (pubkey is the local user's identity pubkey, passed in by caller). |
| `NotestrTestForgottenSlotsHook` | S5 (`client.tsx` + `notestr-test-hooks.d.ts`) | S7 (`forget-device-sibling.spec.ts`) | `window.__notestrTestForgottenSlots(): Promise<string[]>` exposed in `NEXT_PUBLIC_E2E === "1"` mode; returns `notestr-forgotten-slots` IDB keys. |

## Implementation constraints

### From the spec

- **Self-forget signs the user out.** No "forget without sign-out" variant.
- **Sibling-forget cannot delete the sibling's KP from the relay** (open
  Q1 — empirical). v1 ships best-effort: leaves removed, ghost KP waits for
  `Lifetime.not_after`. `forgotten-slots` IDB is the local-only mitigation.
- **No optimistic UI.** Both flows are slow; show per-group progress.
- **No device renaming UI** — out of scope.
- **No cross-pubkey forget** — out of scope. This epic is about a user
  managing **their own** devices.
- **No partial-failure resume.** If self-forget completes 3 of 5 group-leaf
  removals and the network drops, v1 surfaces the error and asks for retry.
  No durable resume queue.

### From project memory / archive

- **E2E tests must be relay-state-independent** (memory
  `feedback_e2e_relay_independence.md`; BACKLOG.archive 2026-05-18 rejecting
  `epic-e2e-relay-state-isolation`). Both new tests
  (`forget-device-self.spec.ts`, `forget-device-sibling.spec.ts`) MUST use:
  - `authenticate(page, bunkerUrl, slot)` with explicit slot strings
    (`"self"`, `"sibling-a1"`, `"sibling-a2"`, `"B"`).
  - `Date.now()` group names at top of each `describe.serial`.
  - `clearAppState` (called internally by `authenticate`).
  - `skipMobile` propagation in `beforeAll` for multi-context tests.
  - NO `e2e-down` / `e2e-up` calls between tests, NO fixture-level resets,
    NO assertions on global relay state.
- **`describe.serial` only for genuinely dependent tests** (memory
  `project_e2e_serial_constraint.md`). Self-forget and sibling-forget are
  internally serial (each spec file's tests share setup), but distinct
  spec files run independently.
- **`forget-device` is per-leaf, not remove-member** (memory
  `project_user_action_vocabulary.md`). A member only leaves when the last
  leaf is gone. The spec's design (iterate matching leaves per group)
  already aligns.

### From exploration findings (spec corrections)

These corrections MUST be picked up by Planner Mode 1 (acceptance criteria
authoring) and Mode 2 (story split) so the architect doesn't rediscover them
at implementation time.

1. **`KeyValueStoreBackend.keys()`, not `getAllKeys()`** (`storage.ts:24-50`
   interface). Spec's `forgotten-slots.ts` sketch is wrong on this line.
2. **`identityStore` is file-private** (`storage.ts:68`); needs a new export
   from `storage.ts` (architect picks shape: store handle vs.
   `clearIdentityStore()` helper).
3. **`keyPackageStore` / `groupStateStore` / `inviteStore` are local vars in
   `client.tsx:162-164`** — not reachable from `forgetSelfDevice`.
   Architect picks among: lift-to-module-scope export, add
   `MarmotClient.clearLocalState()` upstream in marmot-ts, or
   `indexedDB.deleteDatabase("notestr-<name>")` from the forget function.
   Decision recorded in story `architecture.json`.
4. **Sign-out path is `handleDisconnect` in `app/page.tsx`** — not
   reachable from `MarmotProvider`. Pass `onSignOut` callback from
   `page.tsx` → `SettingsModal` → self-forget confirm handler.
5. **`localStorage.removeItem('notestr-nip46-payload')` is incomplete** —
   use `clearNip46Session()` from `src/lib/nostr.ts:142`.
6. **`runKeyPackageSync` is a closure inside `useDeviceSync`** — the
   patch must happen inside the hook body, not as an export.
7. **The Devices tab is NOT a thin wrapper around `DeviceList.tsx`**.
   `DeviceList` sources from the group's ratchet tree leaves; the
   Devices tab sources from union of (a) local `clientId`, (b)
   relay-fetched kind-30443 events authored by the local pubkey.
   Different data flow.

### From open spec questions (resolved or routed)

| Spec Q | Disposition |
|--------|-------------|
| Q1 (NIP-09 enforcement on strfry) | EMPIRICAL — publish and observe. Unit test asserts publish call shape; E2E test asserts the event lands on the relay subscription. |
| Q2 (MLS init key vs Nostr identity key for kind-5) | RESOLVED by the spec itself — kind 443/30443 are Nostr events signed by the user's identity key. Architect proceeds; marmot-researcher engagement still welcome for confirmation. |
| Q3 (slot → leafIndex mapping) | RESOLVED — pattern at `src/components/DeviceList.tsx:119-130` using `defaultKeyPackageEqualityConfig.compareKeyPackageToLeafNode`. |
| Q4 (concurrent epoch advances) | OPEN. Architect picks one of: (a) implicit refresh in `removeLeafByIndex`, (b) retry-on-stale-epoch wrapper, (c) accept failures and surface to user. Decision in story `architecture.json`. Spec already says v1 accepts partial-failure → asks for retry, which biases toward (c) with a wrapper that retries once before bubbling. |

## Acceptance gates (high-level — Planner Mode 1 expands into AC-<TAG>-N)

- AC-SELF-* — Self-forget end-to-end behavior.
- AC-SIBLING-* — Sibling-forget end-to-end behavior.
- AC-INVITE-* — Auto-invite skip on forgotten slots.
- AC-STORE-* — `forgotten-slots` IDB store contract.
- AC-UI-* — Settings modal "Devices" tab.
- AC-DELETE-* — NIP-09 kind-5 deletion publish (self-forget only).
- AC-CLEANUP-* — Local IDB + NIP-46 cleanup on self-forget.
- AC-E2E-* — Two new Playwright tests, relay-state-independent.
- AC-UNIT-* — `forget-device.test.ts` mocking a 2-group MarmotClient.

Planner Mode 1 owns the canonical AC IDs and language.
