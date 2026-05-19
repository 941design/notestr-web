# MLS Leaf Identity UX

## Problem

notestr-web presents a single Nostr identity to the user (their npub), but
under the hood every browser session — every distinct IndexedDB — is a
**separate MLS leaf** with its own private key material. Group membership is
bound to a specific leaf, not to the Nostr pubkey. The user has no mental
model of this distinction, and the application surfaces nothing that would
build one. The consequences range from confusing (groups appear on one
device and not another) to data-losing (clearing IndexedDB silently destroys
all group memberships forever, with no recovery path other than re-invite).

A live debug session against the prod build (commit `8d5fb5e`) confirmed the
shape of the failure: a group created in `notestr-cli` and Welcomed to this
user's npub never surfaced in their browser, despite 40+ kind-1059 gift
wraps reaching the welcome subscription and 15+ of those decrypting
successfully into kind-444 Welcomes. Every Welcome failed `marmot-ts`'s
`joinGroupFromWelcome` with `"No matching secret found"` because the
inviting client (cli) had picked an older or sibling-device KeyPackage whose
private material isn't in *this* browser's IDB. The user's primary browser,
operating under the same npub, was equally unable to join — different IDB,
different leaf material — and the failure was invisible: no UI, no toast,
no settings panel listing the pending invite. The user only knew "the group
isn't there."

This epic exists to make leaf identity a first-class concept in the UI, to
make failed joins visible and recoverable, and to close the silent-failure
surfaces that turned a 2-minute diagnostic into a 3-hour live debug session.

It does not attempt to fix the underlying protocol mismatch (each
browser/IDB is a separate leaf by design — that is MLS, and we are not
changing MLS). It instead bridges the gap with observability, recovery
prompts, and disciplined lifecycle management.

## Solution

Six independent changes, each useful on its own, jointly making the system
robust against the failure modes the debug session surfaced:

1. **Persistent failed-welcomes log** in IndexedDB, with a visible
   "Pending Invitations" panel listing decryptable kind-444 Welcomes the
   device cannot join — with the inviter's pubkey, target KP ref, time, and
   reason.
2. **Identity transparency panel** in Settings showing this device's
   clientId, its KP `d` slot, the events published per relay, and known
   sibling slots observed from the network.
3. **Cold-recovery prompts** rendered inside the Pending Invitations panel
   with concrete actionable text ("ask the inviter to re-invite this
   device's current KP slot…").
4. **Probe-on-signin scan** counting how many addressable-to-us kind-1059
   gift wraps contain undecryptable-by-us Welcomes; if non-zero, surface a
   one-time "you have N pending invitations this device can't accept"
   prompt.
5. **NIP-46 perms list correctness** — replace the leetspeak placeholder
   `sign_event:31337` in `src/lib/nostr.ts:167` with an enumerated list of
   every kind notestr-web signs, so the app works on stricter bunkers, not
   only on permissive nsec.app.
6. **Forget-on-signout flow** that publishes a kind-5 deletion request and
   a per-leaf-remove for the current device's KP and any in-group leaves
   when the user signs out, so dead leaves are not available to poison
   future invite selection.

## Scope

### In Scope

- New IndexedDB tables: `notestr-failed-welcomes`, possibly
  `notestr-identity-meta` for derived sibling-slot observations.
- New UI surfaces: Settings → "Identity" tab (or extension of existing
  Devices tab from `epic-multi-device-sync`); a "Pending Invitations"
  panel in either Settings or the main board area (TBD by design).
- Modifications to `src/lib/nostr.ts:159–209` (the `startNostrConnect`
  perms list).
- Modifications to `src/marmot/device-sync.ts:484–509` (the
  `inviteReader.on("error", …)` handler) and `joinFromWelcomeInvite` to
  capture the failure surface in IDB.
- Modifications to `src/marmot/client.tsx` for the signin-time probe.
- Modifications to the existing forget-device flow
  (`src/marmot/forget-device.ts`) to also fire on explicit signout.

### Out of Scope

- Any protocol-level change to marmot-ts, MIP, or MLS. This epic is
  notestr-web only.
- The notestr-cli side of the same failure cluster — handled by a parallel
  feature request to that project (filed in
  `notestr-cli-feature-requests/`).
- Server/relay-level fixes (purplepag.es rejecting kind-30443, etc.). The
  relay landscape is what it is; this epic adapts to it.
- A fundamental redesign of the multi-device experience (e.g. deterministic
  leaf-secret derivation from the nostr nsec) — that is a research
  direction tracked elsewhere.
- A mechanical "re-invite from web" button. Web clients are not group
  admins for cli-created groups; re-invite has to come from the admin
  client. The UI's job here is to TELL the user what to ask for, not
  perform it.

## Design Decisions

1. **Surface failed welcomes immediately, not eventually.** The single
   highest-yield change in this epic. The current `console.debug`-only
   path is invisible to users and hard to retrieve from a deployed PWA
   ("open DevTools" is not a real recovery instruction for a non-technical
   user). An IDB-backed log + UI panel makes the system self-documenting
   the moment a failure happens. Refs: `src/marmot/device-sync.ts:484,
   509–512` (existing silent paths).

2. **Identity panel reads from observable state, not synthesized models.**
   The "Identity" UI surfaces facts already in the system —
   `client.keyPackages.list()`, `client.groups.loaded`, IDB entries —
   formatted for human consumption. No new state is introduced; this is a
   pure rendering / observability surface. That keeps it cheap to build
   and avoids divergence from canonical state.

3. **Cold-recovery prompts are advisory, not actuated.** The web cannot
   force a re-invite because it isn't admin of these groups. Prompts must
   produce *actions the user takes elsewhere* (open another browser, ask
   the cli operator to re-invite). Phrasing matters here; vague text
   creates more support questions than no text.

4. **Probe-on-signin gates on history, not subscription liveness.** The
   probe runs once, on the first MarmotProvider mount after signin, against
   a `since` window of the last 14 days. Counting undecryptable Welcomes
   in that window is a one-shot diagnostic — the probe does not subscribe
   indefinitely just to keep counting. The live failed-welcomes log
   handles the steady-state surface.

5. **Perms list fix is mechanical and isolated.** Single edit to a single
   line. Treat as a bug fix, not a feature; ship in this epic for
   convenience, but it could equally live in a one-line PR. Refs:
   `src/lib/nostr.ts:167`.

6. **Forget-on-signout reuses the existing forget-device pipeline.** Story
   builds on `epic-forget-this-device` rather than duplicating its
   primitives. The new trigger is the signout button (and the analogous
   `handleDisconnect` path in `app/page.tsx:222–234`); the publish path
   (kind-5 delete + per-leaf-remove + KP slot cleanup) is the same
   primitive already shipped.

## Technical Approach

### `src/marmot/failed-welcomes.ts` (new module)

IDB-backed log of join failures. Schema:

```ts
interface FailedWelcomeRecord {
  recordedAt: number;            // unix ms
  giftWrapEventId: string;       // kind-1059 event id
  innerKind: number;             // observed inner rumor kind (444 if decryptable Welcome)
  innerCreatedAt: number;        // inner rumor created_at (real time, not gift wrap randomized)
  inviterPubkey: string | null;  // from the seal; null if seal-decrypt failed
  groupId: string | null;        // from the Welcome rumor if decryptable
  kpRef: string | null;          // hex-encoded keyPackageRef the Welcome targets
  failureReason: string;         // e.g. "no_matching_kp", "ciphersuite_mismatch", "decrypt_failed"
  failureDetail: string;         // free-form error text from marmot-ts
}
```

API:

- `appendFailedWelcome(record): Promise<void>` — used from
  `joinFromWelcomeInvite` catch branch and from `inviteReader.on("error")`.
- `loadFailedWelcomes(opts?: { since?: number; limit?: number }): Promise<FailedWelcomeRecord[]>` — backs the UI.
- `forgetFailedWelcome(giftWrapEventId): Promise<void>` — dismiss action.
- `pruneOlderThan(ms): Promise<void>` — called on mount, keeps the store
  bounded (default 30-day window).

### `src/marmot/device-sync.ts` changes

`joinFromWelcomeInvite` (line ~410) currently swallows errors:

```ts
} catch (err) {
  console.debug("[device-sync] join from welcome failed:", err);
  await inviteReader.markAsRead(invite.id);
  return null;
}
```

Replace with: capture the error, persist a `FailedWelcomeRecord`, dispatch
a custom DOM event (`notestr:failed-welcomes-changed`) so the UI panel can
refresh. Mark the invite as read iff the error class is one the user must
re-invite around (no matching secret, ciphersuite mismatch); leave it
unread for transient errors that may resolve on retry.

The `inviteReader.on("error", …)` handler (line ~484) also persists a
record (with `failureReason="decrypt_failed"`).

### `src/components/PendingInvitations.tsx` (new)

Lives in Settings → new "Pending Invitations" subsection (or a dedicated
modal entry from a bell-icon in the main header — designer's call). Lists
records from `loadFailedWelcomes`, each with:

- Inviter pubkey (resolved to NIP-05 / name if available).
- Group name if the rumor was decryptable (it is for `no_matching_kp` —
  the Welcome itself unwrapped fine, we just couldn't join).
- Failure reason in human terms.
- One concrete next-step instruction (see "Cold-recovery prompt text"
  below).
- Dismiss button (calls `forgetFailedWelcome`).

### `src/components/SettingsModal.tsx` — Identity tab additions

Extend the existing Settings UI with an "Identity" surface showing:

- This device's clientId (from `client.keyPackages.clientId`).
- This device's current KP `d` slot, KP event ids per relay, last publish
  time.
- A list of *observed sibling slots* derived from the `knownEvents` map
  in `device-sync.ts:runKeyPackageSync` (line ~1060): for each kind-30443
  event for the user's pubkey, show `{d_slot, event_id, created_at,
  relays_present}`, mark which slot is this device, mark which slots are
  in known groups, mark which slots have been observed as failed-welcome
  targets.
- A small explainer: "Each device has its own MLS identity. Groups are
  invited per-device. If a group is missing on this device, the inviter
  may need to re-invite this device's slot. Show the device's slot
  prominently and copyable."

### `src/lib/nostr.ts:167` — perms list

Current:

```ts
perms: "sign_event:31337,nip44_encrypt,nip44_decrypt",
```

Replace with the actual signed-kind set. Audit via `grep`-ing
`signEvent\(` and `nip44\.(en|de)crypt` across `src/` to verify the
enumeration is exhaustive.

**Implemented set (verified in S5, see `src/lib/nostr.ts:NIP46_PERMS`):**

```ts
"sign_event:5,sign_event:13,sign_event:10051,sign_event:22242,sign_event:30078,sign_event:30443,nip44_encrypt,nip44_decrypt"
```

Key correction from the spec's draft list: kinds 443, 444, 445, 0, 1059
are NOT signed by the user's signer. Kind 443 is legacy and query-only;
kind 444 is an unsigned rumor (NIP-59 design); kind 445 uses an ephemeral
key via `finalizeEvent`; kind 1059 (gift wrap) also uses an ephemeral key.
Kind 13 (NIP-59 Seal) is the actual kind the user's signer signs when
marmot-ts sends welcome invitations, routed through applesauce-common's
gift-wrap pipeline.

### Signin-time probe

In `src/marmot/client.tsx`, after MarmotProvider's `init()` completes and
before declaring `loading: false`, run an additional one-shot:

```ts
const since = Math.floor(Date.now() / 1000) - 14 * 86400;
const wraps = await client.network.request(relays, [
  { kinds: [1059], "#p": [pubkey], since },
]);
const failedCount = (await loadFailedWelcomes({ since: since * 1000 })).length;
// If the wraps count is materially larger than failedCount + currently-loaded groups,
// we may be missing invites. Surface a one-time toast / panel.
```

Refine the heuristic at implementation time — exact predicate TBD by the
verification examiner. The point is: scan and surface, not silently drop.

### Forget-on-signout

`handleDisconnect` in `app/page.tsx:222–234` currently sets signer/pubkey
to null without any group-state cleanup. Wire a call to the existing
`forgetSelfDevice` (`src/marmot/forget-device.ts`) so the device's KP and
in-group leaves are properly decommissioned. Gate behind a confirmation
("Sign out and forget this device on the network? You will need to be
re-invited to your groups when you sign in again on this device."). The
plain signout flow (no cleanup) should still exist as an alternative
("Sign out without forgetting") for users who plan to come back to this
browser session.

### Cold-recovery prompt text (for the Pending Invitations panel)

Per failure-reason class:

- `no_matching_kp` — "You were invited to **{group name}** by **{inviter
  pubkey shortened}**. This device's MLS identity doesn't match the
  invitation. To accept: either (a) open the device you originally signed
  in on around **{invite timestamp}**, or (b) ask the inviter to re-invite
  your current device — they can run `invite --device {clientId}` from
  notestr-cli."
- `ciphersuite_mismatch` — "You were invited to **{group name}** using a
  ciphersuite this device does not support. Update notestr-web or ask the
  inviter to use a compatible ciphersuite."
- `decrypt_failed` — "An invitation arrived that this device couldn't
  decrypt. This usually means the gift wrap was malformed or your signer
  is unavailable. Try refreshing the page."

The exact strings are the implementer's call but should preserve the
structure: what happened, what the user can do.

## Stories

- **S1 — Failed-welcomes IDB log + DOM event surface**. The data layer:
  new `src/marmot/failed-welcomes.ts`, wire it into
  `joinFromWelcomeInvite` and `inviteReader.on("error")`. Covers
  AC-LOG-1..4.
- **S2 — Pending Invitations panel**. The UI consumer of S1, with
  cold-recovery prompts. Covers AC-UI-1..3.
- **S3 — Identity transparency in Settings**. Read-only panel showing
  this device's clientId, KP slot, sibling-slot observations. Covers
  AC-IDENT-1..3.
- **S4 — Signin-time probe + one-time prompt**. The "you have N pending
  invitations" detection on first MarmotProvider mount. Covers
  AC-PROBE-1..2.
- **S5 — NIP-46 perms list correctness**. Single-line fix in
  `src/lib/nostr.ts:167`, audit verifying the enumeration is exhaustive.
  Covers AC-PERMS-1..2.
- **S6 — Forget-on-signout flow**. Hook the existing forget-device
  pipeline into `handleDisconnect`. Covers AC-SIGNOUT-1..2.

## Acceptance Criteria

See [`acceptance-criteria.md`](./acceptance-criteria.md).

## Relationship to Other Epics

- `epic-forget-this-device` — S6 of this epic extends that epic's
  decomission primitives to the signout trigger.
- `epic-multi-device-sync` — the Identity panel in S3 likely shares
  surface area with that epic's Devices tab; coordinate.
- `epic-identity-scoped-group-and-task-visibility` — orthogonal scope
  but adjacent semantics; check for overlap during planning.
- `epic-nip42-relay-auth` — the precondition for any of this working
  at all in production (we receive gift wraps from AUTH-gated relays now;
  this epic makes those wraps non-silent).

## Non-Goals

- Eliminating the per-leaf identity model. MLS is per-leaf by design.
- Automatic cross-device leaf migration. Out of band research direction.
- Multi-device fanout from the web (the web is not group admin; that
  responsibility belongs to the admin client, currently notestr-cli).
- Per-relay AUTH troubleshooting UI. The NIP-42 wiring works or it
  doesn't; if it doesn't, that's a separate epic.

## Amendments

- **2026-05-19 — NIP-46 perms kind list corrected (S5 implementation).**
  The Technical Approach section's draft perms list included kinds 443,
  444, 445, 0, and 1059. S5 implementation verified none of these are
  signed by the user's signer: 443 is query-only, 444 is an unsigned
  NIP-59 rumor, 445 uses an ephemeral key, 1059 uses an ephemeral key,
  and 0 was a precautionary inclusion that is not exercised. The correct
  user-signer kinds are 5, 13, 10051, 22242, 30078, 30443. Kind 13
  (NIP-59 Seal) was missing from the draft list — it is the kind signed
  when marmot-ts sends welcome invitations via applesauce-common's
  gift-wrap pipeline. Authoritative source: `src/lib/nostr.ts:NIP46_PERMS`
  with inline per-kind comments. Verified by reading marmot-ts
  `dist/client/group/marmot-group.js` and `applesauce-common/dist/operations/gift-wrap.js`.
