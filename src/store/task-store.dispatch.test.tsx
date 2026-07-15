/**
 * task-store.dispatch.test.tsx
 *
 * S10-Fable-1 (Stage-2/Fable remediation) wiring coverage.
 *
 * task-store.tsx's publish-outbox mount effect used to commit
 * `publishOutbox` to React state ONLY via
 * `outbox.loadPersisted().then(() => setPublishOutbox(outbox))`, with no
 * `.catch()`. `loadPersisted()` performs one IDB `getItem` -- quota,
 * eviction, or private-mode make a rejection a real failure mode, not a
 * hypothetical one. When it rejected, `setPublishOutbox` was never called:
 * `publishOutbox` stayed `null` for the rest of the session, and
 * `dispatch`'s `if (publishOutbox)` send-gate silently skipped the SEND
 * half of EVERY subsequent dispatch. The optimistic `applyEvent` and the
 * legacy-log `appendEvent` still ran, so edits appeared to succeed locally
 * while never reaching the MLS group and never being retried -- a silent
 * publish outage, plus an unhandled promise rejection.
 *
 * The fix (see task-store.tsx's outbox mount effect, ~line 393) adds a
 * `.catch()` that logs and STILL commits the outbox to state via
 * `.finally()`: rehydration failure only affects reconciling PRIOR entries
 * (AC-PUB-1), never the ability to issue a fresh publish.
 *
 * This file proves that fix directly: with `loadPersisted()` forced to
 * reject, `publishOutbox` is still committed to state, and a subsequent
 * `dispatch(taskEvent)` still reaches the outbox's real `publish()` path
 * (observed via the fake group's `sendApplicationRumor` having been
 * invoked). A second baseline test proves the happy path (no rehydrate
 * failure) is unaffected.
 *
 * Deliberately a SEPARATE file from task-store.cutover.test.tsx rather than
 * an addition to it: that file's `../marmot/client` mock always returns
 * `client: null`, which never constructs a `publishOutbox` at all (see its
 * own comment -- it "never invokes dispatch()"). This file needs a non-null
 * `client` to exercise the outbox wiring, plus a `../marmot/storage` mock
 * that can force the "outbox" KV store's `getItem` to reject on demand
 * without touching any of the other stores the suite touches. Reuses
 * task-store.cutover.test.tsx's fake-indexeddb + `storage.bindStores` +
 * per-test `vi.resetModules()` idiom otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { IDBFactory } from "fake-indexeddb";
import type { Task, TaskEvent } from "../domain/task-events";

const PUBKEY = "a".repeat(64);

// Same three-module stub set as task-store.cutover.test.tsx -- see that
// file's comments for why each is needed to resolve the module graph under
// vitest's node environment.
vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
  deserializeApplicationData: (data: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(data)),
  getNostrGroupIdHex: () => "test-h-tag",
}));

let currentFakeGroup: FakeGroup | undefined;
let currentFakeClient: FakeClient | undefined;
vi.mock("../marmot/client", () => ({
  useGroup: () => currentFakeGroup,
  useMarmot: () => ({
    pubkey: currentFakeClient ? PUBKEY : "",
    client: currentFakeClient ?? null,
    signer: null,
    relays: [] as string[],
  }),
}));

vi.mock("./persistence", () => ({
  loadEvents: async () => [],
  appendEvent: async () => {},
}));

// Lets a single test force the "outbox" KV store's `getItem` (what
// publish-outbox.ts's `loadPersisted()` calls) to reject, while every other
// store name (events, joined-groups, bootstrap-completed, ...) goes through
// untouched to the real implementation -- same real `storage.ts` module
// task-store.cutover.test.tsx and publish-outbox.test.ts both rely on
// (fake-indexeddb backed, bound via `storage.bindStores(PUBKEY)`).
const storageControl = { rejectOutboxGetItem: false };
vi.mock("../marmot/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../marmot/storage")>();
  return {
    ...actual,
    createKVStore(name: string, pinnedPubkey?: string) {
      const real = actual.createKVStore(name, pinnedPubkey);
      if (name !== "outbox") return real;
      return {
        ...real,
        async getItem(key: string) {
          if (storageControl.rejectOutboxGetItem) {
            throw new Error(
              "simulated outbox getItem failure (S10-Fable-1 wiring test)",
            );
          }
          return real.getItem(key);
        },
      };
    },
  };
});

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// See task-store.cutover.test.tsx's identical shim for why this is needed
// under vitest's node (non-DOM) environment.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
}

const { act, create } = TestRenderer;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Just enough of a `MarmotGroup` for the legacy `group.on/off(
 *  "applicationMessage", ...)` pair task-store.tsx unconditionally
 *  registers (unrelated to this file's assertions, but required for the
 *  provider to mount cleanly) plus `sendApplicationRumor`/`state`, which
 *  the outbox wiring under test actually calls. */
class FakeGroup {
  readonly state = {};
  readonly sendApplicationRumor = vi.fn(async (_rumor: unknown) => undefined);
  private listeners = new Map<string, Set<(data: Uint8Array) => void>>();

  on(event: string, handler: (data: Uint8Array) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
  }

  off(event: string, handler: (data: Uint8Array) => void): void {
    this.listeners.get(event)?.delete(handler);
  }
}

interface FakeClient {
  network: { publish: ReturnType<typeof vi.fn> };
  keyPackages: { clientId: string };
}

function createFakeClient(clientId: string): FakeClient {
  return {
    network: {
      publish: vi.fn(async () => ({ "relay-1": { from: "relay-1", ok: true } })),
    },
    keyPackages: { clientId },
  };
}

function fixtureTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    assignee: null,
    createdBy: PUBKEY,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    updatedBy: PUBKEY,
  };
}

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  { maxAttempts = 200, stepMs = 5 }: { maxAttempts?: number; stepMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < maxAttempts && !predicate(); i++) {
    await act(async () => {
      await flush(stepMs);
    });
  }
  if (!predicate()) {
    throw new Error(
      `waitUntil: predicate did not become true within ${maxAttempts} attempts`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("task-store.tsx S10-Fable-1: outbox rehydrate-failure wiring", () => {
  let taskStoreModule: typeof import("./task-store");
  let storage: typeof import("../marmot/storage");

  beforeEach(async () => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    storageControl.rejectOutboxGetItem = false;
    storage = await import("../marmot/storage");
    taskStoreModule = await import("./task-store");
    storage.bindStores(PUBKEY);
    currentFakeGroup = undefined;
    currentFakeClient = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function DispatchProbe({
    onReady,
  }: {
    onReady: (dispatch: (event: TaskEvent) => Promise<void>) => void;
  }) {
    const { dispatch } = taskStoreModule.useTaskStore();
    onReady(dispatch);
    return null;
  }

  it(
    "PERMANENT half: a rejecting loadPersisted() still commits publishOutbox " +
      "to state, and dispatch() still issues a send (no silent publish outage)",
    async () => {
      storageControl.rejectOutboxGetItem = true;

      const groupId = "group-fable-1-permanent";
      const group = new FakeGroup();
      const client = createFakeClient("device-under-test");
      currentFakeGroup = group;
      currentFakeClient = client;

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider groupId={groupId}>
            <DispatchProbe onReady={(d) => (dispatch = d)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      // Let the outbox mount effect run to completion -- loadPersisted()
      // rejects, but the fix's .catch()/.finally() must still commit
      // publishOutbox to state, and log the failure instead of swallowing
      // it as an unhandled rejection.
      await waitUntil(() => consoleErrorSpy.mock.calls.length > 0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[task-store] outbox rehydrate failed:",
        expect.any(Error),
      );

      expect(dispatch).toBeDefined();
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask("fable-1-task"),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      // The outbox's real publish path was invoked -- proof publishOutbox
      // is non-null and dispatch's `if (publishOutbox)` send-gate did NOT
      // silently skip the send.
      expect(group.sendApplicationRumor).toHaveBeenCalledTimes(1);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "baseline (regression guard): with loadPersisted() succeeding, " +
      "dispatch() still issues a send exactly as before",
    async () => {
      storageControl.rejectOutboxGetItem = false;

      const groupId = "group-fable-1-baseline";
      const group = new FakeGroup();
      const client = createFakeClient("device-under-test");
      currentFakeGroup = group;
      currentFakeClient = client;

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let dispatch: ((event: TaskEvent) => Promise<void>) | undefined;
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider groupId={groupId}>
            <DispatchProbe onReady={(d) => (dispatch = d)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => dispatch !== undefined);
      // Let the mount effect's loadPersisted() settle before dispatching,
      // same as production's own AC-PUB-1 ordering guarantee.
      await act(async () => {
        await flush(20);
      });

      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask("fable-1-baseline-task"),
      };
      await act(async () => {
        await dispatch!(taskEvent);
      });

      expect(group.sendApplicationRumor).toHaveBeenCalledTimes(1);
      // No rehydrate-failure log on the happy path. (Not a blanket
      // `not.toHaveBeenCalled()` -- react-test-renderer itself logs an
      // unrelated one-time deprecation notice via console.error.)
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        "[task-store] outbox rehydrate failed:",
        expect.anything(),
      );

      await act(async () => {
        renderer.unmount();
      });
    },
  );
});
