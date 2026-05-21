# Bug Report: Self-forget does not propagate to other group members within SLA

## Symptom

When user A picks **Settings → Devices → Forget this device → confirm**, the expectation
(per `AC-E2E-9` in `specs/epic-mls-leaf-identity-ux/acceptance-criteria.md`) is that
user B's view of the group drops A's leaf within **60 seconds**.

In the current build this never happens. 60 s after A's self-forget, B's MLS tree view
still contains 1 A-pubkey leaf (`Expected 0, Received 1`). Member count on B stays at 2.

## Reproduction

- **Failing test:** `e2e/tests/forget-device-self.spec.ts:115`
  ("A self-forgets: signed out, leaf gone from B's view, kind-5 published (AC-E2E-9, AC-E2E-10)")
- Fails on both initial run **and** retry #1 with the same assertion:
  B's count of A-pubkey leaves does not drop by 1 within 60 s.
- Trace artifact: `test-results/forget-device-self-TP-90-s-446fd-blished-AC-E2E-9-AC-E2E-10--chromium-retry1/trace.zip`

### Pre-investigation evidence

- The test-hook `__notestrTestPubkeyLeafIndexes` IS installed on pageB and IS returning
  real values from pageB's local MLS group state (confirmed via temporary instrumentation
  during the scout pass that opened this report). The polled value stays `[1]` for the
  entire 60 s window after A's confirm-click on the forget dialog.
- This means the failure is **product behavior**, not test infrastructure.

## Expected post-condition

After A confirms "Forget this device":

1. A is signed out (`/` route renders the sign-in screen) — *currently works*.
2. A publishes:
   - a kind-5 deletion event tagged with A's KeyPackage event ids, and
   - the MLS commit event(s) (kind-445) that remove A's leaves from each group A is in.
3. B's MarmotProvider ingests the kind-445 event(s); B's local MLS tree no longer
   contains A's leaf; B's group view shows member count 2 → 1.
4. AC-E2E-9 holds: B's count of A-pubkey leaves drops by exactly one within 60 s.

Step 1 currently works. Steps 2–4 are the failure surface.

## Suspected root cause (to confirm)

Two candidate failure modes; one of them must be the cause, or both:

1. **A's `forgetSelfDevice` path does not actually publish the MLS remove commit.**
   I.e. the kind-445 remove-proposal/commit never lands on the relay, so B has nothing
   to ingest. Likely areas: `forgetSelfDevice` in `src/marmot/forget-device.ts` (or
   wherever `forgetSelfDevice` is implemented — exploration to confirm), the path that
   wires the Settings → Devices "Forget this device" confirm button to the actual MLS
   remove flow, and the publish lifecycle that races against the user being signed out.
2. **The commit is published but B's ingest path drops or rejects it.**
   I.e. the relay receives the kind-445, but B's MarmotProvider's MLS subscription
   doesn't process it before the test's 60 s budget elapses. Likely areas: B's
   subscription / ingest of kind-445 in `src/marmot/client.tsx` and adjacent receive
   code, the subscribe-first-receive flow added in commit `9e7aa84`.

Investigation must distinguish these — a relay-level capture of A's outbound events
during the test window settles it.

## Impact

- AC-E2E-9 is broken: the user-facing "Forget this device" promise (other members
  see you leave) is not honored.
- AC-E2E-10 is at risk (kind-5 deletion event publication) — same test asserts both
  but stops at AC-E2E-9 first.
- This is a regression vs the spec for the epic-mls-leaf-identity-ux S6 story
  ("forget-on-signout") that shipped in commit `c7ad8b7`.

## Non-goals for this run

- Do **not** attempt to fix the early-test race for `__notestrTestPubkeyLeafIndexes`
  at line 146 of the same spec. That's a separate, cosmetic flake (the helper at
  `e2e/fixtures/two-party.ts:434-449` should poll for the hook before calling it,
  like the other `getGroupEpochHook` / `getGroupMembersHook` helpers in the same file
  already do). Log it as a finding for the post-fix cleanup pass.
- Do not refactor `forgetSelfDevice` beyond what is needed to make AC-E2E-9 pass.
- Do not touch sibling-forget code paths (`e2e/tests/forget-device-sibling.spec.ts`)
  unless investigation proves the fix sits in shared code.
