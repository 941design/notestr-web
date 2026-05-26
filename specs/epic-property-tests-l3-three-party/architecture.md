# Architecture — Property Tests Layer-3 Three-Party Coverage

This is a **test-only** epic. It adds one Playwright + fast-check property-test
file and edits one documentation table. No production code is touched
(AC-X-NO-PROD-CHANGE-3P-1).

## Paradigm

Model-based property testing (fast-check `fc.commands` / `fc.asyncModelRun`)
driving a real multi-context Playwright system, asserting CRDT-style
convergence invariants at quiescence. The new file is a **self-contained
sibling** of the existing 2-party property spec — package-by-feature: the
test file owns its `ModelState3P` / `RealSystem3P` / command classes and
imports only stable, already-exported helpers from `e2e/fixtures/`.

The deliberate non-goal (Design Decision #1, Non-Goals) is a generic
`actors[]` harness. The 2-party and 3-party files duplicate ~40% of their
structure and stay independently readable. The harness *is* a state machine
with an enumerated actor set; adding an actor changes the machine.

## Module map

| Module | Purpose | Location | Owned data | This epic |
|---|---|---|---|---|
| 3P property spec | 3-context model-based property test (3 **distinct** pubkeys A/B/C) | `e2e/tests/multi-user-3p.property.spec.ts` | `ModelState3P`, `RealSystem3P`, `*Command3P`, `assert*_3P` | **CREATE** |
| Shared e2e fixtures | DSL verbs + test-hook readers | `e2e/fixtures/two-party.ts` | 27 exported helpers (incl. `getGroupEpochHook`, `getGroupMembersHook`, `getPubkeyLeafCountHook`) | **CONSUME (read-only); additive exports only if strictly needed** |
| Bunker-C auth | User-C bunker URL + helper | `e2e/fixtures/auth-helper-c.ts` | `E2E_BUNKER_C_URL`, `USER_C_NPUB`, `authenticateAsBunkerC` | **CONSUME (no change)** |
| Coverage matrix | Permutation + property-test coverage tables | `docs/two-party-permutation-matrix.md` | TP-70..72 rows | **EDIT (TP-70..72 property-coverage row + TP-70c footnote only)** |

Reference (read, do not modify): `e2e/tests/multi-user.property.spec.ts`
(2-party template), `e2e/tests/multi-user-md.property.spec.ts` (an existing
**3-context** property harness for multi-device — closest structural model),
`e2e/tests/three-party.spec.ts` (example-based 3-party; auth-setup template).

## Boundary rules

1. **No production-code edits.** No file under `src/marmot/`, `src/store/`,
   or `src/components/` is modified (AC-X-NO-PROD-CHANGE-3P-1). The required
   test hooks already exist in `src/marmot/client.tsx:634-648` — consume them
   via the `e2e/fixtures/two-party.ts` reader wrappers; do not add or change
   any hook.
2. **The 2-party file is frozen.** `e2e/tests/multi-user.property.spec.ts` is
   not modified (AC-X-NO-2P-CHANGE-1).
3. **The example-based 3-party file is preserved.** `e2e/tests/three-party.spec.ts`
   is not deleted, renamed, or `.skip`-ed (AC-X-NO-EXAMPLE-DELETION-3P-1).
4. **Fixture changes are additive only.** Prefer consuming existing
   `two-party.ts` exports. If a genuinely new shared helper is needed, add it
   as a new export; never alter an existing helper's signature (the 2-party
   file depends on them).
5. **L1/L2 untouched.** `make test` is unaffected; the new file lives under
   `e2e/tests/` and is picked up only by `make e2e` (AC-X-CI-3P-1).

## Seams

Cross-story dependencies (populated by the planner in Mode 2):

- S1 (skeleton: `ModelState3P`, `RealSystem3P`, `beforeAll/afterAll`) is the
  foundation every later story builds on.
- S2 (per-actor task commands) and S3 (group-lifecycle commands) both depend
  on S1's `ModelState3P`/`RealSystem3P` shapes; they are independent of each
  other and may land in either order (spec § Stories).
- S4 (headline assertions) depends on S1's model/system shapes and on the
  `two-party.ts` test-hook readers (present — **strict form**).
- S5 (wire the single property test) depends on S2 + S3 + S4 (needs the full
  command set and the assertions).
- S6 (coverage-matrix doc edit) is independent of the test code.
- S7 (wall-clock validation) depends on S5 being runnable and is **execution-
  bound** (runs `make e2e` against the new file).

## Implementation constraints

1. **STRICT FORM is available.** All three test hooks
   (`getGroupEpochHook`, `getGroupMembersHook`, `getPubkeyLeafCountHook`)
   are exported from `e2e/fixtures/two-party.ts` (lines 479–561) and backed
   by `window.__notestr*` assignments in `src/marmot/client.tsx:634-648`.
   S4 ships the strict assertions directly. The degraded-form ACs
   (AC-3P-DEG-1, AC-3P-DEG-2) are satisfied by including the documented
   degraded fallbacks/comments as specified, but the live path is strict.
2. **Bunker setup — spec vs. property-test convention (decide in S1).**
   The spec (Design Decision #8, AC-3P-FILE-4) says copy `three-party.spec.ts`'s
   **static** bunker setup (`E2E_BUNKER_URL` / `E2E_BUNKER_B_URL` /
   `E2E_BUNKER_C_URL`). However, the 2-party **property** spec deliberately
   uses `spawnSpecBunker()` (per-spec fresh bunkers) to avoid KeyPackage
   accumulation across the many property iterations — a property run is
   ~15 iterations × ~10 commands, which is exactly the load that motivated
   `spawnSpecBunker`. **Default: honor the spec (static constants named in
   AC-3P-FILE-4).** Watch for KP-accumulation flakiness in S7; if it appears,
   the known mitigation is `spawnSpecBunker` ×3, which would be an explicit
   amendment to AC-3P-FILE-4 rather than a silent deviation. Surface the
   choice in S1's result rather than burying it.
3. **Authenticate C via `two-party.ts` `authenticate(page, E2E_BUNKER_C_URL)`**,
   not the bare `authenticateAsBunkerC` — the latter skips `clearAppState`,
   slot-pinning, and the `__notestrTestPubkey` hook-wait that A and B get.
4. **`SwCommand3P` switches A↔B only** (Design Decision #6, AC-3P-SW-1). No
   A↔C or B↔C switches. Document the restriction inline naming AC-3P-SW-1.
5. **Admin-only invites are model preconditions, not runtime checks**
   (Design Decision #2): `InCommand3P.check` returns true only when the
   inviter is A. `B.In(C)` (TP-70c) is out of scope — blocked by MIP-03.
6. **Wall-clock envelope: 12 min** (`test.setTimeout(720_000)`), `numRuns: 15`,
   `maxCommands: 10`. If S7 breaches budget: reduce `numRuns` to 12 before
   reducing `maxCommands` to 8 (Design Decisions #5, #7; AC-3P-WC-2).
7. **Naming discipline.** Every `test`/`describe` title starts with the
   bracketed invariant IDs (`[C0,S5,S6,S7,S10] ...`) per AC-X-NAMING-3P-1.
8. **Env overrides honored:** `FAST_CHECK_SEED`, `FAST_CHECK_PATH`,
   `FAST_CHECK_NUM_RUNS` (AC-3P-RUN-3, AC-X-RUNS-3P-1).

## Notes on the manual / execution-bound ACs

- **AC-3P-RUN-5** and **AC-VAL-3P-1** are fault-injection validations (inject a
  C-relevant divergence, observe the counterexample names a `C.*` command,
  then revert). AC-VAL-3P-1 is under `## Manual Validation` — one-shot, not an
  automated assertion; it is recorded in completion notes.
- **AC-3P-WC-1/2/3** (S7) require running `make e2e` against the new file
  three times and recording wall-clock. These are execution-bound and
  sensitive to the documented multi-context e2e flakiness; treat persistent
  multi-context red as harness flakiness per project memory, not a test defect,
  unless a real 3-party divergence is shown.
