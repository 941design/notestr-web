# Bug Report: e2e harness spawns bunkers before port check and leaks serve worker across runs

## Description

`e2e/global-setup.ts` spawns bunker A, B, and C **before** checking whether port 3100 is free. If the port is already occupied (e.g. by a serve process from a previous run that wasn't cleaned up), the three bunker children are already alive and untracked before `assertPortFree(3100)` fires at line 301. The subsequent setup abort leaves `.state.json` with partial data (bunker PIDs present, serve PID absent) and the three orphaned bunker processes holding the relay's NIP-46 ports.

Additionally, `serve` is spawned with `detached: false` (via `npx`) — `npx` forks a child worker; teardown kills the npx parent but not the child serve process, so port 3100 stays occupied across sessions. No process-group kill is used anywhere in teardown.

## Source

BACKLOG.json finding `e2e-harness-spawns-bunkers-before-port`, promoted 2026-05-21.

## Reproduction Steps

1. Run `make e2e` — teardown kills the npx parent but leaves the serve child alive.
2. Run `make e2e` again — `assertPortFree(3100)` fails and aborts, but bunkers A/B/C are already spawned and their PIDs written to `.state.json`. The relay ports are now held by orphaned processes.
3. Subsequent runs fail with port conflicts until manual process reaping.

## Anchor

`e2e/global-setup.ts:196` (bunker spawns begin) and `e2e/global-setup.ts:301` (assertPortFree call)