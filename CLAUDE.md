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

## marmot-ts (we control the fork)

`@internet-privacy/marmot-ts` is **our fork**, consumed via a `file:` dependency —
`node_modules/@internet-privacy/marmot-ts` is a symlink to the local fork build.

- **Never monkey-patch marmot-ts in `node_modules`.** Edits there are ephemeral
  (any reinstall wipes them) and only touch a symlink into the fork's build output.
  Fix the issue in the fork, rebuild, and re-consume.

### Pitfall: duplicate `ts-mls` instance breaks `make build`

**Symptom:** `make build` (or `npx tsc --noEmit`) fails with `TS2345` errors that
cite two `ts-mls` locations — the fork's tree (`…/marmot-ts/…/ts-mls`) and this
project's `node_modules/ts-mls` — e.g. `ClientState`/`KeyPackage` "not assignable",
or a missing `[__custom_extension_brand]` property.

**Cause:** marmot-ts re-exposes `ts-mls` types in its public API (`MarmotGroup.state`
is a `ts-mls` `ClientState`, etc.), and `ts-mls` brands types with a `unique symbol`.
If marmot-ts and this app resolve *two separate physical copies* of `ts-mls`, those
branded types don't unify — even at the identical version. The fork currently lists
`ts-mls` as a regular `dependency` and is consumed via a `file:` symlink to its dev
tree, so the fork's own copy and this app's copy are two instances.

**The fix lives in the fork — do not work around it here (no `tsconfig` paths
hacks, no copying into `node_modules`; both have been tried and fail):**
1. In the fork, move `ts-mls` from `dependencies` to `peerDependencies` (keep it in
   `devDependencies` so the fork still builds/tests). This declares "use the host's
   single `ts-mls`."
2. Consume the fork as a packed artifact (`pnpm pack` → depend on the `.tgz`) or a
   published/git version — **not** a `file:` link to the live dev directory. A
   tarball installs as a real package with no sibling `ts-mls`, so the install
   dedupes to this app's single copy. For active co-development of both repos, use a
   workspace so they share one `node_modules` / one `ts-mls`.

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
