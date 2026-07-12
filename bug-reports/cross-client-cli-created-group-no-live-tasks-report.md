# Bug Report: Web receives no tasks in a group created by notestr-cli (live kind-445 delivery fails for externally-created groups)

## Status

**REGRESSED 2026-06-28 — canonical report MOVED to the parent repo.** This
cross-client scenario broke again (parent suite `make cross-client-test`: B3.2
fails, B3.1 flaky). Because it is an unlocalised cross-client/integration
failure, the authoritative, comprehensive report now lives in the **parent**
(which owns the web↔cli suite), not in this child repo:

> **`notestr/bug-reports/cross-client-b3-cli-created-group-delivery-regression-report.md`**

The web-side diagnostics below ("Suggested diagnostics") remain useful input for
that triage. Do not maintain a parallel B3 report here — update the parent one.

---

### Prior resolution (2026-05-27) — superseded by the regression above, retained for history

**Resolved 2026-05-27.** B3.2 now passes in the parent suite (`make
cross-client-test`, full run 10/10 green): tasks created in a CLI-created
(MDK-origin) group now reach the web member, in both directions. The fix landed
on the **notestr-cli** side (same-identity convergence / leaf work,
`c50f96b`/`4c17be5`), not in the web consumer — so no notestr-web change was
required. The ranked hypotheses below (live subscription / `#h` mismatch /
epoch) are retained for historical context.

Filed 2026-05-26. Found by the cross-implementation interop suite (see
"How this was found").

## Description

When **notestr-cli** creates an MLS group and invites a **notestr-web** member,
the web joins and **displays the group in the sidebar** — but a task the CLI
subsequently creates in that group **never appears in the web**. The reverse
ownership works fine: in a **web-created** group, tasks created by the CLI show
up in the web (and vice versa) within ~1s. The differentiator is **which
implementation created the group**, not the identities or relays involved.

This is silent data loss from the web member's perspective: they are in the
group, see it, but never see its tasks.

## Expected behavior

A web member of any group — including one created by notestr-cli (MDK) — receives
live task events (kind-445 group messages) created by other members and
materialises them on the board, the same way it does for web-created groups.

## Actual behavior

- The CLI-created group **is visible** in the web sidebar after the invite
  (welcome processed, group surfaced — `__notestrTestGroups()` returns it with a
  `nostrGroupIdHex`).
- A task the CLI then creates in that group **never appears** in the web:
  `window.__notestrTestTasks()` never contains it (60s timeout, both retries).
- Live sync that direction works in the mirror scenario (web-created group), so
  the web's kind-445 ingest pipeline itself is healthy in general.

## Reproduction

Via the parent workspace suite (canonical):

```
make cross-client-test
# → block "B3 CLI-created group":
#     B3.1 CLI creates a group and invites the web; web sees the group   ✓ PASS
#     B3.2 tasks flow both ways in the CLI-created group                 ✗ FAIL
#          (fails at the cli→web hop: webTasks never contains the CLI task)
```

The scenario:

1. notestr-cli/daemon creates group "G3" and invites the web member's npub.
2. Web receives the welcome and shows G3 in the sidebar (B3.1 passes).
3. CLI creates a task in G3.
4. Web, with G3 selected, never lists that task (B3.2 fails, cli→web direction).

## Control (rules out identities/relays/the test rig)

The parent suite's **B1 block uses the same two identities and the same relay
setup**, but with the group **created by the web**. There, tasks created by the
CLI appear in the web, status changes propagate both ways, and concurrent edits
converge — all green. Therefore the failure is **specific to groups created by
notestr-cli (MDK origin)**, not to the relay-URL divergence in the harness
(the CLI daemon dials `ws://127.0.0.1:7777` while the web uses
`ws://localhost:7777` — the same physical relay; B1 proves that divergence does
not break delivery).

## Root cause — hypotheses (ranked, not yet confirmed)

1. **Live subscription not established for externally-created groups.** The web
   may register its live kind-445 subscription (filtered by the group's
   `nostr_group_id` via the `#h` tag) only for groups it creates or via a path
   that an MDK-origin welcome does not trigger. The group renders (welcome
   processed) but no live subscription is wired for it.
2. **`#h` tag / nostr_group_id mismatch.** The CLI tags each kind-445 with the
   group's `nostr_group_id`; the web filters its subscription on the
   `nostr_group_id` it derived from the MDK-created group's extension. If those
   differ, the web's filter never matches the CLI's events. (B3.1 shows the web
   parsed *a* `nostrGroupIdHex`; whether it equals the CLI's published `#h`
   value is unverified.)
3. **MLS epoch / decryption failure (leaf-identity).** The web may receive the
   kind-445 but fail to decrypt it for an MDK-created group (wrong epoch, or the
   web's own leaf is not actually in the group from the CLI's commit) — the
   `epic-mls-leaf-identity-ux` / mls-leaf-debug failure family.

## Suggested diagnostics (web-side, fastest path to isolation)

All available via the in-app test hooks (already used by the e2e suite):

- **Is the CLI's event on the relay, under the web's expected tag?**
  `await window.__notestrTestNetworkRequest(relays, [{ kinds: [445], "#h": [nostrGroupIdHex] }])`
  for the CLI-created group's `nostrGroupIdHex`.
  - Returns the event ⇒ publish + tagging are fine; the bug is web-side consume
    (hypothesis 1 or 3).
  - Returns nothing ⇒ either the CLI tagged a different `nostr_group_id`
    (hypothesis 2 — compare against `notestr-cli which-leaf <prefix>` / the
    CLI's group id in the parent), or it published to a relay the web isn't
    querying.
- **If the event is present, what happens on ingest?**
  `await window.__notestrTestInspectGroupEvent(groupId, eventId)` — inspect
  `firstIngest`/`secondIngest` reasons and `errorMessages` (decryption vs
  filtered-out vs applied), and `__notestrTestGroupEpoch(groupId)` /
  `__notestrTestMlsTrace()` for epoch/MLS state (hypothesis 3).

## Cross-implementation / cross-check via parent

This is a cross-implementation interop defect. Verification **must** go through
the **parent workspace** (the top-level `notestr` repo containing both
`notestr-web` and `notestr-cli`): `make cross-client-test`, block B3. Pure
web↔web e2e tests cannot reproduce it because they never involve an MDK-created
group; the existing multi-user web suites are all web-origin groups (which work).

If the diagnostics point at the **producer** (hypotheses 2: the CLI stamps the
group's `nostr_group_id`/relays or tags kind-445 in a way marmot-ts can't match;
or a leaf-identity gap in the CLI's add-member commit), a **sibling report
should be opened in `notestr-cli`** and reconciled through the parent. Do not
assume the fix is web-side until the diagnostics above localise it.

## Related

- `specs/epic-mls-leaf-identity-ux`, `specs/epic-mls-live-delivery-race`,
  `specs/epic-identity-scoped-group-and-task-visibility`
- The `mls-leaf-debug` diagnostic skill ("group exists on the network, npub
  invited, but never surfaces / syncs in notestr-web") — same failure family,
  here narrowed to the **tasks-don't-sync** variant (the group *does* surface).
- notestr-cli `specs/notestr-cli-leaf-mismatch-feature-request.md`
