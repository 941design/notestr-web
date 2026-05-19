# NIP-42 Relay AUTH — Epic Architecture

## Paradigm

Modular monolith, package-by-feature. The `src/marmot/` directory is
the MLS-on-Nostr feature module; this epic operates strictly within it.

## Module map

This epic touches one production module and (optionally) adds one
sibling module under it.

| Module | Purpose | Owns |
|---|---|---|
| `src/marmot/client.tsx` | React provider for the MarmotClient + NDK instance | NDK construction; the AUTH wiring lives here |
| `src/marmot/event-signer-ndk-adapter.ts` *(new, optional layout)* | Adapter class wrapping `EventSigner` as `NDKSigner` | Adapter implementation; co-located unit test |

The adapter MAY be inlined into `client.tsx` instead of lifted into a
sibling module. Both layouts satisfy AC-OBS-1 ("co-located test
file(s)"). The architect picks based on the size of the adapter once
the full `NDKSigner` surface is implemented — if it ends up <30 LOC and
trivially inline, inline it; otherwise lift it.

The architect MUST NOT modify any of these:

- `src/lib/nostr.ts` — bunker / NIP-46 / NIP-07 signer construction
  (Non-Goal #3 in spec; spec §"Out of Scope" #5).
- `src/marmot/network.ts` — NDK network adapter (no AUTH-related
  concern here; it consumes whatever NDK gives it).
- `src/marmot/device-sync.ts`, `device-store.ts`, `forget-device.ts`,
  `forgotten-slots.ts`, `ingest-queue.ts`, `mls-trace.ts`,
  `per-leaf-remove.ts`, `storage.ts`, `detached-groups.ts` — unrelated.
- `app/page.tsx` — signin / provider mount (no contract change
  needed).
- Any `e2e/` files (spec §"Out of Scope" #4).

## Boundary rules

1. **No new external dependencies.** This epic adds zero new entries to
   `package.json`. `@nostr-dev-kit/ndk` and `applesauce-core` are
   already deps; nothing else is needed.
2. **No imports of `@nostr-dev-kit/ndk` outside `src/marmot/client.tsx`
   and `src/marmot/network.ts`.** Per the boundary documented in
   `src/marmot/forget-device.ts:13–14`, NDK lives only in those two
   files. The new adapter — whether inlined or lifted into a sibling
   module under `src/marmot/` — is allowed to import NDK because it is
   part of the same NDK-owning area. No other module gains NDK imports.
3. **Adapter is one-way.** The adapter wraps an `EventSigner` and
   exposes the `NDKSigner` surface. It does NOT export anything back
   into the `EventSigner` direction; if a future caller needs the
   inverse, they reach for the existing `bridgeNip46ToEventSigner` in
   `src/lib/nostr.ts:35`, not this adapter.

## Seams

This epic introduces one internal seam between the wrapped
`EventSigner` and NDK:

- **`EventSignerNdkAdapter`** — implements `NDKSigner` by delegating to
  a wrapped `EventSigner`. Construction params: `(signer:
  EventSigner, pubkey: string)`. The pubkey is passed in (already
  known at provider mount) rather than awaited from
  `signer.getPublicKey()` so the synchronous `pubkey` getter works.

No cross-story seams; the epic has a single story.

## Implementation constraints

### AUTH wiring timing

NDK's AUTH state machine handles relay-side `["AUTH", "<challenge>"]`
frames. Challenges typically arrive AFTER `ndk.connect()` completes,
when the client issues its first REQ on a relay that requires AUTH.

To avoid any race where a challenge arrives before the policy is
installed, set `ndk.signer` and `ndk.relayAuthDefaultPolicy` **before
`ndk.connect(NDK_CONNECT_TIMEOUT_MS)` is awaited**. Two equivalent
forms:

- **Constructor form (preferred — single statement, no race window):**
  ```ts
  const adapter = new EventSignerNdkAdapter(signer, pubkey);
  const ndk = new NDK({
    explicitRelayUrls: relays,
    signer: adapter,
    relayAuthDefaultPolicy: NDKAuthPolicies.signIn({ ndk: /* see note */ }),
  });
  ```
  The `signIn` factory takes the NDK instance for its `ndk` arg, which
  is a chicken-and-egg ordering issue. The simplest workaround is to
  use the post-construction form below; alternatively, construct the
  NDK without policy, then set `ndk.relayAuthDefaultPolicy` immediately
  before `ndk.connect(...)`.

- **Post-construction form (handles the `signIn({ ndk })` ordering):**
  ```ts
  const ndk = new NDK({ explicitRelayUrls: relays });
  ndk.signer = new EventSignerNdkAdapter(signer, pubkey);
  ndk.relayAuthDefaultPolicy = NDKAuthPolicies.signIn({ ndk });
  await ndk.connect(NDK_CONNECT_TIMEOUT_MS);
  ```

The architect picks; the post-construction form is the obvious choice
because `NDKAuthPolicies.signIn` needs the NDK instance in scope.

### Defensive guard for AC-GUARD-1

MarmotProvider is statically only mounted with a non-null signer (see
exploration.json `architecture.signer_prop_contract`), but the AUTH
wiring still wraps in a defensive `if (signer)` to harden against
future regressions in the mount path. The cost is zero (one extra
branch); the benefit is a clean static guarantee that AC-GUARD-1
holds.

### Adapter return shape for `sign()`

`NDKSigner.sign(event): Promise<string>` returns the signature only
(see exploration.json `similar_features.ndksigner_vs_eventsigner_interface_gap`).
The wrapped `EventSigner.signEvent(draft)` returns the full
`NostrEvent`. Adapter implementation:

```ts
async sign(event: NostrEvent): Promise<string> {
  const signed = await this.wrapped.signEvent(event);
  return signed.sig;
}
```

### `encrypt` / `decrypt` policy

`NDKAuthPolicies.signIn` does not call `encrypt` or `decrypt` on the
signer. The adapter implements them as explicit throws (per
AC-WIRE-3). This is loud-fail-on-unreachable behaviour; a future code
path that lands here gets a clear stack trace rather than a silent
crash.

### Test strategy

Per AC-TEST-1, the test is a direct adapter unit test, not a
MarmotProvider wiring test. Strategy:

1. Use the canonical `EventSigner` stub pattern from
   `src/marmot/forget-device.test.ts:131–139`. Two-method stub:
   `getPublicKey: vi.fn().mockResolvedValue(pubkey)`,
   `signEvent: vi.fn().mockImplementation(async (event) => ({ ...event, sig: 'dummy-sig', id: 'signed-id' }))`.
2. Construct the real `EventSignerNdkAdapter` against that stub.
3. Assert: `adapter.pubkey === 'test-pubkey'`,
   `(await adapter.blockUntilReady()).pubkey === 'test-pubkey'`,
   `(await adapter.sign({ ... })) === 'dummy-sig'`.
4. Optionally assert that `encrypt()` / `decrypt()` throw (low-value
   but cheap — confirms the explicit-throw policy).

No NDK constructor mock is required. `NDKUser` is a lightweight class
constructed via `new NDKUser({ pubkey })`; tests can use the real
class.

### Build & test workflow

Per `CLAUDE.md`'s multi-platform rule: run everything through `make`.
For this epic: `make test` (unit, relay-independent) is the
acceptance gate. The architect MUST NOT invoke `npx vitest run` or
`npm test` directly without going through `make` — the Makefile's
`node_modules` target handles the platform stamp.
