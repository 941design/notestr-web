# Acceptance Criteria — auto-invite-freshness

## AC-FRESHNESS-1

**`syncKnownKeyPackages` MUST collapse `knownEvents` to one event per `d` slot, selecting the event with the highest `created_at`, before iterating.**

Pass condition: The implementation in `src/marmot/device-sync.ts` MUST build an intermediate `Map<slot, NostrEvent>` from `knownEvents.values()` — keyed by `getKeyPackageIdentifier(event) ?? event.id` — retaining only the entry with the higher `created_at` when two events share the same slot key. The outer iteration loop MUST iterate this collapsed map, not the raw `knownEvents` map. The raw `knownEvents` map MUST remain keyed by event id (no write-time structural change).

---

## AC-FRESHNESS-2

**The slot key used in the freshness collapse MUST use `getKeyPackageIdentifier(event) ?? event.id` as the grouping key — the same fallback used by `inviteToAllGroups`'s dedup key.**

Pass condition: Code inspection MUST confirm the slot key expression in the collapse block is `getKeyPackageIdentifier(event) ?? event.id`. Kind-443 events with no `d` tag MUST fall back to `event.id` so they are each treated as their own slot, consistent with the existing dedup behavior.

---

## AC-FRESHNESS-3

**The freshness-collapse block in `syncKnownKeyPackages` MUST be wrapped in a code comment that explains the rotation-race root cause and the marmot-ts grace-window relationship.**

Pass condition: The comment block immediately preceding or containing the `latestBySlot` construction MUST:
- State that `knownEvents` is keyed by event id and therefore retains both old and rotated events for the same slot.
- State that Map iteration is insertion order, so the oldest event wins without the collapse.
- State that the resulting stale Welcome targets a KP the invitee has since rotated and can no longer enumerate during decrypt (per marmot-ts `list()` semantics excluding deprecated entries).
- Reference the manual invite freshness sort at `GroupManager.tsx` as the pattern being mirrored.

A comment that says only "prefer freshest" without explaining the rotation-race mechanism MUST NOT be accepted as passing.

---

## AC-TEST-1

**A new e2e test file `e2e/tests/sibling-auto-invite-rotation-race.spec.ts` MUST exist and MUST fail on `master` HEAD (pre-fix) and pass after the fix.**

Pass condition: The file MUST exist at `e2e/tests/sibling-auto-invite-rotation-race.spec.ts`. The test MUST use `authenticate()` from `e2e/fixtures/two-party.ts` with distinct explicit slot strings (e.g. `'sibling-fresh-1'` and `'sibling-fresh-2'`) — not an inline auth function without a slot parameter. The scenario MUST: sign in both contexts with the same bunker URL, create Group A, wait for the sibling to join (confirming Group A appears in the sibling's sidebar), then create Group B, and assert that Group B appears in the sibling's sidebar within 60 seconds.

---

## AC-TEST-2

**The e2e test for Group B visibility MUST assert the sibling's sidebar shows Group B without relying solely on IDB introspection of `notestr-failed-welcomes`.**

Pass condition: The test's primary pass/fail assertion MUST be `expect(page2.locator('aside').getByText('Group B')).toBeVisible({ timeout: 60_000 })`. The optional belt-and-braces IDB `failedCount === 0` check is permitted but MUST NOT be the only assertion.

---

## AC-COMPAT-1

**The existing e2e test suite MUST NOT regress: `members.spec.ts`, `groups.spec.ts`, `forget-device-sibling.spec.ts`, and `multi-user.spec.ts` MUST all pass after the fix.**

Pass condition: All four files MUST complete with zero failing tests when run against the fixed code. The sibling forget-device flow in `forget-device-sibling.spec.ts` is the highest-risk regression surface because it also exercises same-pubkey two-context setup with slot-keyed dedup.

---

## Manual Validation

The following steps MUST be performed by a human tester and MUST produce the stated outcome after the fix is applied.

1. Open two browser windows (or two browser contexts) signed in to notestr-web using the **same** bunker URL.
2. Wait for both windows to reach the authenticated state (pubkey chip visible).
3. In window 1, create **Group A**. Wait until Group A appears in window 2's sidebar (sibling auto-invite succeeded).
4. In window 1, create **Group B** immediately after.
5. Observe window 2's sidebar. **Expected**: Group B appears within approximately 60 seconds.
6. In window 2, open Settings → Pending Invitations. **Expected**: zero entries (no `FailedWelcomeRecord` for Group B).

**Pre-fix expected outcome (confirming the test catches the bug):** Group B does NOT appear in window 2's sidebar, and Pending Invitations shows a `FailedWelcomeRecord` with `failureReason: "no_matching_kp"` for Group B.
