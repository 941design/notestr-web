# Acceptance Criteria
## Epic: Sibling auto-invite must pick the freshest KeyPackage per slot

Tag prefix: `INVITE`

---

### AC-INVITE-1

`syncKnownKeyPackages` in `src/marmot/device-sync.ts` MUST collapse `knownEvents` to at most one event per `d`-tag slot before iterating, selecting the event with the highest `created_at` value per slot, prior to any call to `inviteToAllGroups`.

**Verification:** `grep -n 'latestBySlot' src/marmot/device-sync.ts` MUST return matches inside the `syncKnownKeyPackages` function body. Confirm the collapse loop (`latestBySlot.get(slot)` + `created_at` comparison) precedes the `inviteToAllGroups` call in the same function.

---

### AC-INVITE-2

`e2e/tests/sibling-auto-invite-rotation-race.spec.ts` MUST exist and MUST pass end-to-end: two browser contexts sharing the same bunker pubkey (sibling devices), where the admin creates two groups in sequence after the sibling's first join has triggered a KP rotation, MUST result in the sibling appearing in both groups' sidebars with zero `FailedWelcomeRecord` entries in the `notestr-failed-welcomes` IDB store.

**Verification:** Run the e2e suite targeting that file. Both `toBeVisible` sidebar assertions and the `failedCount === 0` assertion MUST pass.

---

### AC-INVITE-3

The following e2e test files MUST continue to pass without modification after the fix is in place: `e2e/tests/members.spec.ts`, `e2e/tests/groups.spec.ts`, `e2e/tests/forget-device-sibling.spec.ts`, `e2e/tests/multi-user.spec.ts`.

**Verification:** Run each file individually. All tests MUST pass. No test MUST be skipped or modified to accommodate the `latestBySlot` collapse.

---

### AC-INVITE-4

The `latestBySlot` collapse in `src/marmot/device-sync.ts` MUST be preceded by a code comment that explains (a) why the raw `knownEvents` Map yields stale results without the collapse (insertion order, Map keyed by event id, rotated entries coexisting), (b) the consequence of omitting the collapse (stale Welcome targeting a deprecated KP that marmot-ts `list()` excludes, causing `no_matching_kp` failure), and (c) a reference to the manual invite path in `src/components/GroupManager.tsx` as the precedent for the freshness sort.

**Verification:** `grep -n 'not.*"type"\|GroupManager\|no_matching_kp\|insertion order\|list()' src/marmot/device-sync.ts` MUST return lines within the comment block immediately preceding the `latestBySlot` declaration. The comment MUST be present in the committed source, not only in the git diff.
