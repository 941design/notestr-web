# Cross-Context Coverage for Device-Rename Locality

## Problem

The `rename-device.spec.ts` file claims to cover three permutations from
`docs/two-party-permutation-matrix.md`:

| TP-60 | rename round-trip survives reload (positive) |
| TP-61 | A.Rd(B1, …) — UI affordance does not exist (negative) |
| TP-62 | B does not observe A's rename (negative) |

The current spec at `e2e/tests/rename-device.spec.ts:106-129`
implements TP-61/TP-62 as a single-context smoke that asserts the
DeviceList header reads "Your devices" and that the file's docstring
reasons-by-code-inspection that "the negative TP-62 assertion holds
trivially — there is no surface for it to leak through."

That is sound today, given the current implementation. It is **not** a
test of the contract — it is a test of one component's selector. A
regression that adds a cross-identity surface for device names would
slip through, because the spec never opens a second context to observe
from. Examples of regressions that would silently pass:

1. **MLS commit-extension leak.** A future change wires device names
   into a new MIP-defined group-context extension (analogous to
   `groupData`), broadcasting the rename through every commit. The
   DeviceList component still reads from `deviceNamesStore` first, so
   "Your devices" still reads correctly — but B's context could now
   surface the rename through any UI added downstream.
2. **NIP-78 application-data publish.** A future feature serializes
   device names to an addressable kind-30078 event so the user's
   devices stay in sync across browsers under the same npub. Useful
   feature; but TP-62's "B does not observe" must still hold because
   B is a different npub.
3. **Test-hook leak.** A new debug surface exposes
   `__notestrTestDeviceNames(groupId)` that returns names regardless
   of context. The current test does not enumerate test hooks, so a
   leak there goes unnoticed.

The current spec's docstring acknowledges the limitation:

> The remaining testable scenario is TP-60: same-npub, two contexts,
> one renames the other and the rename survives a reload of the
> renamer's context. (`multi-device-sync.spec.ts` attempts this in a
> more elaborate setup that's currently `fixme`-marked for unrelated
> reasons. The test below is a slimmer, single-purpose version focused
> on the rename round-trip alone.)

So TP-60 has a real round-trip test (single context, reload). TP-61
holds by "the affordance doesn't exist" — verifiable by code
inspection of `DeviceList.tsx`. TP-62 is the gap: it claims a
*negative* property about cross-identity observation but never opens
the cross-identity context to verify it.

## Solution

Add a real two-context test for TP-62: rename in context A; assert that
context B (different npub, same group) cannot observe the new name
through any of:

- DeviceList UI (no row for A's pubkey at all — already negative-by-design)
- MLS group state (no rename data carried in `groupContext.extensions`)
- Outgoing kind-30078 events from A's context (no application-data
  publish containing the rename string)
- Outgoing kind-1059 / kind-1060 / kind-13 wraps from A's context
  (rename should not leak via gift-wrapped DMs)
- Test hooks exposed on B's `window` (no name-revealing surface)

Each negative is a positive assertion in the test: "no event of kind X
containing the rename string was observed by B's NDK subscriber within
N seconds of the rename." The test fails as soon as any future change
introduces a leak surface.

For TP-61 (the "affordance does not exist" case), keep the current
single-context smoke — it's a low-cost guard against accidentally
adding a Forget-style button for sibling-pubkey leaves. Augment its
assertions: explicitly verify the DeviceList does not render any
`[data-testid="device-row"]` whose `data-pubkey` differs from the
local pubkey. Today no such attribute exists; this test would force
the design to keep that property explicit.

## Scope

### In Scope

- **New TP-62 test** in `rename-device.spec.ts` (or a sibling file
  `rename-device.cross-context.spec.ts` — see Design Decision 3): two
  browser contexts authenticated to **different** bunker pubkeys (User
  A and User B), both joined to a shared group. A renames a sibling
  device in context A; the test then asserts:

  1. **B's DeviceList shows no row for A's pubkey.** (Negative trivially
     today, but worth pinning in code.)
  2. **No `kind: 30078` event** with `pubkey == A.pubkey` and a tag or
     content matching the rename string is emitted within 5s of the
     rename. Verified via `openNdkSubscriber()` listening on the same
     relay set.
  3. **No `kind: 1059` (gift-wrap)** with `pubkey == A.pubkey` and a
     decryptable inner content matching the rename string is emitted
     within 5s of the rename.
  4. **B's `__notestrTestSentRumors(groupId)`** for the shared group
     contains no application-rumor whose decrypted content references
     the rename string.
  5. **`group.state.groupContext.extensions`** on B's side does not
     contain any extension carrying the rename string. (Read via a new
     test hook `__notestrTestGroupExtensions(groupId)` if needed; see
     Design Decision 4.)

- **Augmented TP-61 test** in the existing single-context block: assert
  that no `[data-testid="device-row"]` element renders whose
  `data-pubkey` (or, in its absence, whose owning leaf identity) is
  not the local user's pubkey. Forces this property to be explicitly
  encoded rather than relied upon.

- **Update `docs/two-party-permutation-matrix.md` §Rename device** so
  the n/a-by-design qualifier is replaced with "guarded by negative
  Playwright assertions in `rename-device.spec.ts`." The matrix table
  entries for TP-61/TP-62 stay, but the "n/a" annotation goes.

- **Add `__notestrTestGroupExtensions(groupIdStr)`** test hook in
  `src/marmot/client.tsx` (in the existing `if (isTestRuntime())` block
  alongside `__notestrTestGroups`, `__notestrTestPubkeyLeafIndexes`,
  etc.) that returns the current MLS `groupContext.extensions` array
  for the named group. Read-only; required to assert (5) above.

### Out of Scope

- **Implementing cross-context device-name sync.** This epic asserts
  the *current* contract (rename is local-only). A future epic that
  decides to sync device names across same-npub contexts will replace
  this epic's assertions with positive ones for same-npub and keep
  the negative ones for cross-npub.
- **Per-leaf, per-context test hooks for IndexedDB introspection.**
  Tempting to add `__notestrTestDeviceNames(clientId)` and assert it
  returns nothing on B's context. But B's IndexedDB is per-context by
  browser policy — verifying that with a test hook would be belt-and-
  braces. The DeviceList check (1) and the wire-level checks (2)–(4)
  cover the contract.
- **Generalized "no information leak" framework.** This epic targets
  the rename string specifically; a generic "verify no PII in any
  outgoing event" infrastructure is a separate ask.
- **TP-60 redesign.** The existing TP-60 round-trip test stays
  unchanged. (Note: it does have a separate flakiness issue tracked
  in `epic-e2e-relay-state-isolation` — that work is parallel.)

## Design Decisions

1. **Cross-npub, not same-npub.** TP-62 specifies "B does not observe
   A's rename" where B is a separate identity. Same-npub on a different
   browser is a different test (currently in `multi-device-sync.spec.ts`,
   `fixme`-marked) and would need a positive assertion *if* device-name
   sync ever lands. Keeping the negative test cross-npub avoids
   conflating the two contracts.

2. **NDK subscriber, not Playwright network interception.** The relay
   is the source of truth for what was published. Playwright can
   monitor B's incoming WebSocket frames, but it would not see events
   that A published if A's relay-set diverges from B's. Subscribing
   via NDK directly to the same relay used by both contexts is the
   most reliable observer.

3. **Inline in `rename-device.spec.ts` vs new file.** The two-context
   setup is heavier than the existing single-context smoke. Adding a
   third `describe.serial` block to `rename-device.spec.ts` is fine
   from a runtime standpoint (the per-file relay-reset fixture from
   `epic-e2e-relay-state-isolation` makes context setup cheap) and
   keeps all rename coverage in one file. Splitting buys nothing.

4. **`__notestrTestGroupExtensions` hook.** MLS group-context
   extensions are accessed today only via internal marmot-ts
   primitives. Exposing them through a test hook is a small
   production-side change but is needed to make assertion (5) viable
   without scraping internal state. The hook is purely read-only —
   no write surface, no risk of test infra leaking to production.

5. **Rename string is unique per test.** Use `Date.now()` like the
   existing TP-60 test so a leaked rename string is unambiguously
   attributable to this test run, even on a polluted relay.

6. **5-second observation window.** Long enough to catch any
   event that A's commit machinery would publish synchronously
   (typical kind-445 commits take ~1s end-to-end on the local
   relay); short enough to keep the test's wall-clock under 30s
   total.

## Acceptance Criteria

- **AC-RC-1** — `e2e/tests/rename-device.spec.ts` (or a sibling file
  per Design Decision 3) contains a `describe.serial("TP-62: rename
  is invisible cross-identity")` block with two browser contexts
  authenticated to distinct bunker pubkeys via the existing
  `auth-helper.ts` and `auth-helper-b.ts` fixtures.
- **AC-RC-2** — The block creates a shared group (A admin, A invites
  B), then A renames its own sibling device row, then asserts:
  - **AC-RC-2a** — B's DeviceList contains zero rows referencing A's
    pubkey (verified via `getByRole("region", { name: "Your devices" })`
    and `locator('[data-testid="device-row"]').count()`).
  - **AC-RC-2b** — Within 5s of the rename, the NDK subscriber on
    `ws://localhost:7777` observes zero kind-30078 events authored by
    A whose content/tags contain the rename string.
  - **AC-RC-2c** — Within 5s of the rename, the NDK subscriber observes
    zero kind-1059 gift-wraps authored by A.
  - **AC-RC-2d** — `__notestrTestSentRumors(groupId)` on B's context
    returns no rumor whose JSON content references the rename string.
  - **AC-RC-2e** — `__notestrTestGroupExtensions(groupId)` on B's
    context returns extensions that do not reference the rename
    string in any field.
- **AC-RC-3** — TP-61 single-context smoke is augmented to assert
  `page.locator('[data-testid="device-row"]:not([data-local="true"])').count() === 0`
  (or equivalent — current rows do not carry `data-local="false"`
  for non-self leaves; the assertion encodes the absence of any such
  row).
- **AC-RC-4** — `__notestrTestGroupExtensions(groupId: string)` is
  added to `src/marmot/client.tsx` in the test-hooks block, declared
  in `src/types/notestr-test-hooks.d.ts`, and returns the MLS
  groupContext.extensions array for the named group (or an empty
  array if absent).
- **AC-RC-5** — `docs/two-party-permutation-matrix.md` §Rename device
  no longer marks TP-61/TP-62 "n/a-by-design"; instead it cites the
  rename-device cross-context coverage as the negative-property
  guard.
- **AC-RC-6** — A deliberate regression — wiring the rename string
  into a kind-30078 publish in `setDeviceName()` — causes AC-RC-2b
  to fail. Verified once during implementation, then reverted. (Same
  pattern as `epic-property-based-invariants` AC-VAL-1.)

## Affected Files

- `e2e/tests/rename-device.spec.ts` — extended with TP-62 cross-context
  block + augmented TP-61 row-count guard.
- `src/marmot/client.tsx` — adds the new `__notestrTestGroupExtensions`
  read-only hook.
- `src/types/notestr-test-hooks.d.ts` — declares the new hook.
- `docs/two-party-permutation-matrix.md` — updates the §Rename device
  section to drop the "n/a-by-design" annotation.

## Relationship to Other Epics

- **`epic-multi-device-sync`** — the canonical owner of device-name
  semantics. This epic adds negative coverage for the contract that
  multi-device-sync established (rename is per-context, IndexedDB-local,
  no broadcast). If multi-device-sync's follow-up epic ever
  introduces same-npub rename sync, the assertions added here stay
  valid for the cross-npub case (TP-62) but the same-npub case
  becomes a *positive* assertion in that epic, not this one.
- **`epic-e2e-relay-state-isolation`** — soft prerequisite. The new
  TP-62 test runs cleanly in isolation today but would inherit
  cross-spec pollution risk in a fully serialized `make e2e` run if
  another spec authenticated as User A or User B. With per-file
  relay reset, this is moot.
- **`epic-task-sync-publish-contract`** — methodologically similar
  (NDK-observed assertions about what gets published). Reuses the
  `e2e/fixtures/ndk-subscriber.ts` helper introduced there.

## Non-Goals

- **A general-purpose "no leak" assertion library.** The five
  observers in AC-RC-2 are inlined; if a third or fourth rename test
  ever needs the same vocabulary, factor then.
- **Asserting *positive* properties about device-name persistence.**
  TP-60 already does that. This epic is purely about the negative
  half of the contract.
- **Backporting these assertions to `multi-device-sync.spec.ts`.**
  That spec is currently `fixme`-marked for separate reasons (relay
  pollution + MLS remove semantics). Once it is un-fixme'd, the
  same-npub variant of these checks may be useful, but that is a
  follow-up.
