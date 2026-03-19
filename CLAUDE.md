# notestr

## Multi-platform development

This project is developed across Linux x86_64 and macOS ARM (darwin-arm64). Native dependencies (rolldown, @next/swc) are platform-specific.

- Never assume `node_modules/` from a previous session has the right native binaries.
- The Makefile `node_modules` target stamps the current platform — switching platforms triggers a fresh `npm install`.
- When running build, test, or dev commands, always go through `make` so the platform check runs first.
- Do not run `npm install` and then `touch node_modules` without also writing the platform stamp.

## Browser automation

- Use the `playwright-browser` agent for browser interactions, not MCP Playwright tools directly.
- MCP tool calls return verbose snapshots and logs that bloat the main context. The agent handles that internally and returns a concise summary.
- Only use MCP Playwright tools directly for quick, single-step checks (one screenshot or one snapshot).
