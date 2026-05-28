# Bug Report: Self-forget evicts sibling-device leaves (multi-device regression)

**Severity:** HIGH — regression shipped in commit `44a4b9c`. Silent data-loss class.
**Discovered by:** External code-review pass on commit `44a4b9c`.

## Status

**Fixed 2026-05-28** via Option A. `forgetSelfDevice` (`src/marmot/forget-device.ts`)
no longer calls `group.leave()` (which proposes a Remove for every leaf bearing the
pubkey). It now resolves THIS device's own leaf via `getOwnLeafNode` +
`signaturePublicKey` and publishes a single-leaf kind-445 Remove proposal via
`group.propose(...)`, then purges local state via `group.destroy()` (matching
`leave()`'s former internal teardown). A degraded-state fallback to `group.leave()`
remains for the (should-not-happen) case where the own leaf cannot be identified.
Regression guarded by a unit test (two same-pubkey leaves → proposal targets only
the own leaf index); AC-SELF-1/AC-SELF-2/AC-UNIT-2 and the permutation-matrix doc
were amended. Full web unit suite green (271/271). The multi-device e2e
(three-context A1/A2/B) is a recommended follow-up — the reliable regression guard
is the unit test, given known multi-context e2e flakiness.

## Symptom

A user signed in on two or more devices that share the same Nostr pubkey
(call them A1, A2, A3 — each with its own MLS leaf in a shared group), when
tapping **Settings → Devices → "Forget this device"** on A1, also evicts
A2 and A3 from every shared group. The UI promises a per-device action
("Forget *this* device?") but the code performs a per-identity action
("evict every leaf bearing this pubkey").

The user has no warning that other devices will be affected; they reappear
on a separate device only to find they're no longer in any of their groups.

## Reproduction

1. **Set up two-device user A and observer B:**
   - Sign in A on browser context A1 (default e2e bunker key).
   - Sign in A on browser context A2 using the same NIP-46 bunker. Both
     contexts share `pubkeyA` but receive distinct `clientId`s and write
     distinct leaves to any group they're members of.
   - Sign in B on browser context B.
2. **Create a shared group:**
   - On A1: create group G, invite B.
   - On A2: join G (sibling-device auto-invite or manual accept).
   - Wait until A2 has its own leaf in G (verify via DeviceList on A1 or
     `__notestrTestPubkeyLeafCount(g, pubkeyA)` ≥ 2).
3. **Trigger self-forget on A1:**
   - On A1: Settings → Devices → "Forget this device" → Confirm.
4. **Observe:**
   - A1 is signed out (correct).
   - The published kind-445 self-leave proposal targets BOTH A1's leaf AND
     A2's leaf, not just A1's. Verify by counting kind-445 proposal events
     on the relay tagged with G's `#h` and inspecting the Remove
     proposal indices (or by waiting for an admin to commit and observing
     B's view dropping by 2, not 1).
   - On A2 (still signed in): after the next admin commit, A2 also loses
     access to G.

### Failing test (to be written)

There is no current e2e test that exercises this — the failing
`forget-device-self.spec.ts:115` had only A1+B, no A2. Suggested new spec:
`e2e/tests/forget-device-self-multi-device.spec.ts` with a three-context
matrix (A1, A2, B), or a fourth test inside the existing
`forget-device-self.spec.ts` describe.serial block once an A2 fixture is
added.

## Expected post-condition

After A1 taps Forget:

1. Exactly **one** kind-445 Remove proposal is published, targeting A1's
   specific leaf index (not A2's). The leaf is identified by A1's local
   `clientId`, not by `pubkeyA`.
2. A2 remains a member of G. Its leaf is untouched.
3. After an admin commits the proposal, B's view of G drops by exactly
   one A-pubkey leaf (A1's), not two.
4. AC-E2E-11 / AC-E2E-12 (multi-leaf semantics in the
   two-party-permutation matrix at `docs/two-party-permutation-matrix.md:39`)
   are honored.

## Suspected root cause

Confirmed via code inspection:

- `src/marmot/forget-device.ts:118-123` — `selfLeafIndexesForPubkey` calls
  `getPubkeyLeafNodeIndexes(group.state, pubkey)`. This returns **every**
  leaf whose credential matches `pubkey`, not just the current device's.
- `src/marmot/forget-device.ts:201-205` — for each group with ≥1 self-leaf,
  calls `group.leave()` unconditionally.
- `node_modules/@internet-privacy/marmot-ts/dist/client/group/marmot-group.js:256-285` —
  `leave()` calls `proposeLeaveGroup(ownPubkey)`, which builds Remove
  proposals **for every leaf matching `ownPubkey`** and publishes them as
  kind-445 events. The library's own comment on line 271 names this:
  *"Publish one proposal event per leaf index (handles multi-device members)."*

So the fix's intent ("leave this group") is honored at the per-group
granularity, but the per-leaf granularity is wrong: leaving the group on
behalf of A1's identity removes every device that identity has in the
group.

The original pre-fix code (`selfLeafIndexesForKps` matching by stored KP
via `compareKeyPackageToLeafNode` on signaturePublicKey) was accidentally
per-device-correct: A1's stored KP only matches A1's leaf (because each
device has its own signature key). The fix swapped this for pubkey
matching, which is per-identity.

## Candidate fixes

### Option A (cleanest): identify A1's leaf by clientId, then propose Remove only for that leaf

1. The local `clientId` is available via `__notestrTestClientId` (test hook
   gating) and is the same key marmot-ts uses internally for leaf
   identification. Expose / use it in `forgetSelfDevice`.
2. Compute the leaf index by matching the leaf's identifier against the
   local clientId (mirrors the per-leaf logic in `forgetSiblingDevice` and
   `siblingLeafIndexesForEvents`, which already work per-leaf for
   non-self leaves).
3. Build the Remove proposal manually targeting that single leaf index.
   `group.commit({extraProposals: [Remove(thatLeafIndex)]})` is still
   forbidden by RFC 9420 §12.4 (self-commit), so use `group.propose(...)`
   or a marmot-ts-equivalent that publishes a kind-445 proposal targeting
   one specific leaf.

### Option B (smallest): add a `MarmotGroup.leaveLeaf(leafIndex)` API upstream

Add a marmot-ts API that targets one specific leaf, rather than `leave()`
sweeping all leaves matching the caller's pubkey. The caller passes the
explicit leaf index. RFC 9420 still allows proposing Remove on one's own
leaf — `proposeLeaveGroup` could be parameterized with a leaf-index
selector. Wait for upstream + version bump.

### Option C (workaround, deferred): document multi-device behavior

If the product decision is "Forget this device means forget my whole
identity in this group," update the UI to say so explicitly ("Forget all
my devices in all my groups?") and amend the spec. This abandons the
per-device contract but is consistent with the current implementation.

Recommend Option A unless upstream marmot-ts changes are already on the
roadmap. Option A is local-only and matches the existing per-leaf
sibling-forget pattern.

## Impact

- All multi-device notestr users would unexpectedly lose all their
  devices the moment one of them tapped "Forget this device."
- Bug is "silent" from the user's perspective on A1 (they signed out
  intentionally); the surprise lands on A2/A3 after the next admin
  commit, at which point the user has no UI affordance to recover (their
  leaves are gone from the tree).
- Likelihood: any user who follows the standard sibling-device pattern
  (recommended in the notestr UX docs) is exposed.

## Non-goals

- Do not reopen the option-1 / option-2 / option-3 product decision from
  the previous bug (`self-forget-no-mls-propagation`) — that's a separate
  decision tracked by its own bug.
- Do not change AC-E2E-9 again — it correctly asserts kind-445 proposal
  publication for the current device.
- Do not touch sibling-forget (`forgetSiblingDevice`,
  `siblingLeafIndexesForEvents`). They are already per-leaf and correct.
- Do not undo the credential-identity-resolution improvement for groups
  the user created — that part of the fix is correct. The issue is
  specifically the `group.leave()` call sweeping all matching leaves.

## Context: what introduced this regression

Commit `44a4b9c` ("Self-forget does not propagate to other group members
within SLA"). The fix in that commit swapped self-leaf resolution from
"match by stored KP" to "match by Nostr pubkey," correcting a separate
bug (groups the user created had no stored KP to match against). The same
change widened the resolution from per-device to per-identity, and the
follow-on `group.leave()` call inherits that widening.

Caught by external review after merge, not by the original team's
examiner/reviewer pass — the test fixture only signed A in on one
device, so the multi-leaf-per-pubkey scenario wasn't exercised.
