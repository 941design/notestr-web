# Bug Report: Sibling auto-invite over-invites — pubkeyA gets 19 leaves instead of 2

**Severity:** HIGH — blocks every sibling-forget e2e test (the entire `forget-device-sibling.spec.ts` describe.serial cannot get past setup). Symptom is admin-side auto-invite inviting the same sibling device dozens of times in a single setup window.

## Symptom

`e2e/tests/forget-device-sibling.spec.ts:99` ("TP-91 setup: A1 creates group, invites B, A2 auto-joins via same-npub scan") fails reproducibly (two consecutive runs, ~54s each) at line 136:

```
Error: expect(received).toHaveLength(expected)
Expected length: 2
Received length: 19
Received array:  [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, …]
  at e2e/tests/forget-device-sibling.spec.ts:136

await expect
  .poll(() => leafIndexesFor(pageA1, groupId, pubkeyA), { timeout: 30000 })
  .toHaveLength(2);
```

The test creates 3 browser contexts:
- **A1** (slot `sibling-a1`) — admin, creates the group, invites B.
- **A2** (slot `sibling-a2`) — same bunker key as A1, expected to auto-join via the sibling-discovery scan.
- **B**  (slot `observer`)   — distinct bunker key, joins via Welcome.

After A1 creates the group and invites B, the test asserts that `pubkeyA` owns exactly **2** MLS leaves in the group state (A1's + A2's). Instead `pubkeyA` owns **19** leaves (indexes 0,1,3..19 — index 2 is presumably B). The setup test never gets past this sanity check, so the actual sibling-forget action under test is never exercised.

## Reproduction

```
npx playwright test e2e/tests/forget-device-sibling.spec.ts --max-failures=1
```

Build must be fresh (`out/` from the same session as the test run) and the ephemeral relay container must be up (port 7777). Confirmed reproducible twice in a row on 2026-05-21 against `master` HEAD `a334194`.

## Expected vs actual

- **Expected:** After A1 invites B and the auto-invite scan picks up A2's KeyPackage, pubkeyA has exactly 2 leaves (one for A1, one for A2). The slot-keyed dedup in `inviteToAllGroups` (and the freshness collapse in `syncKnownKeyPackages`) should keep this idempotent across repeated emissions of A2's KP.
- **Actual:** pubkeyA accumulates 19 leaves. The admin-side auto-invite is firing repeatedly for the same sibling and producing a new MLS leaf each time.

## Suspected scope and root cause

**Code under suspicion:** `src/marmot/device-sync.ts` auto-invite path.

The prior fix `9ddf32e` ("pick freshest KeyPackage per slot in sibling auto-invite") collapses-by-slot inside `syncKnownKeyPackages` (line 1264-1280). But `handleKeyPackageEvent` (line 1283) fires per-KP-event with no slot-level rate-limiting in front of `inviteToAllGroups`. The dedup inside `inviteToAllGroups` at line 1218-1224 uses:

- A per-session `invited` Set keyed by `${group.idStr}:${inviteeSlot ?? kpEvent.id}`.
- A persisted IDB cache (`persistInvitedKey`).
- A leaf-presence guard `groupHasKeyPackageLeaf(group.state, kpEvent)` at line 1203, keyed by the specific KP event id.

Two hypotheses worth confirming first:

1. **Rotation cascade racing slot-dedup.** A2's bunker republishes its KP many times during the 8s `settle` after invite. Each new event fires `handleKeyPackageEvent` → `inviteToAllGroups`. The slot dedup should catch this, but `pendingInvites.add(dedupKey)` is set *before* `await group.inviteByKeyPackageEvent` and `invited.add(dedupKey)` happens *after*. If `inviteByKeyPackageEvent` resolves before the next event arrives, but the `pendingInvites.delete` in the `finally` block runs *before* `invited.add` is observed by the next concurrent call, a race window opens.
2. **`groupHasKeyPackageLeaf` miss after rotation.** Line 1203 checks for the *specific* `kpEvent` in the group leaves. After A2 rotates KP (event A → event B), `groupHasKeyPackageLeaf(group, eventB)` returns false even though A2 already has a leaf there from event A. The slot-dedup at line 1223 is the only thing standing between this and a duplicate invite. If the session-local `invited` Set is empty for a newly-created admin-side group (it's populated only after the first successful invite for that group+slot), the rotation is treated as a fresh invitee.

Either hypothesis predicts the symptom: the same A2 device gets invited N times where N = (number of KP events emitted during the setup window) − (one for the legitimate join). The leaf-index pattern `[0, 1, 3..19]` is consistent with this — A1 is leaf 0, A2's first legitimate leaf is 1, B claims 2, and leaves 3..19 are repeat-invitations of A2 from successive KP rotations.

Worth checking which one (or both) by adding console.debug logging to `handleKeyPackageEvent` and `inviteToAllGroups` and re-running. The fix likely belongs in `handleKeyPackageEvent` (don't enqueue if the slot is already pending or has an `invited` mark) or in `inviteToAllGroups` (add a `groupHasSlotForPubkey` guard that doesn't depend on the specific event id).

## Acceptance criteria

A fix must:

1. The failing test `e2e/tests/forget-device-sibling.spec.ts:99` passes — `pubkeyA` has exactly 2 leaves after setup, and the assertion at line 136-138 succeeds.
2. The downstream test `e2e/tests/forget-device-sibling.spec.ts:144` (sibling-forget action) is no longer skipped and either passes or surfaces its own distinct failure (this report is not blocking that test's correctness).
3. The repeated `pageA1.waitForTimeout(8000)` / `settle` in the test's setup keeps working as an idempotency check — multiple emissions of A2's KP during the settle window must NOT produce additional leaves.
4. No regression in `forget-device-self.spec.ts`, `active-leave.spec.ts`, or any test that exercises a single-device A + B + (optional C) topology.
5. The cross-author task tests still pass (they don't exercise sibling auto-invite directly, but they verify the group-state-invariant assumptions auto-invite relies on).

## Constraints

- Unrelated to the two fixes shipped earlier this session (`989909d` SHORT_B fixture, `a334194` teardown process group).
- Related but distinct existing reports under `bug-reports/`:
  - `self-forget-evicts-sibling-leaves-report.md` — self-forget over-eviction (forget-side).
  - `self-forget-no-mls-propagation-report.md` — self-forget no kind-445 propagation (forget-side).
  - `self-forget-sole-admin-no-propagation-report.md` — self-forget can't propagate when sole admin (forget-side).
  - This bug is **admin-side auto-invite**, not forget-side. The fix should not touch `forget-device.ts`.
- Acceptance criteria the failing test exercises: AC-E2E-2, AC-E2E-11, AC-E2E-12 (sibling-forget multi-leaf semantics).

## Reference: relevant code locations

- `src/marmot/device-sync.ts:1191-1241` — `inviteToAllGroups` (dedup logic, slot key derivation, the leaf-presence guard at line 1203).
- `src/marmot/device-sync.ts:1243-1281` — `syncKnownKeyPackages` (the freshness collapse from `9ddf32e`).
- `src/marmot/device-sync.ts:1283-1297` — `handleKeyPackageEvent` (live KP event handler — the suspected over-firing path).
- `e2e/tests/forget-device-sibling.spec.ts:99-139` — the failing setup test.
- `e2e/fixtures/two-party.ts` — `leafIndexesFor`, `authenticate`, slot pinning utilities.

Source: in-session investigation 2026-05-21 by Claude Opus 4.7 after `e2e/tests/group-switch-members.spec.ts` regression was fixed and the e2e teardown process-group leak was patched.
