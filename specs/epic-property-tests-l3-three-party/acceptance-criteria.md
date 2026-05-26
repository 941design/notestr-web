# Property Tests Layer-3 Three-Party Coverage — Acceptance Criteria

These criteria are derived from `spec.md` and map to the stories in the spec's § *Stories*. Each AC is observable from a test run and references the matrix scenario family or invariant ID it covers.

## Terminology

- **3P file** — `e2e/tests/multi-user-3p.property.spec.ts`.
- **Strict form** — the L3 invariant text from `epic-property-based-invariants/spec.md` § *Invariant Catalogue*, with assertions wired to all three actors A, B, C.
- **Degraded form** — assertions wired without the test hooks from `epic-property-tests-l3-completion`. C0 falls back to task-subset; S5 is positive-only; S6 records via the existing proxy.
- **TP-70c** — the chain-invite scenario `B.In(C)`, blocked by MIP-03 admin-only-commits in production. Listed `(fixme)` in `docs/two-party-permutation-matrix.md`.

## S1 — Skeleton (file existence and discovery)

- **AC-3P-FILE-1** — `e2e/tests/multi-user-3p.property.spec.ts` exists.
- **AC-3P-FILE-2** — `npx playwright test multi-user-3p.property.spec.ts` discovers exactly one test under one `test.describe.serial` block.
- **AC-3P-FILE-3** — The discovered test's title contains the bracketed invariant IDs `[C0,S5,S6,S7,S10]`.
- **AC-3P-FILE-4** — Three `BrowserContext` and three `Page` objects are created in `test.beforeAll` and torn down in `test.afterAll`. Each authenticates against its respective bunker (`E2E_BUNKER_URL`, `E2E_BUNKER_B_URL`, `E2E_BUNKER_C_URL`).
- **AC-3P-FILE-5** — `cachedPubkeyA`, `cachedPubkeyB`, `cachedPubkeyC` are read once after authentication and stored at module scope, mirroring the 2-party file's caching pattern.

## S2 — Per-actor command classes (`Ct`, `Ut`, `Sc`, `As`, `Un`, `Dt`, `Rl`)

- **AC-3P-CMD-CT-1** — `CtCommand3P(actor, title, desc)` constructor takes `actor: "A" | "B" | "C"`. `check(m)` returns true only when `m.actorIsMember(actor) && m.groupId !== null`.
- **AC-3P-CMD-UT-1** — `UtCommand3P(actor, title)` similarly accepts the three-actor type. The `run` body asserts the post-update task title via `r.getTask(actor, ...)`.
- **AC-3P-CMD-SC-1** — `ScCommand3P(actor, status)` checks status enum closure post-dispatch (per-command postcondition for A2).
- **AC-3P-CMD-AS-1**, **AC-3P-CMD-UN-1**, **AC-3P-CMD-DT-1**, **AC-3P-CMD-RL-1** — each takes `actor` and asserts its respective postcondition (A4 / A5 / A11). Postcondition shape mirrors the 2-party form.
- **AC-3P-CMD-TOSTRING-1** — every command's `toString()` returns `${actor}.Verb(args)` matching the matrix DSL. `C.Ct(title)`, `B.Sc(open)`, etc.

## S3 — Group-lifecycle commands (`Cg`, `In`, `Lg`, `Fd`, `Rd`, `Sw`)

- **AC-3P-CG-1** — `CgCommand3P` is admin-only: it dispatches the group creation on `pageA` only. `check(m)` returns true only when `m.groupId === null && !m.memberA`.
- **AC-3P-IN-1** — `InCommand3P(invitee)` takes `invitee: "B" | "C"` only. The inviter is always A. `check(m)` returns true only when `m.memberA && !m.actorIsMember(invitee)`.
- **AC-3P-IN-2** — A no-op variant where `invitee` is already a member is filtered out by `check`. Generated commands of that shape are pruned by fast-check, not silently no-op'd at `run` time.
- **AC-3P-LG-1** — `LgCommand3P(actor)` accepts `actor: "A" | "B" | "C"`. Each actor leaves through their own `pageX`.
- **AC-3P-FD-1** — `FdCommand3P(actor)` lets actor A forget any leaf belonging to B or C in the shared group. `check(m)` returns true only when `m.memberA && (m.memberB || m.memberC) && m.groupId !== null`. (Forget-by-non-admin is rejected at the model level for the same MIP-03 reason as `B.In(C)`.)
- **AC-3P-RD-1** — `RdCommand3P(actor, name)` is per-actor for the actor's own device.
- **AC-3P-SW-1** — `SwCommand3P` switches `pageA` between bunker A and bunker B *only*. The 3P harness does not generate A↔C or B↔C switches. The reason is documented inline in the file as a comment naming this AC.

## S4 — Headline assertions (depend on test hooks from `epic-property-tests-l3-completion`)

### Strict form (test hooks present)

- **AC-3P-C0-1** — `assertC0_3P` runs only when `m.groupId !== null && m.memberA && m.memberB && m.memberC`. Otherwise returns silently.
- **AC-3P-C0-2** — When triggered, `assertC0_3P` asserts: task-id sets pairwise equal across A/B/C; per shared task id the `status`, `assignee`, `title` match across all three.
- **AC-3P-C0-3** — When triggered, `assertC0_3P` asserts the member sets pairwise equal across all three actor views via `__notestrTestGroupMembers`.
- **AC-3P-C0-4** — When triggered, `assertC0_3P` asserts `epoch(A) == epoch(B) == epoch(C)` via `__notestrTestGroupEpoch`.
- **AC-3P-C0-5** — When triggered, `assertC0_3P` asserts `leafCount(g, p)` matches across all three actors for every `p ∈ unionMembers`.
- **AC-3P-S5-1** — `assertS5_3P` runs the biconditional `(p ∈ members) ⇔ (leafCount >= 1)` for each of `m.pubkeyA`, `m.pubkeyB`, `m.pubkeyC`, scoped to `m.groupId`. Cross-group pollution does not cause false negatives.
- **AC-3P-S6-1** — `assertS6_3P` walks each of `epochSequenceA`, `epochSequenceB`, `epochSequenceC` and asserts non-decreasing.
- **AC-3P-S7-1** — `assertS7_3P` triggers when `m.lastSwitched !== null`. It reads tasks on the post-switch context and asserts none belong to the prior identity's groups.
- **AC-3P-S10-1** — `assertS10_3P` reads `[data-testid="device-row"]` count on each actor's page and asserts equality with `getPubkeyLeafCountHook(page, m.groupId, ownPubkey)`.

### Degraded form (test hooks not yet present)

- **AC-3P-DEG-1** — If `epic-property-tests-l3-completion` has not shipped, the test still runs. `assertC0_3P` falls back to the task-subset check only. `assertS5_3P` checks the positive direction only (member ⇒ ≥1 leaf), scoped to `m.groupId`. `assertS6_3P` records via the same proxy as the 2-party file uses today and asserts non-decreasing on that proxy. `assertS10_3P` asserts `>= 0` only.
- **AC-3P-DEG-2** — A code comment at the top of each degraded assertion names this AC and points at `epic-property-tests-l3-completion`'s test-hook story.

## S5 — Property test wiring

- **AC-3P-RUN-1** — The `fc.commands` array contains exactly the command arbitraries listed in spec.md § *Single test, three-actor commands array*. No additional commands.
- **AC-3P-RUN-2** — `fc.assert` runs with `numRuns: 15` and `fc.commands(..., { maxCommands: 10 })`.
- **AC-3P-RUN-3** — The test honours `FAST_CHECK_SEED` and `FAST_CHECK_PATH` environment variables, identical to the 2-party file's pattern.
- **AC-3P-RUN-4** — `test.setTimeout(720_000)` (12 minutes).
- **AC-3P-RUN-5** — A counterexample print includes all three actors in the `Actor.Verb(args)` chain when relevant. Per AC-FS-12 verification: deliberately inject a failure that requires a `C.*` command, observe that the printed chain contains the C command. Verified once during implementation, then reverted.

## S6 — Coverage table edit

- **AC-3P-DOC-1** — `docs/two-party-permutation-matrix.md` § *Property-test coverage* TP-70..72 row reads "C0, S5, S6, S7, S10, A7..A12 (3-party at L3)" instead of "(covered by 2-party C0 + induction)".
- **AC-3P-DOC-2** — A footnote names TP-70c as labelled-only-blocked-by-MIP-03 with a link to the `(fixme)` annotation in the scenario catalogue.
- **AC-3P-DOC-3** — No other rows in the coverage table are modified.

## S7 — Wall-clock validation

- **AC-3P-WC-1** — `make e2e` against the 3P file alone is run three times locally on the developer machine. The maximum observed wall-clock is recorded in the epic completion notes.
- **AC-3P-WC-2** — If any of the three local runs exceeds 720 seconds, `numRuns` is reduced to 12 (or `maxCommands` to 8) and the validation is repeated. The chosen final value is captured in a code comment alongside the `numRuns:` literal.
- **AC-3P-WC-3** — On CI (whichever the project uses for `make e2e`), the 3P file's runtime appears in the post-merge log within the same envelope. A first-merge warning is acceptable; a sustained breach (≥3 consecutive merges over budget) triggers a follow-up to tune.

## Cross-Cutting Invariants

- **AC-X-NO-PROD-CHANGE-3P-1** — No file under `src/marmot/`, `src/store/`, or `src/components/` is modified. Verified by `git diff --stat origin/master...` showing changes only under `e2e/tests/multi-user-3p.property.spec.ts`, `e2e/fixtures/two-party.ts` (additive helper exports if needed), `docs/two-party-permutation-matrix.md`, this epic's `specs/` directory.
- **AC-X-NO-2P-CHANGE-1** — `e2e/tests/multi-user.property.spec.ts` is not modified by this epic.
- **AC-X-NO-EXAMPLE-DELETION-3P-1** — `e2e/tests/three-party.spec.ts` is not deleted, renamed, or `.skip`-ed. The example-based three-party tests remain.
- **AC-X-CI-3P-1** — `make test` is unaffected (no L1 or L2 changes). `make e2e` runs the 3P file as part of the suite.
- **AC-X-CI-3P-2** — A failing assertion shrinks to a minimal counterexample whose printout names all three actors when relevant.
- **AC-X-NAMING-3P-1** — Every property-test `it`/`test` title contains the asserted invariant IDs in brackets at the start, e.g. `[C0,S5,S6,S7,S10] settled-state equality holds across A/B/C`.
- **AC-X-RUNS-3P-1** — Default `numRuns` is 15. `FAST_CHECK_NUM_RUNS` env override is honoured.

## Manual Validation

- **AC-VAL-3P-1 (one-shot)** — After landing, deliberately introduce a 3-party-only divergence (e.g. comment out C's relay subscription so C never receives B's task events). Run `make e2e` against the 3P file. A counterexample appears whose chain includes a `C.*` command and a B-or-A-dispatched task event that C cannot see post-quiesce. Revert. Documented in epic completion notes; not an automated test.
