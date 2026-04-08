# Task Sync Publish Contract — Acceptance Criteria

These criteria are derived from `spec.md` and map directly to the stories in `stories.json` (once created). Each AC is testable in isolation and asserts a specific observable outcome **against the ephemeral docker-e2e relay only**, never against web-internal state beyond what is needed to parameterize the relay query. ACs are grouped by concern.

## Terminology

- **`G`** — the target MLS group the test has joined or created, with:
  - `G.idStr` — the MLS group identifier string (marmot-ts / ts-mls internal)
  - `G.nostrGroupIdHex` — the 64-char hex of the 32-byte `NostrGroupDataExtension` id, used as the `#h` tag value on kind-445
  - `G.relays` — the group's operational relay set as exposed by `group.relays` (from `NostrGroupDataExtension`)
- **`userPk`** — the current web identity's 64-char hex pubkey (from the bunker fixture).
- **`subscriber`** — a `NdkSubscriber` instance from the new `e2e/fixtures/ndk-subscriber.ts` fixture, connected to `ws://localhost:7777`.
- **`waitForEvent(filter, timeoutMs)`** — the subscriber's method that resolves with the first matching event or rejects on timeout.
- **"published event"** — the single kind-445 Nostr event returned by `waitForEvent` after a dispatch.

## NDK Subscriber Fixture (S1)

- **AC-SUB-1** — After `openNdkSubscriber(["ws://localhost:7777"])` resolves, calling `subscriber.waitForEvent({ kinds: [1], authors: [<random-hex>] }, 1000)` with no matching event on the relay rejects with a timeout error whose message contains `"timeout"`.
- **AC-SUB-2** — After publishing a kind-1 event via a raw NDK publish from within the test harness, `subscriber.waitForEvent({ kinds: [1], ids: [<published-event-id>] }, 5000)` resolves with an `NDKEvent` whose `id` matches the published event. This proves the subscriber round-trips with the relay.
- **AC-SUB-3** — `subscriber.close()` unsubscribes all active subscriptions. After close, calling `waitForEvent` with any filter rejects immediately (or with the next tick's timeout) without leaving dangling relay subscriptions.
- **AC-SUB-4** — `waitForEvents(filter, 3, 5000)` collects exactly three matching events and resolves with them in arrival order. Receiving a fourth matching event does not resolve or reject the already-resolved promise (no double-delivery).
- **AC-SUB-5** — The fixture tolerates `NOTICE` frames from the relay without rejecting. A `NOTICE` is logged via `console.warn` but does not count against the timeout budget.

## Test-Only Debug Hooks (S2)

- **AC-HOOK-1** — When the app is built with `NODE_ENV === "test"` and mounted via `authenticateViaBunker(page)`, `await page.evaluate(() => window.__notestrTestGroups?.())` returns a non-empty array after the user has joined or created at least one group.
- **AC-HOOK-2** — Each entry returned by `window.__notestrTestGroups()` has the shape `{ idStr: string, nostrGroupIdHex: string, relays: string[] }`. `idStr` is non-empty, `nostrGroupIdHex` is 64 lowercase hex chars, `relays` is a non-empty `string[]`.
- **AC-HOOK-3** — A production build (`NODE_ENV === "production"`) does NOT expose `window.__notestrTestGroups`. `await page.evaluate(() => typeof window.__notestrTestGroups)` returns `"undefined"`.
- **AC-HOOK-4** — After the user leaves a group, `window.__notestrTestGroups()` no longer lists that group (the hook reads the current `client.groups` each call, not a cached snapshot).

## Publish-Failure Error Path (S3)

- **AC-ERR-1** — When `group.sendApplicationRumor` throws inside `dispatch` at `src/store/task-store.tsx`, the thrown error is caught and logged via `console.error` with a message beginning with `"[task-store] sendApplicationRumor failed:"`.
- **AC-ERR-2** — When `group.sendApplicationRumor` throws, a `window` CustomEvent with type `"notestr:taskPublishFailed"` is dispatched exactly once. The event's `detail` object contains `{ groupId: string, taskEvent: TaskEvent, error: string }` where `error` is either the original error's `.message` or its stringified form.
- **AC-ERR-3** — After a publish failure, the task remains in local state: `useTaskStore().tasks` still contains a task whose `id` matches the event's `taskEvent.task.id` (for `task.created`) or whose id matches `taskEvent.taskId` (for mutation variants). No roll-back happens.
- **AC-ERR-4** — After a publish failure, the task is still persisted in the IndexedDB event log: `persistence.loadEvents(groupId)` returns an array containing the failed event. No entry is removed on failure.
- **AC-ERR-5** — A successful publish does NOT dispatch any `"notestr:taskPublishFailed"` event — an `addEventListener` attached before the dispatch and detached after a successful round-trip receives zero callbacks.

## Structural Publish Contract (S4, S5)

For each variant, after a dispatch, the published kind-445 event MUST satisfy:

- **AC-STRUCT-1** — `event.kind === 445`.
- **AC-STRUCT-2** — `event.tags.filter(t => t[0] === "h").length === 1`, and the single `h` tag's value equals `G.nostrGroupIdHex`.
- **AC-STRUCT-3** — `event.content` is a non-empty string containing only base64 characters (`/^[A-Za-z0-9+/=]+$/`). The base64-decoded length is at least 28 bytes (12 bytes nonce + 16 bytes Poly1305 authentication tag + 0 bytes plaintext minimum).
- **AC-STRUCT-4** — `event.pubkey !== userPk`. Per MIP-03, kind-445 events are signed with an ephemeral keypair generated fresh per event, not with the user's identity key. The author field MUST NOT equal the bunker-reported pubkey.
- **AC-STRUCT-5** — Publishing the same TaskEvent twice produces two distinct kind-445 events with different `event.id` values AND different `event.pubkey` values (different ephemeral signers). This guards against accidental ephemeral-key reuse.
- **AC-STRUCT-6** — The event has a non-empty signature (`event.sig.length === 128` hex chars) that validates against the ephemeral pubkey.
- **AC-STRUCT-7** — `event.created_at` is within 10 seconds of the wall clock time at which the test dispatched the task event. (Permissive bound to tolerate clock skew between the test host and the docker relay.)
- **AC-STRUCT-8** — The event carries no `#p` tag. kind-445 events are group-scoped, not user-addressed; a `#p` would indicate a misrouted gift wrap or an unrelated event type.

## Round-Trip Decryption Contract (S4, S5)

For each variant, after capturing the published event, re-ingesting it through the web's own `MarmotClient` MUST satisfy:

- **AC-DECODE-1** — Re-fetching the event by id via `client.network.request(G.relays, [{ ids: [event.id] }])` returns the same event the subscriber saw.
- **AC-DECODE-2** — Feeding the fetched event through `await group.ingest([event])` returns a single result whose `kind` field is one of `"processed"`, `"skipped"`. `"rejected"` and `"unreadable"` MUST NOT occur for the web's own published output.
- **AC-DECODE-3** — The self-echo path populates `#sentEventIds` correctly: a second call to `group.ingest([event])` for the same event returns `"skipped"` and does NOT advance the ratchet.
- **AC-DECODE-4** — After a successful publish, the group's `applicationMessage` event fires with a `Uint8Array` whose `deserializeApplicationData` result yields a rumor with `rumor.kind === 31337` and `rumor.tags` containing `["t", "task"]`.
- **AC-DECODE-5** — The decoded rumor's `content` field parses as JSON into a `TaskEvent` whose shape matches the dispatched variant exactly, field for field.

## Per-Variant Contract (S4, S5)

### `task.created`

- **AC-CREATED-1** — After `dispatch({ type: "task.created", task })` with a well-formed `Task` object, `waitForEvent` resolves with a kind-445 event satisfying all AC-STRUCT-* and AC-DECODE-*.
- **AC-CREATED-2** — The decoded rumor's `content` JSON matches `{ "type": "task.created", "task": <task> }` byte-for-byte (modulo JSON object key ordering — comparison is via deep-equal, not string equality).
- **AC-CREATED-3** — The decoded `task` object has `id`, `title`, `description`, `status: "open"`, `assignee: null`, `createdBy: userPk`, `createdAt`, `updatedAt`. `id` is a valid UUIDv4.
- **AC-CREATED-4** — Creating two tasks in rapid succession produces two distinct kind-445 events with different `event.id` values, both matching AC-STRUCT-5.

### `task.updated`

- **AC-UPDATED-1** — After `dispatch({ type: "task.updated", taskId, changes: { title: "new" }, updatedAt, updatedBy })` for a previously-created task, `waitForEvent` resolves with a kind-445 whose decoded rumor content matches the dispatched event byte-for-byte.
- **AC-UPDATED-2** — `changes` is a partial object — `changes.title` is present, `changes.description` is either present or absent depending on the dispatch. Absent keys MUST NOT be serialized as `null` or `undefined` (they MUST be omitted entirely).
- **AC-UPDATED-3** — The update event's `updatedBy` field equals `userPk`.
- **AC-UPDATED-4** — Two consecutive `task.updated` events for the same `taskId` with monotonically increasing `updatedAt` produce two distinct kind-445 events; the relay subscriber observes both in order.

### `task.status_changed`

- **AC-STATUS-1** — After `dispatch({ type: "task.status_changed", taskId, status: "in_progress", updatedAt, updatedBy })`, the observed event decodes to `{ type: "task.status_changed", taskId, status: "in_progress", updatedAt, updatedBy: userPk }`.
- **AC-STATUS-2** — All four valid status transitions (`open`, `in_progress`, `done`, `cancelled`) round-trip through the publish contract without structural divergence.
- **AC-STATUS-3** — `updatedBy` equals `userPk`.

### `task.assigned`

- **AC-ASSIGN-1** — After `dispatch({ type: "task.assigned", taskId, assignee: "<hex>", updatedAt, updatedBy })`, the decoded rumor's `assignee` field equals the dispatched hex string.
- **AC-ASSIGN-2** — Assigning `null` (unassign) produces a decoded rumor whose `assignee` field is explicitly `null` — NOT omitted, NOT `undefined`. The test explicitly asserts `decoded.assignee === null` (per the `task-protocol.md` field detail).
- **AC-ASSIGN-3** — `updatedBy` equals `userPk`.

### `task.deleted`

- **AC-DELETE-1** — After `dispatch({ type: "task.deleted", taskId, updatedAt, updatedBy })`, the decoded rumor matches the dispatched event byte-for-byte.
- **AC-DELETE-2** — After the delete event is published, the task is removed from local state (`useTaskStore().tasks` no longer contains it) AND the `task.deleted` event is appended to the IndexedDB event log (so a reload reconstructs the post-delete state).
- **AC-DELETE-3** — Publishing a delete event for a task that the caller does not own is still permitted at the protocol layer — the web does not enforce authorship on delete. AC-DELETE-1 still holds.

## Publish Failure Test (S6)

- **AC-FAIL-1** — Given a configured failure mode (e.g., the docker-e2e relay is stopped mid-test OR the test intercepts the NDK `publish` method to throw), dispatching `task.created` causes `sendApplicationRumor` to throw, which causes the `dispatch` try/catch to emit `"notestr:taskPublishFailed"` exactly once per failed dispatch.
- **AC-FAIL-2** — The test listens on `window.addEventListener("notestr:taskPublishFailed", handler)` before dispatching, and the handler receives a `CustomEvent` whose `detail.groupId` equals `G.idStr`, `detail.taskEvent.type === "task.created"`, and `detail.error` is a non-empty string.
- **AC-FAIL-3** — After the failure, `useTaskStore().tasks` still contains the task (optimistic state preserved). Calling `await page.reload()` and re-authenticating, the task is still present in state because it was persisted to IndexedDB before the publish failed.
- **AC-FAIL-4** — After the relay is restored and a new task is dispatched, the new task publishes successfully and the subscriber observes its kind-445 event. Previous failures do not poison the publish path.

## Cross-Variant Invariants

- **AC-INV-AUTHOR-1** — Across every test in this suite, no published kind-445 event has `event.pubkey === userPk`. This is a sanity check on the MIP-03 ephemeral-signing property.
- **AC-INV-TAG-1** — Across every test, every published kind-445 event has exactly one `#h` tag, and no `#p` tag.
- **AC-INV-CONTENT-1** — Across every test, every published kind-445 event's `content` decodes as valid base64 with decoded length ≥ 28.
- **AC-INV-IDEMPOTENT-1** — Across every test, dispatching the same logical TaskEvent twice never produces two kind-445 events with the same `event.id`. (Different ephemeral keys, different `created_at`, so ids differ.)
- **AC-INV-ISOLATION-1** — Tests that create groups use unique group names per test. The ephemeral docker-e2e relay is wiped via `docker-compose.e2e.yml down -v` on teardown, so cross-run contamination is impossible, but unique names guard against intra-run leakage.
- **AC-INV-NO-CROSS-PROJECT-1** — The test suite does not import, spawn, or otherwise depend on any file outside `notestr-web/`. `make e2e` must pass without `notestr-cli/` being checked out on the test host.
- **AC-INV-NO-CROSS-PROJECT-2** — `package.json` gains no dev-dependency on any Rust toolchain, no `ffi-napi`, and no `child_process` spawning of Rust binaries.
- **AC-INV-TIMING-1** — Each individual test completes within 30 seconds including setup, dispatch, relay round-trip, and teardown. The full `task-publish-contract.spec.ts` file completes within 5 minutes under `make e2e`.

## Documentation (S7)

- **AC-DOC-1** — `e2e/tests/README.md` exists and documents the pattern "observe the relay via NDK, do not inspect web internals beyond test-only debug hooks" with one concrete example drawn from `task-publish-contract.spec.ts`.
- **AC-DOC-2** — The README explicitly states that `task-publish-contract.spec.ts` is the publish-side counterpart to `notestr-cli/specs/phase11-task-sync-receive-contract.md`, and that the two projects' test suites are intentionally decoupled with the relay as the shared contract surface.
- **AC-DOC-3** — The README documents the required `NODE_ENV=test` build flag and the `window.__notestrTestGroups` debug hook, and states that these are NOT available in production builds.
