# NIP-42 Relay AUTH — Acceptance Criteria

## Terminology

- **NDK instance** — the `NDK` object constructed in
  `src/marmot/client.tsx` inside the `MarmotProvider` `init` callback.
- **signer** — the `EventSigner` (from `applesauce-core`) passed as a
  prop to `MarmotProvider`, originating from the NIP-07 or NIP-46
  signin path in `app/page.tsx`.
- **adapter** — the `EventSigner → NDKSigner` shim added by this epic.
- **AUTH policy** — `NDKAuthPolicies.signIn({ ndk })` exported by
  `@nostr-dev-kit/ndk`.
- **open relay** — any relay that does not send a NIP-42 AUTH
  challenge (notably the ephemeral strfry on `ws://localhost:7777`
  used by the e2e suite).
- **AUTH-gated relay** — any relay that sends a NIP-42 AUTH challenge
  before serving certain reads (e.g. `purplepag.es`, `offchain.pub`).

## NDK Wiring (S1)

**AC-WIRE-1** — After `new NDK({ explicitRelayUrls: relays })` runs in
`MarmotProvider`'s `init` callback, the NDK instance's `signer`
property MUST be set to an object adapting the in-scope `EventSigner`,
such that `ndk.signer.pubkey` synchronously returns the hex pubkey the
provider was given as its `pubkey` prop. (`NDKSigner.pubkey` is a
synchronous getter — `get pubkey(): string` — per
`node_modules/@nostr-dev-kit/ndk/dist/index.d.ts:460`; do not confuse it
with `EventSigner.getPublicKey()`, which is the source-side method the
adapter wraps.)

**AC-WIRE-2** — After construction, the NDK instance's
`relayAuthDefaultPolicy` MUST be set to the value returned by
`NDKAuthPolicies.signIn({ ndk })` (or behave indistinguishably from it
— same identity check OR a function reference produced by passing the
NDK instance to `NDKAuthPolicies.signIn`).

**AC-WIRE-4** — `ndk.signer` and `ndk.relayAuthDefaultPolicy` MUST both be
set **before** `ndk.connect(NDK_CONNECT_TIMEOUT_MS)` is awaited in the
`init` callback. Setting them after `connect()` opens a race window
where an AUTH challenge can arrive before the policy is installed and
go unanswered.

**AC-WIRE-3** — The adapter MUST implement the full `NDKSigner` surface
(`pubkey` getter, `userSync` getter, `blockUntilReady()`, `user()`,
`sign(event)`, `encrypt()`, `decrypt()`). Specifically:

  - `pubkey` MUST synchronously return the hex pubkey the adapter was
    constructed with.
  - `blockUntilReady()` MUST resolve to an `NDKUser` whose `pubkey`
    property equals the same hex pubkey.
  - `sign(event)` MUST delegate to the wrapped `EventSigner` such that
    the returned event's `sig` field is the signature produced by the
    `EventSigner` for the supplied event template.
  - `encrypt()` / `decrypt()` MAY throw an explicit "not implemented"
    error — `NDKAuthPolicies.signIn` never calls them. They MUST NOT
    silently return falsy values; an explicit throw is the safe
    behaviour if a future code path reaches them.

## Defensive Guards (S1)

**AC-GUARD-1** — If MarmotProvider is ever constructed with a falsy
`signer` prop, the NDK instance MUST NOT have an auth policy set that
would attempt to sign with a missing signer. (In practice MarmotProvider
is only mounted when `pubkey` is non-null and a signer exists; this AC
is a static guard against future regressions.)

## No-Op Against Open Relays (S1)

**AC-NOOP-1** — Against an open relay (one that never sends `["AUTH",
…]`), the AUTH wiring MUST NOT cause the client to publish any
kind-22242 event. Verification: the existing e2e suite, which runs
against the open ephemeral strfry on `ws://localhost:7777`, MUST
continue to pass.

## Connect-Timeout Invariant (S1)

**AC-TIMEOUT-1** — Adding AUTH wiring MUST NOT change the timeout
passed to `ndk.connect(...)`. The call site at
`src/marmot/client.tsx:153` MUST continue to invoke
`ndk.connect(NDK_CONNECT_TIMEOUT_MS)` with the same constant
(`NDK_CONNECT_TIMEOUT_MS = 4_000` from `src/config/relays.ts`).

## Test Coverage (S1)

**AC-TEST-1** — A new unit test in `src/marmot/` MUST exercise the
adapter directly (strategy (a) — no NDK constructor mocking required).
At minimum the test MUST cover:

  - `adapter.pubkey` returns the hex pubkey the adapter was constructed
    with.
  - `adapter.blockUntilReady()` resolves to an `NDKUser` whose `pubkey`
    matches that hex.
  - `adapter.sign(event)` invokes the wrapped `EventSigner` and the
    event's `sig` field is populated from what the wrapped signer
    returned (i.e. a stub `EventSigner` returning a known signature
    causes the adapter's signed event to carry that signature).

The wiring (AC-WIRE-1 / AC-WIRE-2) can be verified by inspection in the
small `client.tsx` block and does not require its own automated test.

## Cross-Cutting Invariants

**AC-OBS-1** — The change MUST be confined to `src/marmot/client.tsx`
and its co-located test file(s). No new external dependencies, no edits
under `app/`, no edits to other `src/marmot/*` modules, no edits to
`src/lib/nostr.ts`. (Out-of-scope edits to unrelated files would
indicate scope creep that the verification examiner should flag.)

**AC-OBS-2** — Existing unit tests for `client.test.ts` and the rest of
the test suite MUST continue to pass. `make test` is the entry point.

## Manual Validation

- Deploy the production build (`make build && make deploy`). Sign in
  with the same NIP-46 bunker identity used in
  `notestr-web-group-discovery-report.md`. Confirm whether the `cli`
  group (`mls_group_id=843a8c2f2342f7a86d862f1f478799ed`,
  `nostr_group_id=29cedaa38489fa5e992a1aeab683ead697916f98bbfe93e7d2c829ade6de9b92`)
  surfaces. **Note:** group surfacing additionally requires that the
  Welcome (kind-1059, observed at unix 1779183194) is still on at least
  one of the 4 group relays and that a notestr-web KeyPackage was
  actually published to a public relay. AUTH alone is not sufficient if
  those conditions fail — falsifies the report's §5.4 hypothesis
  cleanly either way.
