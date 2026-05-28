# Acceptance Criteria — epic-forget-this-device

## Constrained by ADRs

_No ADRs constrain this epic. See `docs/adr/` for project ADRs._

---

## AC-SELF-* — Self-forget end-to-end behavior

**AC-SELF-1** — `forgetSelfDevice` MUST iterate every group in `client.groups.loaded` in which the local user has at least one leaf (resolved by credential identity, i.e. `getPubkeyLeafNodeIndexes(group.state, pubkey)`) and, for each such group, publish a kind-445 Remove **proposal targeting ONLY this device's own leaf**. The own leaf MUST be resolved **per device** by its MLS `signaturePublicKey` (via `getOwnLeafNode(group.state)`), because a single Nostr pubkey may own several leaves in one group — one per device. `group.leave()` MUST NOT be used on the normal path: it proposes a Remove for EVERY leaf matching the pubkey, which would evict the user's other devices (sibling leaves) from the group — a per-identity action behind a per-device control (regression `self-forget-evicts-sibling-leaves`). The single-leaf proposal MUST be published via `group.propose(...)` (the same kind-445 proposal wire path as `group.leave()`, no commit). After the proposal is published, `forgetSelfDevice` MUST purge the group's local MLS state (`group.destroy()`), matching the teardown `group.leave()` performed internally, so a failure in a later step or a reload cannot resurface state for a group whose departure was already announced. Self-removal MUST NOT use `removeLeafByIndex` / `MarmotGroup.commit({extraProposals: [Remove(self)]})` — RFC 9420 §12.4 forbids committing a Remove proposal targeting the committer's own leaf, and marmot-ts rejects the attempt with "Commit cannot contain a remove proposal removing committer". The per-group calls MUST use a `for...of` loop (not `Promise.all`) so they are sequential. If this device's own leaf cannot be resolved (`getOwnLeafNode` throws — `state.privatePath` absent, a degraded state that should not occur for a live group), `forgetSelfDevice` MAY fall back to `group.leave()` for that group so the device still departs. Resolution-by-credential-identity for the per-group guard is mandatory because for groups the user CREATED, marmot-ts generates an ephemeral KeyPackage inline that is never stored in the local `KeyPackageManager`, so KeyPackage-equality matching against `client.keyPackages.list()` cannot find the creator's own leaf.

**AC-SELF-2** — `forgetSelfDevice` MUST NOT publish self-Remove proposals (`group.propose`, or the degraded `group.leave()` fallback) with `Promise.all` at any call site — the per-group calls MUST be awaited sequentially to prevent epoch-race conflicts.

**AC-SELF-3** — After all leaf removals complete, `forgetSelfDevice` MUST enumerate every entry in `client.keyPackages.list()` whose `.published` array is non-empty and publish a NIP-09 kind-5 deletion event referencing each published event id.

**AC-SELF-4** — `forgetSelfDevice` MUST call `clearNip46Session()` (from `src/lib/nostr.ts`) to clear NIP-46 localStorage keys — it MUST NOT call `localStorage.removeItem('notestr-nip46-payload')` directly or any other raw `localStorage` call for NIP-46 keys.

**AC-SELF-5** — After local cleanup, `forgetSelfDevice` MUST invoke the `onSignOut` callback it received as a parameter; it MUST NOT call `router.push`, `window.location.assign`, or any direct navigation itself.

**AC-SELF-6** — A confirmation dialog MUST be shown before self-forget executes, explaining that the action removes the device from all groups and signs the user out.

**AC-SELF-7** — During multi-group leaf removal, the UI MUST display a per-group progress indicator; the "Forget" button MUST be disabled while the operation is in progress.

---

## AC-SIBLING-* — Sibling-forget end-to-end behavior

**AC-SIBLING-1** — `forgetSiblingDevice` MUST only iterate groups where `isAdmin(group.groupData, pubkey)` returns `true`; groups where `group.groupData` is null or the local user is not admin MUST be skipped entirely.

**AC-SIBLING-2** — `forgetSiblingDevice` MUST call `removeLeafByIndex` for every leaf in each qualifying group whose key package matches the target `slot`, using a `for...of` loop (not `Promise.all`) — calls are sequential within each group.

**AC-SIBLING-3** — After all leaf removals, `forgetSiblingDevice` MUST call `markSlotForgotten(slot)` to persist the slot in the `notestr-forgotten-slots` IDB store.

**AC-SIBLING-4** — A confirmation dialog for sibling-forget MUST state the partial nature of the operation — that the device's key package on the relay will expire on its own in approximately 28 days, not be deleted immediately.

**AC-SIBLING-5** — During multi-group leaf removal for sibling-forget, the UI MUST display a per-group progress indicator; the "Forget" button MUST be disabled while the operation is in progress.

---

## AC-INVITE-* — Auto-invite skip on forgotten slots

**AC-INVITE-1** — In the `useDeviceSync` hook body in `src/marmot/device-sync.ts`, a `forgottenSlots` variable (type `Set<string>`) MUST be initialized by calling `loadForgottenSlots()` before the sync loop runs; the variable MUST be accessible to `runKeyPackageSync` (via closure) for initialization and to the cleanup function (via closure) for listener deregistration. A `window.addEventListener("notestr:forgotten-slots-changed", refreshForgotten)` listener MUST be registered in the effect body scope so it persists across sync loop iterations.

**AC-INVITE-2** — In `syncKnownKeyPackages` (at the insertion point after the `isLocalDevice` and pubkey guards, before `inviteToAllGroups`), the code MUST check `if (slot && forgottenSlots.has(slot)) continue` and skip inviting that key package event.

**AC-INVITE-3** — In `handleKeyPackageEvent` (at the matching insertion point before the invite call), the code MUST check `if (slot && forgottenSlots.has(slot)) return` (or equivalent early exit) and skip inviting the key package event.

**AC-INVITE-4** — The `window.removeEventListener("notestr:forgotten-slots-changed", refreshForgotten)` cleanup MUST be called when the `useDeviceSync` hook unmounts, preventing memory leaks.

---

## AC-STORE-* — `forgotten-slots` IDB store contract

**AC-STORE-1** — The `notestr-forgotten-slots` IDB store MUST be created via `createKVStore<true>("forgotten-slots")` from `src/marmot/storage.ts`, consistent with all other IDB stores in the codebase.

**AC-STORE-2** — `loadForgottenSlots()` MUST call `forgottenStore.keys()` to enumerate stored slots — it MUST NOT call `forgottenStore.getAllKeys?.()` (that method does not exist on `KeyValueStoreBackend`).

**AC-STORE-3** — `markSlotForgotten(slot)` MUST dispatch `new CustomEvent("notestr:forgotten-slots-changed")` on `window` after writing the slot to IDB, so any in-memory cache in `device-sync.ts` is refreshed synchronously.

**AC-STORE-4** — The module owning the `forgotten-slots` store (either `src/marmot/forgotten-slots.ts` or additions to `src/marmot/device-store.ts`) MUST export at minimum `markSlotForgotten(slot: string): Promise<void>` and `loadForgottenSlots(): Promise<Set<string>>` as its public surface.

---

## AC-UI-* — Settings modal "Devices" tab

**AC-UI-1** — `src/components/SettingsModal.tsx` MUST use the `<Tabs>` primitive from `src/components/ui/tabs.tsx`; the existing connection content MUST become a named tab (e.g. "Connection"), and a new "Devices" tab MUST be added alongside it.

**AC-UI-2** — The Devices tab MUST render a device row for each entry in the union of (a) the local `clientId` and (b) relay-fetched kind-30443 events authored by the local pubkey — it MUST NOT source its data from `DeviceList.tsx`'s ratchet-tree-leaves data flow.

**AC-UI-3** — Each device row MUST display: a user-friendly name (default `device-<slot[8..14]>`), the slot identifier, the KP's `created_at` timestamp, and a "this device" badge when `d.slot === localClientId`.

**AC-UI-4** — Each device row MUST include a destructive "Forget" button styled to indicate an irreversible action; clicking it MUST open the appropriate confirmation dialog (self-forget or sibling-forget) before any operation begins.

**AC-UI-5** — The Devices tab MUST add `useMarmot()` inside `SettingsModal` to obtain `client`, `signer`, `relays`, and `clientId`; `SettingsModal` MUST accept a new `onSignOut` callback prop passed from `app/page.tsx`.

**AC-UI-6** — The self-forget device row button MUST carry `data-testid="device-forget-self-btn"` and the confirmation dialog's confirm button MUST carry `data-testid="device-forget-self-confirm-btn"` (or equivalent stable test identifiers) to support Playwright targeting.

---

## AC-DELETE-* — NIP-09 kind-5 deletion publish path

**AC-DELETE-1** — The kind-5 deletion event published by `forgetSelfDevice` MUST be signed by the user's identity key via `signer.signEvent(...)` and published via `client.network.publish(relays, signedEvent)`, matching the existing publish path used elsewhere in `src/marmot/`.

**AC-DELETE-2** — Each published kind-5 event MUST contain an `e`-tag referencing the id of the target KP event, and the event's `pubkey` MUST match the user's identity pubkey that originally signed the kind-30443 KP event being deleted.

**AC-DELETE-3** — One kind-5 event MUST be published per published KP event id (not one aggregated event for all ids); only KP entries where `.published.length > 0` are targeted.

---

## AC-CLEANUP-* — Local IDB + NIP-46 cleanup on self-forget

**AC-CLEANUP-1** — `forgetSelfDevice` MUST clear the identity IDB store (exposing it via a new `clearIdentityStore()` export from `src/marmot/storage.ts`, or equivalent mechanism decided by the architect) so the local `clientId` is no longer recoverable after sign-out.

**AC-CLEANUP-2** — `forgetSelfDevice` MUST clear or delete the `notestr-key-packages`, `notestr-group-state`, and `notestr-invite-store` IDB databases (via whichever mechanism the architect selects: lifted module-scope exports, `MarmotClient.clearLocalState()`, or `indexedDB.deleteDatabase` by stable name) — the chosen mechanism MUST be recorded in the story's `architecture.json`.

**AC-CLEANUP-3** — `forgetSelfDevice` MUST call `clearNip46Session()` from `src/lib/nostr.ts` to atomically clear `notestr-nip46-payload`, `notestr-nip46-local-key`, and (when `auth-method === 'nip46'`) `notestr-auth-method`.

**AC-CLEANUP-4** — `forgetSelfDevice` MUST call `.clear()` on `invitedKeysStore` (exported from `src/marmot/storage.ts:70`) and `.clear()` on `joinedGroupsStore` (exported from `src/marmot/storage.ts:71`).

---

## AC-SIGNOUT-* — Sign-out via `onSignOut` callback

**AC-SIGNOUT-1** — `app/page.tsx` MUST pass `onSignOut={handleDisconnect}` as a prop into `<SettingsModal>`; `forgetSelfDevice` MUST accept `onSignOut: () => void` as a parameter and invoke it after local cleanup completes.

**AC-SIGNOUT-2** — `forgetSelfDevice` MUST NOT contain any call to `router.push(...)`, `window.location.assign(...)`, `window.location.replace(...)`, or `window.location.href = ...` — navigation is fully delegated to the `onSignOut` callback.

---

## AC-E2E-* — Two new Playwright tests

**AC-E2E-1** — `e2e/tests/forget-device-self.spec.ts` MUST exist and MUST contain a `describe.serial` block with a `Date.now()` group name at the top (e.g. `` `ForgetSelf ${Date.now()}` ``) to guarantee isolation across runs.

**AC-E2E-2** — `e2e/tests/forget-device-sibling.spec.ts` MUST exist and MUST contain a `describe.serial` block with a `Date.now()` group name at the top (e.g. `` `ForgetSibling ${Date.now()}` ``).

**AC-E2E-3** — Both new e2e specs MUST call `authenticate(page, bunkerUrl, slot)` with explicit slot strings (e.g. `"self"`, `"sibling-a1"`, `"sibling-a2"`, `"B"`) — slot MUST NOT be omitted or auto-generated inside the test.

**AC-E2E-4** — Both new e2e specs MUST propagate `skipMobile` via `beforeAll` for any multi-context test using the `SKIP_MOBILE_REASON` pattern established in the existing multi-device spec.

**AC-E2E-5** — Neither new e2e spec MUST call `e2e-down`, `e2e-up`, relay reset helpers, or assert on global relay state; all isolation MUST be achieved via `authenticate` (which calls `clearAppState` internally) and `Date.now()` group names.

**AC-E2E-6** — `e2e/fixtures/cleanup.ts` MUST include `"notestr-forgotten-slots"` in `KNOWN_IDB_NAMES` (the array at lines 16-25) so `clearAppState()` clears the new store on every test run.

**AC-E2E-7** — A `__notestrTestForgottenSlots` window hook MUST be implemented in `src/marmot/client.tsx` inside the `if (process.env.NEXT_PUBLIC_E2E === "1")` test-hooks block; it MUST return a `Promise<string[]>` containing the current keys of the `notestr-forgotten-slots` IDB store.

**AC-E2E-8** — The `__notestrTestForgottenSlots` hook signature MUST be declared in `src/types/notestr-test-hooks.d.ts` alongside the existing hook declarations.

**AC-E2E-9** — The self-forget e2e test MUST assert, within 60 s of A's confirm-click, that a kind-445 group event tagged with the group's MLS nostr_group_id (#h) and `created_at >= sinceBeforeAction` is observed on the relay via the pre-action NDK subscriber. The filter MUST NOT include `authors` because per MIP-03 kind-445 events are signed with an ephemeral keypair (`generateSecretKey()` inside `createGroupEvent`) to hide member identities at the wire level — observing a new kind-445 on the group's #h after the action is sufficient evidence of the leave proposal in the test's two-party topology where A is the sole publisher. B's member-count is NOT required to drop until another admin in the group commits the proposal — that step is outside the self-forget surface and is a separate concern of multi-admin group lifecycle. Rationale: RFC 9420 §12.4 forbids self-commit of Remove, so the user publishes a Remove **proposal** and another admin commits it later; in a 2-party group where the leaver is the sole admin, no commit lands until the remaining member is promoted (out of scope here).

**AC-E2E-10** — The self-forget e2e test MUST assert that a kind-5 deletion event with A's pubkey and an `e`-tag matching A's KP event id is published on the relay, using `openNdkSubscriber.waitForEvent({ kinds: [5], authors: [aPubkeyHex] }, timeoutMs)`.

**AC-E2E-11** — The sibling-forget e2e test MUST assert that A2's leaf is absent from the group member list after A1 performs sibling-forget. Implementation note: "A2's leaf absent" means A2's individual leaf node is removed; A1 retains its own leaf for the same pubkey. The correct assertion is `leafIndexesFor(page, groupId, pubkeyA)` returning length 1 (A1's leaf remains), not length 0. Assert `toHaveLength(1)`, not `toHaveLength(0)`.

**AC-E2E-12** — The sibling-forget e2e test MUST assert that A1's `__notestrTestForgottenSlots()` hook returns an array containing A2's slot string after the forget flow completes.

---

## AC-UNIT-* — `forget-device.test.ts` unit tests

**AC-UNIT-1** — `src/marmot/forget-device.test.ts` MUST exist and MUST use `vi.mock('@internet-privacy/marmot-ts', ...)` following the pattern established in `src/marmot/client.test.ts` and `src/marmot/device-sync.test.ts`.

**AC-UNIT-2** — The unit test MUST construct a mock `MarmotClient` representing two groups (each with at least one leaf matching the local pubkey) and assert that `forgetSelfDevice` publishes exactly one self-Remove proposal (`group.propose`) per group containing a self-leaf, and does NOT call `group.leave()` on the normal path. A regression test MUST assert that, for a group containing two leaves of the same pubkey (this device + a sibling device), the published proposal targets ONLY this device's own leaf index — never the sibling's (regression `self-forget-evicts-sibling-leaves`). `removeLeafByIndex` MUST NOT be asserted for the self-forget path — self-removal uses a kind-445 proposal, not a commit (RFC 9420 §12.4 forbids self-commit of Remove; see AC-SELF-1). A separate test case MUST assert that groups where `getPubkeyLeafNodeIndexes` returns `[]` are skipped entirely (no proposal).

**AC-UNIT-3** — The unit test MUST assert that `forgetSelfDevice` calls the kind-5 publish path once per published KP event id (using a spy on `client.network.publish` or equivalent).

**AC-UNIT-4** — The unit test MUST assert that `forgetSelfDevice` calls `clearNip46Session()` exactly once.

**AC-UNIT-5** — The unit test MUST assert that `forgetSelfDevice` invokes the `onSignOut` callback after all cleanup steps.

**AC-UNIT-6** — The unit test MUST assert that `forgetSiblingDevice` skips groups where `isAdmin(group.groupData, pubkey)` returns `false` and only calls `removeLeafByIndex` in groups where the local user is admin.

**AC-UNIT-7** — The unit test MUST assert that `forgetSiblingDevice` calls `markSlotForgotten` with the target slot string after leaf removal completes.

---

## Manual Validation

- **AC-DELETE-1 / AC-DELETE-2** — Whether strfry honors a kind-5 event signed by the user's identity key against an `e`-tag pointing at one of their own kind-30443 KP events (NIP-09 enforcement) is empirical. The e2e test `AC-E2E-10` provides automated coverage via `openNdkSubscriber.waitForEvent`, but whether strfry *acts* on the deletion (suppressing the kind-30443 from subsequent relay queries) requires checking relay logs or a follow-up relay-query assertion after a propagation delay. If the relay ignores the kind-5 body for kind-30443 targets, the ghost KP will persist until `Lifetime.not_after` — this is the expected v1 fallback and does not constitute a test failure.

- **AC-CLEANUP-2** — The specific mechanism chosen by the architect (lifted exports vs. `MarmotClient.clearLocalState()` vs. `indexedDB.deleteDatabase`) must be verified manually against the architect's recorded decision in the story's `architecture.json`, since the choice is an open decision at planning time and cannot be pre-baked into an automated assertion that is mechanism-agnostic.

---

## Notes

1. **Open spec question Q4 (concurrent epoch advances)** is not encoded as an AC because the architect has three valid responses ((a) implicit refresh in `removeLeafByIndex`, (b) retry-on-stale-epoch wrapper, (c) surface error to user and request retry) — the spec already declares v1 accepts partial failure and asks for retry, which biases toward (c). The architect records the chosen path in the story's `architecture.json`; the unit tests (AC-UNIT-2) will exercise the happy path regardless of choice.

2. **Sibling-forget kind-5 deletion is intentionally absent from ACs.** Spec design decision #2 explicitly marks this as conditional on Q1 (NIP-09 enforcement) and out of v1 scope. If empirical validation confirms the relay honors it, a follow-up epic can add the behavior without invalidating these ACs.

3. **`DeviceList.tsx` is unchanged.** The existing per-group single-leaf sibling-forget UI at `src/components/DeviceList.tsx:192` continues to function. The new Settings "Devices" tab is a distinct surface with a different data source (relay-fetched kind-30443 events ∪ local `clientId`). ACs do not constrain `DeviceList.tsx`.

4. **`identityStore` export shape** is deliberately left open in AC-CLEANUP-1 ("`clearIdentityStore()` export or equivalent mechanism decided by the architect"). The exploration confirmed the store is file-private; the architect picks the export shape consistent with the existing exported-store pattern in `storage.ts`. The AC is testable regardless of shape — the unit test can spy on the chosen export.

5. **`ac_complete` note for AC-CLEANUP-2.** This AC references an open architectural decision (three valid implementation paths). It is still normatively testable post-decision — once the architect records the chosen path, a unit test assertion can be written. The AC is intentionally worded to cover all three paths.
