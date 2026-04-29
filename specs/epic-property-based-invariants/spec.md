# Property-Based Invariant Tests for Multi-User Action Chains

## Problem

The existing test suite is example-based: each spec exercises a hand-picked permutation of user actions (`docs/two-party-permutation-matrix.md` enumerates ~40 of them as `TP-XX` scenarios). That's good coverage of *anticipated* sequences but it cannot catch defects that only surface in *unanticipated* sequences — concurrent edits, late-arriving snapshots, ratchet-tree edge cases when a member with multiple leaves intersperses task ops with `forgetDevice`, or the cumulative effect of 8+ randomly-chosen actions across two users.

The system has properties that should hold no matter what the action sequence is:

- A task's `updatedAt` is the running max of accepted update timestamps for that task.
- A pubkey is a member of a group iff it has ≥1 leaf in the ratchet tree.
- After all messages are delivered (quiescence), every current member of a group sees the same task state, the same member set, the same epoch, and the same per-pubkey leaf count.
- A user's identity-scoped view does not leak across `Sw(B)`.
- And so on.

These are exactly the kinds of invariants that property-based testing — *generate random action sequences, then assert the invariant either on the resulting state or after a few additional actions* — is designed to falsify. fast-check (the de-facto TS QuickCheck) ships generators, shrinking, and `fc.commands` for stateful/model-based testing; it maps almost 1:1 onto the action DSL already defined in `docs/two-party-permutation-matrix.md`.

This epic adds three layers of property-based tests covering the reducer, the multi-client task-event convergence model, and the full MLS+Nostr stack via Playwright, plus a small set of label-only "weak-spot probes" that quantify known-divergent behaviours.

## Solution

Add `fast-check` as a dev dependency and three new test files:

1. `src/store/task-reducer.property.test.ts` — vitest-speed property tests for the LWW reducer and IndexedDB persistence layer.
2. `src/store/multi-client.property.test.ts` — vitest-speed property tests for an in-memory N-client harness modelling the task-event layer's convergence guarantee under adversarial delivery order.
3. `e2e/tests/multi-user.property.spec.ts` — Playwright + fast-check `fc.commands` exercising the full MLS+Nostr stack across two browser contexts using verbs from the existing two-party DSL.

Each layer asserts a subset of the invariant catalogue defined below. The invariant IDs (`S1..`, `A1..`, `C0..`, `D1..`, `R1..`) are the contract surface — every property test names the invariant(s) it checks, and every invariant has at least one property test asserting it (or measuring it, in the case of D and R).

No production code changes are required. The dispatch path, reducer, persistence layer, MLS integration, and existing test hooks (`__notestrTestDispatchTaskEvent`, `__notestrTestGroups`, `__notestrTestSentRumors`, `__notestrTestArmPublishFailure` from `src/types/notestr-test-hooks.d.ts`) are sufficient for property-driving the system from outside.

## Invariant Catalogue

The terminology used below:

- **Reachable state** — any state of the system reached by applying a finite sequence of actions from a fresh boot.
- **Settled state** — a reachable state in which all dispatched task events have been delivered to and applied by every current member of every group, all MLS commits have been applied by every current member, and the ingest retry queues are empty. The test harness reaches this via a quiescence wait (Playwright) or by exhausting the in-memory bus (vitest).
- **Quiescence** — the act of reaching a settled state.
- **Action chain** — an ordered sequence of actions drawn from the DSL verbs (`Au`, `Dc`, `Rl`, `Sw`, `Cg`, `In`, `Lg`, `Fd`, `Rd`, `Ct`, `Ut`, `Sc`, `As`, `Un`, `Dt`).

### S — State invariants (must hold at every reachable state)

- **S1** Every visible task has `status ∈ {open, in_progress, done, cancelled}`.
- **S2** Every visible task has non-empty `id`, `createdAt > 0`, `updatedAt ≥ createdAt`, `assignee` either `null` or a 64-character hex string.
- **S3** A task's `createdBy` and `createdAt` never change once the task exists.
- **S4** A task's `updatedAt` equals `max(updatedAt)` across all events accepted by the reducer for that task.
- **S5 — Member-iff-leaf** For every group `g` and every pubkey `p`: `p ∈ getGroupMembers(g.state)` if and only if `p` has ≥1 leaf in `g`'s ratchet tree.
- **S6** `g.state.groupContext.epoch` is monotonically non-decreasing per client across the action chain.
- **S7 — Identity isolation** Groups and tasks visible under identity A in a given context are not visible under identity B in the same context after `Sw(B)`.
- **S8** Per-group event-log isolation in IndexedDB: events appended for `g₁` never appear in `loadEvents(g₂)`.
- **S9 — Replay determinism** `replayEvents(loadEvents(g))` deep-equals the in-memory reducer state for `g` at every reachable state.
- **S10 — Device-list / leaf-count consistency** For every pubkey `p` rendered in `DeviceList.tsx` for group `g`, the count of devices shown equals the count of leaves `p` has in `g`'s ratchet tree (i.e. `getPubkeyLeafNodes(g.state, p).length`).

### A — Action postconditions (after running an action chain, then one more specific action)

For each, "with newer timestamp" means `event.updatedAt ≥ existing.updatedAt`. Stale variants are covered by **A6**.

- **A1** `Ct(t)` ⇒ actor's local state contains `t` with `status: "open"`, `assignee: null`, `createdBy: actor.pubkey`, `createdAt == updatedAt`.
- **A2** `Sc(t, s)` with newer timestamp ⇒ `t.status == s` for the actor immediately, and for every current group member after delivery.
- **A3** `Ut(t, Δ)` with newer timestamp ⇒ for every key `k` in Δ, `t[k] == Δ[k]`; for every key not in Δ, `t[k]` is unchanged.
- **A4** `As(t, X)` / `Un(t)` with newer timestamp ⇒ `t.assignee == X` / `t.assignee == null`.
- **A5** `Dt(t)` with newer timestamp ⇒ `t` is absent from the actor's local state and from every current group member's state after delivery.
- **A6 — Stale-event no-op** Any of A2–A5 with `event.updatedAt < existing.updatedAt` ⇒ state for that task is byte-identical to the pre-action state.
- **A7** `Cg(g)` ⇒ creator is the sole member of `g` (`getGroupMembers(g.state) == [creator.pubkey]`), and `g.state.groupContext.epoch == 0`.
- **A8** `In(B)` followed by B processing the welcome ⇒ B has ≥1 leaf in `g`, and B's local view includes `g` as attached.
- **A9** `Lg(g)` by user U ⇒ U is absent from `getGroupMembers(g)` for all observers; U's local view shows `g` as detached or absent (per `computeDetachedGroupIds`).
- **A10 — Forget-device leaf semantics** `Fd(pᵢ)` where pubkey `p` had K leaves before:
  - K > 1 ⇒ `p` remains in `getGroupMembers(g)`, and `getPubkeyLeafNodes(g.state, p).length == K - 1`.
  - K == 1 ⇒ `p` is absent from `getGroupMembers(g)`.
- **A11** `Rl` ⇒ post-reload visible task state for every `(user, group)` pair is byte-identical to the pre-reload state.
- **A12** `Sw(B)` in a context that previously held identity A ⇒ that context now shows B's groups (those `g` for which B has ≥1 leaf), not A's, and the React state contains zero `Task` objects from A's groups.
- **A13 — Idempotence** Re-applying any non-`task.snapshot` event to the reducer yields a state byte-identical to the state after the first application.
- **A14 — Negative delivery** After `Lg(g)` or after the last leaf of pubkey `p` is forgotten, no subsequent kind-445 event for `g` is decryptable by `p`'s clients (verified via the relay subscriber + the absence of new `applicationMessage` callbacks on `p`'s side).
- **A15 — Multi-device same-pubkey self-converge** When the same pubkey is signed in to two contexts `A1` and `A2`, after either context's action chain reaches quiescence, A1 and A2 see deep-equal task state for every group both are members of.

### C — Convergence properties (assert at quiescence)

- **C0 — Settled-state equality (headline)** For every group `g`, at quiescence under MLS-faithful total-order delivery (every group member receives every event in the same total order; clients may PAUSE at different prefixes but never see events in *different* orders — the MLS application-message bus enforces this in production), every current member of `g` has identical:
  - `tasks(g)` — the deep-equal `Map<id, Task>` for the group,
  - `members(g) == getGroupMembers(g.state)` — the same set of pubkeys,
  - `epoch(g) == g.state.groupContext.epoch` — the same numeric epoch,
  - `leafCount(g, p) == getPubkeyLeafNodes(g.state, p).length` for every pubkey p ∈ members(g).
- **C1 — Permutation-independence of task state (atomic-kind subset)** For a sequence of events targeting the same task, **drawn from a single atomic-replace mutation kind** (`task.status_changed` only, in practice — see *Known LWW non-commutativity* below for why this restriction is necessary), when all timestamps are strictly distinct, the final reducer state is independent of delivery order.
- **C2 — Author-irrelevance** The final reducer state for a group at quiescence (under MLS-faithful delivery, per C0) is independent of which member authored each event (only the events themselves matter).
- **C3 — Duplicate-tolerance** Delivering each event 1–N times (N small) produces the same settled state as delivering each event exactly once. Asserted under MLS-faithful delivery per C0.

#### Known LWW non-commutativity (architectural constraint)

The reducer's `>=` guard at `task-reducer.ts:16` is **per-task-object, not per-field**. Concretely: a `task.assigned(ts=3)` event applied to a task with `updatedAt=1` raises that task's `updatedAt` to 3, which then causes any subsequent `task.status_changed(ts=2)` to be rejected as stale — even though the two events touch *different fields* and would not conflict under a per-field LWW. In dispatch order they compose cleanly (status_changed at ts=2 applies first; assigned at ts=3 applies second; final state has both fields set). In the swapped order, the second event is silently dropped.

This is **not a bug** — the real notestr system has MLS providing a single total order to every group member, so reordering of the kind that would expose this divergence cannot occur. C0 holds in production.

It IS, however, a constraint on what the reducer-level property tests can claim:

- **C1 cannot be asserted for mixed-kind sequences** even with strictly distinct timestamps. The single-client and multi-client C1 tests are therefore restricted to `task.status_changed`-only sequences targeting a single task. This is the broadest subset under which permutation-independence holds.
- **The multi-client C0 test models MLS total-order delivery** (causal prefix + bus-ordered drain) rather than arbitrary per-client reorder. Arbitrary reorder is documented as out-of-scope at this layer because it would surface the divergence above and the system architecture (MLS bus) prevents it from mattering.

If a future epic decides to harden the reducer with per-field LWW (or per-field LWW for atomic kinds + per-task LWW for `task.updated`'s merge semantics), the C1 restriction here can be relaxed and the multi-client C0 test can move to genuine arbitrary reorder. That is **not** a goal of this epic.

### D — Known-divergent properties (label-only; measured, not asserted)

These are surfaced as `fc.assert` calls wrapped in `expect.soft` or run with `fc.statistics(...)` so the divergence rate is reported but does not fail the build. They exist to (a) make the gap visible, (b) catch any unintended *change* in divergence rate, and (c) flip to positive assertions if/when the team fixes the underlying behaviour.

- **D1 — Concurrent equal-timestamp updates may diverge.** When two clients dispatch updates to the same task with identical `updatedAt`, the reducer's `>=` comparison at `src/store/task-reducer.ts:16` accepts whichever event arrives last, which differs across clients. Cross-references matrix scenarios TP-90/TP-91 (currently `fixme`).
- **D2 — Optimistic local apply diverges from peers when publish fails.** When `sendApplicationRumor` throws (test-armed via `__notestrTestArmPublishFailure`), the local state retains the optimistic change but no peer ever sees it. Divergence persists until the user reloads or re-dispatches.
- **D3 — Late-arriving `task.snapshot` overwrites newer events.** The reducer at `src/store/task-reducer.ts:58–64` unconditionally clears state on `task.snapshot`. If an out-of-order delivery places a snapshot from time T after individual events from T+10, the newer events are lost. Whether to fix the reducer (compare timestamps) or constrain delivery (snapshots only as initial state on join) is a design decision delegated to a follow-up epic.

### R — Resurrection caveat (by design; locked down by labelled property)

- **R1** `task.created(id=X)` arriving after `task.deleted(X)` with later timestamp **does** re-insert X. The reducer has no tombstone. This is by design (deletes are hard, ids are UUIDs and won't collide accidentally) but worth a labelled property test so any silent change to deletion semantics fails loudly.

## Scope

### In Scope

- A new dev dependency on `fast-check` (current latest stable, ~3.x), added to `package.json`.
- A new test file `src/store/task-reducer.property.test.ts` covering invariants S1–S4, S6, S8–S9, A1–A6, A13, C1–C3, D1, D3, R1, with at least 1000 `numRuns` per property.
- A new test file `src/store/multi-client.property.test.ts` covering invariants C0 (task-state subset), C1, C2, C3, A13 in a multi-client setting, plus D1 and D3 as labelled properties. Builds an in-memory `FakeBoard` harness with `N` clients (N ∈ [2, 5]) and an adversarially-ordered delivery bus.
- A new test file `e2e/tests/multi-user.property.spec.ts` that uses fast-check's `fc.commands` to drive random sequences of 5–10 DSL verbs across two browser contexts, asserting invariants S5, S6, S7, S10, A7, A8, A9, A10, A11, A12, A14, A15, C0 (full version including members/epoch/leaves), and measuring D2.
- A new section appended to `docs/two-party-permutation-matrix.md` titled `## Property-test coverage` that cross-references each `TP-XX` scenario to the invariant IDs the property tests cover (e.g. `TP-50, TP-51, TP-53 ⇒ A10, S5, C0`).
- A small make target `make test-property` that runs the two vitest property test files with `FAST_CHECK_NUM_RUNS=10000` to flush corner cases. Default `make test` keeps the standard 1000-run budget for CI speed.
- Documentation in a new `e2e/tests/property-tests.md` that explains the layered approach (reducer → multi-client → full stack), how to read fast-check counterexamples, and how to reproduce a failure deterministically using the printed seed.

### Out of Scope

- Modifying the reducer, dispatch path, MLS integration, or any production code. If a property test surfaces a real bug, fixing it is a follow-up epic per finding.
- A pure-Node MLS harness for fast property tests at the MLS layer. Layer 3 (multi-client convergence) only models the task-event subsystem; full MLS group dynamics are tested only via Playwright. Building an in-memory marmot-ts + fake-relay harness is a possible future investment but is explicitly out of scope here because (a) marmot-ts test mocks at `src/marmot/client.test.ts` are stub-based, not full-stack; (b) building one would be a multi-week effort that doubles as a marmot-ts test framework.
- Property tests for the welcome flow internals (gift-wrap signing, key-package selection). Those are tested in `e2e/tests/multi-device-sync.spec.ts` and have their own contract surface.
- Property tests over relay-level behaviours (NIP-44 envelope, kind-445 wire format). Those belong to `epic-task-sync-publish-contract` and use NDK-based observers.
- Fixing D1 (equal-timestamp tie-break), D2 (publish-failure UX), or D3 (snapshot semantics). Each is a separate decision and a separate epic.
- Removing or rewriting any existing example-based test. Property tests are additive — the existing `multi-user.spec.ts`, `cross-author-tasks.spec.ts`, etc. remain as readable, reproducible smoke tests for the named TP-XX scenarios.

## Design Decisions

1. **fast-check is the only new dependency.** It is the de-facto QuickCheck for TypeScript, has built-in shrinking, supports stateful testing via `fc.commands`, and is well-integrated with vitest and Playwright. No second dependency is needed.
2. **Three layers, not one monolith.** Reducer-level properties run in milliseconds and can afford 1000–10000 runs; multi-client convergence runs in seconds with a few hundred runs; full-stack Playwright runs in minutes with ~20 runs. Mixing them in one file would force the cheapest tests to share the wall-clock budget of the most expensive ones.
3. **The DSL maps onto `fc.commands` directly.** Each verb in the two-party permutation matrix becomes one fast-check `Command` class. This re-uses an existing, reviewed action vocabulary instead of inventing a parallel grammar. The matrix file remains the single source of truth for "what actions exist".
4. **Invariants are named, numbered, and cross-referenced.** Every property test references the invariant IDs it checks via a comment at the top of the test body. Acceptance criteria reference invariant IDs. The documentation cross-references TP-XX scenarios to invariant IDs. This is the contract surface — if an invariant changes, every reference to it can be located by grep.
5. **Property tests assert the *invariant*, not a specific TP-XX scenario.** A property test that runs 1000 random sequences inherently covers many TP-XX scenarios. The documentation maps invariants → TP-XX so reviewers can see the relationship, but each test's assertion is at the invariant level.
6. **The three D-invariants are labelled properties, not skipped tests.** `fc.statistics` is used to print the divergence rate per CI run, so any change in the rate (e.g. a regression that makes D1 worse) is visible in the run log. Skipping them entirely would lose that telemetry.
7. **Layer-1 + Layer-2 run on every CI build; Layer-3 runs only under `make e2e`.** Layer-3 needs a strfry relay and two browser contexts; gating it under e2e (not unit) is consistent with how the existing example-based e2e tests are gated.
8. **Settled-state equality (C0) is the headline invariant and gets the most numRuns budget at Layer-3.** It is the property that captures the user's mental model of correctness ("after random chain, all members agree"). Other Layer-3 invariants share the per-command postcondition path within the same `fc.commands` run.
9. **Quiescence wait at Layer-3 reuses the existing relay-subscription drain pattern from `e2e/tests/multi-user.spec.ts`.** Specifically, after each command, the test waits for either (a) a deterministic UI state via `expect.poll`, or (b) a relay-observer drain (no new events for 500ms). Both are pre-existing patterns in the e2e suite.
10. **Counterexample reproduction is via printed seed, not committed test cases.** When fast-check shrinks a counterexample, it prints the seed and path. Reproducing requires `FAST_CHECK_SEED=<seed> FAST_CHECK_PATH=<path> npm test -- <file>`. The documentation describes this. We do NOT auto-commit failing seeds; that pollutes the test file with one-off snapshots that can mask the underlying property.
11. **Layer-3 follows the project's `describe.serial` rule.** A single `fc.commands` run is genuinely serial (each command's postcondition depends on prior commands' state). Wrapping the property in a single `describe.serial` block matches the project's stated rule on serial tests (per `project_e2e_serial_constraint` memory).
12. **Generators avoid the empty-state corner where every action is a no-op.** Each generator is state-aware: `Ct` always emits a fresh task; `Ut`/`Sc`/`As`/`Un`/`Dt` only target tasks already in the model state; `Lg`/`Fd` only target groups/leaves the actor is part of. This keeps the random-action density high and avoids the failure mode where 80% of generated commands are pruned by `fc.pre`.

## Technical Approach

### Layer 1: `src/store/task-reducer.property.test.ts`

Vitest + fast-check. ~250 lines.

Generators:

```ts
import * as fc from "fast-check";

const arbHexPubkey = fc.hexaString({ minLength: 64, maxLength: 64 });

const arbTask = fc.record({
  id: fc.uuid(),
  title: fc.string({ minLength: 1, maxLength: 60 }),
  description: fc.string({ maxLength: 200 }),
  status: fc.constantFrom("open", "in_progress", "done", "cancelled"),
  assignee: fc.option(arbHexPubkey, { nil: null }),
  createdBy: arbHexPubkey,
  createdAt: fc.integer({ min: 1, max: 2_000_000_000 }),
}).chain((t) =>
  fc.record({ ...t, updatedAt: fc.integer({ min: t.createdAt, max: 2_000_000_000 }) }),
);

// State-aware generator that emits valid events given current state.
function arbTaskEvent(state: TaskState): fc.Arbitrary<TaskEvent> { /* ... */ }

// Sequence builder that threads state.
function arbEventSequence(maxLength = 30): fc.Arbitrary<TaskEvent[]> { /* ... */ }
```

Properties (one `it` per invariant):

```ts
it("S1 — status is always in the enum", () => {
  fc.assert(
    fc.property(arbEventSequence(), (events) => {
      const state = replayEvents(events);
      for (const t of state.values()) {
        expect(["open", "in_progress", "done", "cancelled"]).toContain(t.status);
      }
    }),
    { numRuns: 1000 },
  );
});
```

The full file covers S1–S4, S6 (vacuous at this layer), S8, S9, A1–A6, A13, C1, C2, C3 (single-client subset), D1, D3, R1.

### Layer 2: `src/store/multi-client.property.test.ts`

Vitest + fast-check. ~400 lines.

Harness:

```ts
class FakeBoard {
  clients: TaskState[]; // one Map per client
  bus: Array<{ event: TaskEvent; deliveredTo: Set<number> }>;

  constructor(numClients: number) {
    this.clients = Array.from({ length: numClients }, () => new Map());
    this.bus = [];
  }

  dispatch(clientIdx: number, event: TaskEvent): void {
    this.clients[clientIdx] = applyEvent(this.clients[clientIdx], event);
    this.bus.push({ event, deliveredTo: new Set([clientIdx]) });
  }

  deliver(busIdx: number, targetIdx: number): void {
    const slot = this.bus[busIdx];
    if (slot.deliveredTo.has(targetIdx)) return;
    this.clients[targetIdx] = applyEvent(this.clients[targetIdx], slot.event);
    slot.deliveredTo.add(targetIdx);
  }

  quiesce(): void {
    for (let bi = 0; bi < this.bus.length; bi++) {
      for (let ci = 0; ci < this.clients.length; ci++) {
        this.deliver(bi, ci);
      }
    }
  }
}
```

A second arbitrary, `arbDeliverySchedule`, generates an interleaved sequence of `dispatch(clientIdx, event)` and `deliver(busIdx, targetIdx)` operations. The property test runs the schedule, then calls `quiesce()`, then asserts:

```ts
it("C0 — all clients converge at quiescence", () => {
  fc.assert(
    fc.property(arbBoardSchedule(), ({ numClients, ops }) => {
      const board = new FakeBoard(numClients);
      for (const op of ops) op.kind === "dispatch" ? board.dispatch(...) : board.deliver(...);
      board.quiesce();
      for (let i = 1; i < numClients; i++) {
        expect(mapEqual(board.clients[0], board.clients[i])).toBe(true);
      }
    }),
    { numRuns: 500 },
  );
});
```

Covers C0 (task-state subset), C1, C2, C3, A13 multi-client, A15 (the multi-device case is structurally a 2-client convergence test in this harness), D1 and D3 as labelled properties via `fc.statistics`.

### Layer 3: `e2e/tests/multi-user.property.spec.ts`

Playwright + fast-check `fc.commands`. ~500 lines.

Pattern:

```ts
import { test } from "@playwright/test";
import * as fc from "fast-check";

test.describe.serial("multi-user property", () => {
  test("settled-state equality holds for any 5–10 action chain", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    // ...authenticate both via the bunker fixture.
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const model = new ModelState(); // tracks expected groups, members, tasks per actor.
    const real = new RealSystem(pageA, pageB);

    const commands = [
      fc.constant(new CgCommand(...)),
      fc.constant(new InCommand(...)),
      fc.tuple(arbTaskTitle, arbTaskDesc).map(([t, d]) => new CtCommand(...)),
      fc.tuple(arbActor, arbExistingTask, arbStatus).map(...) /* ScCommand */,
      // ... one per DSL verb
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 10 }), async (cmds) => {
        // Reset both contexts to clean state.
        await real.reset();
        model.reset();
        await fc.asyncModelRun(() => ({ model, real }), cmds);
        // After every fc.commands run, assert the headline invariants.
        await real.quiesce();
        await assertC0(model, real);    // settled-state equality
        await assertS5(real);            // member-iff-leaf
        await assertS7(real);            // identity isolation
        await assertS10(real);           // device-list / leaf-count consistency
      }),
      { numRuns: 20, timeout: 120_000 },
    );
  });
});
```

Each `Command` class:

```ts
class CtCommand implements fc.AsyncCommand<ModelState, RealSystem> {
  constructor(private readonly actor: ActorId, private readonly task: { title: string; desc: string }) {}
  check(m: ModelState): boolean {
    return m.actorIsAuthenticated(this.actor) && m.actorHasGroup(this.actor);
  }
  async run(m: ModelState, r: RealSystem): Promise<void> {
    const id = await r.dispatchCt(this.actor, this.task);
    m.addTask(this.actor, id, { ...this.task, status: "open", assignee: null });
    // Per-command postcondition:
    expect(await r.getTask(this.actor, id)).toMatchObject({ title: this.task.title, status: "open" });
  }
  toString() { return `${this.actor}.Ct(${this.task.title})`; }
}
```

When fast-check shrinks a counterexample, every command's `toString` produces the matrix DSL — a counterexample reads as `A.Cg(g1) → A.In(B) → B.Sc(t1, d) → A.Fd(B1) → ...` and is directly cross-referenceable with `docs/two-party-permutation-matrix.md`.

### Documentation

Append to `docs/two-party-permutation-matrix.md`:

```markdown
## Property-test coverage

The example-based scenarios in the matrix are now reinforced by random-sequence
property tests in `src/store/*.property.test.ts` and
`e2e/tests/multi-user.property.spec.ts`. The mapping below shows which
invariants (defined in `specs/epic-property-based-invariants/spec.md`) are
asserted for each scenario family.

| Scenario family       | Invariants asserted                |
| --------------------- | ---------------------------------- |
| TP-01..04 (setup)     | A7, A8, A9, S5, S7                 |
| TP-10..17 (A→B prop)  | A1..A5, C0, S4                     |
| TP-20..24 (B→A mut)   | A1..A5, C0, C2, S3                 |
| TP-30..32 (snapshot)  | A8, C0, D3                         |
| TP-40..42 (leave)     | A9, A14, S5, C0                    |
| TP-50..53 (forget)    | A10, A14, S5, S10, C0              |
| TP-60..62 (rename)    | (UI-local; out of property scope)  |
| TP-70..72 (3-party)   | (covered by 2-party C0 + induction)|
| TP-80..82 (multi-dev) | A15, C0                            |
| TP-90..91 (concurrent)| D1                                 |
```

Create `e2e/tests/property-tests.md` with sections: "Why three layers", "How to read fast-check output", "Reproducing a counterexample", "When a property fails: bug vs. spec change".

### `package.json`

```json
{
  "devDependencies": {
    "fast-check": "^3.23.0"
  }
}
```

### `Makefile`

Add a single target:

```makefile
test-property: node_modules
	FAST_CHECK_NUM_RUNS=10000 npm test -- src/store/task-reducer.property.test.ts src/store/multi-client.property.test.ts
```

`make test` is unchanged (keeps default 1000-run budget).
`make e2e` already runs `e2e/tests/*.spec.ts` and will pick up `multi-user.property.spec.ts` automatically.

## Stories

Implementation breakdown (preliminary — to be expanded into `stories.json` once accepted):

- **S1** — Add `fast-check` to `package.json` devDependencies. Add `make test-property` target. Verify `make test` and `make test-property` both run cleanly (no tests yet, just dependency wiring).
- **S2** — `src/store/task-reducer.property.test.ts`: implement `arbTask`, `arbTaskEvent(state)`, `arbEventSequence`. Cover invariants S1–S4, S8, S9, A1–A6, A13, R1. ~150 lines.
- **S3** — Extend the same file to cover C1, C2, C3 (single-client multi-event subset), and the labelled properties D1, D3. ~80 lines.
- **S4** — `src/store/multi-client.property.test.ts`: implement `FakeBoard` and `arbBoardSchedule`. Cover invariants C0 (task-state subset), C1, C2, C3, A13, A15. ~250 lines.
- **S5** — Extend the same file with labelled properties for D1 and D3 in the multi-client setting. ~50 lines.
- **S6** — `e2e/tests/multi-user.property.spec.ts`: implement `ModelState`, `RealSystem`, and one `Command` class per DSL verb (`Cg`, `In`, `Lg`, `Fd`, `Rd`, `Ct`, `Ut`, `Sc`, `As`, `Un`, `Dt`, `Rl`). Single property test asserting C0, S5, S6, S7, S10 plus per-command postconditions A1–A12. ~500 lines.
- **S7** — Append `## Property-test coverage` section to `docs/two-party-permutation-matrix.md`. Create `e2e/tests/property-tests.md`.
- **S8** — Inject a deliberate bug into the reducer (flip `>=` to `>` at `task-reducer.ts:16`) and confirm the property suite produces a minimal, readable counterexample. Revert. This is a one-shot validation that property tests actually catch what they claim to catch, run as a manual checklist item — not a committed test.

## Acceptance Criteria

See `acceptance-criteria.md`.

## Relationship to Other Epics

- **`epic-task-sync-publish-contract`** — covers what gets published to the relay (kind-445 wire format, NDK observation). This epic covers what gets *applied* across multiple clients after publish. The two are orthogonal; both feed off the same `dispatch` path.
- **`epic-multi-device-sync`** — covers the welcome flow, auto-invite, and per-device list UI. This epic uses those features as primitives in random action chains; if the welcome flow regresses, A8 fails.
- **`epic-identity-scoped-group-and-task-visibility`** — defines `Sw` semantics. This epic includes random `Sw(B)` actions and asserts S7 (identity isolation) under random sequences.
- **`docs/two-party-permutation-matrix.md`** — defines the action vocabulary and the example-based scenarios. This epic generalises from named scenarios to random sequences over the same vocabulary.

## Non-Goals

- A standalone property-testing framework specific to this project. We use fast-check off the shelf; conveniences are added inline as ~10-line helpers, not as a published library.
- Property-based testing of non-task domains (auth flow internals, bunker handshake, rendering performance). Those are out of scope.
- Auto-committing failing seeds as snapshot tests. Counterexamples are reproduced via `FAST_CHECK_SEED` env vars; once a bug is fixed, the failing case is re-derivable from the property and does not need a frozen snapshot.
- Increasing `numRuns` to a level that makes CI runtime untenable. Default budgets (1000 for vitest, 20 for Playwright) are tuned for ~20s and ~5min respectively. `make test-property` is the path for deeper local exploration.
- Removing or deprecating the example-based test suite. The TP-XX scenarios remain the documentation of intended behaviour; property tests are a backstop against unintended behaviour.
