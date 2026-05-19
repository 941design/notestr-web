# Property Tests Layer-3 Multi-Device Coverage — Acceptance Criteria

These criteria are derived from `spec.md` and map to the stories in the spec's § *Stories*. Each AC is observable from a test run and references the matrix scenario family or invariant ID it covers.

## Terminology

- **MD file** — `e2e/tests/multi-user-md.property.spec.ts`.
- **Identity** — `"A" | "B"`. The nostr identity (pubkey).
- **Device** — `"A1" | "A2" | "B"`. A page authenticated to a bunker. Devices A1 and A2 share identity A's pubkey.
- **Strict form** — assertions wired with the test hooks from `epic-property-tests-l3-completion`.
- **Degraded form** — assertions wired without those hooks (task-subset only).

## S1 — Skeleton

- **AC-MD-FILE-1** — `e2e/tests/multi-user-md.property.spec.ts` exists.
- **AC-MD-FILE-2** — `npx playwright test multi-user-md.property.spec.ts` discovers exactly one test.
- **AC-MD-FILE-3** — Test title contains the bracketed invariant IDs `[A15,C0]` or wider (e.g. `[A15,C0,S5,S6,S10]`).
- **AC-MD-FILE-4** — `test.beforeAll` creates three contexts: two against `E2E_BUNKER_URL` (for A1, A2), one against `E2E_BUNKER_B_URL` (for B). `test.afterAll` closes all three.
- **AC-MD-FILE-5** — `pageA1` is authenticated in `beforeAll`. `pageA2` is created but **not authenticated** in `beforeAll` — authentication happens lazily inside `AttachA2Command_MD`.
- **AC-MD-FILE-6** — `cachedPubkeyA = getPubkeyHex(pageA1)` and `cachedPubkeyB = getPubkeyHex(pageB)` are captured once in `beforeAll`. There is no `cachedPubkeyA2` — A2 shares pubkey A.
- **AC-MD-FILE-7** — In `beforeAll`, `authenticate` for A1 MUST pass an explicit slot string (e.g. `authenticate(pageA1, E2E_BUNKER_URL, "A1")`). `pageA2` is NOT authenticated in `beforeAll` but `AttachA2Command_MD.run` MUST call `authenticate(r.pageA2, E2E_BUNKER_URL, "A2")` with an explicit distinct slot. Two contexts that share `E2E_BUNKER_URL` without distinct slot strings derive the same slot from the bunker pubkey; only one KP lands on the relay and A2 never appears as a separate leaf.
- **AC-MD-FILE-8** — In `beforeAll`, `pageB` (bunker B) MUST be authenticated before `pageA1` (bunker A). B's key package MUST be on the relay before `InCommand_MD` fires. Verifiable by reading `beforeAll`: the `authenticate(pageB, …)` call MUST precede the `authenticate(pageA1, …)` call.

## S2 — `AttachA2Command_MD` and `awaitDeviceJoin`

- **AC-MD-ATTACH-1** — `AttachA2Command_MD.check(m)` returns `true` only when `m.membersA1 && m.groupId !== null && !m.membersA2`. The command never fires twice in one run.
- **AC-MD-ATTACH-2** — `AttachA2Command_MD.run` MUST call `authenticate(r.pageA2, E2E_BUNKER_URL, "A2")` (explicit slot `"A2"` is mandatory — see AC-MD-FILE-7), awaits the welcome via `awaitDeviceJoin`, sets `m.membersA2 = true`, and records the initial epoch into `m.epochSequenceA2`.
- **AC-MD-ATTACH-3** — `awaitDeviceJoin(pageNew, primaryPage, groupId)` polls the leaf count for `pubkeyA` on `primaryPage` until `>= 2`, with a 30-second timeout; on timeout it MUST throw. The poll MUST use either `leafIndexesFor(primaryPage, groupId, pubkeyA)` (preferred — mirrors `forget-device-sibling.spec.ts:136-138`) or `__notestrTestPubkeyLeafCount(groupId, pubkeyA)` directly via `getPubkeyLeafCountHook`; both are acceptable.
- **AC-MD-ATTACH-4** — `AttachA2Command_MD.run`'s postcondition asserts `leafIndexesFor(r.pageA1, m.groupId, m.pubkeyA).length >= 2`.
- **AC-MD-ATTACH-5** — `toString()` returns `"A2.Attach()"`.
- **AC-MD-ATTACH-6** — A deliberate regression (e.g. throw inside the welcome handler) causes a counterexample to print whose chain ends in `A2.Attach()`. Verified once during implementation, then reverted.

## S3 — Per-device commands

- **AC-MD-CT-1** — `CtCommand_MD(device, title, desc)` accepts `device: Device`. `check(m)` returns `true` only when `m.deviceIsMember(device) && m.groupId !== null`.
- **AC-MD-UT-1**, **AC-MD-SC-1**, **AC-MD-AS-1**, **AC-MD-UN-1**, **AC-MD-DT-1** — each accepts `device: Device` and dispatches on `r.page(device)`. Postconditions follow the 2-party pattern (A3 / A2 / A4 / A4 / A5).
- **AC-MD-RL-1** — `RlCommand_MD(device)` reloads `r.page(device)`. Post-reload, the model and the actual state should still agree on the device's view (A11).
- **AC-MD-CMD-TOSTRING-1** — every command's `toString()` returns `${device}.Verb(args)` (e.g. `A2.Ct(title)`, `B.Sc(open)`).

## S4 — Group-lifecycle commands

- **AC-MD-CG-1** — `CgCommand_MD` dispatches the group creation on `pageA1` only. `check(m)` returns `true` only when `m.groupId === null && !m.membersA1`. Postcondition: `m.membersA1 = true`, `m.groupId` set.
- **AC-MD-IN-1** — `InCommand_MD` invites B from `pageA1`. `check(m)` returns `true` only when `m.membersA1 && !m.membersB`.
- **AC-MD-LG-1** — `LgCommand_MD(device)` for `device ∈ {"A1", "A2", "B"}` lets the device leave through its own page. Postcondition: `m.deviceIsMember(device) = false`.
- **AC-MD-LG-2** — When `device = "A1"` and `m.membersA2`, the leave reduces identity A's leaf count from 2 to 1; A is still a member of the group through A2. The model encodes this.
- **AC-MD-FD-1** — `FdCommand_MD` lets A1 forget one of A's leaves. `check(m)` returns `true` only when `m.membersA1 && m.membersA2 && m.groupId !== null`.
- **AC-MD-FD-2** — Postcondition: leafCount(g, A) drops by 1. If it reaches 1, identity A still has one leaf; if 0, A is removed (this branch is unreachable when the precondition requires both A1 and A2 as members).
- **AC-MD-RD-1** — `RdCommand_MD(device, name)` renames the device on the device's own page.

## S5 — Headline assertions

### Strict form (test hooks present)

- **AC-MD-A15-1** — `assertA15_MD` runs only when `m.groupId !== null && m.membersA1 && m.membersA2`. Otherwise returns silently.
- **AC-MD-A15-2** — When triggered, asserts task-id sets equal between A1 and A2; per shared id, `status`, `assignee`, `title` match.
- **AC-MD-A15-3** — When triggered, asserts `members(A1) == members(A2)` via `__notestrTestGroupMembers`.
- **AC-MD-A15-4** — When triggered, asserts `epoch(A1) == epoch(A2)` via `__notestrTestGroupEpoch`.
- **AC-MD-A15-5** — When triggered, asserts `leafCount(g, p)` matches between A1 and A2 for every member pubkey.
- **AC-MD-C0-1** — `assertC0_MD` runs only when all three (A1, A2, B) are members of the same group. Asserts the four dimensions across all three pages.
- **AC-MD-S5-1** — `assertS5_MD` asserts `(p ∈ members) ⇔ (leafCount >= 1)` for `pubkeyA` and `pubkeyB` separately, scoped to `m.groupId`. For pubkeyA, the expected leaf count is 2 when both A1 and A2 are attached, 1 after either has left or been forgotten.
- **AC-MD-S6-1** — `assertS6_MD` asserts each of `epochSequenceA1`, `epochSequenceA2`, `epochSequenceB` is non-decreasing.
- **AC-MD-S10-1** — `assertS10_MD` reads `[data-testid="device-row"]` count on `pageA1` and on `pageA2`. Each must equal `getPubkeyLeafCountHook(page, m.groupId, m.pubkeyA)`.

### Degraded form (test hooks not yet present)

- **AC-MD-DEG-1** — Without test hooks, `assertA15_MD` falls back to task-subset only. `assertC0_MD` likewise. `assertS5_MD` runs the positive direction only. `assertS6_MD` records via the proxy from the 2-party file. `assertS10_MD` asserts `>= 0`.
- **AC-MD-DEG-2** — A code comment at the top of each degraded assertion names this AC and points at `epic-property-tests-l3-completion`'s test-hook story.

## S6 — Property test wiring

- **AC-MD-RUN-1** — `fc.commands` array contains exactly the command arbitraries listed in spec.md § *Single test wiring*.
- **AC-MD-RUN-2** — `fc.assert` runs with `numRuns: 12` and `fc.commands(..., { maxCommands: 8 })`.
- **AC-MD-RUN-3** — `FAST_CHECK_SEED` and `FAST_CHECK_PATH` env vars are honoured.
- **AC-MD-RUN-4** — `test.setTimeout(720_000)` (12 minutes).
- **AC-MD-RUN-5** — A counterexample print includes `A2.*` commands when relevant. Per AC-FS-12 verification: deliberately inject a divergence reachable only after `A2.Attach`, observe the printed chain contains `A2.Attach()` followed by an A2-targeted command. Verified once during implementation, then reverted.

## S7 — Coverage table edit

- **AC-MD-DOC-1** — `docs/two-party-permutation-matrix.md` § *Property-test coverage* TP-80..82 row reads "A15, C0, S5, S6, S10 (multi-device at L3)" instead of "A15, C0".
- **AC-MD-DOC-2** — A footnote captures the TP-52 caveat: "Leaf-count consequence asserted; full forget-self membership behaviour pending the `(fixme)` resolution in `epic-multi-device-sync`."
- **AC-MD-DOC-3** — No other rows in the coverage table are modified.

## S8 — Wall-clock validation

- **AC-MD-WC-1** — `make e2e` against the MD file alone is run three times locally. Maximum observed wall-clock is recorded in epic completion notes.
- **AC-MD-WC-2** — If any of the three runs exceeds 720 seconds, `numRuns` is reduced to 10 (or `maxCommands` to 6) and the validation is repeated. Final values are captured in code comments.
- **AC-MD-WC-3** — On CI, the MD file's runtime appears in the post-merge log within the same envelope. Sustained breach (≥3 consecutive merges) triggers a follow-up to tune.

## Cross-Cutting Invariants

- **AC-X-NO-PROD-CHANGE-MD-1** — No file under `src/marmot/`, `src/store/`, or `src/components/` is modified. Verified by `git diff --stat origin/master...` showing changes only under `e2e/tests/multi-user-md.property.spec.ts`, `e2e/fixtures/multi-device.ts`, `e2e/fixtures/two-party.ts` (additive helpers if needed), `docs/two-party-permutation-matrix.md`, this epic's `specs/` directory.
- **AC-X-NO-2P-CHANGE-MD-1** — `e2e/tests/multi-user.property.spec.ts` is not modified.
- **AC-X-NO-3P-CHANGE-MD-1** — If `epic-property-tests-l3-three-party` has shipped, `e2e/tests/multi-user-3p.property.spec.ts` is not modified.
- **AC-X-NO-EXAMPLE-DELETION-MD-1** — `e2e/tests/multi-device-cross-npub.spec.ts`, `e2e/tests/multi-device-sync.spec.ts`, and `e2e/tests/multi-user.spec.ts` are not deleted, renamed, or `.skip`-ed.
- **AC-X-CI-MD-1** — `make test` is unaffected. `make e2e` runs the MD file as part of the suite.
- **AC-X-CI-MD-2** — A failing assertion shrinks to a minimal counterexample whose printout names the relevant device(s).
- **AC-X-NAMING-MD-1** — Every property-test `it`/`test` title contains the asserted invariant IDs in brackets.
- **AC-X-RUNS-MD-1** — Default `numRuns` is 12. `FAST_CHECK_NUM_RUNS` env override is honoured.

## Manual Validation

- **AC-VAL-MD-1 (one-shot)** — After landing, deliberately introduce an A1↔A2 divergence (e.g. comment out the IndexedDB persistence call so A2 never sees A1's task creates after a `Rl`). Run `make e2e` against the MD file. A counterexample appears whose chain includes `A2.Attach()`, an A1-dispatched task event, and an A2 reload, with the post-reload A2 view diverging from A1. Revert. Documented in epic completion notes.
- **AC-VAL-MD-2 (one-shot)** — Deliberately introduce a leaf-count regression (e.g. modify `getPubkeyLeafNodes` to return `length - 1`). The MD file's `assertS5_MD` and `assertS10_MD` should both fail with non-equal leaf counts. Revert. Documented in epic completion notes.
