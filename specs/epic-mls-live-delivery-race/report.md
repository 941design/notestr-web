# MLS Live-Delivery Race — Empirical F-Class Report (S4)

**Status:** Inconclusive — the failing cluster did not fail on the dev host. F-class verdicts could not be produced.

**Date of run:** 2026-05-18
**Operator:** Lead agent (autonomous) during `/base:feature` RESUME of `epic-mls-live-delivery-race`
**Code under test:** Working-tree HEAD `7b31ba163bf86961accb57d2f8949a12ebbef660` plus uncommitted S1/S2/S3 work (mls-trace.ts, mls-trace-classify.ts, hooks across device-sync.ts/network.ts/task-store.tsx/client.tsx)
**Host:** Linux dev host (mrother.linux), Docker-hosted ephemeral strfry relay on `ws://localhost:7777`
**Browser:** Playwright bundled `chromium-headless-shell-1208` (after a fresh install — see "Pre-run friction" below)

## Run summary

One harness invocation: `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers NEXT_PUBLIC_E2E_TRACE_MLS=1 DIAG=1 npx playwright test e2e/tests/multi-user-diag.spec.ts --project=chromium`.

```
Running 2 tests using 1 worker

[chromium] › multi-user-diag.spec.ts:125 › run triangulation
  [diag-epoch] A after createGroup: count=1, epoch=0
  [diag-epoch] A after invite B: count=1, epoch=1
  [diag-epoch] A after 2s settle: count=1, epoch=1
  [diag-epoch] B after select group: count=1, epoch=1
  [diag-epoch] A at B-ready: count=1, epoch=1
  [diag-epoch] A after dispatch task: count=1, epoch=1
  [diag-epoch] B after 3s settle: count=1, epoch=1
  [diag] B authoritative signals: history=0 persisted=1 in-memory=1

[chromium] › multi-user-diag.spec.ts:235 › trace-capture harness (multi-user live-delivery)
  [diag-harness] run 1 of 3: harness-run-1-1779109952772
  [diag-harness] run 1: assertion PASSED — no trace dump needed.

2 passed (46.0s)
```

Wall-clock: 46 seconds total. Well under AC-DIAG-6's 12-minute budget.

## Trace artifacts produced

**None.** No `e2e/.triage/mls-trace-{A,B}-{run}.json`, no `expected-task-{run}.json`, no `mls-trace-classify.log`.

This is by design: the harness only dumps traces on failure (AC-DIAG-2: "writes per-page traces ... on every failure"). Since the assertion passed on run 1, the loop exited early (MAX_RUNS bound is the upper cap, not a fixed iteration count) and no failure was observed.

## Verdict per AC-REPORT-2

**Cannot determine F-class dominance from this run.** The diagnostic gate is intended to classify *failures*; with zero failures, there is no data to classify.

This is **not** the F3-termination case (AC-REPORT-2a), because that clause is conditioned on "F3 dominates ≥50% of failing-cluster failures across three runs" and we have zero failures to dominate among. The terminate-after-S4 path does not apply.

## Why the test did not reproduce the race

The spec's problem section describes the cluster as failing **intermittently** under CI load and on contended hosts (see `spec.md:5–9`). On a quiet dev host with a freshly-spawned ephemeral relay and no concurrent test load, the F1/F2 timing window is much narrower:

- **F1 (fetch-then-subscribe gap)** requires a relay-side delivery to arrive in the window between User A's publish and User B's subscription opening. On a localhost relay with sub-millisecond round-trips, that window is effectively closed.
- **F2 (welcome-epoch lag with no draining commit)** requires a kind-445 application message to ride a commit that hasn't yet decrypted on B. The harness does not arm an auto-invite — there is no sibling-KP injection during the dispatch — so the only commits in play are A's initial group-creation and the invite of B itself, which decrypt deterministically before the assertion fires.

In other words: this scenario, on this host, runs in the happy path. The race needs a deterministic trigger to surface reliably; AC-REG-2 / `__notestrTestArmAutoInvite` (planned in S7) is exactly that trigger but it doesn't ship until S6+S7. Chicken-and-egg.

## Implications for the S5/S6 fork

**The S5-vs-S6 decision cannot be made from empirical evidence.** Three possible resolutions, none of which the harness can adjudicate without further work:

1. **Ship both S5 and S6 unconditionally.** Treats F1 and F2 as plausible-by-design rather than empirically-confirmed. Doubles implementation cost but is the only path that addresses both modes without the diagnostic gate.
2. **Run the harness under load to attempt to reproduce.** Multiple parallel test processes, network throttling (`tc qdisc add dev lo root netem delay 100ms`, per AC-VAL-2), or a CI environment if one exists. Speculative; no guarantee of reproduction.
3. **Land S6 first (to gain `__notestrTestArmAutoInvite`'s F2 trigger via S7), then re-run S4 with the deterministic trigger.** Inverts the spec's story order. The F2 path becomes testable; F1 still needs a different deterministic mechanism (e.g. a subscription that opens *after* a known-published kind-445).

## Open follow-ups (AC-REPORT-3)

- **No `unknown` failures to report**, since no failures occurred at all. This AC is vacuously satisfied.
- **Diagnostic-gate adequacy** (noted by Codex via the S3 ARCH examiner): the harness covers 1 of 6 failing-cluster scenarios. Even if the local run had failed, a 1-scenario sample would not have provided reliable F-class dominance evidence. This is a known scope reduction (per AC-DIAG-2 RECONCILE rewrite on 2026-05-18) but its consequence is more visible here than in the AC adjudication.

## Pre-run friction (worth surfacing — meta-level, not a project-state artifact)

- Playwright `node_modules/playwright-core/browsers.json` pins `chromium-headless-shell` revision 1208, but `/opt/playwright-browsers/` already had revisions 1223 only. First harness attempt crashed with `Executable doesn't exist at .../chromium_headless_shell-1208/chrome-linux/headless_shell`. Fix was `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers npx playwright install chromium` to fetch the 1208 binaries. The repo's `make e2e-install` target would have fixed this on a fresh checkout, but the cross-environment Linux/macOS state had drifted out of sync without that target being re-run. This is the kind of stamp-mismatch the project's `CLAUDE.md` flags ("never assume node_modules has the right native binaries"); the same caveat probably applies to Playwright browser binaries.

## Recommendation for team-lead surface

The S5/S6 fork that AC-REPORT-2 expects this report to drive **cannot be driven by this run's evidence**. The user must adjudicate option 1, 2, or 3 above before further story-level work is meaningful. S4 ships as "complete by artifact" (this report exists) but the decision gate it was supposed to feed is open.

---

## S8 closeout notes

**Date:** 2026-05-18
**Story:** S8 (doc-and-retry-config)
**Host:** Linux dev host (mrother.linux)

### AC-X-CI-1 (recast per GAP-3)

No CI infrastructure exists in this repo. AC-X-CI-1 ("10 consecutive CI runs
passing with retries=1") is recast as "10 consecutive local `make e2e` runs."

Current run conditions: S5 and S6 changes are present in the working tree. The
playwright retries configuration now reads:

```ts
retries: process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1" ? 0 : 1,
```

Consecutive 10-run validation is deferred until the relay environment is
confirmed stable on the dev host (the pre-run friction note in the S4 section
above describes the Playwright browser-binary mismatch that affected S4;
the same condition would need to be cleared before a 10-run count is
meaningful). **This AC is outstanding.**

### AC-VAL-4 (post-rollout, one week)

No CI infrastructure exists (GAP-3). Recast as: inspect local run logs over
the next observation window for retry counts of `multi-user.spec.ts:145` and
`three-party.spec.ts:79`. Expected: ≤2 retries across the week.

**Disposition:** deferred to "when CI lands" per stories.json scope note.
This AC is a monitoring follow-up, not a merge gate.

### AC-VAL-5 (one-shot relay-reset regression confirmation)

Procedure: reintroduce the deleted `_relayReset` fixture locally (do NOT
commit), run `make e2e` 10 times, compare failure rate to the post-S5/S6
baseline, then revert via `git restore`. This validation requires a stable
10-run post-S5/S6 baseline to exist first (see AC-X-CI-1 above).

**Disposition:** outstanding, pending AC-X-CI-1 baseline.

### Follow-ups filed

- `BACKLOG.json` slug `playwright-retries-zero-after-baseline`: drop retries
  to 0 unconditionally after 50 consecutive clean local runs of the e2e suite.
  Anchor: `playwright.config.ts:retries`.
