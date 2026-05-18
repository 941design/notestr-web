# Architecture — Property Tests Layer-3 Completion

This is the operational architecture document all agents working on `epic-property-tests-l3-completion` consume. It reflects what the codebase actually does today; it does not propose changes beyond what this epic requires. Synthesized from `exploration.json`; no `arch_debate` flag was set, so no Proposer↔Codex deliberation was run.

## Paradigm

Package-by-feature React (Context Provider) + functional core (`marmot-ts` / `ts-mls`) + e2e Playwright fixtures.

- **MarmotProvider** (`src/marmot/client.tsx:120–619`) owns all MLS state and is the single install site for every `window.__notestrTest*` test hook.
- **Production code never imports from `e2e/`**. The boundary is one-directional.
- **e2e talks to the browser exclusively through `window.__notestrTest*` hooks** (via `page.evaluate`) and Playwright DOM locators. There are no direct React-component imports from e2e tests.
- **`marmot-ts` exports are pure functional helpers** over `ClientState`. They have no React, no side effects, and are importable freely in `src/`.

## Module Map

| Module | Location | Purpose | Owned Data |
|---|---|---|---|
| MarmotProvider | `src/marmot/client.tsx:120–619` | Owns MarmotClient lifecycle and `state.groups`. Installs/cleans every test hook in one gated `useEffect`. | `state.groups: MarmotGroup[]`, `state.client`, `pubkey`, `relays` |
| marmot-ts helpers | `node_modules/@internet-privacy/marmot-ts/...` | `getGroupMembers`, `getPubkeyLeafNodes`, `getPubkeyLeafNodeIndexes`, group-state utilities. | stateless |
| notestr-test-hooks.d.ts | `src/types/notestr-test-hooks.d.ts` | Ambient `Window` declarations for every `__notestrTest*` hook. | type-only |
| two-party.ts | `e2e/fixtures/two-party.ts` | Thin `page.evaluate` wrappers over `window.__` hooks. One helper per DSL verb. | stateless |
| ndk-subscriber.ts | `e2e/fixtures/ndk-subscriber.ts` | Out-of-band NDK relay subscriber using User-B's rotated private key. Connects to `RELAY_URL = ws://localhost:7777`. | NDK instance + active subscriptions |
| multi-user.property.spec.ts | `e2e/tests/multi-user.property.spec.ts` | The L3 full-stack property test: `ModelState`, `RealSystem`, 13 Command classes, 5 invariant assertions. | `ModelState` (per `fc.commands` run); `pageA`/`pageB` are `beforeAll`-scoped |

## Boundary Rules

1. **One-directional boundary.** Production code (`src/`) never imports from `e2e/`. The only `e2e → src/` import is for types from `src/store/task-events.ts`.
2. **Test hooks gated.** All `window.__notestrTest*` installations live inside `if (isTestRuntime() && state.client)` (`client.tsx:415–416`). `isTestRuntime()` returns true only when `NEXT_PUBLIC_E2E=1` or `NODE_ENV=test`. Production builds carry no hook code.
3. **Hooks share a single closure.** All hooks are installed in the same `useEffect` (`client.tsx:415–599`) with deps `[pubkey, relays, state.client, state.groups]`. Adding a new hook is a single assignment + a single delete in cleanup. No new deps needed for the three hooks this epic adds.
4. **e2e → browser only via hooks.** Every e2e read of in-browser state goes through `page.evaluate(window.__notestrTest*)` wrapped in a `two-party.ts` helper. The helper throws loudly when the hook is missing.
5. **No production behaviour changes** (epic-specific). `AC-X-NO-PROD-CHANGE-COMP-1` enumerates the exact set of files this epic may modify. Outside that set, `src/` is off-limits.

## Seams

### 1. Group lookup by `idStr`
All hooks resolve the active group with `state.groups.find((entry) => entry.idStr === groupId)` and return `null`/`[]`/`0` on absent — exact pattern of `__notestrTestPubkeyLeafIndexes` at `client.tsx:446–449`. The three new hooks (`__notestrTestGroupEpoch`, `__notestrTestGroupMembers`, `__notestrTestPubkeyLeafCount`) use this verbatim.

### 2. Epoch boundary (bigint → number)
`group.state.groupContext.epoch` is `bigint` (`ts-mls` declares it). `bigint` is not structured-clone-compatible across the Playwright `page.evaluate` serialization boundary. AC-HOOK-3 specifies coercion via `Number(g.state.groupContext.epoch)` at the hook boundary. Precision loss is accepted (test scenarios never approach `Number.MAX_SAFE_INTEGER`).

### 3. Property-test data flow
```
fc.commands → Command.run() →
  two-party.ts helper (page.evaluate) →
    window.__notestrTest* (live closure over state.groups) →
      marmot-ts pure helper over group.state →
    serialized return →
  expect(...) in test process
```
Because the hook `useEffect` reruns on every `state.groups` change, hooks always serve post-quiescence MLS state when called after `quiesceFor()` / `real.quiesce()`.

### 4. A14 (out-of-band relay observation)
```
LgCommand.run / FdCommand.run (last-leaf branch only) →
  openNdkSubscriber([RELAY_URL]) →
  subscriber.waitForDuration(filter={kinds:[445], "#h":[hex]}, 2000) →
  expect(events.length).toBe(0)
```
This is **wire-level** (AC-A14-8), not MLS decryption. The assertion relies on strfry honouring `#h` tag filtering in REQ responses (standard NIP-01); strfry has no write-policy plugin gating kind-445 server-side, so the filter is REQ-engine-only. `waitForDuration` does not yet exist on `NdkSubscriber` — AC-A14-7 is the addition: resolves after `ms` with whatever arrived, never rejects (distinct from the existing `waitForEvents`, which rejects on timeout when `count` is not met).

### 5. Cross-run MLS state pollution
`fc.asyncModelRun` resets `ModelState` between runs, but not the bunker / IndexedDB / relay. Stale leaves from prior runs on the same pubkey remain on older groups. This is the operational reality `assertS5` and `assertC0` are scoped around:
- `assertS5` scopes the biconditional to `m.groupIdA` (Decision #3 in spec.md), not the global member set.
- New `ModelState.lastSwitched` (S2) must be reset to `null` per-run (currently `epochSequenceA/B` already are).

## Implementation Constraints

1. **Hook install site is single-file.** Three new hook assignments go inside the `useEffect` at `client.tsx:415–599`, before the cleanup `return`. Three matching deletes go in the cleanup at `client.tsx:584–598`. No restructuring; no new useEffect.
2. **Missing imports must be added.** `getGroupMembers` and `getPubkeyLeafNodes` are not yet imported in `client.tsx` (only `getPubkeyLeafNodeIndexes` is). S4 adds both to the `@internet-privacy/marmot-ts` import block (`client.tsx:13–20`). Forgetting this is a TS compile error.
3. **Allowed file set** (AC-X-NO-PROD-CHANGE-COMP-1): `src/marmot/client.tsx`, `src/types/notestr-test-hooks.d.ts`, `e2e/tests/multi-user.property.spec.ts`, `e2e/fixtures/two-party.ts`, `e2e/fixtures/ndk-subscriber.ts` (for AC-A14-7), `specs/epic-property-tests-l3-completion/**`, and (S8 only) `e2e/tests/property-tests.md`. Anything else triggers a scope-violation flag.
4. **`waitForDuration` semantics.** Subscribes, collects events for exactly `ms` ms via `setTimeout`, then resolves with the collected array. Never rejects. Closes the subscription on resolve. This is a distinct method from `waitForEvents`; do not modify `waitForEvents`.
5. **`recordEpoch` migration.** S6 swaps every `recordEpoch(...)` call site (lines 242, 281, 325, 377, 429, 481, 531, 580, 628, 674, 719, 767 — 12 sites) from `readEpoch(page) // groups.length proxy` to `__notestrTestGroupEpoch(page, groupIdStr)`. The proxy comment at `readEpoch` (209–218) becomes obsolete and should be removed; `readEpoch` itself may be deleted if no callers remain.
6. **`SwCommand.run` populates `lastSwitched` BEFORE the switch.** S2 captures `priorGroupIds` pre-switch (membership state is wiped post-switch). The new `ModelState.lastSwitched` field must be initialised to `null` in the constructor AND in `model.reset()` (or via the same per-run reset path that handles `epochSequenceA/B`).
7. **`assertS5` is rewritten twice.** S1 lands the partial model-flag-based body (AC-S5-1 through AC-S5-4). S5 replaces the body with the hook-based full biconditional (AC-S5-5). S5 explicitly depends on S1 (same function being edited) AND S4 (the hooks it consumes).
8. **AC-X-DESCRIBE-TITLE-1** — the `test.describe.serial` block title at `multi-user.property.spec.ts:962` (`[S5,S6,S7,S10,A7-A12,A14,C0]`) is unchanged. The epic's purpose is to make the title true, not to modify it.
9. **AC-X-NO-EXAMPLE-DELETION-COMP-1** — no `e2e/tests/*.spec.ts` is deleted, renamed, or `.skip`-ed. The full list lives in `exploration.json#testing_and_conventions.forbidden_files`.
10. **Two `notestr-test-hooks.d.ts` files exist** — `src/types/notestr-test-hooks.d.ts` (canonical, edited by this epic) and a second copy at `src/marmot/notestr-test-hooks.d.ts`. Architect must verify which the install site imports from before editing; the spec targets `src/types/`.

## Out of Scope (per spec.md § *Out of Scope*)

- 3-party / multi-device-same-pubkey scenarios (separate epics).
- Any reducer change. `>=` LWW guard, `task.snapshot` semantics, stale-rejection rules remain.
- New invariants beyond the parent epic's catalogue.
- Increasing L3 `numRuns` (stays 20).
- New `fc.commands` Command classes.
- Auto-resetting browser/bunker/IndexedDB between runs (rejected during parent epic for wall-clock cost; honoured here).
