# Bug Report: Same-identity multi-device — the web never sends the task-state snapshot when it AUTO-invites a sibling device, so a second device of the same npub starts from an empty board

## Status

Open. Filed 2026-05-27. **Symptom reproduced and root-caused** by a same-identity
cross-implementation reproduction (notestr-web ↔ notestr-cli/daemon, one npub on
two devices). The fix is **web-side only** — notestr-cli already performs the
equivalent snapshot publish when it auto-admits a sibling device. Verification
must run through the parent workspace (see "How this was found / cross-check").

## Summary

When the same Nostr identity (npub) is used on two devices — e.g. **notestr-web**
in the browser and **notestr-cli/daemon** (the REPL) — the two devices end up
with **diverging task lists**. The MLS sibling-device admission works in both
directions (each device auto-invites the other as a new group member), but the
**history hand-off is one-sided**:

- When the **web** auto-adds the other device to a web-created group, it does
  **not** publish the kind-30078 `task.state_sync` snapshot. The newly-added
  device joins at a later MLS epoch, cannot decrypt the pre-join kind-445
  traffic (MLS forward secrecy), and therefore **never sees the tasks that
  existed in that group before it was added**.
- The **CLI** *does* publish that snapshot when it auto-admits a sibling, so the
  reverse direction (the web learning a CLI-created group's prior tasks) works
  (if slowly).

The asymmetry is the user-visible "same npub, different devices, diverging
tasks."

## Environment

- notestr-web (browser / marmot-ts) + notestr-cli/daemon (Rust / MDK), **one
  identity (one npub) on two devices**, one shared relay.
- Both clients authenticate against the same NIP-46 bunker (same key).

## Reproduction

Via the parent workspace (canonical): `e2e/same-identity.spec.ts`, which logs in
both the browser and the CLI/daemon as the **same** npub (keys.A) and walks six
"links" of the convergence chain. Run it on a **clean** relay (Playwright's retry
reuses the ephemeral relay, so retry results are contaminated by the prior
attempt's events for the same npub — read the first attempt only).

Clean-relay result:

| Link | What it checks | Result |
|------|----------------|--------|
| LINK1 | CLI device auto-joins a **web**-created group | ✅ |
| LINK2 | CLI sees tasks created in that web group **before it joined** | ❌ **(this bug)** |
| LINK3 | CLI sees a web task created **after** it joined (kind-445) | ✅ |
| LINK4 | Web sees a task the CLI creates | ✅ |
| LINK5 | Web auto-joins a **CLI**-created group | ✅ |
| LINK6 | Web sees tasks created in that CLI group before it joined | ✅ (slow) |

LINK2 fails on **every** run; LINK1/LINK5 pass on every run. So discovery /
sibling-admission is solid in both directions; only the **web→sibling history
snapshot** is missing.

## Symptoms

- A device added to a web-created group materialises an **empty board** and only
  accumulates tasks created from its join-epoch onward. Everything created
  earlier on the web is invisible to it, permanently (until a manual invite or
  some other snapshot re-publish happens).
- The reverse (CLI-created group → web) eventually converges, making the overall
  picture look like "each device has tasks the other doesn't."

## Root cause

The web has **two** invite paths and only one of them publishes the snapshot:

- **Manual invite** (`src/components/GroupManager.tsx:189-195`): calls
  `group.inviteByKeyPackageEvent(...)` **and then**
  `publishTaskStateSync(group.idStr, hex, signer, client, relays)`. ✅
- **Automatic sibling invite** (`src/marmot/device-sync.ts:1133-1183`,
  `inviteToAllGroups`): calls `group.inviteByKeyPackageEvent(kpEvent)` at
  `device-sync.ts:1171` and records dedup state — but **never calls
  `publishTaskStateSync`**. ❌

`inviteToAllGroups` is the same-identity sibling path: its key-package scan is
filtered to `authors:[pubkey]` (own pubkey), so every invitee here is another
device of the *same* npub (`inviteePubkey === pubkey`, see the joiner-suppression
check at `device-sync.ts:1153`). Because the snapshot is the **only** way a
later-epoch member can obtain pre-join task history (MLS forward secrecy blocks
decrypting earlier kind-445s — see `docs/task-protocol.md`), omitting it on this
path means same-identity devices can never reconcile history from the web side.

For contrast, notestr-cli publishes the snapshot when its key-package watcher
admits a sibling (`publish_bootstrap_for_watcher_admit`, cli
`src/commands/groups.rs` ~:3798), which is why LINK6 (cli→web history) works.

## Suggested fix

Mirror the manual path: after a **successful** auto-invite in `inviteToAllGroups`,
publish the snapshot for the invitee. Concretely, inside the `try` block at
`device-sync.ts:1169-1181`, right after `invited.add(dedupKey)` /
`persistInvitedKey(dedupKey)`:

```ts
// A sibling added at a later MLS epoch cannot decrypt pre-join kind-445
// traffic, so without this snapshot it starts from an empty board. Mirrors
// the manual-invite path in GroupManager. Non-fatal; logs internally.
void publishTaskStateSync(group.idStr, inviteePubkey, signer, client, relays);
```

Requirements / notes:
- `inviteePubkey` is already computed at `device-sync.ts:1135`
  (`getKeyPackageNostrPubkey(kpEvent)`); `group.idStr` and `client` are in scope.
  `signer` and `relays` must be threaded into `runKeyPackageSync`'s scope (the
  same values the manual path passes; available from the Marmot/client context).
- For a sibling (same npub) the snapshot is **NIP-44 self-encrypted** (own→own)
  under d-tag `notestr:task-sync:{group.idStr}:{ownPubkeyHex}`; the sibling
  device fetches and decrypts it with itself as the NIP-44 counterparty. This is
  the **same event shape** the cross-client suite's B2 block already proves the
  CLI can fetch and apply (see `publishTaskStateSync`, `device-sync.ts:1437-1495`),
  so the fix reuses an already-validated wire path — no new format.
- Publishing on the successful-invite branch (not on the dedup-skip branch) keeps
  it to one snapshot per genuine admission; kind-30078 is replaceable, so even an
  occasional duplicate is idempotent.

## Residual / secondary concern (not this bug, flag for follow-up)

Under same-identity, **both** devices auto-invite each other, churning MLS epochs
more than the simple cross-member case. Live sync (LINK3/LINK4) was green on a
clean relay but failed on Playwright's contaminated retry. The retry failures are
most likely a harness artifact (the ephemeral relay isn't wiped between retries,
so attempt 2 runs against attempt 1's leftover key packages / welcomes / group
messages for the same npub). Still, live-sync stability under mutual auto-invite
should be re-verified on a clean relay after the snapshot fix lands, rather than
assumed.

Separately: notestr-cli has an additional **continuous** same-identity
reconciliation channel ("personal-sync", kind-1059 gift-wrap, `personal-sync.*`
envelopes) that notestr-web does **not** implement. It is a CLI-only backstop and
is NOT required to fix this bug — a one-time snapshot plus normal kind-445
catch-up is sufficient for convergence. It is noted only because it explains why
cli↔cli same-identity is more robust than web↔cli, and is a candidate if a
continuous (not just join-time) web-side reconciliation is later desired.

## How this was found / cross-check via parent

Surfaced by the same-identity reproduction in the **parent workspace** (the
top-level `notestr` repo containing both `notestr-web` and `notestr-cli`):
`e2e/same-identity.spec.ts`, run from the parent (relay up →
`npx playwright test same-identity` → relay down). This is a
cross-implementation interop defect; **reproduction and fix-verification must run
from the parent**, not from notestr-web alone (pure web↔web tests cannot exercise
it — they would need a second web device, and the divergence is specifically
web↔cli over the wire).

Environment caveat that produced a false failure first: the shared macOS/Linux
tree silently replaced the Linux `notestr-daemon` binary with a macOS Mach-O one
mid-session, which presents as `daemon exited early (code 2)` with no daemon log.
Rebuild the Rust bins (`cargo build --release --bins`, with the HTTPS git rewrite)
and confirm `od -An -tx1 -N4 target/release/notestr-daemon` is `7f 45 4c 46`
(ELF) before running.

## Related

- `specs/epic-multi-device-sync/` — the multi-device design (the spec describes
  the auto-invite + snapshot intent; the auto-invite path shipped without the
  snapshot call).
- notestr-cli `specs/epic-same-identity-device-convergence/`,
  `specs/epic-invite-all-devices/`, `specs/phase7-multi-device-sync.md` — the CLI
  counterpart (which does publish the snapshot on admit).
- `notestr-cli/bug-reports/cross-client-late-join-snapshot-incompatible-report.md`
  — the cross-*member* (different-npub) snapshot bug, already fixed; this report
  is the same-*identity* (same-npub) analogue, on the web auto-invite path.
- Parent: `cross-client-findings.md` (interop findings hub).
