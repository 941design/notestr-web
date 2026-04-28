# Two-party permutation matrix

This document enumerates the user-action permutations exercised by the two-party
e2e tests in `e2e/tests/`, using a compact DSL so the permutation table fits in
a reasonable column width.

"Two parties" means either two distinct npubs (User A vs User B) or the same
npub running in two browser contexts (multi-device). Single-user specs that
only use a relay observer (e.g. `task-publish-contract.spec.ts` via
`ndk-subscriber`) are out of scope.

## Protocol model & constraints

A handful of MLS / marmot-ts / app-level facts shape which scenarios are
testable today and explain every `fixme` / `n/a-by-design` row in the
matrix below.

- **One MLS leaf per device, ≥ 1 leaf per member.** A Nostr identity
  (pubkey) can have several leaves in the same group. `getGroupMembers`
  returns the set of pubkeys with ≥ 1 leaf; `getPubkeyLeafNodes` returns
  the leaf set for a pubkey. *Member departure is the emergent
  consequence of removing the last leaf.*
- **Two distinct removal primitives in marmot-ts:**
  `removeLeafByIndex` (per-leaf — used by `DeviceList`) and
  `proposeRemoveUser(pubkey)` (all leaves at once — *not currently
  used* by notestr-web). "Forget device" ≠ "leave group" ≠ "remove
  member"; no local-storage soft-forget is needed.
- **`DeviceList` renders only the local identity's leaves.**
  `GroupManager.tsx` instantiates it with `pubkey={selfPubkey}`. There is
  no UI surface to enumerate or rename another identity's devices, and
  device names are stored in a per-context IndexedDB (`deviceNamesStore`)
  with no MLS broadcast — i.e. names are local-context-only.
- **MIP-03 admin-only commits.** `MarmotGroup#commit` enforces
  `groupData.adminPubkeys.includes(senderPubkey)`. Non-admin members can
  *propose* (Add, Remove, Update) but cannot commit. notestr-web does
  not currently promote invitees to admin, so any flow that requires a
  non-admin to invite or remove (e.g. chain invites — `B.In(C)`) fails
  at the commit step.
- **`leave()` is a self-remove proposal, not a commit.** RFC 9420 §12.4
  forbids a member from committing a Remove of their own leaf, so
  `client.groups.leave()` publishes a remove proposal per leaf and
  destroys local state. Until an admin commits the proposal, the
  ex-member's pubkey remains in the admin's `getGroupMembers(state)`
  view. There is no auto-commit on the admin side today.
- **Task-event merge is LWW on `updatedAt` with no tiebreaker.**
  `task-reducer.applyEvent` admits an event iff
  `event.updatedAt >= existing.updatedAt`; on a tie, the
  later-applied event wins, which can differ across pages. Tests pin
  the deterministic case (`updatedAt` separated by ≥ 1 s); the tie case
  is `fixme` until the product makes a call (CRDT, lex tiebreaker on
  pubkey, per-field LWW, …).

## DSL

### Actors

| Token   | Meaning                                                      |
| ------- | ------------------------------------------------------------ |
| `A`     | User A — distinct npub                                       |
| `B`     | User B — distinct npub                                       |
| `C`     | User C — distinct npub (third party, only in chain tests)    |
| `A1`,`A2` | Two browser contexts both signed in as User A's npub       |
| `B1`,`B2` | Two browser contexts both signed in as User B's npub       |
| `*`     | Any actor (used in the matrix to mean "actor irrelevant")    |

When a leaf needs to be referenced, e.g. as the target of a forget or rename,
the same actor token names the leaf: `Fd(B1)` = "forget B's leaf 1".

### Verbs

Two-letter PascalCase, args in parentheses.

| Code        | Verb                                | Args                              |
| ----------- | ----------------------------------- | --------------------------------- |
| `Au`        | authenticate (sign in)              | —                                 |
| `Dc`        | disconnect (sign out)               | —                                 |
| `Rl`        | reload page                         | —                                 |
| `Sw(X)`     | identity-switch within same context | new identity actor                |
| `Cg(g)`     | create group                        | group name token                  |
| `In(X)`     | invite member                       | invitee actor                     |
| `Lg(g)`     | leave group                         | group token                       |
| `Fd(d)`     | forget device leaf                  | leaf actor (e.g. `B1`)            |
| `Rd(d,n)`   | rename device                       | leaf, new-name string             |
| `Ct(t,T?)`  | create task                         | task token, optional title        |
| `Ut(t,Δ)`   | update task fields                  | task, change spec (e.g. title=…)  |
| `Sc(t,s)`   | status change                       | task, status `o|p|d|c`            |
| `As(t,X)`   | assign task                         | task, assignee actor              |
| `Un(t)`     | unassign task                       | task                              |
| `Dt(t)`     | delete task                         | task                              |

Task status codes: `o`=open, `p`=in_progress, `d`=done, `c`=cancelled.

### Operators

| Symbol | Meaning                                                            |
| ------ | ------------------------------------------------------------------ |
| `→`    | sequence: next action                                              |
| `⇒`    | causes observation: RHS is an assertion, not a user action         |
| `⟂`    | observes: `B⟂t1` = "B sees t1"; `B⟂t1.p` = "B sees t1 in_progress" |
| `⊥`    | does NOT observe: `B⊥t1` = "B does not see t1"                     |
| `;`    | concurrent: both sides happen in overlapping windows               |
| `;;`   | comment to end of line                                             |
| `{…}`  | set literal: `members={A,B}`                                       |

### Action notation

Each step is `Actor.Verb(args)`. Example sequence:

```
A.Cg(g1) → A.In(B) ⇒ B⟂g1 → A.Ct(t1) ⇒ B⟂t1 → B.Sc(t1,p) ⇒ A⟂t1.p
```

Reads: "A creates group g1, invites B; B sees g1; A creates task t1; B sees t1;
B moves t1 to in_progress; A sees t1 in_progress."

Identity-switch sequences (single browser context, sequential parties) use
`Sw`:

```
A.Au → A.Cg(g1) → A.Dc → Sw(B) → B.Au ⇒ B⟂g1.detached
```

## Scenario catalogue

Each scenario has a stable ID. The "Spec" column is the spec file (or `—` if
not yet covered). `multi-user` ≡ `e2e/tests/multi-user.spec.ts`, etc.

### Setup-and-invite (group lifecycle, cross-npub)

| ID    | Scenario (DSL)                                            | Spec        |
| ----- | --------------------------------------------------------- | ----------- |
| TP-01 | `A.Au → A.Cg(g1) → A.In(B) ⇒ B⟂g1`                        | multi-user, task-sync, identity-visibility (test 3) |
| TP-02 | `A.Cg(g1) → A.In(B) ⇒ B⟂g1.attached` (full interactivity) | identity-visibility (test 3) |
| TP-03 | `A.Cg(g1) → Sw(B) ⇒ B⟂g1.detached`                        | identity-visibility (tests 1, 2) |
| TP-04 | `A.Cg(g1) → Sw(B) → B.Lg(g1) ⇒ B⊥g1`                      | identity-visibility (test 2) |

### Task propagation (cross-npub, A→B)

| ID    | Scenario (DSL)                                            | Spec        |
| ----- | --------------------------------------------------------- | ----------- |
| TP-10 | `A.Ct(t1) ⇒ B⟂t1` (live MLS)                              | multi-user  |
| TP-11 | `A.Ct(t1) → B.Rl ⇒ B⟂t1` (recovery)                       | multi-user  |
| TP-12 | `A.Ct(t1) → A.In(B) ⇒ B⟂t1` (NIP-44 snapshot)             | task-sync   |
| TP-13 | `A.Ut(t1,title=…) ⇒ B⟂t1.title=…`                         | cross-author-tasks |
| TP-14 | `A.Sc(t1,p) ⇒ B⟂t1.p`                                     | cross-author-tasks |
| TP-15 | `A.As(t1,B) ⇒ B⟂t1.assignee=B`                            | cross-author-tasks |
| TP-16 | `A.Un(t1) ⇒ B⟂t1.assignee=⊘`                              | cross-author-tasks |
| TP-17 | `A.Dt(t1) ⇒ B⊥t1`                                         | cross-author-tasks |

### Cross-author task mutations (B mutates A's task)

| ID    | Scenario (DSL)                                            | Spec        |
| ----- | --------------------------------------------------------- | ----------- |
| TP-20 | `A.Ct(t1) → B.Sc(t1,p) ⇒ A⟂t1.p`                          | multi-user  |
| TP-21 | `A.Ct(t1) → B.Ut(t1,title=…) ⇒ A⟂t1.title=…`              | cross-author-tasks |
| TP-22 | `A.Ct(t1) → B.As(t1,A) ⇒ A⟂t1.assignee=A`                 | cross-author-tasks |
| TP-23 | `A.Ct(t1) → B.As(t1,A) → B.Un(t1) ⇒ A⟂t1.assignee=⊘`      | cross-author-tasks |
| TP-24 | `A.Ct(t1) → B.Dt(t1) ⇒ A⊥t1`                              | cross-author-tasks |

### Snapshot of pre-existing state delivered on join

| ID    | Scenario (DSL)                                            | Spec        |
| ----- | --------------------------------------------------------- | ----------- |
| TP-30 | `A.Ct(t1) → A.In(B) ⇒ B⟂t1`                               | task-sync   |
| TP-31 | `A.Ct(t1) → A.Sc(t1,p) → A.As(t1,A) → A.In(B) ⇒ B⟂t1.p,assignee=A` | snapshot-history |
| TP-32 | `A.Ct(t1) → A.Dt(t1) → A.In(B) ⇒ B⊥t1`                    | snapshot-history |

### Member lifecycle (leave, re-invite)

| ID    | Scenario (DSL)                                                          | Spec         |
| ----- | ----------------------------------------------------------------------- | ------------ |
| TP-40 | `A.Cg(g1) → A.In(B) ⇒ B⟂g1 → B.Lg(g1) ⇒ B⊥g1 ∧ A⟂g1`                    | active-leave |
| TP-40b | `…TP-40 ⇒ A⟂members={A}` (member-count shrink — fixme: requires admin commit) | active-leave (fixme) |
| TP-41 | `…TP-40 → A.In(B) ⇒ B⟂g1` (re-invite after leave)                       | active-leave |

### Forget-device semantics (per-leaf removal)

The matrix here matters because the protocol distinguishes forgetting one of
many leaves from removing the last leaf. The MLS primitive is per-leaf
(`removeLeafByIndex`); member-departure is the *emergent* consequence of
removing the last leaf.

| ID    | Scenario (DSL)                                                            | Spec            |
| ----- | ------------------------------------------------------------------------- | --------------- |
| TP-50 | `A.Cg → A.In(B1) → A.In(B2) → A.Fd(B1) ⇒ A⟂members={A,B} ⇒ A⟂devices(B)=1` | forget-device   |
| TP-51 | `A.Cg → A.In(B) → A.Fd(B1) ⇒ A⟂members={A}` (last leaf gone)              | forget-device   |
| TP-52 | `A1.Cg → A1.Fd(A2) ⇒ A1⟂members={A} ⇒ A1⟂devices(A)=1`                    | multi-device-sync (fixme) |
| TP-53 | `A.Cg → A.In(B1) → A.In(B2) → A.Fd(B1) → A.Ct(t1) ⇒ B2⟂t1`                | forget-device   |

### Rename device

`TP-61` and `TP-62` reduce to **n/a-by-design**: `DeviceList` only renders
the local identity's own leaves, and `setDeviceName` writes to a per-context
IndexedDB store (`deviceNamesStore`). There is no cross-identity surface to
rename through and no broadcast channel. The `rename-device` spec contains
a single-context smoke confirming this reduction.

| ID    | Scenario (DSL)                                                          | Spec          |
| ----- | ----------------------------------------------------------------------- | ------------- |
| TP-60 | `A1.Cg → A1.Rd(A2,"Laptop") → A1.Rl ⇒ A1⟂device(A2).name="Laptop"`      | rename-device |
| TP-61 | `A.Rd(B1,…)` — UI affordance does not exist                             | rename-device (n/a-by-design) |
| TP-62 | `B⊥device.rename` — no cross-identity surface, holds trivially          | rename-device (n/a-by-design) |

### Three-party invite chain

| ID     | Scenario (DSL)                                                                      | Spec        |
| ------ | ----------------------------------------------------------------------------------- | ----------- |
| TP-70  | `A.Cg(g1) → A.In(B) → A.In(C) ⇒ B⟂g1 ∧ C⟂g1` (admin issues both invites)            | three-party |
| TP-70c | `A.Cg(g1) → A.In(B) → B.In(C) ⇒ C⟂g1` (chain — blocked by MIP-03 admin-only-commits) | three-party (fixme) |
| TP-71  | `…TP-70 → A.Ct(t1) ⇒ B⟂t1 ∧ C⟂t1`                                                   | three-party |
| TP-72  | `…TP-70 → C.Ct(t1) ⇒ A⟂t1 ∧ B⟂t1`                                                   | three-party |

### Multi-device, distinct-npub mix

| ID    | Scenario (DSL)                                            | Spec        |
| ----- | --------------------------------------------------------- | ----------- |
| TP-80 | `A1.Cg(g1) → A1.In(B) ⇒ A2⟂g1 ⇒ B⟂g1`                     | multi-device-cross-npub |
| TP-81 | `…TP-80 → A1.Ct(t1) ⇒ A2⟂t1 ⇒ B⟂t1`                       | multi-device-cross-npub |
| TP-82 | `…TP-80 → B.Sc(t1,p) ⇒ A1⟂t1.p ⇒ A2⟂t1.p`                 | multi-device-cross-npub |

### Concurrent edits (race semantics)

| ID    | Scenario (DSL)                                            | Spec        |
| ----- | --------------------------------------------------------- | ----------- |
| TP-90 | `A.Ct(t1) → ( A.Ut(t1,title=X) ; B.Ut(t1,title=Y) ) ⇒ both converge to LWW(updatedAt)` | concurrent-edits |
| TP-91 | `A.Ct(t1) → ( A.Sc(t1,p) ; B.Sc(t1,d) ) ⇒ both converge`  | concurrent-edits |

## Action × actor coverage matrix

Legend: `mu`=multi-user, `ts`=task-sync, `iv`=identity-visibility, `md`=multi-device-sync (fixme), `ca`=cross-author-tasks, `al`=active-leave, `fd`=forget-device, `rd`=rename-device, `tp`=three-party, `mx`=multi-device-cross-npub, `ce`=concurrent-edits, `sh`=snapshot-history. `—` = uncovered. `n/a` = combination doesn't apply.

### Cross-npub (A vs B as distinct identities)

| Action     | A acts → B observes      | B acts → A observes      | Same task, both edit |
| ---------- | ------------------------ | ------------------------ | -------------------- |
| `Au`       | mu, ts, iv (precondition)| mu, ts, iv (precondition)| n/a                  |
| `Dc`       | iv (precondition)        | —                        | n/a                  |
| `Rl`       | mu, ts (recovery)        | mu (recovery)            | n/a                  |
| `Sw(X)`    | iv (sequential identity replacement) | n/a                | n/a                  |
| `Cg(g)`    | n/a                      | n/a                      | n/a                  |
| `In(X)`    | mu, ts, iv               | tp (B invites C)         | n/a                  |
| `Lg(g)`    | al                       | al, iv (detached only)   | n/a                  |
| `Fd(d)`    | fd                       | —                        | n/a                  |
| `Rd(d,n)`  | rd (local-only)          | —                        | n/a                  |
| `Ct(t)`    | mu (live + reload), ts (snapshot) | —               | —                    |
| `Ut(t,Δ)`  | ca                       | ca                       | ce (fixme)           |
| `Sc(t,s)`  | ca                       | mu, ca                   | ce (fixme)           |
| `As(t,X)`  | ca                       | ca                       | —                    |
| `Un(t)`    | ca                       | ca                       | —                    |
| `Dt(t)`    | ca                       | ca                       | —                    |

### Same-npub multi-device (A1 vs A2)

| Action     | A1 acts → A2 observes    |
| ---------- | ------------------------ |
| `Au`       | md (auto-sync 2 devices) — fixme |
| `Cg(g)`    | md — fixme               |
| `Rd(d,n)`  | md — fixme               |
| `Fd(A2)`   | md (last-leaf semantics) — fixme |
| `Ct(t)`    | md — fixme               |
| `Rl` invariant (no kind-445 inflation on plain reload) | md — fixme |

### Mixed (A1+A2 same-npub, B distinct)

| Action            | All-observers |
| ----------------- | ------------- |
| `A1.In(B)`        | mx            |
| `A1.Ct(t)`        | mx            |
| `B.Sc(t,p)`       | mx            |

### Three-party chain (A,B,C distinct)

| Action            | Observers |
| ----------------- | --------- |
| `A.In(B)→B.In(C)` | tp        |
| `A.Ct(t)`         | tp (B and C both observe) |
| `C.Ct(t)`         | tp (A and B both observe) |

## Coverage summary

- **Pre-this-change**: ~15 of the scenarios had spec coverage (TP-01, -03,
  -04, -10, -11, -12, -20 and a handful of single-context ones).
- **Post-this-change** (`cross-author-tasks`, `active-leave`,
  `forget-device`, `three-party`, `snapshot-history`, `concurrent-edits`,
  `multi-device-cross-npub`, `rename-device`):
  - **active**: TP-13–TP-24 (cross-author task mutations),
    TP-31/-32 (snapshot history), TP-40/TP-41 (leave + re-invite),
    TP-50/-51/-53 (forget-device semantics), TP-60 (rename round-trip),
    TP-70/-71/-72 (three-party admin-issued chain),
    TP-80/-81/-82 (multi-device + distinct npub),
    TP-90/-91 (concurrent edits with deterministic LWW).
  - **fixme** (waiting on product/protocol decisions):
    - TP-40b: requires auto-commit of pending leave proposals on the admin's side.
    - TP-52: multi-device-sync test redesign (test-pollution sensitivity, not protocol).
    - TP-70c: three-party chain — requires admin promotion or auto-commit of Add proposals.
    - TP-90/-91 tie-breaker: requires a deterministic tie-resolution policy (CRDT, lex tiebreaker, or per-field LWW).
  - **n/a-by-design**: TP-61, TP-62 — DeviceList scope is local-only.

## Updating this document

When adding a new two-party test, add the scenario under the appropriate
section with a TP-XX id, fill in the Spec column with the file slug, and add
the file slug to the legend. When extending an existing scenario family,
choose the next id within that family's hundred-block (`TP-2x` for
cross-author mutation, `TP-5x` for forget-device, etc.).
