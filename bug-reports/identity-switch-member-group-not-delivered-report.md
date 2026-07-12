# Bug Report: After an identity switch in a shared browser, an invited member never sees their own group

## Status

**OPEN — filed 2026-07-12** from a full e2e baseline run (browser binaries
repaired first; see "Environment" below). Not previously tracked: no
bug-report or `BACKLOG.json` item existed for this failure. Distinct from the
cross-client B3 regression (see "Not the same as B3").

**Update, later 2026-07-12: RESOLVED — root-caused as a test-design bug and
fixed inline in the spec. See "Investigation findings (2026-07-12)" below.**

## Symptom

`e2e/tests/identity-visibility.spec.ts:78` — **"identity switch restores full
interactivity for member"** — fails deterministically:

| Project | Attempt 1 | Retry | Duration |
|---|---|---|---|
| chromium | ✘ | ✘ | ~55.6s |
| Mobile Chrome | ✘ | ✘ | ~55.7s |
| Mobile Safari | ✘ | ✘ | ~56.2s |

All three browsers, both attempts. This is **not flake** — ~55s is the 45s
`toBeVisible` timeout plus fixture overhead, i.e. the group simply never
arrives.

Failing assertion (`identity-visibility.spec.ts:149`):

```
await expect(page.getByLabel('Groups').getByText(groupName)).toBeVisible({ timeout: 45000 });
// Error: element(s) not found  (waiting for the "Switch-Test <ts>" group)
```

## Scenario

Single browser, shared IndexedDB, one identity switch A → B:

1. Context B (separate, cleared context): User **B** authenticates via bunker,
   publishes a key package, context closes.
2. Shared context: User **A** authenticates, creates group `Switch-Test <ts>`,
   invites **B** by npub, then **plain "Sign out"** (group state deliberately
   left in the shared IndexedDB).
3. Same shared context: User **B** authenticates. **B must now see the group**
   (delivered via MLS welcome) and have full interactivity.

Step 3 never surfaces the group.

## The nuance the web project may not have connected

**The two halves of the identity-scoping feature have split: isolation passes,
delivery fails.**

- `identity-visibility.spec.ts:30` — *"a different identity does NOT see the
  prior identity's group (per-pubkey isolation)"* — **PASSES**. B does not leak
  A's data. ✅
- `identity-visibility.spec.ts:78` — *"identity switch restores full
  interactivity for member"* — **FAILS**. B does not receive B's own legitimately
  invited group. ❌

So the "don't leak another identity's data" invariant holds, but the "still
deliver a group I was actually invited to" invariant is broken — specifically in
the shared-browser identity-switch path.

## Leading hypothesis (UNVERIFIED — needs a bisect to confirm)

This test **predates** the per-pubkey partitioning work — it was introduced in
`00b9aea` (*feat: identity-scoped group and task visibility*). The most recent
change to the surrounding file is `7607c7c` (*feat(marmot): partition IndexedDB
per-pubkey for cross-account isolation*), which:

- reworked the storage layer these tests exercise
  (`bindStores(pubkey)`/`unbindStores`, lazy per-pubkey DB resolution,
  `notestr-${pubkey}-${name}` databases), and
- **rewrote the sibling isolation tests** (the old "detached group" tests became
  the passing `:30` isolation test) **but left the `:78` delivery test
  untouched** — and `:78` now fails.

An unchanged test regressing underneath a storage-layer change whose stated goal
was cross-account isolation is the strongest lead. Candidate mechanisms to
investigate (in order):

1. **Welcome processing writes into the wrong / an empty partition.** When B
   binds to its own partition on sign-in, does B's MLS welcome actually get
   fetched and processed into `notestr-${B_pubkey}-group-state`, or does the
   binding/`pinnedPubkey` logic (which pins `group-state`, `key-packages`,
   `invites` to their identity) leave B looking at an empty store?
2. **Key-package availability across contexts.** B generated its key package in
   the *separate* Context B (now closed); the shared context's
   `notestr-${B_pubkey}-key-packages` partition may lack the private material B
   needs to decrypt the welcome. Confirm whether B re-derives/re-publishes on
   sign-in or depends on state that never existed in this partition.
3. **Timing of `bindStores` vs. welcome subscription** on the sign-in that
   follows a sign-out in the same page lifecycle.

**Falsification step:** check out `7607c7c^`, install browsers, and run
`npx playwright test identity-visibility.spec.ts:78 --project=chromium`. If it
passes there and fails at `7607c7c`, the partitioning commit is the culprit.

## Not the same as B3

Do **not** fold this into the cross-client B3 regression
(`bug-reports/cross-client-cli-created-group-no-live-tasks-report.md`). B3 is
*over-the-wire, cross-implementation* (a **CLI/daemon**-created MDK group whose
live task delivery to the web stalls). This bug is *web-only, single-browser,
single-relay*, and is about **group delivery across a local identity switch /
partition binding** — a different code path (`src/marmot/storage.ts`,
`client.tsx`), even though both present as "a member doesn't see a group."

## Baseline context (2026-07-12)

Rest of the web suite is healthy: **244 passed / 3 failed / 158 skipped**, where
the 3 failures are this one test across the 3 browser projects. CLI e2e 53/53,
parent same-identity 4/4 green.

## Environment caveat (why this was invisible before)

The first baseline run reported the *entire* web suite as failing — a false
signal. `/opt/playwright-browsers` held Chromium **1228** while
`node_modules` pins **1208**, so every test died at `browserType.launch`.
After installing rev 1208, the suite ran and this single real failure surfaced.
If the web project last saw "everything red," it likely attributed it to the
browser mismatch and never noticed this genuine regression underneath.

## Investigation findings (2026-07-12)

**Status: RESOLVED — test bug, fixed inline.** The product behaves correctly;
the test asserted a cryptographically impossible delivery. The test was
restructured (see "Fix applied") and now passes: chromium 12.5s green (was a
deterministic 55s timeout), isolation test `:30` still green.

### Confirmed root cause: candidate #2 (key-package availability), NOT unpinned stores, NOT timing

The test's Step 1 published User B's key package from a **separate, then
closed** browser context (`contextB`). A Playwright context has fully separate
IndexedDB, so the key package's **private HPKE init key** — stored by
marmot-ts in the `key-packages` store — only ever existed in `contextB`'s
storage. It never existed in the shared context under *any* partition, pre- or
post-partitioning.

The delivery chain in B's shared-context session, verified end-to-end:

1. `src/marmot/device-sync.ts:611-615` — on sign-in, device-sync fetches all
   historical kind-1059 gift wraps for B (`{ kinds: [1059], "#p": [pubkey] }`,
   no `since`) and subscribes live (`:623-638`). **The welcome IS fetched** —
   no timing race (candidate #3 refuted).
2. Gift-wrap (outer NIP-44) decryption uses the bunker signer — works anywhere
   B is signed in.
3. `src/marmot/device-sync.ts:412-421` — `joinFromWelcomeInvite` calls
   `client.joinGroupFromWelcome({ welcomeRumor })`, which must match the
   Welcome's KP ref against a locally stored key package in
   `notestr-<B>-key-packages` (pinned store, `src/marmot/client.tsx:218`).
   **This is the break point**: B's partition holds no KP matching the ref
   (the fresh KP created on sign-in has a different ref), so the join fails
   → `no_matching_kp` → `FailedWelcomeRecord` appended → the group never
   surfaces. No recovery path exists: A is signed out, and auto-invite is
   same-pubkey-siblings-only (`device-sync.ts:1139-1169`), so nobody can
   re-invite B's fresh KP.

Candidate #1 (unpinned module-level stores flipping partitions) is **refuted**
for this bug: the unpinned singletons (`deviceNamesStore`, `invitedKeysStore`,
`joinedGroupsStore`, `bootstrapCompletedStore`, `groupSyncStore`,
`failedWelcomesStore`, `identityStore`) resolve *at access time* against the
active pubkey (`storage.ts:76-83`), which during B's session is correctly B.
They follow the active identity **by design**; the `pinnedPubkey` variant
exists only to protect against in-flight tasks from a signed-out identity.
No store misresolution occurs in this scenario.

### Why the test passed before 7607c7c (the leak it silently depended on)

Pre-partitioning, all group state lived in the origin-level
`notestr-group-state` DB. B's `client.groups.loadAll()`
(`client.tsx:247`) loaded **A's copy** of the group — whose MLS state, after
A's invite commit, includes B's leaf. `computeDetachedGroupIds`
(`src/marmot/detached-groups.ts:10-13`) checks membership **by pubkey**, and
B's pubkey IS a member → not detached → full interactivity. The MLS welcome
path **never once succeeded** in this test; the "delivery" it observed was the
exact cross-identity storage leak that 7607c7c intentionally removed. The
commit's claim that this test proves "membership flows over the network, not
local storage" was aspirational — the test body (unchanged by 7607c7c) could
not satisfy it.

### Fix applied (test-only, `e2e/tests/identity-visibility.spec.ts`)

Removed the throwaway `contextB`. The whole scenario now runs in ONE context:
**B signs in first** (key package + private material land in
`notestr-<B>-key-packages` of the shared IDB), plain-signs-out (partition
preserved), then A signs in / creates / invites (GroupManager picks the
freshest KP by `created_at` — B's just-published one), signs out, then B
re-signs in and the Welcome is decryptable with B's local private material.
This exercises **genuine network delivery through an identity switch** — the
test's stated intent — in the only form MLS permits. A load-bearing comment in
the test explains why B's KP must be published from the shared context.

No product code changed. No protocol/wire-format impact.

### Product-behavior note (correct as-is, for the record)

A user invited via a key package published from a *different, now-gone* device
can never decrypt that Welcome on a new device — MLS guarantees this. The
product's designed handling is the failed-welcome record + Pending Invitations
panel + sign-in probe banner (`client.tsx:290-328`), i.e. "surface it, let the
user request a re-invite." That is the correct behavior and is unchanged.

### Cross-project verification (2026-07-12, lead re-run of `:78`)

The initial fix verification covered chromium only. Re-ran the fixed test
across **all three projects** to confirm:

| Project | Result |
|---|---|
| chromium | ✓ pass, 12.0s (first attempt) |
| Mobile Chrome | ✓ pass, 12.8s (first attempt) |
| Mobile Safari (WebKit) | ✓ pass — one first-attempt 45s timeout, passed on retry (13.3s); then **3/3 clean in isolation** at ~12–13s |

The suite is green (`retries: 1` absorbs the flake). The single Mobile Safari
first-attempt timeout is **intermittent WebKit welcome-delivery timing**, not a
regression in the fix: the same test passes cleanly the large majority of runs
and 3/3 when run alone. This matches the previously-documented WebKit / NIP-46
welcome-delivery timing flakiness class (see project memory
`project_e2e_nip46_connect_race`, `project_multicontext_e2e_blanking`) — a
pre-existing harness characteristic, not specific to this test. No further
action taken; noted for the record.
