# Property Tests Layer-3 Completion — Acceptance Criteria

These criteria are derived from `spec.md` and map to the stories in the spec's § *Story Breakdown*. Each AC is observable from a test run (CI log or local invocation) and references the AC-FS-X identifier from `specs/epic-property-based-invariants/acceptance-criteria.md` it strengthens.

## Terminology

- **Strict form** — the AC text from `epic-property-based-invariants/acceptance-criteria.md` taken literally (e.g. AC-FS-9 says "the count of `data-testid="device-row"` rows equals `getPubkeyLeafNodes(g.state, p).length`", which the current implementation does not assert).
- **L3 file** — `e2e/tests/multi-user.property.spec.ts`.
- **Test hook** — a `__notestrTest*` symbol declared on `Window` in `src/types/notestr-test-hooks.d.ts` and installed in production code paths under a test-only branch.

## S1 — assertS5 biconditional (partial form, model-flag-based)

S1 lands before the Phase 2 hooks (S4) exist, so the biconditional is established via the model's `memberA`/`memberB` flags as the truth side and `leafIndexesFor(...).length` as the observable side. The full hook-based biconditional is enforced by S5 (see AC-S5-5 below).

- **AC-S5-1** — `assertS5` asserts the biconditional via model flags: for each `(pubkey, isMember)` in `[(m.pubkeyA, m.memberA), (m.pubkeyB, m.memberB)]`, when `isMember === true` it asserts `leafCount(m.groupIdA, pubkey) >= 1`; when `isMember === false` it asserts `leafCount(m.groupIdA, pubkey) === 0`. Both directions are checked. Strengthens AC-FS-6 (partial).
- **AC-S5-2** — The check is scoped to `m.groupIdA` only. Pubkey-B leaves in older groups do not cause a false negative. A passing run with cross-run leftover state in older groups is still green.
- **AC-S5-3** — When `m.groupIdA` is `null` or either pubkey is `null`, the assertion returns without throwing (early-return path).
- **AC-S5-4** — A deliberate model-state mismatch (e.g. set `m.memberB = false` while B is actually a member) causes the assertion to fail. Verified once during implementation, then reverted.

## S2 — assertS7 fill

- **AC-S7-1** — `ModelState` gains a field `lastSwitched: { context: ActorId; priorGroupIds: string[] } | null`, initialised to `null` in the constructor AND reset to `null` in `model.reset()` so that cross-run state does not bleed from run N into run N+1.
- **AC-S7-2** — `SwCommand.run` populates `lastSwitched` immediately before issuing the switch, capturing the prior identity's `groupIdA`/`groupIdB` set.
- **AC-S7-3** — `assertS7` reads the post-switch `__notestrTestTasks` and asserts that no task carries a `groupId` in `lastSwitched.priorGroupIds`.
- **AC-S7-4** — When `lastSwitched` is `null` (no `Sw` fired in the run), `assertS7` returns without asserting. The describe-block title `S7` claim is honoured: the assertion runs *only* when there is something to check, but it runs whenever there is.
- **AC-S7-5** — The original comment in `assertS7` claiming "this is checked in `SwCommand.run` directly" is removed because the assertion now lives in `assertS7`. Strengthens AC-FS-8.

## S3 — A14 via openNdkSubscriber

- **AC-A14-1** — `LgCommand.run` opens an `NdkSubscriber` on `[RELAY_URL]`, subscribes to `{ kinds: [445], "#h": [groupNostrIdHex] }`, calls `waitForDuration(filter, 2000)` (added in AC-A14-7), and asserts the returned event count is `0`. Closes the subscriber in a `finally` block.
- **AC-A14-2** — `FdCommand.run` performs the same subscription wait in the `leafCount === 1` (last-leaf) branch only. The `leafCount > 1` branch retains its existing A10 check and does not subscribe.
- **AC-A14-3** — `getNostrGroupIdHex(page, groupIdStr)` is added to `e2e/fixtures/two-party.ts`. It reads `__notestrTestGroups()`, finds the entry with matching `idStr`, and returns its `nostrGroupIdHex`. Throws if not found.
- **AC-A14-4** — The `tasksBefore` / `tasksAfter` capture-and-discard at `LgCommand.run:329-340` and `FdCommand.run:384-389` is removed in the same change.
- **AC-A14-5** — The `openNdkSubscriber` import at L3:41 is no longer dead. Removing it would now break the build.
- **AC-A14-6** — A deliberate regression (e.g. comment out the leave commit so kind-445 traffic continues unabated) causes the A14 assertion to fail with a non-zero event count. Verified once during implementation, then reverted. Strengthens AC-FS-11.
- **AC-A14-7** — `waitForDuration(filter: NDKFilter, ms: number): Promise<NDKEvent[]>` is added to the `NdkSubscriber` interface in `e2e/fixtures/ndk-subscriber.ts`. It subscribes to the relay, collects events for exactly `ms` milliseconds (using `setTimeout` to settle), then resolves with all events received. It NEVER rejects on timeout (the existing `waitForEvents` rejects when `count` is not met; `waitForDuration` is the never-reject variant). Closes the subscription on resolve.
- **AC-A14-8** — Interpretation note: A14 asserts wire-level delivery (zero kind-445 events arrive at the subscriber's relay connection in the 2-second window), not MLS decryption. The semantics depend on the ephemeral e2e relay honouring `#h` tag filtering and on the strfry container not forwarding kind-445 events to a connection whose subscription filter does not match. This is the operational meaning of "decryptable" in AC-FS-11 for this epic: the leaving user's relay connection no longer sees in-group traffic. If a future epic needs the stronger decryption-attempt assertion, it can extend the fixture.

## S4 — Test hook additions

- **AC-HOOK-1** — `src/types/notestr-test-hooks.d.ts` declares three new optional `Window` properties: `__notestrTestGroupEpoch`, `__notestrTestGroupMembers`, `__notestrTestPubkeyLeafCount`.
- **AC-HOOK-2** — All three hooks are installed at the same site as `__notestrTestPubkeyLeafIndexes`. Each resolves the group by `idStr` (matching how the existing leaf-indexes hook does it).
- **AC-HOOK-3** — `__notestrTestGroupEpoch(idStr)` returns `Number(g.state.groupContext.epoch)` (coerced from `bigint`, which is the ts-mls representation), or `null` if no group with that idStr is loaded. Precision loss is acceptable; epoch values in property-test scenarios never approach `Number.MAX_SAFE_INTEGER`.
- **AC-HOOK-4** — `__notestrTestGroupMembers(idStr)` returns `getGroupMembers(g.state)` as a sorted array of hex strings, or `null` if absent.
- **AC-HOOK-5** — `__notestrTestPubkeyLeafCount(idStr, pubkeyHex)` returns `getPubkeyLeafNodes(g.state, pubkeyHex).length`. Returns `0` for unknown pubkeys (matching how the existing leaf-indexes hook treats absence).
- **AC-HOOK-6** — None of the new hooks mutate state. `tsc --noEmit` passes; the production build is unaffected.
- **AC-HOOK-7** — `e2e/fixtures/two-party.ts` exports three thin `page.evaluate(...)` wrappers (`getGroupMembersHook`, `getGroupEpochHook`, `getPubkeyLeafCountHook`) mirroring the `leafIndexesFor` style. Each throws if the corresponding hook is not installed (matching `leafIndexesFor`'s behaviour).

## S5 — assertC0 full version (and assertS5 full biconditional via hooks)

- **AC-C0-1** — The existing task-subset assertions (id set, status, assignee, title) at `multi-user.property.spec.ts:830-855` are unchanged.
- **AC-C0-2** — When `m.memberA && m.memberB && m.groupIdA && m.groupIdB`, `assertC0` additionally asserts `new Set(membersA) deep-equals new Set(membersB)`.
- **AC-C0-3** — Under the same precondition, `assertC0` asserts `epochA === epochB`.
- **AC-C0-4** — Under the same precondition, `assertC0` asserts `leafCount(g, p)` matches across A and B for every `p ∈ membersA ∪ membersB`.
- **AC-C0-5** — A deliberate divergence (e.g. inject a stale read on B's side that returns a different epoch) causes the assertion to fail. Verified once during implementation, then reverted. Strengthens AC-FS-5.
- **AC-S5-5** — `assertS5` is rewritten to use the hook-based full biconditional: for every `p ∈ {m.pubkeyA, m.pubkeyB}`, assert `membersA.includes(p) === (leafCount(m.groupIdA, p) >= 1)` where `membersA` comes from `getGroupMembersHook(r.pageA, m.groupIdA)`. This replaces the model-flag-based partial form from AC-S5-1 with the truth from the production `getGroupMembers` helper. Strengthens AC-FS-6 (full).

## S6 — assertS6 monotonicity + recordEpoch swap

- **AC-S6-1** — Every `recordEpoch(actor, ...)` call site in the L3 file passes the value returned by `__notestrTestGroupEpoch(actorPage, groupId)` rather than `(await __notestrTestGroups()).length` or any other proxy.
- **AC-S6-2** — `assertS6` walks `epochSequenceA` and `epochSequenceB` and asserts each sequence is non-decreasing (`seq[i] >= seq[i-1]` for all `i >= 1`).
- **AC-S6-3** — When the epoch is unavailable (group not loaded, hook returns `null`), `recordEpoch` does not push to the sequence. The monotonicity assertion is therefore over only the values that were actually observed.
- **AC-S6-4** — A deliberate regression (e.g. record a forged decreasing epoch) causes the assertion to fail. Verified once during implementation, then reverted. Strengthens AC-FS-7.

## S7 — assertS10 strict equality

- **AC-S10-1** — `assertS10` reads `getPubkeyLeafCountHook(r.pageA, m.groupIdA, m.pubkeyA)` and asserts it equals `await r.pageA.locator('[data-testid="device-row"]').count()`.
- **AC-S10-2** — The previous `expect(deviceRows).toBeGreaterThanOrEqual(0)` is removed.
- **AC-S10-3** — When `m.groupIdA` or `m.pubkeyA` is `null`, the assertion returns without throwing.
- **AC-S10-4** — A deliberate UI regression (e.g. introduce a stray `data-testid="device-row"` element) causes the assertion to fail. Verified once during implementation, then reverted. Strengthens AC-FS-9.

## S8 — AC-VAL-1 re-run

- **AC-VAL-1-RR-1** — With Phase 1 + Phase 2 merged, `src/store/task-reducer.ts:16` is manually edited from `>=` to `>`. `make test-property` (with default `FAST_CHECK_NUM_RUNS=10000`) is invoked.
- **AC-VAL-1-RR-2** — A counterexample appears within 60 seconds. The shrunk counterexample contains an event sequence with at least one pair of events sharing an `updatedAt` value.
- **AC-VAL-1-RR-3** — The reducer change is reverted (verified by `git diff src/store/task-reducer.ts` returning empty).
- **AC-VAL-1-RR-4** — A short note is appended to the epic completion record (e.g. a comment in the merge commit or a follow-up entry in `e2e/tests/property-tests.md`) capturing the seed, the counterexample text, and the elapsed wall-clock to first failure.

## Cross-Cutting Invariants

- **AC-X-NO-PROD-CHANGE-COMP-1** — No file under `src/marmot/`, `src/store/task-events.ts`, `src/store/task-reducer.ts`, `src/store/task-store.tsx`, `src/store/persistence.ts`, or `src/components/` is modified except for the test-hook install site at `src/marmot/client.tsx` (the file that already installs `__notestrTestPubkeyLeafIndexes` at line 446). Verified by `git diff --stat origin/master...` showing changes only under `src/marmot/client.tsx`, `src/types/notestr-test-hooks.d.ts`, `e2e/tests/multi-user.property.spec.ts`, `e2e/fixtures/two-party.ts`, `e2e/fixtures/ndk-subscriber.ts` (for AC-A14-7's `waitForDuration` addition), this epic's `specs/` directory, and (for AC-VAL-1-RR-4) `e2e/tests/property-tests.md`.
- **AC-X-NO-EXAMPLE-DELETION-COMP-1** — No existing example-based test file is deleted, renamed, or `.skip`-ed.
- **AC-X-DESCRIBE-TITLE-1** — The `test.describe.serial` block title at L3:962 (currently `[S5,S6,S7,S10,A7-A12,A14,C0]`) is unchanged after this epic. The epic's purpose is to make that claim true, not to modify it.
- **AC-X-COVERAGE-TABLE-1** — The *Property-test coverage* table in `docs/two-party-permutation-matrix.md` is unchanged. The epic strengthens enforcement of the invariants the table already names.
- **AC-X-CI-1** — `make test` continues to pass. `make e2e` continues to pass. The L3 wall-clock for the property test alone remains within the 10-minute envelope per AC-FS-4.
- **AC-X-CI-2** — A failing assertion (in `assertC0`-full, `assertS5`-biconditional, `assertS6`-monotonicity, `assertS7`-isolation, `assertS10`-equality, or A14 in Lg/Fd) shrinks to a minimal counterexample whose `Actor.Verb(args)` printout is readable per AC-FS-12.
