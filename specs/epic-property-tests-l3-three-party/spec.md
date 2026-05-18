# Property Tests Layer-3 — Three-Party Coverage

## Problem

The matrix at `docs/two-party-permutation-matrix.md` § *Property-test coverage* maps the 3-party scenario family (TP-70..72) to the claim "covered by 2-party C0 + induction". The L3 property spec at `e2e/tests/multi-user.property.spec.ts` only opens two browser contexts (`pageA`, `pageB`) and cannot generate any 3-party action chain.

"Covered by induction" is a real argument for many CRDT-style invariants — if convergence holds for any pair of clients in a group, it holds for any N. But the inductive step depends on assumptions that the L3 harness deliberately does *not* enforce:

1. **Admin-only commits (MIP-03 follower).** TP-70 (admin issues both invites) and TP-70c (chain invite, B invites C) behave very differently. The current L3 harness has no `B.In(C)` command — neither variant is exercised. The example-based `e2e/tests/three-party.spec.ts` covers TP-70 and TP-71 / TP-72, but only at fixed action sequences.
2. **Three-leaf ratchet-tree dynamics.** `Fd` semantics, S10 row-count consistency, and S5 member-iff-leaf are all per-pubkey-per-group. A 2-party harness can verify them only for the pair {A, B}; the third leaf's effect on commit ordering, welcome-snapshot membership, and leaf-index reuse is unobserved. Spec.md §S5/§S10 are stated for "every pubkey in the group", and the inductive argument from N=2 to N=3 is strictly weaker than empirical evidence for N=3.
3. **Shrinking counterexamples.** When a property test fails, fast-check shrinks to the minimum failing case. A 3-party bug shrunk by a 2-party harness will be reported as a 2-party divergence with no signal that a third actor was relevant — or, more insidiously, the bug will not be reproducible in the 2-party harness at all.

The infrastructure for a third party already exists: `e2e/fixtures/auth-helper-c.ts` ships `E2E_BUNKER_C_URL`, `USER_C_NPUB`, and `authenticateAsBunkerC`. The bunker is wired in `docker-compose.e2e.yml` and used by `e2e/tests/three-party.spec.ts`. The structural cost of adding C to the property harness is therefore much smaller than starting from scratch.

## Solution

Extend the L3 property harness to open three browser contexts and authenticate one bunker per actor (A → bunker A, B → bunker B, C → bunker C). Widen the actor model from `"A" | "B"` to `"A" | "B" | "C"`. Add the missing 3-party DSL command (`InCommand` already exists for admin invites; `BInCCommand` is the new one for "B invites C", which TP-70c blocks via MIP-03 and which therefore stays a labelled-only probe rather than an asserted command). Re-run the headline invariants (C0, S5, S6, S7, S10) across the three actors at quiescence.

A new test file `e2e/tests/multi-user-3p.property.spec.ts` is added rather than expanding the existing 2-party file. Two reasons: the 2-party file's actor model is hard-coded throughout (`pageA` / `pageB` references, `m.memberA` / `m.memberB`, `epochSequenceA` / `epochSequenceB`); refactoring to a generic `actors[]` shape would balloon the diff. Second, the 3-party run takes ~2× the wall-clock per command — it should not gate the 2-party file's CI envelope.

## Scope

### In Scope

- A new property test file `e2e/tests/multi-user-3p.property.spec.ts` modelled on the existing 2-party file but with three contexts.
- A `RealSystem3P` class with `pageA`, `pageB`, `pageC`, plus `page(actor: "A" | "B" | "C")` accessor, mirroring the 2-party `RealSystem` shape.
- A `ModelState3P` class with per-actor pubkeys, membership flags, group-id tracking, and per-actor epoch sequences.
- Command classes adapted from the 2-party file:
  - **`CgCommand` (admin = A only).** A creates the group; B and C are invited later. Three-party C0 requires a single shared group.
  - **`InCommand`** generalised to `(inviter, invitee)` arguments; constrained at the model level so only A invites (admin-only-commits, per MIP-03 and the project's three-party.spec convention).
  - **`LgCommand`, `FdCommand`, `RdCommand`, `CtCommand`, `UtCommand`, `ScCommand`, `AsCommand`, `UnCommand`, `DtCommand`, `RlCommand`, `SwCommand`** — each generalised over `actor: "A" | "B" | "C"`.
  - **No new commands.** `B.In(C)` (TP-70c) is excluded because the project's MIP-03 follower rejects non-admin commits; the labelled-only probe variant is captured under § *Out of Scope* of this epic and tracked in `docs/two-party-permutation-matrix.md` as `(fixme)`.
- Headline invariant assertions extended to three-actor form:
  - **`assertC0_3P`** — for every group `g` with all three actors as members, the four dimensions (tasks, members, epoch, leafCount) match across A, B, C.
  - **`assertS5_3P`** — biconditional `(p ∈ members) ⇔ (leafCount >= 1)` for every `p ∈ {A, B, C}`.
  - **`assertS6_3P`** — per-actor epoch monotonicity for all three.
  - **`assertS7_3P`** — identity isolation triggered after any `Sw` (no change in shape, just three contexts).
  - **`assertS10_3P`** — DeviceList row-count equality for each actor's own pubkey.
- Coverage table update in `docs/two-party-permutation-matrix.md` § *Property-test coverage*: change the TP-70..72 row from "(covered by 2-party C0 + induction)" to "C0, S5, S6, S7, S10, A7..A12 (3-party at L3)". Append a footnote naming the labelled-only TP-70c case.
- `Makefile` no changes needed — Playwright auto-discovers `e2e/tests/*.spec.ts`. The 3-party file inherits the existing `make e2e` gating.

### Out of Scope

- TP-70c "chain invite" (`B.In(C)`). The MIP-03 admin-only-commits constraint means a non-admin invite never produces a valid welcome at the relay. Capturing it as a labelled-only probe (zero events on C's side after `B.In(C)` attempt) is a candidate for a follow-up epic, not this one. The existing `(fixme)` annotation in the matrix table for TP-70c remains.
- 4-or-more-party harness. The argument for 3-party is the matrix coverage gap; the argument for N≥4 is weaker (no scenario family in the matrix needs it).
- A generalised N-party harness with `actors[]`. The 2-party and 3-party files duplicate ~40% of their structure but stay independently readable; a generic harness is a refactoring epic, not a coverage epic.
- Refactoring the 2-party file. It remains untouched. If a future epic merges them, that is an explicit choice with its own ACs.
- 3-party invariants that don't apply: A15 (multi-device same-pubkey) is covered by `epic-property-tests-l3-multi-device`; this epic uses three distinct pubkeys.
- A new bunker fixture. `auth-helper-c.ts` is reused as-is.
- New test hooks. This epic depends on the hooks added by `epic-property-tests-l3-completion` (epoch / members / leaf-count). If that epic has not landed, the 3-party file degrades gracefully — `assertC0_3P` falls back to the task-subset check, `assertS5_3P` keeps the positive-only direction, etc. Acceptance criteria document the gating.

## Design Decisions

1. **Separate file, not a refactor.** The 2-party file is 1048 lines with hard-coded `A` / `B` references throughout. A generic `actors[]` rewrite would touch every command's `check`, `run`, and `toString`. The benefit (one file instead of two) does not justify the diff size. The duplication is honest about the structural reality: the harness *is* a state machine with an enumerated actor set, and adding actors changes the state machine.
2. **Admin-only invites are encoded as a model precondition, not a runtime check.** `InCommand.check(m)` returns `true` only when the inviter is A (admin). This avoids generating commands fast-check would have to discard via `fc.pre` and keeps the random-action density high.
3. **C0 over the single shared group only.** A 3-party run could in principle have multiple groups (A creates g1, A invites B; A creates g2, A invites C; etc.), but the C0 assertion is meaningful only when all three actors are members of the same group. The harness scopes the assertion: when the model knows of a single group with all three as members, assert; otherwise skip with the early-return pattern used by the 2-party `assertC0`.
4. **Per-run cleanup is the same as the 2-party file.** Reset only the model; let MLS leftover state accumulate across runs. The `assertS5` scoping rule (current group only) from `epic-property-tests-l3-completion` carries over. Add C's identity to the per-run identity-restore logic that the 2-party file uses for `Sw`.
5. **Wall-clock budget.** The 2-party L3 file has a 10-minute envelope (AC-FS-4). The 3-party file gets a separate 12-minute envelope. With three contexts and per-command cost ~1.3× the 2-party cost, 20 runs × ~10 commands × ~3.5 s per command + setup ≈ 11 minutes. If the budget is exceeded in practice, lower `numRuns` to 15 before reducing `maxCommands` (longer chains are higher-signal than more runs).
6. **`SwCommand` only switches A's context.** The 2-party file's `SwCommand` switches A's identity to B or back. In 3-party, switching introduces 2³ = 8 identity-context combinations and the model bookkeeping explodes. This epic's `SwCommand` is restricted: it switches only A's context, and only between A and B (matches the 2-party file's behaviour). The 3-party identity-isolation invariant is therefore tested for the A→B switch under a 3-party group; the A→C and B→C switches are explicitly out of scope. This is a conscious narrowing — the value of 3-party is *task convergence under three-leaf MLS*, not identity-switching combinatorics.
7. **`numRuns: 15` instead of 20.** The wall-clock argument plus the diminishing-returns argument: 20 runs catches roughly the same defects as 15 in a 3-party harness because each run has higher per-command coverage (more state surface). If shrinking is slow on a real failure, reduce `maxCommands` from 10 to 8 first.
8. **Reuse the auth pattern from `three-party.spec.ts`.** That file already authenticates all three bunkers in series. Copy its setup verbatim into the new property file's `test.beforeAll`. Do not introduce a parallel bunker-startup pattern.

## Technical Approach

### File layout

```
e2e/tests/multi-user-3p.property.spec.ts    (new)
e2e/fixtures/two-party.ts                   (no change; helpers already export)
e2e/fixtures/auth-helper-c.ts               (no change)
docs/two-party-permutation-matrix.md        (coverage table edit only)
specs/epic-property-tests-l3-three-party/   (this epic)
```

### Command class generalisation

Pattern for each command in the new file (illustrated with `CtCommand`):

```ts
class CtCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(
    private readonly actor: "A" | "B" | "C",
    private readonly title: string,
    private readonly desc: string,
  ) {}

  check(m: ModelState3P): boolean {
    return m.actorIsMember(this.actor) && m.groupId !== null;
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    const id = await r.dispatchCt(this.actor, { title: this.title, description: this.desc });
    m.addTask(id, {
      title: this.title,
      description: this.desc,
      status: "open",
      assignee: null,
      createdBy: m.pubkey(this.actor),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await r.getTask(this.actor, id)).toMatchObject({ title: this.title });
  }

  toString(): string {
    return `${this.actor}.Ct(${this.title})`;
  }
}
```

The `actor: "A" | "B" | "C"` widening is the only meaningful change over the 2-party form. Every helper that the command calls (`r.dispatchCt`, `m.actorIsMember`, `m.pubkey`) is the 3-party version; the 2-party originals stay untouched.

### `ModelState3P` shape

```ts
class ModelState3P {
  groupId: string | null = null;        // single shared group
  groupName: string | null = null;
  pubkeyA: string | null = null;
  pubkeyB: string | null = null;
  pubkeyC: string | null = null;
  memberA = false;
  memberB = false;
  memberC = false;
  tasks: Map<string, ModelTask> = new Map();
  epochSequenceA: number[] = [];
  epochSequenceB: number[] = [];
  epochSequenceC: number[] = [];
  lastSwitched: { context: "A" | "B"; priorGroupIds: string[] } | null = null;
  // ... helpers: pubkey(actor), actorIsMember(actor), recordEpoch(actor, n), reset()
}
```

### Headline invariant assertions

`assertC0_3P` (all three members of the shared group):

```ts
async function assertC0_3P(m: ModelState3P, r: RealSystem3P): Promise<void> {
  if (!m.groupId || !(m.memberA && m.memberB && m.memberC)) return;

  const tasksByActor = await Promise.all(
    (["A", "B", "C"] as const).map((a) => r.getTasks(a)),
  );
  // task subset across all three
  const idSets = tasksByActor.map((t) => new Set(t.keys()));
  expect(idSets[0]).toEqual(idSets[1]);
  expect(idSets[1]).toEqual(idSets[2]);
  // status / assignee / title equality across all three for shared task ids
  for (const id of idSets[0]) {
    const tA = tasksByActor[0].get(id)!;
    const tB = tasksByActor[1].get(id)!;
    const tC = tasksByActor[2].get(id)!;
    for (const f of ["status", "assignee", "title"] as const) {
      expect(tA[f]).toBe(tB[f]);
      expect(tB[f]).toBe(tC[f]);
    }
  }

  // Members/epoch/leafCount via the new test hooks (epic-property-tests-l3-completion).
  const membersByActor = await Promise.all(
    (["A", "B", "C"] as const).map((a) => getGroupMembersHook(r.page(a), m.groupId!)),
  );
  expect(new Set(membersByActor[0])).toEqual(new Set(membersByActor[1]));
  expect(new Set(membersByActor[1])).toEqual(new Set(membersByActor[2]));

  const epochByActor = await Promise.all(
    (["A", "B", "C"] as const).map((a) => getGroupEpochHook(r.page(a), m.groupId!)),
  );
  expect(epochByActor[0]).toBe(epochByActor[1]);
  expect(epochByActor[1]).toBe(epochByActor[2]);

  const allMembers = new Set([
    ...(membersByActor[0] ?? []),
    ...(membersByActor[1] ?? []),
    ...(membersByActor[2] ?? []),
  ]);
  for (const p of allMembers) {
    const lcs = await Promise.all(
      (["A", "B", "C"] as const).map((a) => getPubkeyLeafCountHook(r.page(a), m.groupId!, p)),
    );
    expect(lcs[0]).toBe(lcs[1]);
    expect(lcs[1]).toBe(lcs[2]);
  }
}
```

`assertS5_3P`, `assertS6_3P`, `assertS7_3P`, `assertS10_3P` follow the same actor-iteration pattern.

### Authentication setup

Copy from `e2e/tests/three-party.spec.ts`:

```ts
test.beforeAll(async ({ browser }) => {
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  contextC = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  pageC = await contextC.newPage();
  await Promise.all([
    authenticate(pageA, E2E_BUNKER_URL),
    authenticate(pageB, E2E_BUNKER_B_URL),
    authenticate(pageC, E2E_BUNKER_C_URL),
  ]);
  cachedPubkeyA = await getPubkeyHex(pageA);
  cachedPubkeyB = await getPubkeyHex(pageB);
  cachedPubkeyC = await getPubkeyHex(pageC);
});
```

### Single test, three-actor commands array

```ts
test.describe.serial("[C0,S5,S6,S7,S10,A7-A12,A14] 3-party multi-user property", () => {
  test.setTimeout(720_000); // 12 minutes

  test("[C0,S5,S6,S7,S10] settled-state equality holds across A/B/C", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    const real = new RealSystem3P(pageA, pageB, pageC);
    const arbActor = fc.constantFrom<"A" | "B" | "C">("A", "B", "C");
    // ... arbTitle, arbDesc, arbStatus same as 2-party

    const commands: fc.Arbitrary<fc.AsyncCommand<ModelState3P, RealSystem3P>>[] = [
      fc.constant(new CgCommand3P()),
      // Admin-only invite: inviter is always A, invitee is B or C
      fc.constantFrom("B", "C" as const).map((invitee) => new InCommand3P(invitee)),
      arbActor.map((actor) => new LgCommand3P(actor)),
      arbActor.map((actor) => new FdCommand3P(actor)),
      // ... CtCommand3P, UtCommand3P, ScCommand3P, AsCommand3P, UnCommand3P, DtCommand3P, RlCommand3P
      fc.constant(new SwCommand3P()), // switches A only, A↔B
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.commands(commands, { maxCommands: 10 }),
        async (cmds) => {
          const model = new ModelState3P();
          model.pubkeyA = cachedPubkeyA;
          model.pubkeyB = cachedPubkeyB;
          model.pubkeyC = cachedPubkeyC;

          await fc.asyncModelRun(() => ({ model, real }), cmds);
          // identity restore (same pattern as 2-party)
          if (model.pubkeyA !== cachedPubkeyA) {
            await switchIdentity(real.pageA, E2E_BUNKER_URL);
            model.pubkeyA = cachedPubkeyA;
            model.memberA = false;
            model.groupId = null;
          }
          await real.quiesce();

          await assertC0_3P(model, real);
          await assertS5_3P(model, real);
          await assertS6_3P(model);
          await assertS7_3P(model, real);
          await assertS10_3P(model, real);
        },
      ),
      {
        numRuns: 15,
        verbose: true,
        seed: parseInt(process.env.FAST_CHECK_SEED ?? "0") || undefined,
        path: process.env.FAST_CHECK_PATH ?? undefined,
      },
    );
  });
});
```

### Stories

- **S1 — Skeleton.** Add `e2e/tests/multi-user-3p.property.spec.ts` with `beforeAll`/`afterAll` setup, `RealSystem3P`, `ModelState3P`. No commands yet. Confirm Playwright discovers and skips (no test body).
- **S2 — Per-actor command classes.** Port `CtCommand`, `UtCommand`, `ScCommand`, `AsCommand`, `UnCommand`, `DtCommand`, `RlCommand` to 3-party form. ~250 LOC.
- **S3 — Group-lifecycle commands.** Port `CgCommand` (admin only), `InCommand` (admin invitee = B or C), `LgCommand`, `FdCommand`, `RdCommand`, `SwCommand` (A↔B only). ~200 LOC.
- **S4 — Headline assertions.** Implement `assertC0_3P`, `assertS5_3P`, `assertS6_3P`, `assertS7_3P`, `assertS10_3P`. Depend on `epic-property-tests-l3-completion`'s test hooks. ~150 LOC.
- **S5 — Wire single property test.** Combine commands array, `numRuns: 15`, `maxCommands: 10`, `setTimeout(720_000)`, identity restore. ~50 LOC.
- **S6 — Coverage table edit.** Update the TP-70..72 row in `docs/two-party-permutation-matrix.md` to reflect 3-party L3 enforcement. Add footnote for TP-70c (labelled-only / blocked by MIP-03).
- **S7 — Wall-clock validation.** Run `make e2e` against the new file three times locally; record p95 and p99 wall-clock. Adjust `numRuns` or `maxCommands` if the 12-minute envelope is breached in any of the three runs.

S2 and S3 can land in either order. S4 depends on `epic-property-tests-l3-completion` having shipped the test hooks; if it has not, S4 ships a degraded form (task-subset only) and a follow-up story re-enables the full assertions.

## Acceptance Criteria

See `acceptance-criteria.md`.

## Relationship to Other Epics

- **`epic-property-tests-l3-completion`** — *prerequisite for the strict form* of `assertC0_3P`, `assertS6_3P`, `assertS10_3P`. Without that epic's test hooks, this epic ships a degraded variant (task-subset only) and a follow-up.
- **`epic-property-tests-l3-multi-device`** — independent. Multi-device same-pubkey is a separate axis (3 leaves of one pubkey vs. 3 distinct pubkeys).
- **`epic-property-based-invariants`** — extends the matrix coverage from "by induction" to "by enforcement". The original epic's S6 story said the L3 spec covers "two browser contexts"; this epic adds a sibling spec for three.
- **`docs/two-party-permutation-matrix.md`** — the coverage table is updated. TP-70..72 stop being inductive claims and become enforced rows.
- **`e2e/tests/three-party.spec.ts`** — the example-based 3-party file remains. Property tests are additive per the parent epic's policy (AC-X-NO-EXAMPLE-DELETION-1).

## Non-Goals

- A generic N-party harness. 3 is enough to break the 2-party inductive claim; N≥4 has no scenario-family motivation.
- Asserting `B.In(C)` / TP-70c. MIP-03 blocks it; a labelled-only probe is a follow-up.
- Making the 3-party file depend on or consume the 2-party file. They are independent.
- Modifying the existing 2-party file. The 2-party assertions stay as `epic-property-tests-l3-completion` leaves them.
- A new bunker. `auth-helper-c.ts` exists.
- Exhaustive 3-actor `Sw` permutations. SwCommand is restricted to A↔B for combinatorial reasons.
- Full identity isolation matrix across all three actors. `assertS7_3P` triggers on any `Sw`, but the harness only fires A↔B switches; A↔C and B↔C are out of scope.
