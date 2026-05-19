# Architecture — epic-property-tests-l3-multi-device

## Paradigm

Test-additive change to an existing modular-monolith Next.js + Playwright codebase. No production-code changes; the epic ships one new Playwright spec, one new test fixture file, and one documentation table edit.

The new spec is the sibling of `e2e/tests/multi-user.property.spec.ts` and follows the same DSL pattern:
- A `ModelState` class describes "what the test thinks happened"
- A `RealSystem` class wraps the Playwright `Page` instances
- `fc.AsyncCommand`-implementing classes mutate both
- Assertion functions check post-quiescence invariants from the catalogue

## Module map

| Module | Purpose | Location | Owns |
|---|---|---|---|
| MD property spec | New 3-context / 2-identity property file | `e2e/tests/multi-user-md.property.spec.ts` | `ModelStateMD`, `RealSystemMD`, `*Command_MD` classes, `assert*_MD` functions, `fc.assert` wiring |
| MD fixture helpers | Re-exports + `awaitDeviceJoin` | `e2e/fixtures/multi-device.ts` | `awaitDeviceJoin(pageNew, primaryPage, groupId)`; thin re-exports if needed |
| Coverage matrix | Documentation table | `docs/two-party-permutation-matrix.md` | TP-80..82 coverage row update only |
| 2-party fixtures (consumed) | Auth, group ops, task ops, hooks | `e2e/fixtures/two-party.ts`, `e2e/fixtures/auth-helper.ts`, `e2e/fixtures/auth-helper-b.ts` | NOT modified |
| 2-party property spec (sibling) | Original property file | `e2e/tests/multi-user.property.spec.ts` | NOT modified |
| Production marmot/store/components | Group state, MLS, DeviceList | `src/marmot/`, `src/store/`, `src/components/` | NOT modified — read-only consumers via test hooks |

## Boundary rules

- **No production-code changes.** Per cross-cutting AC `AC-X-NO-PROD-CHANGE-MD-1`, this epic touches only `e2e/tests/multi-user-md.property.spec.ts`, `e2e/fixtures/multi-device.ts`, `e2e/fixtures/two-party.ts` (additive helpers ONLY if absolutely needed — preferred is the new fixture file), `docs/two-party-permutation-matrix.md`, and this epic's `specs/` directory.
- **2-party file is read-only.** `e2e/tests/multi-user.property.spec.ts` is not modified. Patterns are duplicated/adapted, not factored out.
- **3-party file is read-only.** If `epic-property-tests-l3-three-party` ships during this epic, its property file is similarly untouched.
- **Example-based files preserved.** `multi-device-cross-npub.spec.ts`, `multi-device-sync.spec.ts`, `multi-user.spec.ts` are not deleted, renamed, or `.skip`-ed.
- **Test hooks consumed via existing helpers.** `__notestrTestGroupEpoch`, `__notestrTestGroupMembers`, `__notestrTestPubkeyLeafCount` are wrapped by `getGroupEpochHook` / `getGroupMembersHook` / `getPubkeyLeafCountHook` in `two-party.ts`. The MD file imports those helpers — it does NOT call the window hooks directly.

## Seams

| Seam | Producer | Consumer | Contract |
|---|---|---|---|
| Test hooks | `src/marmot/client.tsx:569-620` | `e2e/fixtures/two-party.ts` helpers | Three window functions installed in `useEffect` gated on `state.client`. Shipped by `epic-property-tests-l3-completion` (DONE). |
| Slot pinning | `e2e/fixtures/two-party.ts:36-46` (`pinClientSlot`) | `authenticate(page, bunkerUrl, slot)` | Explicit slot string MUST be passed for multi-device tests. Without it, two contexts on the same bunker derive identical slots and only one KP lands. |
| Welcome poll | New `e2e/fixtures/multi-device.ts` | `AttachA2Command_MD.run` | `awaitDeviceJoin(pageNew, primaryPage, groupId)` polls `leafIndexesFor(primaryPage, groupId, pubkeyA).length >= 2` with 30 s timeout. Modelled on `forget-device-sibling.spec.ts:136-138`. |
| Device-row count | `src/components/DeviceList.tsx:210` | `assertS10_MD` | `[data-testid="device-row"]` count on each page equals leaves of LOCAL identity in current group. |

## Implementation constraints (from exploration)

1. **Explicit slots are mandatory.** `authenticate(pageA1, E2E_BUNKER_URL, "A1")` and `authenticate(pageA2, E2E_BUNKER_URL, "A2")`. Use slot strings the test file declares as constants near the top (`SLOT_A1 = "A1"`, `SLOT_A2 = "A2"`).
2. **`pageA2` is unauthenticated in `beforeAll`.** The page is created in `beforeAll`, NOT authenticated. `AttachA2Command_MD` calls `authenticate(pageA2, E2E_BUNKER_URL, "A2")` lazily inside `run()`.
3. **Auth order in `beforeAll`: B → A1.** Mirrors 2-party (`multi-user.property.spec.ts:997-1000`). B's KP must be on the relay before A invites in `InCommand_MD`. A2's KP publication is deferred until `AttachA2Command_MD` fires.
4. **Do not pre-`goto` `pageA2`.** `pinClientSlot` uses `page.addInitScript` which must run before the first navigation. `authenticate()` handles this; leaving `pageA2` untouched in `beforeAll` is correct.
5. **Cached pubkeys.** `cachedPubkeyA = await getPubkeyHex(pageA1)` and `cachedPubkeyB = await getPubkeyHex(pageB)` in `beforeAll` after both are authenticated. A2 reuses `cachedPubkeyA` — there is no `cachedPubkeyA2`.
6. **`numRuns: 12`, `maxCommands: 8`.** Per spec design decision 6. Wall-clock budget ~6.5 min within the 720 s test timeout. Tunable via S8 (wall-clock validation).
7. **`test.setTimeout(720_000)` (12 minutes).** Higher than 2-party (600 s) to absorb welcome-wait overhead.
8. **`FAST_CHECK_SEED` / `FAST_CHECK_PATH` honoured.** Same parse pattern as 2-party: `parseInt(env ?? "0") || undefined`.
9. **Identity is model-only.** Production code has pubkey + active leaves. The model splits identity from device for descriptive bookkeeping. No production-code reshape.
10. **No `SwCommand_MD`.** Out of scope. The combinatorial explosion of identity-switching × per-device welcome state is left as a follow-up.
11. **Identity-restore step omitted.** No `Sw` means no drift; the 2-party file's `switchIdentity(real.pageA, E2E_BUNKER_URL)` restore at end-of-run does not appear here.
12. **A14 wire checks via `openNdkSubscriber`.** Present in 2-party `LgCommand`/`FdCommand`. Decision deferred to story planner: include in MD or assert via existing leaf-count consequence only. Spec leans toward leaf-count-consequence-only (see S4 description).

## Story split (from spec § Stories)

- **S1** — Skeleton: file + 3 contexts + auth in `beforeAll`. ~50 LOC.
- **S2** (RISER) — `AttachA2Command_MD` + `awaitDeviceJoin` helper. ~80 LOC.
- **S3** — Per-device commands: `CtCommand_MD`, `UtCommand_MD`, `ScCommand_MD`, `AsCommand_MD`, `UnCommand_MD`, `DtCommand_MD`, `RlCommand_MD`. ~250 LOC.
- **S4** — Group-lifecycle: `CgCommand_MD`, `InCommand_MD`, `LgCommand_MD`, `RdCommand_MD`, `FdCommand_MD`. ~200 LOC.
- **S5** — Headline assertions: `assertA15_MD`, `assertC0_MD`, `assertS5_MD`, `assertS6_MD`, `assertS10_MD`. ~150 LOC.
- **S6** — Wire `fc.assert`: commands array, `numRuns: 12`, `maxCommands: 8`. ~50 LOC.
- **S7** — Coverage table edit. Markdown-only. **Lighter-path candidate.**
- **S8** — Wall-clock validation: 3 local runs, tune `numRuns`/`maxCommands` if envelope breaches.

S2 is the riser: every subsequent story composes against the second-device entry path.

## Cross-references

- **Prerequisite (DONE):** `specs/epic-property-tests-l3-completion/` — ships the test hooks consumed here.
- **Sibling (PLANNED):** `specs/epic-property-tests-l3-three-party/` — independent, 3-distinct-identities axis.
- **Related (PLANNED):** `specs/epic-multi-device-sync/` — owns the welcome flow this epic exercises; regression there fails `AttachA2Command_MD` first.
