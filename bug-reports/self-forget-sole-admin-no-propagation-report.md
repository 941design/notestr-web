# Bug Report: Self-forget does not propagate to others in the most common notestr scenario (sole-admin two-party group)

**Severity:** HIGH (product behavior) / MEDIUM (technical) — the prior fix
in commit `44a4b9c` documents this as an acknowledged limitation, but the
user-visible promise of "Forget this device" remains unfulfilled in the
most common notestr topology.
**Decision required:** product-level (which option to take). Implementation
is straightforward once the option is chosen.

## Symptom

User A creates a private group, invites user B. A and B chat for a while.
A then decides to leave the group: Settings → Devices → "Forget this
device" → Confirm.

What A expects: A is signed out, and B's view of the group reflects A's
departure (member count drops, A's avatar disappears, etc.).

What actually happens after commit `44a4b9c`:

1. A is signed out (correct).
2. A's kind-445 self-leave proposal is published on the relay (correct
   relative to the amended AC-E2E-9).
3. A's kind-5 deletion of A's KeyPackage events is published (correct).
4. **B continues to see A as a member, indefinitely.** B's member count
   stays at 2. A's leaf remains in B's local MLS state. There is no
   visible signal to B that A has left.

The acceptance criterion (AC-E2E-9, as amended in commit `44a4b9c`)
passes because it now asserts "proposal published," not "B sees A gone."
The amended AC explicitly notes that B's local state only updates after
"another admin commits the proposal" — but in this 2-party topology
**there is no other admin** (per `docs/two-party-permutation-matrix.md:33,39`,
invitees are non-admin by default). The proposal sits on the relay
forever.

## Reproduction

The currently-passing test `e2e/tests/forget-device-self.spec.ts:115`
covers exactly this topology and now passes — but only because the
assertion was relaxed. To reproduce the user-visible failure:

1. Sign in A. Create group G. Invite B.
2. Sign in B. Verify B sees G with member count 2.
3. A: Settings → Devices → "Forget this device" → Confirm.
4. Wait 60 s, 5 min, 1 hour, 1 day.
5. Observe B: member count is still 2. A is still listed.

## Background — why the previous fix didn't address this

When commit `44a4b9c` was being developed, the implementer surfaced a
hard MLS protocol constraint: RFC 9420 §12.4 forbids a member from
committing a Remove proposal targeting their own leaf. The MLS-correct
primitive is `group.leave()`, which publishes a Remove **proposal** and
requires another admin to commit it.

In a two-party group with a sole admin (A), no other admin exists. The
proposal cannot be committed. The product owner was presented with four
options:

1. Publish self-leave proposal; amend AC-E2E-9. (Chosen — honest about
   the limitation, no behavior fix.)
2. Auto-promote a co-member to admin before leaving.
3. Sole-admin leave dissolves the group.
4. Defer the bug; keep the fix that landed so far.

Option 1 was chosen. This bug report formally tracks the unresolved
user-visible behavior gap.

## Expected post-condition

Depends on resolution path. The product team must choose one:

### Option 2 — Auto-promote a co-member, then leave

When A self-forgets and is the sole admin, the forget flow:
1. Selects a co-member (B in 2-party; the first co-member by some
   deterministic rule in N-party).
2. Builds a single MLS commit promoting that co-member to admin.
3. Publishes the commit.
4. Publishes the self-leave Remove proposal.
5. New admin (B) commits it on receipt.

Trade-off: silently changes another user's role without their consent.
Probably needs a UX gate ("This will make B an admin so they can finish
removing you. Continue?").

### Option 3 — Sole-admin leave dissolves the group

When A self-forgets and is the sole admin, the group is tombstoned:
1. A publishes a kind-5 deletion (or new kind) tombstoning the group
   identifier.
2. B's UI shows "this group has been dissolved" and removes it from the
   group list.

Trade-off: stronger semantic, larger blast radius. Asymmetric with
non-sole-admin scenarios. Probably needs a UX confirm ("You're the only
admin. Forgetting this device will dissolve the group for everyone.
Continue?").

### Option 4 — Block + warn (no protocol change)

When A self-forgets on a sole-admin group, show a confirm dialog:

> You are the only admin of "G". If you forget this device, your
> proposal to leave will be published, but other members will continue to
> see you in the group until another admin is added. Continue anyway?
> [Cancel] [Forget anyway]

Trade-off: honest, no protocol change, no upstream marmot-ts work, but
A is left without a real path to leave. May be acceptable as a stopgap
while option 2 or 3 is designed.

### Option 5 — Promote a co-admin elsewhere in the app (UX-first)

Introduce a UI for admin promotion before forget is invoked. User flow:
1. A wants to leave G. A promotes B to admin via a dedicated
   "Group settings → Add admin" affordance.
2. After B accepts admin role (separate commit), A invokes forget.
3. Now option-1 plumbing works — B can commit A's leave proposal.

Trade-off: requires building admin-promotion UI as a separate feature.
Highest user friction but most explicit / honest.

## Suspected root cause

Architectural, not a code defect:

- notestr group invitations default to "non-admin invitee" per
  `docs/two-party-permutation-matrix.md:33,39`. This is by design (MLS
  admin role carries elevated capabilities).
- MLS protocol (RFC 9420 §12.4) forbids self-commit of Remove. The
  member who is leaving cannot ratify their own leave.
- In any group where the leaving member is the sole admin, the
  combination of these two constraints means the leave proposal is
  unactionable.

The previous fix (commit `44a4b9c`) is correct relative to the amended
AC-E2E-9. It does not "solve" the protocol-level deadlock — it
**documents** it. This bug is a request to resolve the deadlock at the
product level.

## Impact

- The single most common notestr topology (2-party private chat between
  A and B) cannot fulfill the "Forget this device" promise. Users who
  tap forget will see themselves signed out and may believe other
  members no longer see them — but they do.
- User trust: a forget action that doesn't actually remove the user from
  others' views is a subtle privacy/decommissioning failure. Particularly
  bad for falling-out scenarios (A wants to leave a chat with B; B keeps
  seeing A in the member list and could continue sending messages).
- Discoverability: the limitation is documented in
  `specs/epic-forget-this-device/acceptance-criteria.md` (the amended
  AC-E2E-9 with RFC 9420 §12.4 rationale), but ordinary users never see
  the spec.
- This is the original user complaint that triggered the previous bug
  workflow. Option 1 documented the limitation; it did not fix the
  complaint.

## Non-goals

- Do not modify marmot-ts core. RFC 9420 §12.4 enforcement is correct
  and must not be relaxed.
- Do not undo the `group.leave()` switch from commit `44a4b9c`. That
  primitive is correct (subject to the multi-device regression tracked
  in `self-forget-evicts-sibling-leaves-report.md`, which is a separate
  bug).
- Do not change the AC-E2E-9 amendment again unless the chosen option
  makes the original assertion ("B sees A gone within 60 s") truly
  achievable. Options 2 and 3 do; options 4 and 5 do not.

## Decision required before implementation

This bug cannot proceed to a /base:bug fix until the product owner picks
one of the options above (or a fifth one not yet enumerated). The
implementation cost varies materially:

- Option 4 (warn + continue): smallest. Pure UI work — a confirm dialog
  with a sole-admin detection check.
- Option 2 (auto-promote): medium. Build an MLS commit promoting a
  co-member to admin; sequence it before the self-leave; coordinate UX
  consent.
- Option 3 (dissolve): medium-large. New event semantic for "group
  dissolved"; consumers (B's UI) must handle it; persistence implications.
- Option 5 (admin-promotion UI first): largest. Net new feature surface
  for admin management.

Recommend surfacing this decision before dispatching to /base:bug.

## Context

This report formalizes the deferred concern raised when commit `44a4b9c`
landed. The external code-review pass identified the gap explicitly:
"the original 'other member sees A removed' failure is still present;
the test now masks it instead of catching it." That framing is technically
accurate — the option-1 fix retreated the assertion, not the behavior.
This bug exists to track the behavioral resolution.

## Product decision (2026-07-12)

The product owner reviewed the four options and ruled: **sole-admin leave is
an edge case with relatively low priority.** No fix option was selected yet;
the decision among options 2/3/4/5 remains open and is made at dispatch time.

Tracking moved to `BACKLOG.json` finding
`sole-admin-self-forget-leaves-remaining` (created 2026-07-12). This report
stays as the evidence document; do not dispatch from this file.
