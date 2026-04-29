# E2E Relay State Isolation Between Spec Files

## Problem

The e2e suite shares a single ephemeral strfry relay across every spec file
in a `make e2e` run. The relay's storage is `tmpfs` (per
`docker-compose.e2e.yml:7-8`) and `make e2e-down -v` wipes it between runs,
but **within a run** the relay accumulates events across spec files.

The notestr clients in those specs publish kind-30443 KeyPackage events
during `authenticate()` (so siblings of the same npub can be auto-invited
to groups). Those events are addressable, replaceable, and indefinitely
retained by the relay — so by spec file N the relay holds key packages
from every npub that ever authenticated in specs 1..N-1.

When `device-sync.ts:583+` runs its `Effect 2: Auto-invite new devices`
loop, it subscribes to `{ kinds: [30443], "#p": [pubkey] }` and treats
**every** matching event as a candidate for auto-invite. The local-device
filter at `device-sync.ts:610-618` deduplicates events whose KeyPackage
slot identifier (`d` tag) matches one of the current context's local key
packages — but stale slots from prior spec files are not local to *this*
context, so they look like foreign sibling devices. The auto-invite
issues a commit, and the resulting MLS group ends up with ghost leaves
that no live browser context controls.

This is documented as a known failure mode in
`e2e/tests/multi-device-sync.spec.ts:64-71`:

> Test-pollution sensitivity: earlier tests in the suite leave live
> kind-30443 key packages on the shared e2e relay. When multi-device-sync
> runs after them, pageA's auto-invite picks up those stale slots and the
> initial 2-device assertion fails with 4–5 "leaf-*" ghost rows. Runs in
> isolation pass this gate.

The same flaw was reintroduced by `e2e/tests/rename-device.spec.ts:76` in
the more recent matrix-coverage epic:

```ts
await expect(pageA1.locator('[data-testid="device-row"]')).toHaveCount(2, {
  timeout: 30000,
});
```

If `multi-device-sync.spec.ts` (`fixme`) ever runs ahead of this, or if
any other spec leaks key packages for the same bunker pubkey, this
assertion fails for reasons unrelated to the rename feature being
tested. Today rename-device passes only because the suite ordering
happens to put it before any other multi-context spec for the same npub.
The next spec author who adds a multi-device test for User A will
re-trigger the failure.

The blast radius is bigger than rename-device: every spec that asserts
an exact device-row count, an exact member count, or an exact leaf
count for a given pubkey is at risk the moment a sibling spec for the
same identity lands.

## Solution

Treat per-spec relay-state isolation as test infrastructure: between spec
files, the relay's view of "what key packages exist for User A right now"
must reflect only the current spec's publishes, not historical ones from
the suite.

The cleanest implementation is a relay reset hook that runs between spec
files. strfry does not expose a runtime "wipe events" API, so the reset
must be done at the Docker level: tear down the relay container and
bring it back up. This is fast on `tmpfs` (sub-second) and matches what
`make e2e-down -v && make e2e-up` already does between runs.

Wire the reset into Playwright's per-file lifecycle so each spec file
starts from a clean relay. Specs that need to inherit state from another
file (none today — every existing spec authenticates from scratch in a
`beforeAll`) can opt out via a project-level annotation if a future
need arises.

## Scope

### In Scope

- **`e2e/global-setup.ts` extension**: export a `resetRelay()` helper that
  runs `docker compose -f docker-compose.e2e.yml restart relay` (the
  `tmpfs` volume is wiped on container restart, and strfry's startup is
  ~200ms on a cold JIT). Helper lives next to the existing
  `globalSetup` hook.
- **Per-file reset hook**: a Playwright fixture that calls `resetRelay()`
  in `beforeAll` of every spec. Implementation choice: extend the
  existing `e2e/fixtures/two-party.ts` or a new `e2e/fixtures/relay-reset.ts`
  module that exports a wrapped `test` (mirroring how `ndk-client.ts`
  extends the base). Do not add to `globalSetup` itself — that runs
  once per worker, not per file.
- **Mark `multi-device-sync.spec.ts:64-88` `fixme`-removal**: the relay
  pollution blocker called out in the inline comment is now resolved.
  The MLS-remove-semantics blocker mentioned in the same comment
  remains, so the spec stays `fixme` but with a narrower reason.
- **Update `e2e/tests/rename-device.spec.ts:76`** to drop its implicit
  reliance on suite ordering. The exact-2 assertion stays, but with a
  documentation comment pointing at the relay-reset fixture as the
  precondition that makes it sound.
- **Document the relay-isolation contract** in `e2e/tests/property-tests.md`
  (added by the property-based-invariants epic) and in
  `e2e/fixtures/relay-reset.ts`'s module-level JSDoc. The contract:
  *every spec file starts with an empty relay; cross-file state must be
  re-established explicitly (e.g. by re-authenticating, re-creating
  groups).*
- **CI runtime budget check**: per-file restart adds ~22 spec files × ~1s =
  ~22s overhead to `make e2e`. Confirm the new total wall-clock is still
  within the project's e2e budget (currently nominal: ~10 minutes for
  the full chromium pass).

### Out of Scope

- **Production-side filtering of stale key packages.** Tempting fix
  ("ignore key packages whose `created_at` predates this client's session
  start") but it changes a real product behaviour: a user signing in
  on a brand-new device should still be auto-invited based on a key
  package they published yesterday from another browser. The pollution
  is a test-relay artefact, not a real-world signal.
- **`make e2e-isolation`** as a separate make target. Reset becomes
  unconditional; there is no scenario where a spec author legitimately
  wants stale key packages from an earlier spec.
- **Replacing strfry with a Playwright-native fake relay.** That is a
  different epic (would also enable headless ndk fixtures without
  Docker). Out of scope here.
- **Three-party sequencing fixes** in `three-party.spec.ts` (the
  `TP-70c chain` `fixme`). That blocker is MIP-03 admin-only-commits, not
  relay state.

## Design Decisions

1. **Restart the container, not the strfry process.** The relay binary
   does have a SIGUSR1 / log-rotation flag, but no clean "delete all
   events" handle. Restarting the Docker container is the simplest way
   to guarantee a fresh `tmpfs` mount.
2. **`docker compose restart relay`, not `down && up`.** Restart preserves
   the docker network, which is what Playwright's `ws://localhost:7777`
   resolves through. `down` would break the network mapping.
3. **Per-file, not per-test.** Resetting between every `test()` block
   would torpedo specs that authenticate once in `beforeAll` and then
   run multiple `test()` blocks against the same MLS group. File-level
   isolation maps cleanly onto the existing scope of bunker-shared
   identities.
4. **Reset before, not after.** Running reset *after* a spec means the
   first spec in the run inherits whatever was on the relay from the
   `make e2e-up` warm-up. Running it *before* makes the first spec
   identical to all subsequent specs.
5. **Bunker processes are not restarted.** Bunker state (NIP-46 session
   tokens) survives reset; only relay-published events get wiped. Specs
   that need a fresh bunker session can call `clearAppState()` (already
   in `e2e/fixtures/cleanup.ts`).
6. **No fixture flag to opt out.** If a future spec genuinely needs to
   inherit relay state, it can publish what it needs in its own
   `beforeAll`. Simpler than maintaining an opt-out matrix.

## Acceptance Criteria

- **AC-RI-1** — A new helper `resetRelay()` in
  `e2e/fixtures/relay-reset.ts` runs `docker compose -f
  docker-compose.e2e.yml restart relay` and waits for the relay's
  `ws://localhost:7777` to accept connections again before resolving.
  Timeout: 10s.
- **AC-RI-2** — Every spec file under `e2e/tests/` consumes a Playwright
  fixture that calls `resetRelay()` in its file-level `beforeAll`.
  Mechanism: a wrapped `test` exported from `relay-reset.ts` that the
  specs import in place of `import { test } from "@playwright/test"`.
- **AC-RI-3** — Running `make e2e` with `multi-device-sync.spec.ts`
  re-enabled (its relay-pollution `fixme` removed; the MLS-remove
  blocker still gates it) shows the device-row count assertion now
  passes deterministically across at least 10 consecutive runs.
- **AC-RI-4** — Running `npx playwright test rename-device.spec.ts
  multi-device-sync.spec.ts forget-device.spec.ts` in any order shows
  no inter-test pollution failures.
- **AC-RI-5** — Total `make e2e` wall-clock budget on a CI host
  increases by no more than 30 seconds compared to baseline.
- **AC-RI-6** — A regression that disables the per-file reset (e.g. by
  removing the fixture import from one spec) is caught by a sentinel
  test that authenticates two npubs in sequence across two `test()`
  blocks and asserts the second one sees zero leftover key packages
  via the existing NDK subscriber fixture.

## Affected Specs (today)

- `e2e/tests/rename-device.spec.ts:76` — exact-2 device-row assertion.
- `e2e/tests/multi-device-sync.spec.ts:64-88` — currently `fixme` with
  this exact problem documented.
- `e2e/tests/forget-device.spec.ts` — depends on leaf counts; would be
  vulnerable if a sibling spec ever authenticates User A or B with the
  same bunker.
- `e2e/tests/multi-device-cross-npub.spec.ts` — same risk surface.
- Future specs: anything in `epic-property-based-invariants` (S6, the
  Playwright property test) that asserts member counts, leaf counts,
  or device-row counts. Currently mitigated by the spec being
  pre-S6.

## Non-Goals

- Catching every flaky e2e test. This epic is scoped to the specific
  class of flakes caused by cross-spec key-package pollution. Other
  flakes (timeout sensitivity, ordering of MLS commits within a single
  spec) are separate.
- Replacing the bunker fixture process model. Bunkers stay long-lived;
  only the relay restarts.
- Standing up a parallel test relay per spec. One relay, restarted
  between files, is sufficient and cheaper than coordinating multiple
  port mappings.
