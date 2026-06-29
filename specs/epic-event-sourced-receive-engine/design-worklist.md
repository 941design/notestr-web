# Event-Sourced Receive Engine — Remaining Design Worklist

**Status:** product decisions resolved (ADR-002, 2026-06-29); these are the
engineering-internal design artifacts owed before the noted phase gates. None
change product behavior. Implementation has NOT started — every item below is a
*design* deliverable (a doc/contract), not code.

Process one item per loop iteration, top to bottom (ordering respects
dependencies). For each item: produce the artifact, tick the box, commit with a
focused message, then continue. Stop when all boxes are ticked.

---

- [x] **1. Engine↔adapter ingest seam contract** *(gate: before any engine/adapter story; Open Q4 / Constraint 3)*
  - Resolve the ET-1 contradiction: who calls `group.ingest()` and who drives
    `client.network.subscription()`. Decide whether the engine receives raw
    `NostrEvent[]`, an `IngestResult` async iterable, or another typed shape.
  - Deliver: a new typed seam (e.g. `IngestSource`) added to architecture.md
    "Seam Contracts" + the `engine-types.ts` intent, and an updated Boundary
    Rule 9 (engine must not import marmot-ts types). Confirm `marmot-adapter.ts`
    remains the sole marmot-coupled file.

- [x] **2. Formal FSM transition table** *(gate: before Phase 5; Open Q6 / Constraint 4)*
  - Enumerate legal transitions, entry/exit conditions, and guard predicates for
    the nine states. Model `degraded` as an orthogonal `{ state, health }` pair,
    not a flat enum peer.
  - Deliver: `specs/epic-event-sourced-receive-engine/fsm.md`, linked from
    architecture.md. Must cover joining→degraded (Decision 4) and the
    catch-up→live cutover condition.

- [ ] **3. Re-join detection + accepted-log reset sequencing** *(gate: before Phase 2; Decision 3 follow-up)*
  - Specify how the engine distinguishes a re-join (new MLS Welcome) from a plain
    restart, and the exact order in which it clears the per-group accepted-event
    log and `bootstrap-completed` flag relative to replaying the fresh snapshot.
  - Deliver: a subsection in architecture.md (or fsm.md if lifecycle-bound) and,
    if it touches the wire/convergence contract, a check against
    `../protocol/task-protocol.md` first.

- [ ] **4. Joining-gate timeout value + transition wiring** *(gate: before joining-phase story; Decision 4 follow-up)*
  - Pick the timeout duration and define the precise `joining → degraded`
    (and recovery-back) transition, consistent with the FSM table.
  - Deliver: update fsm.md + architecture.md Constraint 2; note the chosen value
    and its rationale.

- [ ] **5. Recovery-sequencing protocol (three-way replay)** *(gate: before Phase 7; Open Q7 / Constraint 5)*
  - Define the replay protocol across raw-log / deferred-store / checkpoint so an
    unreadable event (id in raw-log AND deferred-store, NOT accepted-log, with
    `lastIngestedFactId` set) is neither dropped nor re-ingested.
  - Deliver: a "Recovery Sequencing" subsection in architecture.md with the
    intersection rule stated as an invariant.

- [ ] **6. Rule-10 teardown-order enforcement** *(gate: before joining-phase story; Open Q8 / Constraint Boundary-Rule-10)*
  - Replace the unenforceable "adapter outlasts engine" convention with a
    structural mechanism (single owner that tears down in a fixed order, or an
    explicit lifecycle handshake) so the adapter's `group.off()` can't starve the
    engine mid-teardown.
  - Deliver: update Boundary Rule 10 + Implementation Constraints in
    architecture.md with the enforcement mechanism.

---

When all six are ticked, the epic is ready for story planning
(`/base:story-planner` or `/base:feature`). Update architecture.md's Open
Questions to mark each engineering item RESOLVED as it lands.
