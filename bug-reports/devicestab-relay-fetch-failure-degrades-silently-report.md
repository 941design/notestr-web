# Bug Report: DevicesTab relay-fetch failure degrades silently

## Description

DevicesTab relay-fetch failure degrades silently to local-only device list without user warning — the catch block at DevicesTab.tsx:173-174 swallows relay errors with no visible feedback.

Source: BACKLOG.json finding promoted 2026-06-01

## Reproduction Steps

1. Open the Devices tab with the app connected to a relay.
2. Interrupt the relay connection (simulate network failure or relay downtime).
3. Observe that the device list continues to display without any indication that the relay fetch failed.
4. Expected: a visible error or warning indicator that the relay fetch failed.
5. Actual: the device list silently falls back to local devices only.

## Expected Behavior

When a relay fetch fails in DevicesTab, the app should display a visible error or warning to the user indicating that the device list may be incomplete (relay unreachable).

## Actual Behavior

The `try/catch` block at DevicesTab.tsx:173 silently swallows the error. The `slotMap` retains whatever it had before the failure (or whatever was accumulated before the error occurred), and the UI renders without any indication of the failure.

## Impact

Users may believe their device list is complete when in fact it only reflects locally-known devices, potentially missing key packages fetched from the relay.

## Affected File

`src/components/DevicesTab.tsx:173-174`