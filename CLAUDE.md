# notestr

## Multi-platform development

This project is developed across Linux x86_64 and macOS ARM (darwin-arm64). Native dependencies (rolldown, @next/swc) are platform-specific.

- Never assume `node_modules/` from a previous session has the right native binaries.
- The Makefile `node_modules` target stamps the current platform — switching platforms triggers a fresh `npm install`.
- When running build, test, or dev commands, always go through `make` so the platform check runs first.
- Do not run `npm install` and then `touch node_modules` without also writing the platform stamp.

## Browser automation

- Use the `/base:playwright` skill for multi-step browser interactions, not MCP Playwright tools directly.
- MCP tool calls return verbose snapshots and logs that bloat the main context. The skill handles that internally and returns a concise summary.
- Only use MCP Playwright tools directly for quick, single-step checks (one screenshot or one snapshot).
- `.mcp.json` pins `@playwright/mcp` to `--browser chromium` so the bundled Playwright Chromium is used. Without that flag the server defaults to branded Chrome, which is not installed on the Linux dev host (only `/opt/playwright-browsers/chromium-*` is). Keep the flag when editing `.mcp.json`.

## E2E relay (port 7777)

The e2e tests need a Nostr relay on `ws://localhost:7777`. Two project-owned
compose files publish on that port:

- `docker-compose.yml` — long-running dev relay, persistent state (`make relay-up`).
- `docker-compose.e2e.yml` — ephemeral test relay, tmpfs DB (`make e2e-up`).

Only one container can bind 7777 at a time. **The agreed policy is `make e2e`
REUSES whatever is already on :7777 instead of fighting for the port.** The
target chooses:

1. If our `notestr-web-relay-1` is running → `docker restart` it (tmpfs wipes
   its DB — the cleanest case).
2. Else if port 7777 is held by anything else (the dev relay, or even an
   unrelated container) → use it as-is. Do NOT try to start the ephemeral
   container, which would fail with `Bind for 0.0.0.0:7777 failed: port is
   already allocated` and abort the whole run.
3. Else → start the ephemeral container.

`make e2e-up` honours the same policy: if 7777 is held it logs "already in
use, reusing" and exits 0 instead of erroring with the cryptic docker bind
failure. Tests assume relay-state-independence, so reuse is safe.

**Caveat — diagnosing auth timeouts in e2e:** the reuse policy trusts the
existing :7777 listener to be a working NIP-46-capable strfry. If every
auth/setup test times out on `pubkey-chip`, check what's actually on the
port — an unrelated or unhealthy strfry (e.g. `barcode-dvm-strfry` from a
different project's compose, marked `(unhealthy)`) will not serve the test
traffic. Diagnose with:

```sh
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep 7777
lsof -nP -iTCP:7777
```

Stopping the offending container restores normal behaviour; do NOT change
the e2e port to avoid the conflict.

## marmot-ts (we control the fork)

`@internet-privacy/marmot-ts` is **our fork**. The `make node_modules` target clones
it to `/tmp/marmot-ts`, builds `dist`, **packs it into a tarball**
(`/tmp/marmot-ts/marmot-ts.tgz`), and rewrites `package.json` to depend on that
tarball — **not** a `file:` symlink to the dev tree. The tarball is the only
consumption shape that keeps a single `ts-mls` instance (see below).

- **Never monkey-patch marmot-ts in `node_modules`.** Edits there are ephemeral
  (any reinstall wipes them). Fix the issue in the fork, rebuild, repack, re-consume.

### Why a tarball, not a symlink or workspace (duplicate `ts-mls`)

marmot-ts re-exposes `ts-mls` types in its public API (`MarmotGroup.state` is a
`ts-mls` `ClientState`, etc.), and `ts-mls` brands types with a `unique symbol`
(`CustomExtension[__custom_extension_brand]`). If marmot-ts and this app resolve
*two physical copies* of `ts-mls`, those branded types **don't unify — even at the
identical version**, and `make build` / `npx tsc --noEmit` fail with `TS2345`
errors citing two `ts-mls` paths (one under `/tmp/marmot-ts`, one under our
`node_modules`).

The fix has two halves, both in place:
1. **Fork:** `ts-mls` is a `peerDependency` (+ `devDependency`), not a regular
   `dependency` — so the published/packed package carries no `ts-mls` and uses the
   host's copy. (marmot-ts commit "Declare ts-mls as a peer dependency".)
2. **Consumer:** the Makefile depends on the **packed tarball**, whose
   `devDependencies` (and thus `ts-mls`) are excluded — so npm installs marmot-ts as
   a real dir with no sibling `ts-mls`, deduping to our single copy.

**Do NOT switch marmot-ts to a pnpm `workspace:*` / live symlink to "get live
edits".** It reintroduces the bug: pnpm creates *two virtual `ts-mls` instances*
because the fork's devDep `ts-mls` resolves a different transitive `@noble/ciphers`
than the consumer scope, and pnpm keys its store by full resolution. The tarball
excludes devDeps and sidesteps this entirely. Also rejected (verified): `tsconfig`
`paths` for `ts-mls` (no effect — the fork's `.d.ts` resolve by realpath) and
copying marmot-ts into `node_modules` (breaks its other deps).

**Co-development loop:** after editing the fork, rebuild its dist
(`cd /tmp/marmot-ts && pnpm build`), then in this repo force a repack+reinstall:
`touch package.json && make node_modules`. (`make node_modules` re-runs the pack +
`npm install` steps; the clone/build step is skipped while `/tmp/marmot-ts/dist`
exists, so delete it to pull a fresh fork branch.)

**Note:** `vitest` unit tests pass even when the build is broken (they transpile
per-file without a whole-program typecheck), so green unit tests do **not** prove
`make build` typechecks. Gate the build on `npx tsc --noEmit` / `make build`.

## Documentation

This project maintains a technical specification in ./docs/task-protocol.md describing the task management protocol over nostr MLS.

- Whenever you work on task state, task datamodel or similar, check whether the protocol needs to be updated.

## Project state
Project orientation lives in `BACKLOG.md`. On a fresh session — or when
resuming work after idle time — run `/base:orient` to get a 3-line
"you are here" plus ranked next moves. Do not inline backlog content
into this file.
