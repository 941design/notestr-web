# E2E Relay Observation

`task-publish-contract.spec.ts` verifies the publish-side task contract by observing the relay through a plain NDK subscriber. The test does not trust the browser's React state as proof of sync.

The pattern is:

1. Authenticate the browser and create or select a group.
2. Read test-only debug metadata such as `window.__notestrTestGroups()` to get the current `#h` tag value and relay list.
3. Subscribe directly to the relay with `openNdkSubscriber(...)`.
4. Dispatch the task event in the browser and assert on the observed kind-445 event.

This is the publish-side counterpart to `notestr-cli/specs/phase11-task-sync-receive-contract.md`. The two suites are intentionally decoupled and share only the relay plus the wire contract.

The debug hooks are available only in e2e builds with `NEXT_PUBLIC_E2E=1`. Production builds must not expose `window.__notestrTestGroups`.

## Error-state observation (canonical selectors)

The task board has **no top-level error banner** — task failures degrade
gracefully by design, so there is no `data-testid="error-banner"` to assert
on. Never assert "no error is shown" by the *absence* of a bespoke
`data-testid`: a selector that doesn't exist always matches zero elements, so
a missing node reads as "no error" and silently masks real failures. Use the
canonical, failure-mode-specific surfaces instead:

- **Task publish failure** → the `notestr:taskPublishFailed` DOM CustomEvent is
  the canonical contract. Observe it with an event recorder (see
  `attachPublishFailureRecorder` in `task-publish-contract.spec.ts`), not a
  DOM banner. A successful publish must NOT dispatch it (AC-ERR-5); a forced
  failure dispatches it with `{ groupId, taskEvent, error }`. Event-based
  assertions cannot be masked by a missing element.
- **Task bootstrap on an empty/degraded group** (AC-3) → graceful empty board.
  Assert positively: the board columns render (`[data-column="open"]` visible,
  no crash) and `[data-testid="task-card"]` has count 0. No error is shown
  because, by design, none exists for this path.
- **Component-scoped errors** (devices / identity / QR) DO carry stable
  testids — e.g. `device-relay-error`, `identity-sibling-fetch-error`,
  `npub-qr-scan-error`, `pending-invitations-dismiss-error`. Assert on those
  directly where a component surfaces a visible failure.
