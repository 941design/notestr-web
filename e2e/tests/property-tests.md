# Property-Based Test Documentation

## Why three layers

The property-based test suite is split into three layers, each trading speed for
realism:

**Layer 1 — reducer** (`src/store/task-reducer.property.test.ts`)  
Pure TypeScript: no browser, no relay, no MLS. Runs in milliseconds. Exercises
the LWW reducer and IndexedDB persistence layer with 1 000 random event
sequences per property. Best place to catch reducer logic bugs because
counterexamples shrink to a handful of events.

**Layer 2 — multi-client** (`src/store/multi-client.property.test.ts`)  
Pure TypeScript `FakeBoard` harness with 2–5 in-memory clients and an
adversarially-ordered delivery bus. Runs in seconds with 500 random schedules
per property. Tests convergence (C0) and commutativity (C1, C2, C3) without a
real relay or MLS layer. The delivery model is single-total-order (faithful to
what MLS provides in production), so arbitrary per-client reorder is explicitly
out of scope here.

**Layer 3 — full stack** (`e2e/tests/multi-user.property.spec.ts`)  
Playwright + fast-check `fc.commands` across two browser contexts, a live
strfry relay, and real MLS group state. Runs in 4–6 minutes with 20 random
action chains of up to 10 commands each. Tests the full MLS + Nostr + React
stack. Counterexamples are harder to shrink (each step is an async browser
operation), but they catch integration defects that layers 1 and 2 cannot reach.

Run layers 1 and 2 via `make test` (default budget). Run layer 3 via `make e2e`.
Run all layers at a higher budget via `make test-property` (layers 1–2 only,
10 000 runs).

## Invariant catalogue cross-reference

All invariant IDs (`S1..S10`, `A1..A15`, `C0..C3`, `D1..D3`, `R1`) are defined
in [`specs/epic-property-based-invariants/spec.md`](../../specs/epic-property-based-invariants/spec.md).
Each property test body begins with a comment of the form `// {ID}: short
description` and each test title contains `[{ID}]` so the full set is greppable:

```
grep -r '\[S1\]\|\[A7\]\|\[C0\]' src/store e2e/tests
```

Layer coverage summary:

| Layer | File | Invariants |
| ----- | ---- | ---------- |
| 1 | `task-reducer.property.test.ts` | S1–S4, S8, S9, A1–A6, A13, C1–C3, D1, D3, R1 |
| 2 | `multi-client.property.test.ts` | C0, C1–C3, A13, A15, D1, D3 |
| 3 | `multi-user.property.spec.ts` | S5, S7, S10, A1–A5, A7–A12, A14, C0 |

S6 (epoch monotonicity) is verified at layer 1; the real MLS epoch is not
exposed via test hooks at layer 3.

## How to read fast-check counterexample output

When a property fails, fast-check prints:

```
Error: Property failed after 7 tests
{ seed: -295995254, path: "2:1", endOnFailure: true }
Counterexample: [A.Cg(group),A.In(B),B.Sc(cancelled) /* replayPath="E:B" */]
Shrunk 3 time(s)
Got error: expect(received).toBe(expected)
  Expected: "cancelled"
  Received: "open"
```

Key fields:

- **seed** — the random seed for this run. Use it to reproduce the exact same
  sequence (see next section).
- **path** — the shrink path that led to the minimal counterexample.
- **Counterexample** — the minimal failing action sequence in `Actor.Verb(args)`
  DSL form. Each entry maps 1:1 to a scenario in
  `docs/two-party-permutation-matrix.md`.
- **Shrunk N time(s)** — how many shrink steps fast-check took. A higher number
  means the original failing input was more complex; the counterexample shown is
  already minimal.

The `Actor.Verb(args)` form is produced by each `Command.toString()` method and
is deliberately aligned with the matrix DSL so a counterexample like
`[A.Cg(group),A.In(B),B.Sc(cancelled)]` can be read directly as:
_A creates a group, A invites B, B sets the first task to cancelled_.

## How to reproduce a counterexample

Pass the seed and path as environment variables before re-running the failing
test:

```bash
# Layer 3 (Playwright)
FAST_CHECK_SEED=-295995254 FAST_CHECK_PATH="2:1" \
  npx playwright test e2e/tests/multi-user.property.spec.ts

# Layer 1 or 2 (vitest)
FAST_CHECK_SEED=-295995254 FAST_CHECK_PATH="2:1" \
  npx vitest run src/store/task-reducer.property.test.ts
```

The `seed` env var maps to fast-check's `seed` option; `path` maps to
`path`. Both are read in the test files via:

```ts
seed: parseInt(process.env.FAST_CHECK_SEED ?? "0") || undefined,
path: process.env.FAST_CHECK_PATH ?? undefined,
```

Re-running with the same seed + path replays the identical counterexample,
including all shrink steps up to the minimal case.

**Policy on committing seeds:** Do not commit failing seeds as snapshot tests.
The property itself is the specification; a committed seed is a one-off snapshot
that masks the underlying property and rots as the codebase changes. Once the
underlying bug is fixed, the seed is no longer needed — the property will not
regenerate the failing case.

## Asserted vs. labelled-only properties

**Asserted (S, A, C):** The test body calls `expect(...)` and the CI build fails
if the assertion does not hold. These are invariants the system is contractually
required to satisfy on every reachable action chain.

**Labelled-only (D):** The test body calls `fc.statistics(...)` and prints a
divergence rate to the CI log, but does NOT call `expect`. These are
*known-divergent* behaviours — cases where the system intentionally or
unavoidably produces different results across clients or delivery orderings.

The three D-invariants and why they are labelled-only:

- **D1 — equal-timestamp divergence.** When two clients dispatch updates to the
  same task with the same `updatedAt`, the reducer's `>=` guard accepts
  whichever event arrives last. Different delivery orders yield different final
  states. This is architecturally benign in production (MLS total order prevents
  it), but the harness cannot guarantee total order at layers 1–2. Fixing it
  requires per-field LWW and is a separate epic decision.

- **D2 — publish-failure optimistic divergence.** When `sendApplicationRumor`
  throws (armed via `__notestrTestArmPublishFailure`), the local state retains
  the optimistic change but no peer sees it. This is a known UX gap; fixing it
  requires error recovery UI. Tested at layer 3 only (full stack needed to arm
  the failure hook).

- **D3 — late snapshot overwrites newer events.** The reducer unconditionally
  clears state on `task.snapshot`. An out-of-order snapshot from time T wipes
  individual events from T+10. Whether to fix the reducer or constrain delivery
  is a design decision deferred to a follow-up epic.

Labelled properties print output like:

```
[fc:statistics] snapshot-overwrites-newer: 23.4% (234/1000)
[fc:statistics] equal-timestamp-divergent: 11.8% (118/1000)
```

A sustained increase in these rates across CI runs is a signal that an
unintended change affected the divergent behaviour.
