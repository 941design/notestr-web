# Same-actor task edits within one second are silently dropped (CRDT LWW gate too strict for coarse timestamps)

## Description

A user's second mutation of the same task is silently lost when both mutations
land in the **same wall-clock second** and originate from the **same actor**
(same pubkey, same device). The lost edit never appears — not on the author's
own screen, and not on any other member's.

This is real, user-facing data loss, not merely a test artifact. The e2e suite
`e2e/tests/cross-author-tasks.spec.ts` is where it currently surfaces, but the
root cause is in production code paths exercised by the normal UI.

## Expected behavior

If a user assigns a task and immediately unassigns it (two clicks within a
second), the task ends up **unassigned**. If a user drags a card from "open"
through "in_progress" to "done" within a second, it ends up in **done**. The
last action a single actor takes always wins over their own earlier action.

## Actual behavior

The second action is rejected by the task reducer's Last-Write-Wins gate and
silently discarded. The task stays in the state set by the first action. The
author sees their own second click do nothing (optimistic apply also rejects
it), and the event is never published, so peers never see it either.

## Root cause

Commit `a0d19e3` ("feat(task-crdt): remove task.snapshot, add FWW + deterministic
LWW") changed the reducer gate in `src/store/task-reducer.ts` for all four
mutation event types (`task.updated`, `task.status_changed`, `task.assigned`,
`task.deleted`) from `event.updatedAt >= existing.updatedAt` to strict:

```
event wins iff:
  event.updatedAt > existing.updatedAt
  || (event.updatedAt === existing.updatedAt && event.updatedBy < (existing.updatedBy ?? ""))
```

The tie-break only resolves edits by **different** authors (lexicographically
lower pubkey wins). When the **same** actor edits the **same** task twice within
one second:
- `event.updatedAt === existing.updatedAt` (both `Math.floor(Date.now()/1000)`, same second)
- `event.updatedBy === existing.updatedBy` (same pubkey)
- → `updatedBy < updatedBy` is **false** → the second event is **rejected**.

Producers all use **one-second resolution**:
`src/components/Board.tsx:99,116,127` (status/assign/update handlers) and
`src/store/task-events.ts:63` (`createTask`). The reducer's convergence design
(documented in `docs/task-protocol.md` "## Task reducer semantics", ~line 446)
is correct **given** that distinct edits get distinct `updatedAt` — but
one-second producers violate that assumption.

The drop happens on both the sender's optimistic apply (`src/store/task-store.tsx:248`)
and every receiver (`src/store/task-store.tsx:207-219`).

## Reproduction

Deterministic, unit-level (no e2e/relay needed):

```
existing task: { updatedAt: T, updatedBy: P, assignee: P }
apply task.assigned { taskId, assignee: null, updatedAt: T, updatedBy: P }
→ EXPECTED: assignee === null
→ ACTUAL:   assignee === P   (event rejected by the gate)
```

End-to-end, this surfaces intermittently in `cross-author-tasks.spec.ts`:
whichever consecutive same-actor pair happens to fall inside one wall-clock
second times out at 30s (TP-15/16 assign in the latest run; TP-22/23 unassign in
an earlier triage). A single 30s timeout then unmounts `TaskStoreProvider`,
deleting `window.__notestrTestDispatchTaskEvent`, so every following test in the
file throws "is not installed" in ~5ms — turning one real failure into eight reds.

## Impact

- **Severity:** data loss on rapid same-actor edits — a routine interaction.
- **Surface:** every task mutation type (update, status, assign, delete).
- **Scope:** production UI + the cross-author e2e suite.

## Fix constraints

1. **Do NOT weaken the reducer back to `>=`.** That reintroduces inter-author
   divergence under out-of-order delivery, which is exactly why `a0d19e3`
   tightened it. Convergence (commutativity / idempotence) must be preserved —
   the property tests in `src/store/task-reducer.property.test.ts` and
   `src/store/multi-client.property.test.ts` must still pass.

2. **Must compose with a third, device-level tie-break that is coming.** A prior
   run (learning `lww-tie-break-pubkey-alone-fails`, run
   `bug-sibling-lww-tiebreak-divergence-2026-05-24-0833`) prescribed adding a
   third tie-break level `updatedByDevice` (MLS clientId) for the *sibling-device*
   case (two devices, same pubkey, **concurrent**). That fix was recorded as a
   learning but its code was **never landed on master** (branch
   `fix/sibling-concurrent-edit-divergence` points at master with no commits;
   its worktree is pruned). This bug is a **different** root cause —
   *same* device, *sequential* edits — which the clientId tie-break cannot fix
   (one device's two edits share the same clientId). Whatever fix lands here must
   not collide with, and ideally compose cleanly with, that eventual third level.

3. Two candidate approaches (analysis to choose — favor minimal blast radius and
   determinism):
   - **(A) Millisecond timestamps:** producers emit `Date.now()` instead of
     `Math.floor(Date.now()/1000)`. Reducer unchanged. Task `createdAt`/`updatedAt`
     are internal CRDT ordering keys only — confirmed never rendered as dates, so
     display-safe. Requires touching `Board.tsx` ×3, `task-events.ts:createTask`,
     AND the e2e specs that hand-build events with `Math.floor(Date.now()/1000)`
     (they bypass `Board.tsx`, so must change too or they keep colliding), plus
     `docs/task-protocol.md`. Probabilistic (relies on an `await` existing between
     any two same-actor dispatches).
   - **(B) Sender-side monotonic clock:** in `dispatch()` (`task-store.tsx`), set
     `event.updatedAt = max(event.updatedAt, (existing?.updatedAt ?? 0) + 1)` for
     the four mutation types before optimistic apply + publish. One chokepoint
     fixes both the real UI and the e2e specs without editing every producer/spec.
     Deterministic per-actor monotonicity. Keeps the seconds wire format;
     `updatedAt` may drift a few seconds ahead of wall-clock under rapid bursts
     (harmless — not displayed).

4. Add a deterministic reducer/store unit test that locks the behavior: same
   actor, two sequential edits with equal (or non-increasing) timestamps → the
   **last** edit wins; while the existing inter-author tie-break commutativity is
   preserved.

5. Update `docs/task-protocol.md` to match (per CLAUDE.md, task-datamodel/protocol
   changes require a protocol-doc update). The `Task` interface comments currently
   say "unix seconds"/"unix timestamp".

## Verification environment notes

- `node_modules` is platform-correct for this Linux aarch64 host (swc-linux-arm64
  + rolldown binding-linux-arm64 present; marmot-ts `dist` intact). Run all
  build/test via `make` (the platform stamp guard).
- **Prefer the deterministic reducer/store unit test as the primary regression
  guard** (`make test`). The multi-context e2e is independently flaky (project
  memory: intermittent `about:blank` page-blanking in cross-author/multi-party
  specs), so a green e2e is not the sole proof and a red multi-context run is not
  necessarily this bug.
- The ephemeral e2e relay is already up (docker `notestr-web-relay-1`, port 7777).
  Tests must remain relay-state-independent — never wipe/start/stop/assert relay
  state.
- Do NOT kill processes discovered on ports; the harness fails loud on a busy port.

Source: bug surfaced from reported e2e failures in `cross-author-tasks.spec.ts`, 2026-05-24.
