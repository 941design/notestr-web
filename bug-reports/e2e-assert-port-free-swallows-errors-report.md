# Bug Report: assertPortFree swallows non-[setup] errors, masking environment failures as port-free

**Severity:** LOW — pre-existing, edge-case environments, single-file fix.
**Discovered by:** External code-review pass on commit `44a4b9c` (though
the defect predates that commit — introduced in `9ef3518`).

## Symptom

When the e2e harness boots, the very first sanity check is
`assertPortFree(3100)` in `e2e/global-setup.ts:131-147`. Its purpose is
to fail loud if some other process is already holding the dev-server
port. The check uses `execSync('lsof -ti:3100')` and inspects the result.

The catch handler re-raises only errors whose message starts with the
literal token `[setup]`:

```ts
} catch (err) {
  // lsof exits non-zero when no process found — that's the happy path.
  // Re-throw our own error; swallow lsof's exit-code error.
  if (err instanceof Error && err.message.startsWith('[setup]')) throw err;
}
```

Every other error — `lsof` not on `PATH`, `EACCES` on the proc table,
`ENOMEM`, `EAGAIN`, a corrupted child process, anything — is silently
swallowed. The function returns as if the port were free, and globalSetup
proceeds to build the app and start `serve out -l 3100`.

The eventual `serve` start may then fail with a less-actionable error
(EADDRINUSE if the port really is busy, or — worse — appear to succeed
if the port is free but lsof was lying about something else). The
operator sees a confusing downstream failure instead of "lsof not
installed, please install it or skip the port check."

## Reproduction

Three scenarios that all manifest the bug:

### Scenario A — lsof not on PATH

```bash
# Temporarily hide lsof.
PATH="" node -e "require('child_process').execSync('lsof -ti:3100')"
# → throws "Command failed: lsof -ti:3100 / lsof: command not found"

# Now run the harness:
PATH=/usr/bin make e2e   # PATH excludes /usr/sbin where lsof lives
# Expected: loud failure with a [setup] message.
# Actual: assertPortFree silently returns "port free," build starts,
#         serve start fails with EADDRINUSE or succeeds spuriously.
```

### Scenario B — lsof permission denied

Some containerized CI environments restrict access to /proc/net for
non-root users. lsof exits with EACCES, and the catch handler swallows
it. globalSetup proceeds; the eventual failure is generic.

### Scenario C — port really is busy, but lsof somehow fails first

Less common, but if lsof crashes (segfault, OOM during fork) on an
actually-busy port, the harness proceeds as if the port were free and
hits EADDRINUSE on `serve` start. The operator sees the EADDRINUSE error
but not the upstream lsof failure that should have caught the busy
port earlier.

## Expected behavior

The catch handler should distinguish three error classes:

1. **Happy path:** lsof exited non-zero with empty stdout (no process
   holding the port). Swallow.
2. **Setup-side hard fail:** the `[setup] Port N is already in use ...`
   error that the function itself re-raises after detecting a held port.
   Re-raise (current behavior).
3. **Environmental fail:** lsof not found, EACCES, ENOMEM, ENOENT on the
   binary, etc. Re-raise with a clear `[setup]` prefix so the operator
   can act:
   - `[setup] lsof not installed; cannot verify port {port} is free —
     install lsof or set PORT_CHECK_DISABLED=1 to skip the check.`
   - `[setup] lsof exited with permission error (EACCES); cannot verify
     port {port} is free.`
   - etc.

## Suspected root cause

`e2e/global-setup.ts:142-146` — the catch handler is over-broadly
permissive. The intent comment ("lsof exits non-zero when no process
found — that's the happy path") only describes one specific failure
mode of one specific command. It conflates:

- exit-code-1-with-empty-stdout (genuine happy path)
- exit-code-127 (command not found)
- exit-code-126 (permission denied)
- exit-code-signal (child killed)
- ChildProcessError exceptions (Node-side spawn failure)

Node's `execSync` throws a generic `Error` for all of these, and the
catch handler treats them all the same.

## Candidate fix

Replace `execSync` with `spawnSync` so the exit code and stdout are
exposed separately. Then:

```ts
async function assertPortFree(port: number): Promise<void> {
  const { spawnSync } = await import('child_process');
  const result = spawnSync('lsof', ['-ti', `:${port}`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Environmental failures — re-raise loudly with a [setup] prefix.
  if (result.error) {
    // ENOENT (binary missing) is the most common; surface that explicitly.
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `[setup] lsof not installed; cannot verify port ${port} is free — ` +
        `install lsof or set PORT_CHECK_DISABLED=1 to skip the check.`,
      );
    }
    throw new Error(
      `[setup] lsof failed (${code ?? 'unknown'}): ${result.error.message} — ` +
      `cannot verify port ${port} is free.`,
    );
  }

  // lsof prints PIDs to stdout. Exit code is 1 when no process found
  // (happy path) or 0 when one or more PIDs printed.
  const pids = (result.stdout || '').trim();
  if (pids) {
    throw new Error(
      `[setup] Port ${port} is already in use (PID(s): ${pids.replace(/\n/g, ', ')}). ` +
      `The e2e harness will NOT kill processes it discovers — free the port manually ` +
      `(e.g. \`kill <pid>\` after confirming what it is) and re-run.`,
    );
  }

  // No PIDs in stdout — port is free regardless of lsof's exit code.
  // (lsof returns 1 on "nothing matched," 0 on "matched at least one PID.")
}
```

Also consider: an environment variable `PORT_CHECK_DISABLED=1` that
short-circuits the check entirely. Useful in CI environments where lsof
isn't available and the test runner is sandboxed to free ports.

## Impact

- Low in normal developer environments (lsof is ubiquitous on macOS and
  most Linux distros).
- Medium in restricted CI environments (containerized, root-only proc).
- Operational annoyance: when it bites, the downstream EADDRINUSE error
  is far less actionable than the upstream "lsof not found" would have
  been.
- Pre-existing in commit `9ef3518` ("test(e2e): fail loud on busy port
  3100 instead of SIGKILLing discovered PIDs"). The intent of that
  commit was to fail loud, not to fail quiet on the meta-failure path.

## Non-goals

- Don't refactor global-setup.ts more broadly. The fix is scoped to the
  one catch handler.
- Don't add a fallback "if lsof is missing, try `ss` / `netstat` /
  /proc/net" — those are speculative and out of scope for a defensive
  catch fix.
- Don't add tests for environment-breakage scenarios (mocking
  child_process.spawnSync to inject ENOENT would be over-engineered for
  a one-line fix).

## Files affected

- `e2e/global-setup.ts:131-147` — `assertPortFree` function. Single-file
  change, ~20 line diff.

## Context

Surfaced by the external code-review pass on commit `44a4b9c`. Not
introduced by that commit — predates it. The reviewer's finding (#3 of
3) flagged this as LOW severity, distinct from the higher-severity
findings #1 (multi-device regression) and #2 (sole-admin propagation
gap). Worth rolling into the next adjacent e2e-harness fix pass; can
share a commit with the already-filed
`e2e-harness-spawns-bunkers-before-port` backlog finding if both are
addressed together.
