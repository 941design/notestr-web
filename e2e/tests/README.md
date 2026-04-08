# E2E Relay Observation

`task-publish-contract.spec.ts` verifies the publish-side task contract by observing the relay through a plain NDK subscriber. The test does not trust the browser's React state as proof of sync.

The pattern is:

1. Authenticate the browser and create or select a group.
2. Read test-only debug metadata such as `window.__notestrTestGroups()` to get the current `#h` tag value and relay list.
3. Subscribe directly to the relay with `openNdkSubscriber(...)`.
4. Dispatch the task event in the browser and assert on the observed kind-445 event.

This is the publish-side counterpart to `notestr-cli/specs/phase11-task-sync-receive-contract.md`. The two suites are intentionally decoupled and share only the relay plus the wire contract.

The debug hooks are available only in e2e builds with `NEXT_PUBLIC_E2E=1`. Production builds must not expose `window.__notestrTestGroups`.
