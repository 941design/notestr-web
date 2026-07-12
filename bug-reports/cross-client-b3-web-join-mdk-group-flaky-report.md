# Bug Report: Web flakily fails to surface/join a CLI-created (MDK) group (B3.1)

## Status

**OPEN — filed 2026-06-29 by the parent `notestr` repo (integration owner).**
This is the web-side hop of the cross-client **B3 regression**. The parent owns
the umbrella + acceptance:
`notestr/bug-reports/cross-client-b3-cli-created-group-delivery-regression-report.md`
(close-on-green: parent `make cross-client-test` B3 block). Governance:
`notestr/protocol/README.md`.

## Summary

When **notestr-cli/daemon creates a group** and invites the web member, the web
**intermittently fails to surface the group** in its sidebar. The
`make cross-client-test` hop `B3.1` is **flaky**: it passed on the first attempt
but timed out (60s) on the serial retry (`e2e/cross-client.spec.ts:306`,
`webGroups()` never contains the new group). Confirmed on two runs (2026-06-28,
2026-06-29). Web-created groups (B1) and the same-identity web-joins-CLI-group
case (same-identity test 4) are green — so this is specific to joining a
**different-npub, CLI/MDK-created** group.

## Reproduction

```
# from the parent workspace:
make cross-client-test    # block "B3 CLI-created group", test B3.1 (flaky — run a few times)
```

1. CLI/daemon creates group G3, invites the web member's npub.
2. Web should surface G3 (`__notestrTestGroups()` contains it) within 60s.
3. Intermittently it does not (welcome not processed / group not materialised).

## Where to look

The web's processing of a **welcome into an MDK-origin group** and the live
subscription it wires for it. Use the in-app hooks to separate the failure mode:

- `__notestrTestInspectGroupEvent` / `__notestrTestGroupEpoch` /
  `__notestrTestMlsTrace` — is the welcome received but not applied (decryption /
  epoch / leaf), vs. never received?
- Compare against the same-identity path (green) and the web-created path (green)
  to isolate what's specific to a different-npub MDK welcome.

NOTE (ruled out): the per-pubkey IndexedDB partitioning (`7607c7c`) shipped and
B3 did **not** change across runs, so the IDB-partitioning change is **not** the
cause. Likely region: the marmot/welcome-processing + group-subscription path
(`src/marmot/`), not the storage layer.

## Acceptance

- `make cross-client-test` B3.1 passes reliably across ≥5 runs (no flaky
  reclassification) for a CLI-created group.
- Parent umbrella closes when the whole B3 block is green.

## Anchor

`src/marmot/client.tsx` (welcome processing / group subscription; exact site is
part of the triage).
