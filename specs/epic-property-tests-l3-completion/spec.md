# Property Tests Layer-3 Completion — Make the Asserted Invariants Real

## Problem

The full-stack property test (`e2e/tests/multi-user.property.spec.ts`) advertises a broad invariant set in its describe-block title — `[S5,S6,S7,S10,A7-A12,A14,C0]` — and the matrix in `docs/two-party-permutation-matrix.md` § *Property-test coverage* maps every TP-XX scenario family onto invariants from that set. Reading the file alone, a reviewer reasonably believes those invariants are enforced.

In practice, several of them are **observed but not asserted**, or stubbed out entirely:

- **`assertS6` (`multi-user.property.spec.ts:873`)** is a stub (`void m;`) with a comment that the MLS epoch isn't exposed via test hooks. Every command's `recordEpoch(...)` call writes to a sequence that nothing ever reads.
- **`assertS7` (`multi-user.property.spec.ts:882`)** is a stub (`void m; void r;`) with a comment that the check is "done in `SwCommand.run()` directly" — but `SwCommand.run` does not in fact compare the post-switch task set against the prior identity's groups.
- **`assertC0` (`multi-user.property.spec.ts:830`)** asserts task-id set equality plus status/assignee/title equality, but skips the three other dimensions spec.md §C0 calls out as part of settled-state equality: `members`, `epoch`, and per-pubkey `leafCount`.
- **`assertS5` (`multi-user.property.spec.ts:858`)** only asserts the positive direction (B is a member ⇒ B has ≥1 leaf). The comment explains that the negative direction is omitted because cross-run leftover MLS state can leave pubkey-B leaves in older groups. The full biconditional is what spec §S5 promises.
- **`assertS10` (`multi-user.property.spec.ts:890`)** counts `[data-testid="device-row"]` rows, then asserts `>= 0` rather than equality with `getPubkeyLeafNodes(g.state, p).length`. The actual invariant is equality.
- **A14 verification in `LgCommand.run` (lines 327–340)** captures `tasksBefore`/`tasksAfter` and runs an empty for-loop with comments only. **A14 verification in `FdCommand.run` (lines 384–391)** captures the same pair, never compares them, and only asserts the leaf-count consequence (which is A10, not A14).
- **`openNdkSubscriber` (`multi-user.property.spec.ts:41`)** is imported but never called. AC-FS-11 in `epic-property-based-invariants/acceptance-criteria.md` explicitly requires it for A14: "include a 2-second observer wait via `e2e/fixtures/ndk-subscriber.ts` confirming no new kind-445 events for the affected group are decryptable on the leaving / forgotten context."

The result: a property test whose **describe title and matrix coverage promise more than the file enforces**. The cheapest path to credible coverage is to fill the assertions, not to remove the claims. Most fills are 10–50 LOC; the only structural prerequisite is exposing three already-computed values (epoch, members set, leaf count by pubkey) via test hooks.

## Solution

A two-phase epic:

1. **Cheap closures.** Tighten the L3 assertions that already have all the data they need, in-file, without touching production. Covers `assertS5` negative direction, `assertS10` real equality, `assertS7` filling, A14 wiring in `LgCommand` / `FdCommand` via the existing `ndk-subscriber` fixture, and removing the dead `openNdkSubscriber` import (subsumed by A14 wiring).
2. **Test-hook closures.** Add three additive read-only test hooks that expose values already computed by existing code (`getGroupMembers`, `getPubkeyLeafNodes`, the MLS group context's `epoch`). Use them to fill `assertC0` (full version), `assertS6` (epoch monotonicity), and the strict form of `assertS10`.

Both phases are additive. No production behaviour changes; no existing test changes; no test removed.

## Scope

### In Scope

- **Phase 1 — file-only fixes (`e2e/tests/multi-user.property.spec.ts`):**
  - Replace `assertS5`'s positive-only check with the full biconditional, scoped to the **current** group `m.groupIdA` so cross-run MLS leftover state does not pollute the assertion.
  - Replace `assertS10`'s `>= 0` checks with `expect(deviceRows).toBe(getPubkeyLeafNodes(g.state, m.pubkeyA).length)`. The leaf-count side already exists via `leafIndexesFor`.
  - Fill `assertS7`: read `__notestrTestTasks()` and `__notestrTestGroups()` after every `Sw`, assert no task ids carry a `groupId` belonging to the prior identity's group set. The model already tracks per-actor pubkey and group membership.
  - Wire A14 in `LgCommand.run` and `FdCommand.run` (last-leaf branch) via `openNdkSubscriber`: subscribe with the leaving / forgotten user's relay key for kind 445 filtered by the affected `nostrGroupIdHex`, settle 2 s, assert zero new application-message events decrypt successfully on that side. Replace the dead `tasksBefore`/`tasksAfter` capture-and-discard with this real check.
- **Phase 2 — additive test hooks (`src/types/notestr-test-hooks.d.ts`, `src/types/notestr-test-hooks.ts` if it exists, plus the install site in `src/store` or `src/marmot`):**
  - `__notestrTestGroupEpoch(groupIdStr) → number | null` returning `g.state.groupContext.epoch` for the group with that idStr, or `null` if absent.
  - `__notestrTestGroupMembers(groupIdStr) → string[] | null` returning the result of `getGroupMembers(g.state)` (sorted hex pubkeys).
  - `__notestrTestPubkeyLeafCount(groupIdStr, pubkeyHex) → number` returning `getPubkeyLeafNodes(g.state, pubkey).length`. (Distinct from `__notestrTestPubkeyLeafIndexes`, which already exists; the new hook is a length-only helper to avoid the per-call array allocation when only the count is needed and to clarify intent at the call site.)
- **Phase 2 — assertion fills using the new hooks:**
  - `assertC0`: extend to compare `members(A) == members(B)`, `epoch(A) == epoch(B)`, and `leafCount(g, p)` per pubkey across actors at quiescence. Match spec §C0 exactly.
  - `assertS6`: walk `epochSequenceA` / `epochSequenceB` and assert each sequence is non-decreasing. The recorded values are already in the model — the fill is the assertion. Replace the `void m;` stub.
  - `assertS10`: use `__notestrTestPubkeyLeafCount` directly rather than `leafIndexesFor(...).length`, primarily for clarity.
- **AC-VAL-1 manual validation (one-shot):** the existing epic's S8 story called for a manual `>=` → `>` flip in `task-reducer.ts:16` to confirm the property suite catches it. Treat that as a story in this epic and execute it after Phase 1+2 land, since the assertion surface has expanded and the validation needs to re-run on the broader surface.

### Out of Scope

- 3-party (TP-70..72) and multi-device same-pubkey at L3 (TP-80..82). Both have separate epics: `epic-property-tests-l3-three-party` and `epic-property-tests-l3-multi-device`.
- Any reducer behaviour change. The `>=` LWW guard, `task.snapshot` semantics, and stale-rejection rules remain as-is.
- New invariants. This epic only fills assertions for invariants already in the catalogue at `specs/epic-property-based-invariants/spec.md`.
- Increasing `numRuns` for L3. The 20-run budget remains; the goal is correctness of the assertions, not depth.
- Removing or rewriting `assertC0`'s task-subset check; it is *extended*, not replaced.
- Adding new commands to the `fc.commands` set. The thirteen DSL Command classes are unchanged.

## Design Decisions

1. **Hooks expose computed values, not internals.** `getGroupMembers` and `getPubkeyLeafNodes` are already used in production paths (`src/marmot/detached-groups.ts`, `src/marmot/device-sync.ts`). The new hooks call those exact functions. This keeps the test surface honest — if the production helper changes its semantics, every test using the hook follows.
2. **Hook output shape mirrors what the test wants to assert.** Members hook returns `string[]` (sorted) so `expect(membersA).toEqual(membersB)` works directly. Epoch hook returns `number | null` so absent-group cases are explicit. Leaf-count hook returns `number` to avoid the array allocation when the test only needs equality of counts.
3. **`assertS5` scoping over isolation.** The cross-run MLS state pollution is real (groups created in run N still have leaf entries when run N+1 reuses pubkey B). Two options were considered: (a) hard-reset the bunker / IndexedDB between runs, (b) scope the assertion to `m.groupIdA`. Option (b) is taken because (a) was rejected during the original epic for cost reasons (a fresh-bunker reset between runs would dominate L3 wall-clock). Scoping to the active group preserves the invariant's spirit: the question "does B have ≥1 leaf in the group B is supposed to be a member of" *is* the operationally meaningful one.
4. **A14 via the existing fixture, not a custom subscriber.** `e2e/fixtures/ndk-subscriber.ts` ships `openNdkSubscriber` and `waitForEvents` already. The 2-second wait plus zero-event filter is two lines of glue; do not introduce a parallel observer.
5. **Phase 1 ships independently.** None of Phase 1 depends on the new test hooks. If Phase 2 hits a snag (e.g. epoch hook installation site is awkward), Phase 1 still closes four gaps and removes one dead import. Track them as separate stories so they can land separately.
6. **Hook signatures take `groupIdStr`, not the live `MarmotGroup` object.** The L3 test already addresses groups by their `idStr` (the canonical client-facing identifier from `__notestrTestGroups`). Passing the group object across the Playwright bridge would require structured cloning of MLS internals; passing a string is trivial and matches existing hooks (`__notestrTestPubkeyLeafIndexes(groupId, pubkeyHex)`).
7. **`epochSequence` becomes load-bearing in S6.** Currently `recordEpoch` is wired per-command but its output is dead. Filling `assertS6` makes those recordings observable. To avoid interleaving with other actors' actions, the assertion is per-actor monotonicity (each actor's own observed epoch sequence is non-decreasing), not cross-actor (epochs across actors are not synchronized between dispatches).
8. **AC-VAL-1 is a story, not a manual checklist item.** The original epic's S8 was framed as a "manual validation, not a committed test." Once Phase 1+2 land, the validation surface has changed materially. Capture the re-run as a story whose acceptance criterion is documented evidence (a CI run or local log) of the counterexample appearing within 60 s and being shrunk to two equal-`updatedAt` events.

## Technical Approach

### Phase 1 — File-only fixes

#### 1.1 `assertS5` full biconditional, scoped to `m.groupIdA`

Replace the body of `assertS5` (currently lines 858–871) with:

```ts
async function assertS5(m: ModelState, r: RealSystem): Promise<void> {
  if (!m.groupIdA || !m.pubkeyA || !m.pubkeyB) return;

  const membersA = await getGroupMembersHook(r.pageA, m.groupIdA);
  if (membersA === null) return; // group not loaded on A — skip

  for (const p of [m.pubkeyA, m.pubkeyB]) {
    const isMember = membersA.includes(p);
    const leafCount = (await leafIndexesFor(r.pageA, m.groupIdA, p)).length;
    expect(isMember).toBe(leafCount >= 1);
  }
}
```

`getGroupMembersHook` is the Phase 2 helper. While Phase 1 lands, the assertion stays positive-only; the negative direction is enabled in Phase 2.

If Phase 2 is delayed, Phase 1's `assertS5` body is:

```ts
async function assertS5(m: ModelState, r: RealSystem): Promise<void> {
  if (!m.groupIdA) return;
  for (const [actor, pubkey, isMember] of [
    ["A", m.pubkeyA, m.memberA],
    ["B", m.pubkeyB, m.memberB],
  ] as const) {
    if (!pubkey) continue;
    const leafCount = (await leafIndexesFor(r.pageA, m.groupIdA, pubkey)).length;
    if (isMember) {
      expect(leafCount).toBeGreaterThanOrEqual(1);
    } else {
      expect(leafCount).toBe(0);
    }
  }
}
```

This still uses the model's `memberA`/`memberB` flags as the truth side and asserts the leaf-count consequence in both directions. The pollution risk is contained to `m.groupIdA`, which is freshly assigned per run.

#### 1.2 `assertS7` identity isolation fill

**Note (2026-05-18, post-implementation):** The reference implementation below uses `task.groupId`, but the `Task` interface does not have a `groupId` field — tasks are scoped by which `TaskStoreProvider` is mounted (per-group), not by a field on the task object. S2 adapted to a group-level assertion using `__notestrTestGroups()` instead: after the switch, `assertS7` reads the post-switch context's loaded groups and asserts none of their `idStr` values appear in `priorGroupIds`. Groups shared between A and B (where `groupIdA === groupIdB`) are excluded from `priorGroupIds` to avoid false positives. See AC-S7-3 in `acceptance-criteria.md`.

The model tracks `pubkeyA`, `pubkeyB`, `groupIdA`, `groupIdB`, plus the post-`Sw` invalidation in `SwCommand.run`. Fill (reference, pre-implementation):

```ts
async function assertS7(m: ModelState, r: RealSystem): Promise<void> {
  // After any Sw, the post-switch context must have zero tasks belonging
  // to groups the prior identity was a member of.
  if (m.lastSwitched === null) return;
  const { context, priorGroupIds } = m.lastSwitched;
  const tasks = await r.getTasks(context);
  for (const task of tasks.values()) {
    expect(priorGroupIds).not.toContain(task.groupId);
  }
}
```

`SwCommand.run` populates `m.lastSwitched = { context: "A" | "B", priorGroupIds: string[] }` right before the switch. This requires extending `ModelState` with an optional `lastSwitched` field (already a per-run-resettable property by analogy to `epochSequenceA/B`).

#### 1.3 A14 in `LgCommand` and `FdCommand`

Replace the `tasksBefore` / `tasksAfter` capture-and-discard in `LgCommand.run` (lines 327–340) with a real subscriber assertion:

```ts
// Inside LgCommand.run, after the leave commit and member.recordEpoch():
const groupNostrIdHex = await getNostrGroupIdHex(r.pageA, m.groupIdA!);
const subscriber = await openNdkSubscriber([RELAY_URL]);
try {
  const filter: NDKFilter = {
    kinds: [445],
    "#h": [groupNostrIdHex],
  };
  // waitForDuration collects events for the full 2s and resolves with whatever
  // arrived — it never rejects on timeout. Distinct from waitForEvents, which
  // rejects when `count` events do not arrive within `timeoutMs`. The
  // waitForDuration method is added to `e2e/fixtures/ndk-subscriber.ts` as
  // part of this story (AC-A14-7).
  const events = await subscriber.waitForDuration(filter, 2000);
  // A14: no new kind-445 events arrive at the leaving context's relay
  // connection. Wire-level interpretation, not MLS decryption — see
  // AC-A14-8 for the precise semantics and the relay-filter assumption.
  expect(events.length).toBe(0);
} finally {
  await subscriber.close();
}
```

Apply the same pattern in `FdCommand.run` for the `leafCount === 1` branch (last-leaf case). For `leafCount > 1`, A14 does not apply (the pubkey still has remaining leaves and continues to receive events).

`getNostrGroupIdHex` is a thin Playwright `evaluate` over the existing `__notestrTestGroups()` hook to find the entry whose `idStr === groupIdA` and return its `nostrGroupIdHex`.

The dead `openNdkSubscriber` import becomes live by virtue of this wiring.

### Phase 2 — Test hooks + dependent fills

#### 2.1 Test hook additions

Append to `src/types/notestr-test-hooks.d.ts`:

```ts
declare global {
  interface Window {
    /** Test-only: read the MLS epoch for the group with the given idStr. */
    __notestrTestGroupEpoch?: (groupIdStr: string) => number | null;

    /** Test-only: read the sorted member pubkey set for a group. */
    __notestrTestGroupMembers?: (groupIdStr: string) => string[] | null;

    /** Test-only: count leaves belonging to a pubkey in a group. */
    __notestrTestPubkeyLeafCount?: (groupIdStr: string, pubkeyHex: string) => number;
  }
}
```

Install site is `src/marmot/client.tsx:446` (the file that installs `__notestrTestPubkeyLeafIndexes`); add the three new hooks alongside. Each hook resolves the group by `idStr`, calls the production helper (`getGroupMembers`, `getPubkeyLeafNodes`, or reads `g.state.groupContext.epoch`), and returns the result. The epoch hook coerces `bigint` to `number` via `Number(g.state.groupContext.epoch)` — see AC-HOOK-3 for the rationale. All three are read-only and side-effect-free.

#### 2.2 `assertC0` full settled-state equality

Extend (do not replace) the current task-subset check at `multi-user.property.spec.ts:830`:

```ts
async function assertC0(m: ModelState, r: RealSystem): Promise<void> {
  if (!m.memberA || !m.memberB || !m.groupIdA || !m.groupIdB) return;

  // Existing task-subset check (id set, status, assignee, title) — unchanged.
  // ...

  // New: members equality.
  const membersA = await getGroupMembersHook(r.pageA, m.groupIdA);
  const membersB = await getGroupMembersHook(r.pageB, m.groupIdB);
  expect(membersA).not.toBeNull();
  expect(membersB).not.toBeNull();
  expect(new Set(membersA!)).toEqual(new Set(membersB!));

  // New: epoch equality.
  const epochA = await getGroupEpochHook(r.pageA, m.groupIdA);
  const epochB = await getGroupEpochHook(r.pageB, m.groupIdB);
  expect(epochA).toBe(epochB);

  // New: per-pubkey leaf-count equality.
  for (const p of new Set([...(membersA ?? []), ...(membersB ?? [])])) {
    const lcA = await getPubkeyLeafCountHook(r.pageA, m.groupIdA, p);
    const lcB = await getPubkeyLeafCountHook(r.pageB, m.groupIdB, p);
    expect(lcA).toBe(lcB);
  }
}
```

`getGroupMembersHook`, `getGroupEpochHook`, `getPubkeyLeafCountHook` are thin `page.evaluate(...)` wrappers in `e2e/fixtures/two-party.ts` mirroring the existing `leafIndexesFor` style.

#### 2.3 `assertS6` epoch monotonicity

```ts
async function assertS6(m: ModelState): Promise<void> {
  for (const seq of [m.epochSequenceA, m.epochSequenceB]) {
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    }
  }
}
```

Pre-requisite: `recordEpoch` calls in commands must use `__notestrTestGroupEpoch`, not `groups.length`. Audit the call sites of `recordEpoch` (currently in `LgCommand`, `FdCommand`, `InCommand`, etc.) and switch each to read the real epoch via the new hook before recording.

The `assertS6` body comment about the proxy being non-monotonic is removed once the real epoch is recorded.

### Story Breakdown

- **S1 — `assertS5` biconditional (partial form), scoped to current group.** ~20 LOC. No prerequisites. Closes AC-S5-1 through AC-S5-4 — the partial, model-flag-based form (uses `m.memberA`/`m.memberB` as truth, asserts both directions against `leafIndexesFor`). Strengthens AC-FS-6 partially; the full hook-based biconditional lands in S5 as AC-S5-5.
- **S2 — `assertS7` fill via `lastSwitched` model field.** ~30 LOC. Requires extending `ModelState` and `SwCommand.run` to populate the field. Closes AC-FS-8.
- **S3 — A14 wiring in `LgCommand` and `FdCommand` via `openNdkSubscriber`.** ~65 LOC (was ~50; +15 for the `waitForDuration` addition to `e2e/fixtures/ndk-subscriber.ts`). Replaces the dead-code capture-and-discard, makes the import live, adds the `waitForDuration` fixture helper. Closes AC-A14-1 through AC-A14-8. Strengthens AC-FS-11 (with the wire-level interpretation documented in AC-A14-8).
- **S4 — Add three test hooks (epoch / members / leaf-count).** ~50 LOC across `notestr-test-hooks.d.ts` and `src/marmot/client.tsx`. No assertion changes. Pure infrastructure. Epoch hook coerces `bigint` to `number` via `Number(...)`.
- **S5 — `assertC0` full version + `assertS5` full biconditional via hooks.** ~50 LOC (was ~40; +10 for the `assertS5` rewrite). Depends on S4. Closes AC-FS-5 strict form. Also closes AC-S5-5 (rewrites `assertS5` from the model-flag partial form to the hook-based full biconditional, replacing the body S1 wrote).
- **S6 — `assertS6` epoch monotonicity + `recordEpoch` swap to real epoch hook.** ~30 LOC. Depends on S4. Closes AC-FS-7 strict form.
- **S7 — `assertS10` switch to `__notestrTestPubkeyLeafCount` and assert equality.** ~10 LOC. Depends on S4. Closes AC-FS-9 strict form.
- **S8 — AC-VAL-1 re-run.** Manual one-shot. Flip `>=` to `>` at `src/store/task-reducer.ts:16`, run `make test-property`, capture the counterexample, revert. Document in epic completion notes.

S1, S2, S3 can land in any order independently of S4. S5, S6, S7 all depend on S4. **S5 also depends on S1** because it rewrites the body S1 authored (the partial assertS5 becomes the full hook-based one). S8 should run after S1–S7 land.

## Acceptance Criteria

See `acceptance-criteria.md`.

## Relationship to Other Epics

- **`epic-property-based-invariants`** — this epic ratifies the assertion surface that one promised. Every AC in this epic references an AC-FS-X from the parent epic and replaces "implementation present" with "implementation enforces the invariant".
- **`epic-property-tests-l3-three-party`** — independent. 3-party adds new commands and a third context; this epic does not touch the command set.
- **`epic-property-tests-l3-multi-device`** — independent. Multi-device same-pubkey requires a structural rework of the actor/identity split that this epic does not.
- **`docs/two-party-permutation-matrix.md`** — the *Property-test coverage* table currently overstates A14 enforcement. Once this epic ships, the table is accurate; no edit is needed.

## Non-Goals

- Removing or weakening any invariant. The catalogue at `epic-property-based-invariants/spec.md` is unchanged.
- Replacing the existing `assertC0` task-subset check. The check is extended in place.
- Changing the L3 budget (`numRuns: 20`, `maxCommands: 10`).
- Auto-resetting browser / bunker / IndexedDB between fc.commands runs to make `assertS5` cleanly bidirectional without scoping. The original epic explicitly rejected per-run reset for wall-clock reasons; this epic respects that decision.
- Adding a new property test file. All changes are in the existing L3 file plus the test-hooks shim.
- Backporting these checks to L1 / L2. The reducer-layer property tests already cover their own invariants (S1–S4, A1–A6, etc.) at higher run counts.

## Amendments

### 2026-05-18 — Pre-implementation validation pass

`base:spec-validator` flagged five issues during Step 2 of `/base:feature`. All five were resolved before the planning phase via the following amendments:

1. **Epoch type — `bigint` vs `number`.** `groupContext.epoch` is `bigint` in ts-mls; the original AC-HOOK-3 declared the hook returns `number` without specifying the coercion. AC-HOOK-3 amended to specify `Number(g.state.groupContext.epoch)`; § 2.1 of this spec updated to match. Test scenarios never approach `Number.MAX_SAFE_INTEGER`, so precision loss is acceptable.
2. **`waitForEvents` arity / semantics — fixture rejects on timeout.** The original § 1.3 code sample called `subscriber.waitForEvents(filter, 2000)` with two arguments where the fixture requires `(filter, count, timeoutMs)`, AND the fixture rejects on timeout rather than resolving with partial results. Resolution: add a new `waitForDuration(filter, ms)` method to `e2e/fixtures/ndk-subscriber.ts` that resolves after `ms` with whatever arrived and never rejects. New AC-A14-7 specifies the method; § 1.3 code sample updated. S3 LOC estimate raised from ~50 to ~65; `e2e/fixtures/ndk-subscriber.ts` added to the AC-X-NO-PROD-CHANGE-COMP-1 allow-list.
3. **AC-S5-1 spanning S1 and S5 incompatibly.** The original AC-S5-1 described the full biconditional, which only becomes true after S4's hooks land; but S1 was scheduled to close it pre-S4. Split: AC-S5-1 rewritten to describe S1's partial model-flag-based biconditional; new AC-S5-5 captures the full hook-based biconditional that S5 rewrites `assertS5` to. Story breakdown updated to reflect S5's new dependency on S1 (S5 rewrites the body S1 authored).
4. **AC-X-NO-PROD-CHANGE-COMP-1 install-site ambiguity.** The original guard text said "a single file under `src/store/` or `src/marmot/`" without naming the file. Grep confirmed install site is `src/marmot/client.tsx:446`. AC-X-NO-PROD-CHANGE-COMP-1 amended to name the file explicitly so the diff check is mechanical.
5. **A14 wire-level vs. decryption.** Parent AC-FS-11 says "decryptable" but the ndk-subscriber fixture observes wire-level deliveries, not MLS decryption. Resolution: codify the wire-level interpretation in new AC-A14-8 with the relay-filter assumption (ephemeral strfry honours `#h` tag filtering). This is the operational meaning of "decryptable" for this epic; a stronger decryption-attempt assertion is deferred to a future epic if needed.

No story renumbering occurred. Acceptance-criteria edits are confined to: AC-S5-1 (rewritten), AC-S5-5 (new), AC-HOOK-3 (tightened), AC-A14-1 (uses `waitForDuration`), AC-A14-7 (new fixture helper), AC-A14-8 (new interpretation note), AC-X-NO-PROD-CHANGE-COMP-1 (install site named + fixture path added).

### 2026-05-18 — S2 implementation adaptation: assertS7 operates at group level

The spec's §1.2 reference implementation for `assertS7` uses `task.groupId` as the truth side. During S2 implementation it emerged that the `Task` interface has no `groupId` field — the task store is partitioned by which `TaskStoreProvider` is mounted, not by a property on the task object. The architect adapted: `assertS7` now asserts at group level by reading `__notestrTestGroups()` on the post-switch context and asserting no loaded group's `idStr` appears in `priorGroupIds`. Groups shared between A and B are excluded from `priorGroupIds` to prevent false positives when the post-switch identity legitimately loads a group it was already a member of. The §1.2 reference code is annotated accordingly. AC-S7-3 in `acceptance-criteria.md` reflects the group-level semantics. This adaptation is sound and arguably stronger than per-task checking (it catches groups loaded with no tasks).
