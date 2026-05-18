# Property Tests Layer-3 — Multi-Device Same-Pubkey Coverage

## Problem

The matrix at `docs/two-party-permutation-matrix.md` § *Property-test coverage* maps the multi-device family TP-80..82 to invariants `A15, C0`. The L3 property file `e2e/tests/multi-user.property.spec.ts` does not exercise either invariant under multi-device conditions:

- **A15** (multi-device same-pubkey self-converge) is asserted **only at L2** (`src/store/multi-client.property.test.ts`'s `[A15]` test, using the in-memory `FakeBoard` with two clients sharing a `createdBy`/`updatedBy` pubkey). The L2 harness simulates the task-event subsystem; it does **not** model the MLS layer's per-leaf semantics, the welcome flow that brings a second device online, or the relay-mediated delivery of kind-445 events to two leaves of the same pubkey.
- **C0** at L3 is asserted across two distinct identities (A and B) but never across two leaves of the same identity. The C0 invariant is "every current group member has identical `(tasks, members, epoch, leafCount)`"; "current member" includes every leaf of the member's pubkey, and identical state across leaves of one pubkey is a stronger claim than identical state across the pair-of-pubkeys axis.

Concretely, two scenarios from the matrix are unreachable in the current L3 harness:

- **TP-80**: `A1.Cg(g1) → A1.In(B) ⇒ A2⟂g1 ⇒ B⟂g1`. Requires two contexts authenticated to the *same* nostr identity (A1 and A2) plus a third for B. The current harness has one bunker per actor (A → bunker A, B → bunker B); there is no `A2` context.
- **TP-81 / TP-82**: same multi-device prerequisite, with task creation / status changes propagating to A2 and to B.

The example-based file `e2e/tests/multi-device-cross-npub.spec.ts` covers TP-80..82 at fixed action sequences. Property tests are absent for the same reason as TP-70..72: the harness's hard-coded `pageA` / `pageB` shape cannot generate sequences that need a third (or fourth) context, and the actor model (`"A" | "B"`) cannot distinguish identity from device.

The architectural gap that drives this is more subtle than the 3-party gap. 3-party only requires widening the actor type and adding a third bunker. Multi-device requires **separating identity from context**: the harness must model "identity X has devices x1 and x2", which is not a refinement of `"A" | "B"` — it is a different shape entirely.

## Solution

A new property test file `e2e/tests/multi-user-md.property.spec.ts` with three browser contexts mapped to two identities:

- `pageA1` — bunker A, first device for identity A
- `pageA2` — bunker A, second device for identity A
- `pageB`  — bunker B, only device for identity B

The actor model splits into `Identity = "A" | "B"` and `Device = "A1" | "A2" | "B"`. Commands operate on devices (because UI state is per-device); invariants are evaluated per-pubkey (because membership and ratchet-tree leaves are per-pubkey).

Headline invariants:

- **A15 at L3**: post-quiescence, A1 and A2 agree on tasks, on the member set, on the epoch, and on per-pubkey leaf counts for every group both are members of. Equality across the two leaves of identity A.
- **C0 at L3 with multi-device**: post-quiescence, A1, A2, and B all agree on the four dimensions for the shared group.
- **S10 at L3 with multi-device**: DeviceList row count equals 2 for identity A in any group both A1 and A2 belong to, and equals 1 for identity B.

This epic depends on `epic-property-tests-l3-completion` having shipped the test hooks (epoch / members / leaf-count). Without those, the file cannot assert the strict form of A15 or C0.

## Scope

### In Scope

- A new property test file `e2e/tests/multi-user-md.property.spec.ts` modelled on the 2-party file but with the identity/device split.
- Three browser contexts: two for identity A (against the same bunker), one for identity B.
- A `RealSystemMD` class with `pageA1`, `pageA2`, `pageB`, plus a `page(device: Device)` accessor.
- A `ModelStateMD` class tracking:
  - `pubkeyA`, `pubkeyB` (one each — devices share the identity's pubkey)
  - `membersA1`, `membersA2`, `membersB` (per-device membership flag — needed because a device may not yet have processed the welcome that makes it a leaf)
  - `groupId`, `groupName`
  - `tasks: Map<id, ModelTask>` (model is identity-scoped, not device-scoped — A1 and A2 share)
  - `epochSequenceA1`, `epochSequenceA2`, `epochSequenceB` (epoch is per-device since each device has its own MLS view)
  - `lastSwitched` (carried over from `epic-property-tests-l3-completion`)
- A new fixture `e2e/fixtures/multi-device.ts` exporting `authenticateAsBunkerA(page)` (already exists in `auth-helper.ts` — re-exported for clarity), and a helper `awaitDeviceJoin(pageNew, primaryPage, groupId)` that waits for a freshly-authenticated second device of identity A to receive the welcome and appear as a leaf.
- DSL command classes adapted from the 2-party file:
  - **`CgCommand_MD`** — A1 creates the group on `pageA1` only.
  - **`InCommand_MD`** — A1 invites B (only B is invited; A2 joins via second-device-sync, not via explicit invite).
  - **`AttachA2Command_MD`** — explicit "second device for identity A comes online" command. Authenticates `pageA2` (if not already), waits for welcome propagation, sets `m.membersA2 = true`. This is the new command not present in the 2-party file.
  - **`CtCommand_MD`, `UtCommand_MD`, `ScCommand_MD`, `AsCommand_MD`, `UnCommand_MD`, `DtCommand_MD`** — each takes `device: Device` (any of A1, A2, B) and dispatches on that device's page.
  - **`LgCommand_MD`** — leaving is per-leaf (semantic match for "this device leaves"); A1 leaving while A2 stays should reduce identity A's leaf count from 2 to 1 without removing A from the group.
  - **`FdCommand_MD`** — A1 forgets one of A's leaves (A2's, by index). Tests S5 and A10 in the multi-leaf-same-pubkey case.
  - **`RdCommand_MD`** — per-device device rename.
  - **`RlCommand_MD`** — per-device reload.
  - **No `SwCommand`.** The multi-device epic is orthogonal to identity switching. Combining the two would explode the model (three devices × two identities × Sw history) and is left as a follow-up.
- Headline invariant assertions:
  - **`assertA15_MD`** — at quiescence, A1 and A2 see identical `(tasks, members, epoch, leafCount)`. New assertion specific to this epic.
  - **`assertC0_MD`** — at quiescence with all three devices as members, A1, A2, and B all agree on the four dimensions.
  - **`assertS5_MD`** — biconditional `(p ∈ members) ⇔ (leafCount >= 1)` where leaf count for identity A is 2 (or 1 after a `Lg`/`Fd`).
  - **`assertS10_MD`** — DeviceList row count for identity A on any of A1's or A2's pages equals 2 (or whatever the current leaf count is); for B equals 1.
  - **`assertS6_MD`** — per-device epoch monotonicity for A1, A2, B.
- Coverage table update in `docs/two-party-permutation-matrix.md`: change the TP-80..82 row to "A15, C0, S5, S6, S10 (multi-device at L3)".

### Out of Scope

- TP-52 (`A1.Cg → A1.Fd(A2)`) is **flagged in scope but only partially asserted**. The matrix has it `(fixme)` because of historical behavioural questions in `multi-device-sync.spec.ts`. This epic asserts the leaf-count consequence (after `Fd(A2)`, leafCount(g, A) drops by 1) but does not assert any further membership change because the `(fixme)` is unresolved upstream. Resolving the `(fixme)` is a separate epic.
- Combining multi-device with 3-party. Two identities A and B with two devices each plus a third identity C is a 5-context harness. Out of scope.
- Combining multi-device with `Sw`. Identity switching while also tracking per-device welcome state explodes the test surface.
- A new bunker for A2. A2 authenticates against the same `E2E_BUNKER_URL` as A1.
- Reworking the 2-party file to share infrastructure with the MD file. Same reasoning as the 3-party epic: the 2-party file stays as it is.
- Asserting multi-device invariants at L1 or L2 beyond what `multi-client.property.test.ts`'s `[A15]` test already covers.

## Design Decisions

1. **Identity vs device is a model-only distinction.** Production code does not have an "identity" concept separate from pubkey + active leaves. The model splits them so the test can talk about "identity A's view" (= the union of A1's and A2's view, which should always be equal at quiescence). This is descriptive bookkeeping, not a production abstraction.
2. **`AttachA2Command_MD` as an explicit command.** In production, second-device sync is a background process triggered by the welcome flow. In the property harness, it must be a discrete, observable step so the model knows when A2 transitions from "authenticated but not in group" to "leaf in group". Encoding it as a command also lets fast-check generate sequences where A2 attaches *after* tasks have been created — a non-trivial case for the welcome snapshot path.
3. **No `SwCommand`.** Two reasons. First, combinatorial: identity-switching adds an axis the model already strains under (three devices × group state × switch history). Second, motivational: the multi-device gap in the matrix is about leaves of one pubkey converging, not about identity rebinding. Sw stays in the 2-party file where it has full assertion coverage.
4. **Tasks are identity-scoped in the model.** `ModelStateMD.tasks` is a single `Map`, not a per-device map. A1 and A2 should always see the same tasks (that is what A15 asserts). Keeping a single model task map encodes this expectation directly: any divergence from the model is a real divergence.
5. **Epochs are per-device.** A1 and A2 see the same MLS epoch only after they've both processed the same commits. Between commits and applies, their local-view epochs can be one apart. Per-device epoch sequences capture this; quiescence is the moment when all three converge (asserted by C0 / A15).
6. **`numRuns: 12` and `maxCommands: 8`.** Rationale: three-context wall-clock plus the `AttachA2Command_MD` welcome wait (~3 s typical) push per-command cost to ~4 s. `12 × 8 × 4 = 384 s ≈ 6.5 min` plus setup, well within a 10-minute envelope. The `maxCommands` reduction from 10 to 8 is intentional: shrinkability of multi-device counterexamples is harder than the 2-party case (more state surface), and shorter chains shrink faster.
7. **`AttachA2Command_MD` rate-limited via `check`.** Once A2 is attached, the command should not fire again. Encode `m.membersA2` as the gate. A re-attach scenario (A2 logs out and back in) is meaningful but adds a `Detach` command and another welcome wait per run; out of scope.
8. **Identity-restore between runs.** The 2-party file restores `pageA` to bunker A between runs in case `Sw` fired. This file does not have `Sw`, so identity restore is unnecessary. However, group state from prior runs accumulates: a follow-up run will see `pageA1` already in groups created by previous runs. The same `assertS5` / `assertC0` scoping rule (current group only) carries over from `epic-property-tests-l3-completion`.
9. **`assertA15_MD` is the new assertion.** It is structurally similar to `assertC0` between A1 and A2 (the same four dimensions) but is named separately because the invariant *itself* is named A15 in the catalogue and the failure mode is different (a divergence between A's two leaves is a leaf-sync bug; a divergence between A and B is a group-comm bug).
10. **`AttachA2Command_MD` runs against an already-mounted `pageA2`.** The page is created in `test.beforeAll` and authenticated lazily by the command. Creating it in `beforeAll` keeps the page lifecycle attached to the test, not to the command — `pageA2.close()` happens in `afterAll`, which is correct.

## Technical Approach

### File layout

```
e2e/tests/multi-user-md.property.spec.ts    (new)
e2e/fixtures/multi-device.ts                (new — small helpers)
e2e/fixtures/auth-helper.ts                  (no change)
e2e/fixtures/auth-helper-b.ts                (no change)
docs/two-party-permutation-matrix.md         (coverage table edit)
specs/epic-property-tests-l3-multi-device/   (this epic)
```

### `ModelStateMD` shape

```ts
type Identity = "A" | "B";
type Device = "A1" | "A2" | "B";

class ModelStateMD {
  groupId: string | null = null;
  groupName: string | null = null;
  pubkeyA: string | null = null;
  pubkeyB: string | null = null;
  membersA1 = false;  // A1 has processed the create / welcome
  membersA2 = false;  // A2 has processed the welcome (set by AttachA2Command_MD)
  membersB = false;
  tasks: Map<string, ModelTask> = new Map();
  epochSequenceA1: number[] = [];
  epochSequenceA2: number[] = [];
  epochSequenceB: number[] = [];

  identityOf(d: Device): Identity { return d === "B" ? "B" : "A"; }
  pubkeyOf(d: Device): string | null {
    return this.identityOf(d) === "A" ? this.pubkeyA : this.pubkeyB;
  }
  deviceIsMember(d: Device): boolean {
    return d === "A1" ? this.membersA1
         : d === "A2" ? this.membersA2
         : this.membersB;
  }
  identityIsMember(i: Identity): boolean {
    return i === "A" ? (this.membersA1 || this.membersA2) : this.membersB;
  }
  // ...
}
```

### `RealSystemMD` shape

```ts
class RealSystemMD {
  constructor(
    readonly pageA1: Page,
    readonly pageA2: Page,
    readonly pageB: Page,
  ) {}
  page(d: Device): Page {
    return d === "A1" ? this.pageA1 : d === "A2" ? this.pageA2 : this.pageB;
  }
  // ... dispatchCt, getTasks, getTask, quiesce — all per-device
}
```

### `AttachA2Command_MD`

```ts
class AttachA2Command_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  check(m: ModelStateMD): boolean {
    // Only attach A2 once per run, and only after A1 is in a group.
    return m.membersA1 && m.groupId !== null && !m.membersA2;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    // Authenticate pageA2 against bunker A.
    await authenticate(r.pageA2, E2E_BUNKER_URL);
    // Wait for A2 to receive the welcome and appear as a leaf.
    await awaitDeviceJoin(r.pageA2, r.pageA1, m.groupId!);
    m.membersA2 = true;
    // Record initial epoch.
    const epoch = await getGroupEpochHook(r.pageA2, m.groupId!);
    if (epoch !== null) m.epochSequenceA2.push(epoch);

    // Postcondition: A2 has ≥1 leaf belonging to pubkeyA.
    const leaves = await leafIndexesFor(r.pageA1, m.groupId!, m.pubkeyA!);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
  }

  toString(): string { return "A2.Attach()"; }
}
```

`awaitDeviceJoin` polls `__notestrTestPubkeyLeafCount(groupId, pubkeyA)` on `r.pageA1` until it returns `>= 2`, with a 30-second timeout. If timeout, throw — fast-check shrinks to the minimal failing chain.

### `assertA15_MD`

```ts
async function assertA15_MD(m: ModelStateMD, r: RealSystemMD): Promise<void> {
  if (!m.groupId || !(m.membersA1 && m.membersA2)) return;

  const tasksA1 = await r.getTasks("A1");
  const tasksA2 = await r.getTasks("A2");
  expect(new Set(tasksA1.keys())).toEqual(new Set(tasksA2.keys()));
  for (const [id, ta1] of tasksA1) {
    const ta2 = tasksA2.get(id)!;
    expect(ta1.status).toBe(ta2.status);
    expect(ta1.assignee).toBe(ta2.assignee);
    expect(ta1.title).toBe(ta2.title);
  }

  const membersA1 = await getGroupMembersHook(r.pageA1, m.groupId);
  const membersA2 = await getGroupMembersHook(r.pageA2, m.groupId);
  expect(new Set(membersA1)).toEqual(new Set(membersA2));

  const epochA1 = await getGroupEpochHook(r.pageA1, m.groupId);
  const epochA2 = await getGroupEpochHook(r.pageA2, m.groupId);
  expect(epochA1).toBe(epochA2);

  for (const p of new Set([...(membersA1 ?? []), ...(membersA2 ?? [])])) {
    const lc1 = await getPubkeyLeafCountHook(r.pageA1, m.groupId, p);
    const lc2 = await getPubkeyLeafCountHook(r.pageA2, m.groupId, p);
    expect(lc1).toBe(lc2);
  }
}
```

### `assertC0_MD`, `assertS5_MD`, `assertS10_MD`, `assertS6_MD`

`assertC0_MD` extends across A1 / A2 / B (three-way comparison, structurally identical to `assertC0_3P` from `epic-property-tests-l3-three-party`). `assertS5_MD` runs the biconditional for both `pubkeyA` (expected leaf count = 2 when both A1 and A2 are in) and `pubkeyB` (expected 1). `assertS10_MD` checks `DeviceList` row count on each of A1 and A2 against `getPubkeyLeafCountHook(..., pubkeyA)` (should be 2 when both attached). `assertS6_MD` walks all three epoch sequences for monotonicity.

### Single test wiring

```ts
test.describe.serial("[A15,C0,S5,S6,S10] multi-device property", () => {
  test.setTimeout(720_000);

  test("[A15,C0] multi-device convergence holds for any 5-8 action chain", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    const real = new RealSystemMD(pageA1, pageA2, pageB);
    const arbDevice = fc.constantFrom<Device>("A1", "A2", "B");
    // ... arbTitle, arbDesc, arbStatus

    const commands: fc.Arbitrary<fc.AsyncCommand<ModelStateMD, RealSystemMD>>[] = [
      fc.constant(new CgCommand_MD()),
      fc.constant(new InCommand_MD()),
      fc.constant(new AttachA2Command_MD()),
      arbDevice.map((d) => new CtCommand_MD(d /* + arbTitle/arbDesc */)),
      arbDevice.map((d) => new UtCommand_MD(d /* + arbTitle */)),
      arbDevice.map((d) => new ScCommand_MD(d /* + arbStatus */)),
      arbDevice.map((d) => new AsCommand_MD(d)),
      arbDevice.map((d) => new UnCommand_MD(d)),
      arbDevice.map((d) => new DtCommand_MD(d)),
      arbDevice.map((d) => new RlCommand_MD(d)),
      arbDevice.map((d) => new LgCommand_MD(d)),
      arbDevice.map((d) => new RdCommand_MD(d)),
      fc.constant(new FdCommand_MD()),
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.commands(commands, { maxCommands: 8 }),
        async (cmds) => {
          const model = new ModelStateMD();
          model.pubkeyA = cachedPubkeyA;
          model.pubkeyB = cachedPubkeyB;

          await fc.asyncModelRun(() => ({ model, real }), cmds);
          await real.quiesce();

          await assertA15_MD(model, real);
          await assertC0_MD(model, real);
          await assertS5_MD(model, real);
          await assertS6_MD(model);
          await assertS10_MD(model, real);
        },
      ),
      {
        numRuns: 12,
        verbose: true,
        seed: parseInt(process.env.FAST_CHECK_SEED ?? "0") || undefined,
        path: process.env.FAST_CHECK_PATH ?? undefined,
      },
    );
  });
});
```

### Stories

- **S1 — Skeleton.** New file with three contexts, two identities, no commands. Confirm Playwright discovers and skips.
- **S2 — `AttachA2Command_MD` and `awaitDeviceJoin`.** This is the unique multi-device infrastructure piece; land it before any other commands so subsequent stories can compose against a known second-device entry path. ~80 LOC.
- **S3 — Per-device commands ported from 2-party.** `CtCommand_MD`, `UtCommand_MD`, `ScCommand_MD`, `AsCommand_MD`, `UnCommand_MD`, `DtCommand_MD`, `RlCommand_MD`. Each accepts `device: "A1" | "A2" | "B"`. ~250 LOC.
- **S4 — Group-lifecycle commands.** `CgCommand_MD`, `InCommand_MD` (admin = A1), `LgCommand_MD` (per-device), `RdCommand_MD`, `FdCommand_MD` (A1 forgets A2's leaf — the multi-leaf case). ~200 LOC.
- **S5 — Headline assertions.** `assertA15_MD`, `assertC0_MD`, `assertS5_MD`, `assertS6_MD`, `assertS10_MD`. Depends on `epic-property-tests-l3-completion` test hooks. ~150 LOC.
- **S6 — Wire single property test.** Combine commands array, `numRuns: 12`, `maxCommands: 8`. ~50 LOC.
- **S7 — Coverage table edit.** Update TP-80..82 row in `docs/two-party-permutation-matrix.md`.
- **S8 — Wall-clock validation.** Three local runs, capture max wall-clock, tune if over 12 min.

S2 is the riser — without `AttachA2Command_MD`, no command after it can target A2.

## Acceptance Criteria

See `acceptance-criteria.md`.

## Relationship to Other Epics

- **`epic-property-tests-l3-completion`** — *prerequisite*. The strict form of `assertA15_MD`, `assertC0_MD`, `assertS6_MD`, `assertS10_MD` requires the test hooks (epoch / members / leaf-count). Without those hooks, this epic ships in degraded form (task-subset only).
- **`epic-property-tests-l3-three-party`** — independent. 3-party uses three distinct identities; this epic uses two identities with three contexts. Could in principle be combined into a 5-context "general" harness, but that combination is explicitly out of scope.
- **`epic-property-based-invariants`** — extends matrix coverage from "L2 only" (A15) to "L2 + L3". The original epic's S6 story said the L3 spec asserts A15 in passing; this epic delivers the dedicated multi-device L3 surface.
- **`epic-multi-device-sync`** — the welcome flow this epic exercises is owned by that epic. If the welcome flow regresses, `AttachA2Command_MD` fails first; that is the intended early-warning signal.
- **`docs/two-party-permutation-matrix.md`** — coverage table updated. TP-80..82 row reflects the L3 multi-device assertion.
- **`e2e/tests/multi-device-cross-npub.spec.ts`** — the example-based multi-device file remains. Property tests are additive.

## Non-Goals

- A unified harness combining multi-device with 3-party or with `Sw`. Explicitly out of scope.
- Resolving the TP-52 `(fixme)` (multi-device forget-self semantics). This epic asserts the leaf-count consequence only.
- Adding a fourth context for B2 (B's second device). The matrix does not include a TP scenario for it, and the symmetry argument from A's two devices is sufficient inductive evidence.
- A new bunker. A1 and A2 share `E2E_BUNKER_URL`.
- Modifying the 2-party file or the (when-it-lands) 3-party file.
- Asserting multi-device invariants at L1. The reducer has no concept of devices.
