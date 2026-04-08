# Task Sync Publish Contract & Observable Test Coverage

## Problem

A user reported that a task created in notestr-web does not propagate to the MCP server hosted by notestr-cli, despite both clients authenticated via the same NIP-46 bunker, pointing at the same operational relays, and participating in the same MLS group. The **reverse** direction — MCP-created tasks reaching the web — works correctly as of the strict NIP-59 fix in notestr-cli.

The existing web test suite (`e2e/tests/tasks.spec.ts`, `e2e/tests/groups.spec.ts`, `e2e/tests/multi-device-sync.spec.ts`) covers:

- Creating a task in the web UI and asserting it appears in the local DOM board.
- Creating groups and asserting the group appears in the sidebar.
- Multi-device joining where both parties are web contexts (currently marked `fixme`).

It does **not** cover:

- What the web actually publishes to the relay when a task is created.
- Whether the published kind-445 event conforms to `task-protocol.md` at the workspace root.
- Whether the event is visible to an independent relay subscriber (a non-marmot-ts observer).
- Whether all five `TaskEvent` variants — `task.created`, `task.updated`, `task.status_changed`, `task.assigned`, `task.deleted` — round-trip through the publish path correctly.

Without that coverage, the reported bug falls through the gap: the web's internal state shows the task (because `dispatch` applies it optimistically to the local store at `src/store/task-store.tsx:93-98` **before** calling `sendApplicationRumor` at line 111), while the relay may receive nothing, a malformed event, or the event may go to the wrong relays. The user has no way to tell which, and neither do we.

This epic establishes the **publish-side contract** that the web guarantees to the relay, and adds Playwright coverage that asserts the contract using a **plain NDK subscriber** against the same relay the web publishes to. Nothing in the test suite depends on notestr-cli, MDK, or any Rust code — the only contract surface is the relay and the wire format documented in `task-protocol.md`.

## Solution

1. Define the wire-format guarantees the web MUST meet when publishing a task event (kind-445 shape, `#h` tag format, ChaCha20-Poly1305 content layout, MIP-03 conformance, target relay set).
2. Add a new Playwright e2e test `e2e/tests/task-publish-contract.spec.ts` that:
   - Authenticates the web via the bunker fixture.
   - Creates a group in context A.
   - Opens a headless NDK subscriber that connects to the same relay and filters for `{ kinds: [445], '#h': [<nostr_group_id>] }`.
   - Dispatches each of the five `TaskEvent` variants through the web UI or store dispatch.
   - Asserts each expected kind-445 event is observed on the NDK subscription within a timeout.
   - Asserts structural properties of each event (kind, tags, content base64 length, author-is-ephemeral).
   - Optionally asserts decryption round-trip by reusing the web's own `MarmotClient.groups[i]` to decrypt the observed event and verify the decoded rumor matches the expected `TaskEvent` JSON.
3. Add per-variant assertions so that the test catches not only "event was published" but also "event content matches the protocol-defined shape for this variant".
4. Surface publish failures from `sendApplicationRumor` at `src/store/task-store.tsx:111` as **user-visible errors**, not silently swallowed promise rejections. Any failure that prevents a relay publish must be caught and either retried, queued, or surfaced via toast/log so the user knows their task did not sync.

## Scope

### In Scope

- A new Playwright test file `e2e/tests/task-publish-contract.spec.ts` that covers all five `TaskEvent` variants against a live ephemeral strfry relay via the existing `docker-compose.e2e.yml` infrastructure.
- A test fixture `e2e/fixtures/ndk-subscriber.ts` that wraps an NDK relay subscription into an async iterator, allowing Playwright tests to `await` the arrival of matching events with a bounded timeout. Builds on the existing `e2e/fixtures/ndk-client.ts` headless-NDK fixture pattern.
- Structural assertions per the Contract Definition below — each test verifies `kind == 445`, `#h` matches the nostr_group_id, `content` is base64-encoded with decoded length ≥ 28, and the event's author is a per-event ephemeral keypair (distinct from the user's identity pubkey).
- A round-trip decryption assertion per variant: the observed event is fed through `decryptGroupMessageEvent` from marmot-ts using the current group state, and the resulting rumor is asserted to be kind 31337 with tag `["t", "task"]` and a content JSON matching the expected `TaskEvent` shape.
- An error-handling change in `src/store/task-store.tsx` to **catch and surface** `sendApplicationRumor` failures instead of leaking them as unhandled promise rejections. At minimum: log to `console.error` with a recognisable prefix, dispatch a `taskPublishFailed` event that the UI layer can observe, and retain the task in local state (do not roll back optimistic update). Whether to also display a toast is a UX decision delegated to the GroupManager / Board refactor — the spec requires the error **path** to exist and be testable, not a specific UX surface.
- A dedicated test that forces a relay-unreachable scenario (disconnect the `docker-compose.e2e.yml` relay mid-flight) and asserts the error path fires.
- Documentation in `e2e/tests/README.md` (new file) describing how each test in the suite observes the relay independently of the web's own state.

### Out of Scope

- Modifying the wire format in `task-protocol.md`. If the spec is under-specified, a separate epic updates the protocol; this epic tests only what the current protocol says.
- Implementing a retry queue for failed publishes. The error-handling change is minimal and observability-focused. A full offline-first task queue is a follow-up.
- Integration with notestr-cli. This epic has zero dependencies on the Rust side. The CLI has its own independent receive-contract spec (`notestr-cli/specs/phase11-task-sync-receive-contract.md`) that asserts the mirror side of the contract against the same relay. Cross-stack drift is caught by running both test suites independently against the same `task-protocol.md` version.
- Capturing kind-445 fixtures for replay. If the CLI wants to replay a captured web event, it does so from its own side without any affordance from this epic.
- Testing groups created in context A appearing in context B (covered by `epic-multi-device-sync`).
- Testing the welcome flow (covered by `epic-multi-device-sync` and the NIP-59 fix in notestr-cli).
- Changing the self-echo dedup logic at `node_modules/@internet-privacy/marmot-ts/dist/client/group/marmot-group.js:364`. That logic is library-internal and stays as-is.

## Design Decisions

1. **The relay is the only contract surface.** The test does not inspect any web-internal state beyond what is needed to derive the `nostr_group_id` to filter on. The assertion target is the NDK-observed relay content, not the web's React state. This mirrors the CLI-side approach in `notestr-cli/specs/phase11-task-sync-receive-contract.md`.
2. **NDK is the observer, not marmot-ts.** NDK is already a dev dependency via the headless fixture pattern (`e2e/fixtures/ndk-client.ts`). Using NDK avoids re-instantiating a second MarmotClient as the subscriber, which would test the web ↔ web round-trip instead of the publish-to-relay contract.
3. **Round-trip decryption uses marmot-ts, but via the same MarmotClient the web uses.** For per-variant content assertions, the test re-reads the published event through the web's own `client.network.request(relays, [{ ids: [event.id] }])` path and feeds it back through `client.groups[i].ingest(...)`. This tests "the web can decrypt its own published output via the public API" — not a separate library instance. It also exercises the `#sentEventIds` self-echo suppression path at `marmot-group.js:364`.
4. **Timeout budget is 5 seconds per assertion, 30 seconds per test.** Publish and relay echo should be sub-second on the ephemeral docker-e2e relay; a 5-second ceiling is generous but keeps the suite runtime predictable.
5. **The error-handling change is observability-only.** Catching the rejection and surfacing it via `console.error` plus a store-level event is enough to make the failure testable. A UX-level toast is not required in this epic because that involves product decisions about where error state lives in the UI.
6. **Each variant gets its own test.** Running all five in one test makes failures hard to attribute. The file is structured as a `test.describe('task publish contract', () => { test('task.created', ...); test('task.updated', ...); ... })` block so a single-variant regression reports clearly.
7. **The test authenticates via bunker, not via local keys.** Production usage is bunker-based; the test should exercise the same auth path. The existing `e2e/fixtures/bunker.mjs` + `authenticateViaBunker(page)` helper already supports this.
8. **Do not assert against `notestr-invite-*` or `notestr-group-state` IDB stores.** Those are web-internal. The contract test only touches the relay.

## Technical Approach

### `e2e/fixtures/ndk-subscriber.ts` (new)

A thin wrapper around NDK that exposes a filter-to-async-iterator surface:

```ts
import NDK, { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk";

export interface NdkSubscriber {
  waitForEvent(filter: NDKFilter, timeoutMs: number): Promise<NDKEvent>;
  waitForEvents(filter: NDKFilter, count: number, timeoutMs: number): Promise<NDKEvent[]>;
  close(): Promise<void>;
}

export async function openNdkSubscriber(relays: string[]): Promise<NdkSubscriber>;
```

`waitForEvent` subscribes to the given filter, resolves with the first matching event, and unsubscribes. `waitForEvents` collects N events before resolving. Both reject on timeout. The fixture disposes all subscriptions on `close()`.

### `e2e/tests/task-publish-contract.spec.ts` (new)

```ts
import { test, expect } from "@playwright/test";
import { authenticateViaBunker } from "../fixtures/auth-helper";
import { openNdkSubscriber } from "../fixtures/ndk-subscriber";

test.describe("task publish contract", () => {
  test("task.created publishes a kind-445 with conformant shape", async ({ page }) => {
    await authenticateViaBunker(page);
    // Create group, wait for it in sidebar
    // Extract nostrGroupId via window exposure (see design decision note below)
    // Open NDK subscriber on ws://localhost:7777
    // Trigger task creation in the UI
    // Await relay event, assert shape
  });

  test("task.status_changed publishes a kind-445 with the new status", async ({ page }) => { ... });
  test("task.updated publishes a kind-445 with changed fields", async ({ page }) => { ... });
  test("task.assigned publishes a kind-445 with the assignee", async ({ page }) => { ... });
  test("task.deleted publishes a kind-445 for the removed task", async ({ page }) => { ... });
  test("publish failure is surfaced, not silently swallowed", async ({ page }) => { ... });
});
```

Getting the `nostrGroupId` from the web to the test harness without depending on web internals is accomplished by exposing a minimal read-only debug helper **only** when `NODE_ENV === "test"`:

```ts
// src/marmot/client.tsx, inside init() after client is created, guarded by NODE_ENV
if (process.env.NODE_ENV === "test") {
  (window as unknown as { __notestrTestGroups?: () => Array<{ idStr: string; nostrGroupIdHex: string; relays: string[] }> })
    .__notestrTestGroups = () =>
    client.groups.map((g) => ({
      idStr: g.idStr,
      nostrGroupIdHex: getNostrGroupIdHex(g.state),
      relays: g.relays ?? DEFAULT_RELAYS,
    }));
}
```

The test calls `await page.evaluate(() => window.__notestrTestGroups?.())` to resolve the group id. Production builds never expose this function because `NODE_ENV` is `"production"` there. This is consistent with the existing test-only `data-testid` attributes already scattered through the web tree.

### `src/store/task-store.tsx` (modified)

Current code at lines 91-112 applies optimistically, persists, then calls `sendApplicationRumor` without a try/catch:

```ts
const dispatch = useCallback(async (taskEvent: TaskEvent) => {
  // Apply optimistically
  const nextState = applyEvent(stateRef.current, taskEvent);
  setState(nextState);
  await appendEvent(groupId, taskEvent);
  if (group) {
    const rumor: Rumor = { id: "", kind: TASK_EVENT_KIND, content: JSON.stringify(taskEvent), tags: [["t", "task"]], created_at: Math.floor(Date.now() / 1000), pubkey: "" };
    await group.sendApplicationRumor(rumor);  // ← can throw, swallowed by caller's lack of try/catch
  }
}, [group, groupId]);
```

Change to:

```ts
const dispatch = useCallback(async (taskEvent: TaskEvent) => {
  const nextState = applyEvent(stateRef.current, taskEvent);
  setState(nextState);
  await appendEvent(groupId, taskEvent);
  if (!group) return;

  const rumor: Rumor = { /* unchanged */ };
  try {
    await group.sendApplicationRumor(rumor);
  } catch (err) {
    console.error("[task-store] sendApplicationRumor failed:", err);
    // Emit an observable event so UI / tests can react.
    window.dispatchEvent(
      new CustomEvent("notestr:taskPublishFailed", {
        detail: { groupId, taskEvent, error: err instanceof Error ? err.message : String(err) },
      }),
    );
    // Intentional: do NOT roll back the optimistic local state. The task
    // is persisted in IndexedDB and visible in the UI. The failure only
    // affects multi-client sync. Rolling back would surprise users whose
    // peers are offline.
  }
}, [group, groupId]);
```

A small `useEffect` in Board.tsx (or a dedicated toaster hook) can later listen on `'notestr:taskPublishFailed'` and render a toast. That UI surface is follow-up work — this epic only requires the event to fire so the test can assert it.

### `e2e/tests/task-publish-contract.spec.ts` — per-variant assertion skeleton

```ts
test("task.created publishes a kind-445 with conformant shape", async ({ page }) => {
  await authenticateViaBunker(page);
  await createGroupInUI(page, "PublishContractTest");

  const [group] = await page.evaluate(() => window.__notestrTestGroups?.() ?? []);
  expect(group).toBeDefined();

  const sub = await openNdkSubscriber(["ws://localhost:7777"]);

  const eventPromise = sub.waitForEvent(
    { kinds: [445], "#h": [group.nostrGroupIdHex] },
    5000,
  );

  await createTaskInUI(page, "Test title", "Test description");

  const event = await eventPromise;

  // Structural assertions
  expect(event.kind).toBe(445);
  expect(event.tags.find((t) => t[0] === "h")?.[1]).toBe(group.nostrGroupIdHex);
  expect(event.content).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
  const decodedLen = Buffer.from(event.content, "base64").length;
  expect(decodedLen).toBeGreaterThanOrEqual(28); // 12 nonce + 16 poly1305 tag + 0 plaintext
  // Author is ephemeral, not the user's identity pubkey
  const userPk = await page.evaluate(() => /* expose test hook for user pubkey */);
  expect(event.pubkey).not.toBe(userPk);

  // Round-trip decrypt via the web's own MarmotClient
  const decoded = await page.evaluate(async (eventId) => {
    const cli = await window.__notestrTestMarmotClient?.();
    const grp = cli?.groups.find((g) => /* match */);
    const ev = (await cli?.network.request(grp?.relays, [{ ids: [eventId] }]))?.[0];
    const [result] = await grp?.ingest([ev]) ?? [];
    return result ?? null;
  }, event.id);

  expect(decoded).toBeTruthy();
  // assert the decoded rumor matches the expected TaskEvent shape

  await sub.close();
});
```

### Test isolation invariants

- Each test creates a fresh group with a unique name per test to avoid cross-test contamination on the tmpfs relay.
- The docker-e2e relay is already wiped on `make e2e` teardown via `docker-compose.e2e.yml down -v`.
- The NDK subscriber is closed at the end of each test via a test-scoped `afterEach`.

## Relationship to Other Epics

- **`epic-e2e-test-infrastructure`** — provides the `docker-compose.e2e.yml` ephemeral relay, `e2e/fixtures/bunker.mjs`, `authenticateViaBunker`, `ndk-client.ts`. This epic extends that foundation with a NDK subscriber fixture and new test file.
- **`epic-multi-device-sync`** — introduced per-device auto-invite and `DeviceList`. That epic's tests cover the invite flow; this epic covers what happens AFTER a user is already in a group and creates tasks.
- **`epic-identity-scoped-group-and-task-visibility`** — defines how groups and tasks are scoped per identity. This epic's tests use a single identity per Playwright context, so identity-scoping is not under test here.

## Acceptance Criteria

See `acceptance-criteria.md`.

## Stories

Implementation breakdown lives in `stories.json` once this spec is accepted. Preliminary story grouping:

- **S1** — NDK subscriber fixture (`e2e/fixtures/ndk-subscriber.ts`) + unit test against the docker-e2e relay proving it can see events published by a raw NDK publish.
- **S2** — `window.__notestrTestGroups` debug hook in `src/marmot/client.tsx`, guarded by `NODE_ENV === "test"`.
- **S3** — `task-store.tsx` error-handling change: try/catch around `sendApplicationRumor`, `notestr:taskPublishFailed` custom event, store update preserves optimistic state.
- **S4** — `task-publish-contract.spec.ts` per-variant test for `task.created`.
- **S5** — Remaining variants: `task.status_changed`, `task.updated`, `task.assigned`, `task.deleted`. One test per variant.
- **S6** — Publish-failure path test: `test("publish failure is surfaced, not silently swallowed")`. Uses a relay-disconnect trick (e.g. `docker-compose stop` mid-test, or an NDK-side interception) to force `sendApplicationRumor` to throw, asserts the `notestr:taskPublishFailed` custom event fires with the expected detail.
- **S7** — Documentation (`e2e/tests/README.md`) describing how each test observes the relay and what guarantees the contract provides.

## Non-Goals

- A retry queue for failed publishes.
- A global toast system.
- Any change to `task-protocol.md`.
- Any dependency on notestr-cli, MDK, or the Rust side of the stack.
- Integration of this test suite into notestr-cli's CI. Each project's test suite stays independent.
- Capturing kind-445 fixtures for replay in other projects' tests. If the CLI wants such fixtures, it captures them from its own relay observer, not via any affordance in this epic.
