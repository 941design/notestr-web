# MLS Leaf Identity UX — Acceptance Criteria

## Terminology

- **leaf identity** — the MLS private key material in `notestr-key-packages`
  IDB store. Distinct per browser session.
- **slot** — the `d` tag identifier on a kind-30443 KeyPackage event;
  derived from `clientId` from `notestr-identity` IDB store.
- **failed welcome** — a kind-1059 gift wrap addressed to the user that
  decrypted into a kind-444 Welcome which `joinGroupFromWelcome` could not
  accept.
- **Pending Invitations panel** — the UI surface listing failed welcomes,
  whether located in Settings, in a dedicated drawer, or in a notification
  surface (to be settled at design time).
- **record key** — the dedup identity for a `FailedWelcomeRecord`. For
  join-failure records (path via `joinFromWelcomeInvite`), the record key is
  `invite.id` (the Rumor ID), stored in the `giftWrapEventId` field, because
  the outer kind-1059 event ID is not available at catch time. For
  decrypt-failure records (path via `inviteReader.on("error")`), the record
  key is the actual kind-1059 event ID, also stored in `giftWrapEventId`.
  Both are suitable as a stable dedup key; callers MUST treat the field as
  an opaque record identifier, not assume it is always a gift-wrap event ID.

## Failed-Welcomes IDB Log (S1)

**AC-LOG-1** — When `joinFromWelcomeInvite` catches an error from
`client.joinGroupFromWelcome`, the implementation MUST append a
`FailedWelcomeRecord` to the new `notestr-failed-welcomes` IDB store with
`{recordedAt, giftWrapEventId, innerKind, inviterPubkey, groupId, kpRef,
failureReason, failureDetail}` populated from the available decrypted
rumor + caught error. The `appendFailedWelcome()` call MUST occur before
`inviteReader.markAsRead(invite.id)` — after mark-as-read the invite will
not be replayed. If the rumor was not decryptable, `groupId` and `kpRef`
MAY be null and `failureReason` MUST be `"decrypt_failed"`.

**AC-LOG-2** — When `inviteReader.on("error", …)` fires for an undecryptable
gift wrap, the implementation MUST append a `FailedWelcomeRecord` with
`failureReason="decrypt_failed"` and `giftWrapEventId` set to the `eventId`
argument supplied by the error callback (which IS the kind-1059 event ID in
this path).

**AC-LOG-3** — Records MUST be unique by the `giftWrapEventId` field (which
holds `invite.id` for join-failure records and the kind-1059 event ID for
decrypt-failure records — see Terminology §"record key"). Re-processing the
same invite or gift wrap MUST NOT create a duplicate entry; it MUST overwrite
the existing record or be a no-op.

**AC-LOG-4** — A custom DOM event `notestr:failed-welcomes-changed` MUST
fire after every append, dismiss, or prune so subscribed UI components can
refresh without polling.

**AC-LOG-5** — `pruneOlderThan(30 * 86400 * 1000)` MUST run once per
MarmotProvider mount to keep the store bounded.

## Pending Invitations Panel (S2)

**AC-UI-1** — A user-reachable surface (Settings tab, header
notification, or equivalent — implementer's choice) MUST render the
contents of `loadFailedWelcomes()`. The surface MUST be discoverable from
the main app navigation in no more than two clicks.

**AC-UI-2** — Each rendered failed welcome MUST display: inviter pubkey
(short form acceptable), group name (if available from the decrypted
rumor), human-readable failure reason, and ONE concrete recovery
instruction (see spec §"Cold-recovery prompt text").

**AC-UI-3** — Each rendered failed welcome MUST have a dismiss action.
The dismiss action MUST call `forgetFailedWelcome(giftWrapEventId)` and
refresh the panel. Additionally, for records with `failureReason =
"decrypt_failed"`, the dismiss action MUST also call
`inviteReader.markAsRead(giftWrapEventId)` because this failure path does
not call `markAsRead` at record-creation time (unlike the join-failure path
which calls `markAsRead` in the catch block before appending the record).

**AC-UI-4** — When `loadFailedWelcomes()` returns zero records, the panel
MUST render an empty state ("No pending invitations") rather than not
rendering.

## Identity Transparency Panel (S3)

**AC-IDENT-1** — Settings MUST include an "Identity" surface displaying:

  - The current device's `clientId` (from `client.keyPackages.clientId`),
    rendered copy-friendly (button to copy to clipboard).
  - This device's current KP `d` slot (the same `clientId`, or whatever
    `keyPackageSlot()` returns for the current device's published KP),
    rendered copy-friendly.
  - Per published kind-30443 event for the current slot: `{event_id,
    relays_where_published, created_at}`.

**AC-IDENT-2** — The same surface MUST list *observed sibling slots* —
every `d` slot seen in kind-30443 events authored by the current pubkey
that is NOT the current device's slot. For each: `{d_slot, latest_event_id,
latest_created_at, relays_seen_on, is_in_group: bool}`. The
`is_in_group` flag MUST be true iff any loaded `MarmotGroup` has a leaf node
whose KeyPackage equals the slot's published KP (reuse
`groupHasKeyPackageLeaf` from `device-sync.ts`).

**AC-IDENT-3** — The surface MUST include short explainer text
clarifying that each device is a separate MLS identity (≤3 sentences,
plain language, no protocol jargon).

## Signin-Time Probe (S4)

**AC-PROBE-1** — On the first MarmotProvider mount after signin where
`lastProbeAt` is absent from `notestr-identity` IDB store, or
`lastProbeAt < now - 24h`, the implementation MUST:

  1. After `setState({ loading: false })` — not before, not blocking the
     critical path — launch a background IIFE (no `await` in the main
     init sequence).
  2. Fetch `{kinds: [1059], "#p": [pubkey], since: now - 14*86400}` from
     `DEFAULT_RELAYS` and compute a count of gift wraps in that window.
  3. Compare with `(await loadFailedWelcomes({ since: (now - 14*86400) *
     1000 })).length`. If the fetched wrap count materially exceeds the
     sum of failed-welcome records and currently-loaded groups in that
     window, surface a one-time inline banner (NOT a toast — no toast
     library exists; use the inline banner pattern from
     `DevicesTab.tsx:274-288`, `aria-live="polite"`) reading "You have N
     invitations to groups this device hasn't accepted. Open Pending
     Invitations to see them." with a CTA linking to the Pending
     Invitations panel.
  4. Set `lastProbeAt = now` in `notestr-identity` IDB store in all cases
     (whether the banner was shown or not).

**AC-PROBE-2** — The probe MUST NOT block MarmotProvider's `loading:
false` transition. It MUST run entirely in the background after the
provider's critical path completes.

## NIP-46 Perms Correctness (S5)

**AC-PERMS-1** — The `perms` string passed to `NDKNip46Signer.nostrconnect`
in `src/lib/nostr.ts:167` MUST NOT contain `sign_event:31337` (the
placeholder leetspeak token). It MUST be a comma-separated list of the
form `sign_event:{kind}` for every kind the application asks the signer
to sign, plus `nip44_encrypt,nip44_decrypt`.

**AC-PERMS-2** — The enumerated kind set MUST cover every distinct
literal kind passed to any `signer.signEvent(...)` call across the
codebase, including kinds signed by NDK internally on the app's behalf
(e.g. kind 22242 for NIP-42 AUTH). An automated check (a unit test
scanning the source tree for literal kinds passed to signing helpers, or
an enforcement pattern in review) is acceptable; manual audit at
implementation time, documented in the architect retro, is acceptable.
The complete enumeration MUST appear in `src/lib/nostr.ts` (not split
across files).

## Forget-on-Signout (S6)

**AC-SIGNOUT-1** — `handleDisconnect` in `app/page.tsx` MUST offer a
"forget this device on the network" option (implemented via the
`AlertDialog` confirmation pattern from `DevicesTab.tsx:350-384`, or an
equivalent two-path confirmation UX). The forget path MUST invoke the
existing `forgetSelfDevice` from `src/marmot/forget-device.ts` before
nulling `signer`/`pubkey` state.

**AC-SIGNOUT-2** — The non-forget path MUST behave exactly as today: null
signer/pubkey state, clear NIP-46 session if applicable, no
network-visible side effects on KP / leaf state.

**AC-SIGNOUT-3** — The signout flow MUST be reachable from the same
location it is reachable from today (Settings → Sign out button); no
regression of existing access patterns.

## Cross-Cutting Invariants

**AC-OBS-1** — All new IDB stores (`notestr-failed-welcomes` and any
others) MUST be scoped to the current origin (default IDB behavior — no
explicit cross-origin sharing). The new store MUST be added to
`KNOWN_IDB_NAMES` in `e2e/fixtures/cleanup.ts`.

**AC-OBS-2** — The Identity, Pending Invitations, and signin probe
surfaces MUST be no-ops when no signer is connected (the connect screen
path). No errors thrown, no UI artifacts in the unauthenticated state.

**AC-OBS-3** — Existing unit tests MUST continue to pass. `make test` is
the entry point. New unit tests MUST cover at minimum:

  - `failed-welcomes.ts` append/load/dismiss/prune round-trip (including
    the dedup invariant from AC-LOG-3).
  - The `lastProbeAt` storage and gating logic from AC-PROBE-1 (the probe
    runs when absent or stale; does not run when fresh).
  - The perms enumeration matches the live `signEvent` call set
    (mechanical audit; spec §"perms list" enumerates the expected set).

**AC-OBS-4** — No new external dependencies. The implementation uses
only modules already in `package.json`.

## Manual Validation

- After deploy, open the prod build in a fresh browser (Playwright or
  incognito). Sign in via NIP-46 bunker. Confirm the Identity panel shows
  the new clientId / slot. Confirm Pending Invitations is empty (or
  reflects whatever real state exists).
- From notestr-cli (assuming it has implemented its parallel
  feature-request items, OR using a manual `invite <npub>` while a stale
  KP is the newest), trigger a failed-join. Confirm the failure appears
  in the Pending Invitations panel within ~10s of the gift wrap arriving.
  Confirm the recovery-instruction text is accurate and copy-pasteable.
- Sign out via the "forget this device" path. Confirm the cli observes
  a kind-5 deletion + per-leaf-remove for this device's slot (cross-check
  via cli REPL or `nak`).
