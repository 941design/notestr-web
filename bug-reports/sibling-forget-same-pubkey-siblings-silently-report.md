# Bug Report: Sibling-forget on same-pubkey siblings silently no-ops after MIP-00 KP change

Source: BACKLOG.json finding promoted 2026-06-01

## Description

AC-E2E-2/AC-E2E-11/AC-E2E-12 are reported broken for the two-device-same-pubkey
flow: a user cannot decommission their other device when both devices belong to
the same Nostr pubkey. This is the same protocol guarantee the self-forget fix
(bug-self-forget-no-mls-propagation) restored, but for the sibling code path.

## Expected behavior

`A1` calls sibling-forget on `A2` (same pubkey, different slot). `A2`'s leaf is
removed from `A1`'s ratchet tree (leaf count for pubkeyA goes 2 → 1), the Remove
commit propagates to other members (B sees the same), and `A2`'s slot appears in
`A1`'s `__notestrTestForgottenSlots`.

## Actual behavior (as reported in the finding, 2026-05-21)

`e2e/tests/forget-device-sibling.spec.ts:181` hangs the 30s poll: `A2` leaf stays
in `A1`'s ratchet tree (length 2 instead of 1). `siblingLeafIndexesForEvents`
matches relay-fetched KP events to leaves via `compareKeyPackageToLeafNode`
(signaturePublicKey equality). Suspected cause: commit `13297ec` (MIP-00
kind-30443 compliance) changed the serialization round-trip such that the decoded
relay KP no longer matches the in-tree leaf signature key for siblings. No error
surfaced; the UI silently did nothing.

## Reproduction steps

- Anchor: `src/marmot/forget-device.ts:130` (`siblingLeafIndexesForEvents` /
  `forgetSiblingDevice`).
- Repro test: `e2e/tests/forget-device-sibling.spec.ts` — "A1 forgets A2: A2 leaf
  gone from all views, slot in A1's forgotten-slots IDB".

## Impact

Two-device-same-account users cannot decommission a sibling device — a core
device-management guarantee.

## Investigation note (2026-06-01)

The finding's suspected approach (2) — repair the KP-shape round-trip so
`compareKeyPackageToLeafNode` keeps working — was superseded by commit `0b360bc`
("fix(forget-device): credential-based fallback when sibling has rotated its
KP"), which added `siblingLeafIndexesByPubkeyExcludingOwn`: when the primary
KP-equality match yields `[]`, the sibling leaves are re-derived by credential
pubkey and the local admin's own leaf is excluded via `ownLeafIndex` (MLS
signature-key match). The May 26 triage run recorded both sibling-forget tests
green. This bug run re-verifies against a fresh e2e run before closing.
