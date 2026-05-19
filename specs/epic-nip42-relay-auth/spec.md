# NIP-42 Relay AUTH

## Problem

Welcome-grade public relays (notably purplepag.es, offchain.pub, and
plausibly others in the prod relay set) gate kind-1059 gift-wrap reads
behind NIP-42 AUTH. The current notestr-web NDK instance is constructed as
`new NDK({ explicitRelayUrls: relays })` (`src/marmot/client.tsx:151`)
with no `signer` and no `relayAuthDefaultPolicy`, so when one of these
relays sends an AUTH challenge the client silently does nothing and the
subscription returns zero events.

The user-visible symptom is the one documented in
`notestr-web-group-discovery-report.md`: a group created in `notestr-cli`
and a Welcome published to the public relay set never surfaces in
notestr-web, despite the same NIP-46 bunker identity. Unauthenticated
`nak` probes against all 4 of the cli's group relays returned zero
kind-1059 events while the cli's own subscription captured the loop-back
— strong evidence at least one relay requires AUTH for gift-wrap reads,
and notestr-web cannot respond.

The same blind spot applies to every other AUTH-gated read notestr-web
issues: kind-30443 (addressable key packages from sibling devices),
kind-10051 (key-package relay lists), kind-30078 (encrypted task
snapshots). Any one of these silently truncating breaks cross-device
group membership.

## Solution

Wire a small adapter between the signed-in `EventSigner` (from
`applesauce-core`, used by both NIP-07 and NIP-46 paths) and NDK's
`NDKSigner` interface. After NDK is constructed, set `ndk.signer` to that
adapter and install `NDKAuthPolicies.signIn({ ndk })` as the default
relay auth policy. NDK then responds to incoming AUTH challenges by
signing a kind-22242 AUTH event with the user's signer, the relay
accepts it, and any subsequent REQ on that relay returns the events the
user is entitled to.

Behavior is fully a no-op against relays that never challenge — the
existing e2e strfry on `ws://localhost:7777` stays unaffected. AUTH must
not block initial relay connection; NDK already handles AUTH as a
follow-on to connect, but the contract is explicit here: connect timeout
stays at the existing 4 s.

## Scope

### In Scope

- Adapter `EventSigner → NDKSigner` (or use a stock NDK adapter if one
  fits — verified during implementation).
- Wire `ndk.signer` and `ndk.relayAuthDefaultPolicy =
  NDKAuthPolicies.signIn({ ndk })` immediately after `new NDK(...)` in
  `src/marmot/client.tsx`.
- Unit test verifying NDK is constructed with the signer + policy when
  a signer is in scope.
- Manual smoke-test post-deploy: log in to the prod build, observe
  whether the previously-invisible `cli` group surfaces. (Manual; not an
  automated AC.)

### Out of Scope

- NIP-65 / kind-10051 relay discovery on signin (separate follow-up —
  the report's §5.2).
- Failed-welcomes IDB log + debug panel (separate follow-up — the
  report's §5.5).
- Surfacing the relay set in Settings (separate follow-up — overlapping
  the report's §5.2).
- An e2e test against a strfry instance configured with `requireAuth =
  true`. The existing e2e infrastructure runs an open ephemeral relay
  per `docker-compose.e2e.yml`; spinning up a second AUTH-required
  variant is a meaningful infra change and belongs in its own epic.
- AUTH against the bunker's own NIP-46 relay. The bunker session uses a
  separate NDK instance inside `src/lib/nostr.ts`; this epic only
  touches the MarmotProvider's NDK instance. If bunker-relay AUTH
  surfaces as an issue, it gets its own epic.

## Design Decisions

1. **Adapter layer over `EventSigner`, not a direct dependency on
   `applesauce-core` in NDK's adapter type.** The `EventSigner` API
   exposes `getPublicKey()` and `signEvent(template)`; NDK's `NDKSigner`
   interface (declared around lines 449–525 of
   `node_modules/@nostr-dev-kit/ndk/dist/index.d.ts`) uses a slightly
   different shape. A thin adapter class keeps the dependency direction
   one-way and means NDK never sees the EventSigner type. Refs:
   `src/marmot/client.tsx:151`.

2. **`NDKAuthPolicies.signIn({ ndk })` over a custom policy.** The stock
   `signIn` policy is the documented happy-path for NIP-42: it signs a
   kind-22242 with the configured `ndk.signer`. Custom policies make
   sense only when filtering relays or rate-limiting AUTH; we want every
   relay that asks to get AUTH. Refs:
   `node_modules/@nostr-dev-kit/ndk/dist/index.d.ts:3447` (`signIn`).

3. **Gate AUTH wiring on `signer != null`.** The connect screen mounts
   the page before any signer exists; MarmotProvider is only mounted
   under `if (!pubkey) { ...connect ui... } else { <MarmotProvider .../> }`
   in `app/page.tsx:237/424`. By construction MarmotProvider always
   receives a non-null signer, but the AUTH wiring is still defensive:
   if NDK ever gets constructed without a signer, it must not install an
   auth policy that has nothing to sign with. Refs: `app/page.tsx:424`.

4. **AUTH does not change connect timeout.** `NDK_CONNECT_TIMEOUT_MS`
   (4 s) gates the initial connect, not AUTH. NDK runs AUTH as a
   follow-on after connect completes; the existing timeout stays.
   Refs: `src/config/relays.ts:19`, `src/marmot/client.tsx:153`.

5. **No behavior change against open relays.** Relays that never send
   AUTH challenges see no kind-22242 from the client. The existing e2e
   suite runs against an open strfry on `ws://localhost:7777` and must
   stay green. Refs: `docker-compose.e2e.yml`, `e2e/`.

## Technical Approach

### `src/marmot/client.tsx`

Two additions, both at NDK construction time inside the `init` callback:

1. After `import NDK, { NDKEvent, NDKRelay, NDKRelaySet } from
   "@nostr-dev-kit/ndk";` add `NDKAuthPolicies` (and `type NDKSigner` if
   needed for the adapter type, plus any signer-payload type required by
   the adapter `sign` signature).
2. Define a small adapter — class `EventSignerNdkAdapter` wrapping the
   in-scope `EventSigner` — implementing the **full** `NDKSigner`
   surface. The mandatory members and how the adapter implements each
   (verified against
   `node_modules/@nostr-dev-kit/ndk/dist/index.d.ts:453–513`):

   - `get pubkey(): string` — returns the hex pubkey passed in at
     construction. Synchronous getter, NOT a `getPublicKey()` method.
   - `get userSync(): NDKUser` — returns an `NDKUser` keyed to that
     pubkey.
   - `blockUntilReady(): Promise<NDKUser>` — resolves to the same
     `NDKUser`. (Called by `NDKAuthPolicies.signIn` before signing.)
   - `user(): Promise<NDKUser>` — same as `userSync` but async-shaped.
   - `sign(event): Promise<string>` — delegates to the wrapped
     `EventSigner.signEvent(event)` and returns the resulting `sig`
     field. (The exact return shape — full signed event vs. just the
     signature — is determined by checking
     `node_modules/@nostr-dev-kit/ndk/dist/index.d.ts:4034` at
     implementation time; the spec assertion is that whatever the
     signature is, it comes from the wrapped `EventSigner`.)
   - `encrypt()` / `decrypt()` — MUST throw an explicit
     "not implemented" error. The `signIn` policy never calls these;
     a future caller that lands on them should get a loud failure
     rather than a silent falsy value.

3. After `const ndk = new NDK({ explicitRelayUrls: relays });`:

   ```ts
   if (signer) {
     ndk.signer = new EventSignerNdkAdapter(signer, pubkey);
     ndk.relayAuthDefaultPolicy = NDKAuthPolicies.signIn({ ndk });
   }
   ```

### Adapter unit test

Strategy is fixed by AC-TEST-1: **direct adapter unit test**, no NDK
constructor mocking. Implementation MAY place the adapter and its test
in one of:

- The adapter class declared inline in `client.tsx` and the test in a
  new file `src/marmot/event-signer-ndk-adapter.test.ts`, with the
  class also exported from `client.tsx` for the test. **Or:**
- The adapter lifted into a small co-located module
  `src/marmot/event-signer-ndk-adapter.ts` with the test alongside.

Either layout is acceptable. AC-OBS-1 permits "co-located test
file(s)" — a sibling module under `src/marmot/` counts.

The test MUST cover the three concrete assertions in AC-TEST-1
(`pubkey` getter, `blockUntilReady()` resolving to the right `NDKUser`,
`sign()` round-trip through a stub `EventSigner`). The wiring ACs
(WIRE-1 / WIRE-2) are verified by inspection of the small
`client.tsx` block.

## Stories

- **S1 — Add NIP-42 AUTH to MarmotProvider's NDK** — single story.
  Add the adapter, wire `ndk.signer` + `relayAuthDefaultPolicy` after
  NDK construction, and ship a unit test. Covers AC-WIRE-1, AC-WIRE-2,
  AC-WIRE-3, AC-GUARD-1, AC-NOOP-1, AC-TIMEOUT-1, AC-TEST-1, AC-OBS-1,
  AC-OBS-2.

Single story by deliberate choice — the change is self-contained inside
`src/marmot/client.tsx`, the adapter is small, and splitting wiring
from adapter would create artificial sequencing.

## Acceptance Criteria

See [`acceptance-criteria.md`](./acceptance-criteria.md).

## Relationship to Other Epics

- `epic-mls-live-delivery-race` — that epic addresses delivery races
  AFTER events reach the client; this epic addresses events not reaching
  the client at all on AUTH-gated relays. Complementary.
- Three follow-up epics flagged in the discovery report (NIP-65/10051
  discovery, failed-welcomes IDB log, Settings relay-set UI) remain
  unimplemented and out of scope here.

## Non-Goals

- Building a generic, multi-policy relay auth abstraction. The
  `signIn({ ndk })` policy is sufficient and stock; no abstraction layer
  is warranted.
- Bypassing or replacing NDK's NIP-42 implementation. We use what NDK
  ships.
- AUTH for the NIP-46 bunker session relay. Different NDK instance,
  different concern, not in scope.
