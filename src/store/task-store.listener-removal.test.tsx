/**
 * task-store.listener-removal.test.tsx
 *
 * S12 (legacy->engine full cutover, Phase 8) exit-gate coverage.
 *
 * AC-MIG-3 / VQ-S12-007: `src/store/task-store.tsx` must contain ZERO
 * `applicationMessage` listener registrations after this story. Asserted
 * both structurally (grep on the source file -- the pre-Phase-8 tree had
 * exactly one such match, task-store.tsx's own `group.on("applicationMessage",
 * handleApplicationMessage)` registration, so this check is
 * state-discriminating across the phase boundary, not trivially true
 * before this story too) and behaviorally (a simulated
 * applicationMessage-shaped delivery to the group `TaskStoreProvider` is
 * handed does NOT change `tasks` -- proof the deletion is a real, dead
 * removal, not merely absent from a grep that happens not to exercise the
 * removed code).
 *
 * VQ-S12-001: also structurally checks `src/marmot/device-sync.ts` no
 * longer registers a persistence-side `applicationMessage` listener (the
 * second listener this story removes) and no longer drives
 * `group.ingest()` directly.
 *
 * VQ-S12-004: confirms the engine path fully covers what the removed
 * listeners provided -- the SAME fixture payload, delivered through the
 * engine's own ingest path instead of the removed listener, DOES appear in
 * `tasks`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { IDBFactory } from "fake-indexeddb";
import type { IngestSignal, IngestSource, RawProtocolFactInput } from "../engine/engine-types";
import type { Task, TaskEvent } from "../domain/task-events";

vi.mock("@internet-privacy/marmot-ts", () => ({
  generateKeyPackageSlot: () => "f".repeat(64),
  deserializeApplicationData: (data: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(data)),
  getNostrGroupIdHex: () => "test-h-tag",
}));

/**
 * Just enough of an EventEmitter to prove a legacy-shaped
 * `applicationMessage` emission has NO consumer left on the task-store
 * side. Not wired to the engine at all -- `engineIngestSourceOverride`
 * (used by the second behavioral test below) drives the engine path
 * independently, exactly as production's real `MarmotGroup` and the
 * engine's own `IngestSource` are two separate objects post-cutover.
 */
class FakeGroup {
  private listeners = new Map<string, Set<(data: Uint8Array) => void>>();

  on(event: string, handler: (data: Uint8Array) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
  }

  off(event: string, handler: (data: Uint8Array) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  /** True iff at least one "applicationMessage" handler is currently
   *  registered -- a direct proof that nothing is listening, stronger than
   *  merely asserting `tasks` didn't change (which could also be explained
   *  by a listener that fired but happened to no-op). */
  hasApplicationMessageListeners(): boolean {
    return (this.listeners.get("applicationMessage")?.size ?? 0) > 0;
  }

  emitApplicationMessage(data: Uint8Array): void {
    for (const handler of this.listeners.get("applicationMessage") ?? []) {
      handler(data);
    }
  }
}

let currentFakeGroup: FakeGroup | undefined;
vi.mock("../marmot/client", () => ({
  useGroup: () => currentFakeGroup,
  useMarmot: () => ({
    pubkey: "",
    client: null,
    signer: null,
    relays: [] as string[],
  }),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// vitest.config.ts runs this suite under `environment: "node"` (no DOM).
// task-store.tsx's PRE-EXISTING `isTestRuntime()` window-hook-registration
// effect assumes a `window` global whenever `NODE_ENV === "test"`. A
// minimal self-referencing shim (not jsdom, which this repo does not
// depend on) is sufficient since this file never asserts against the
// window-hook surface itself.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
}

const { act, create } = TestRenderer;

function fixtureTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    assignee: null,
    createdBy: "pk-fixture",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    updatedBy: "pk-fixture",
  };
}

/** Legacy-shaped fixture: raw bytes as `group.on("applicationMessage", ...)`
 *  would have delivered them -- `deserializeApplicationData` (mocked
 *  above) decodes this back into a `Rumor`-shaped object. Kept even though
 *  the listener consuming it is gone -- the point of the first test below
 *  is that this payload, delivered the OLD way, now goes nowhere. */
function legacyMessageBytes(taskEvent: TaskEvent, rumorId: string): Uint8Array {
  const rumor = {
    id: rumorId,
    kind: 31337, // TASK_EVENT_KIND
    content: JSON.stringify(taskEvent),
    tags: [],
    created_at: 1_700_000_000,
    pubkey: "pk-fixture",
  };
  return new TextEncoder().encode(JSON.stringify(rumor));
}

function factInput(id: string, groupId: string): RawProtocolFactInput {
  return {
    id,
    groupId,
    nostrEventId: id,
    nostrEvent: {
      id,
      pubkey: "pk-fixture",
      created_at: 1_700_000_000,
      kind: 445,
      tags: [],
      content: "ciphertext",
      sig: "sig",
    },
    receivedAt: 1_700_000_000_000,
    receiptSource: "historical",
    epochAtReceipt: "epoch-0",
  };
}

/** Engine-path fixture: the SAME task-created payload, wrapped as an
 *  `IngestSignal` the engine's `catchUp()` drain yields during "welcome"
 *  origin's catching_up phase. */
function messageSignal(groupId: string, taskEvent: TaskEvent, id: string): IngestSignal {
  return {
    type: "message",
    fact: factInput(id, groupId),
    rumorId: id,
    payload: taskEvent,
    epoch: "epoch-0",
    receiptSource: "historical",
  };
}

async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function createFixtureIngestSource(catchUpSignals: IngestSignal[]): IngestSource {
  return {
    catchUp() {
      return fromArray(catchUpSignals);
    },
    openLive() {
      return () => {};
    },
    ingestPersisted() {
      return fromArray([]);
    },
    fetchBootstrap() {
      return fromArray([]);
    },
    close() {},
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
// AC-MIG-3 / VQ-S12-007 -- structural grep gate
// ---------------------------------------------------------------------------

describe("AC-MIG-3: task-store.tsx contains zero applicationMessage listener registrations", () => {
  it("grep gate: zero `applicationMessage` matches in src/store/task-store.tsx", () => {
    const source = readFileSync(join(__dirname, "task-store.tsx"), "utf-8");
    const matches = source.match(/applicationMessage/g) ?? [];
    expect(matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VQ-S12-001 -- device-sync.ts's persistence-side listener + group-ingest
// driver are also gone. Structural (this suite runs under vitest's node
// environment and cannot easily drive a real MarmotGroup's group.ingest()).
// ---------------------------------------------------------------------------

describe("VQ-S12-001: device-sync.ts no longer drives group.ingest() or an applicationMessage listener", () => {
  const deviceSyncSource = readFileSync(
    join(__dirname, "..", "marmot", "device-sync.ts"),
    "utf-8",
  );

  it("device-sync.ts contains no `group.ingest(` call", () => {
    expect(deviceSyncSource).not.toMatch(/group\.ingest\(/);
  });

  it('device-sync.ts registers no "applicationMessage" listener', () => {
    expect(deviceSyncSource).not.toMatch(/"applicationMessage"/);
  });
});

// ---------------------------------------------------------------------------
// Behavioral proof: the removed listener no longer fires, AND the engine
// path fully covers what it used to provide (VQ-S12-001 / VQ-S12-004).
// ---------------------------------------------------------------------------

describe("task-store.tsx S12: removed listener is behaviorally dead; engine path covers it", () => {
  const PUBKEY = "a".repeat(64);
  let taskStoreModule: typeof import("./task-store");
  let storage: typeof import("../marmot/storage");

  beforeEach(async () => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    storage = await import("../marmot/storage");
    taskStoreModule = await import("./task-store");
    storage.bindStores(PUBKEY);
    currentFakeGroup = undefined;
  });

  function TasksProbe({ onRender }: { onRender: (tasks: Task[]) => void }) {
    const { tasks } = taskStoreModule.useTaskStore();
    onRender(tasks);
    return null;
  }

  it(
    "a legacy-shaped applicationMessage emission on the group " +
      "TaskStoreProvider is handed (via useGroup) does NOT change tasks -- " +
      "no consumer is registered for it anymore",
    async () => {
      const groupId = "group-dead-listener";
      const group = new FakeGroup();
      currentFakeGroup = group;
      const fixtureTaskId = "dead-listener-task-1";

      let latestTasks: Task[] = [];
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider groupId={groupId}>
            <TasksProbe onRender={(tasks) => (latestTasks = tasks)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      // Give the provider's mount effects a chance to settle.
      await act(async () => {
        await flush(20);
      });

      // Direct proof nothing registered on the group at all.
      expect(group.hasApplicationMessageListeners()).toBe(false);

      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      await act(async () => {
        group.emitApplicationMessage(legacyMessageBytes(taskEvent, "rumor-dead-1"));
      });
      // Nothing to await-until (no consumer should react) -- a final flush
      // is the honest way to assert an absence of an async state change.
      await act(async () => {
        await flush(20);
      });

      expect(latestTasks.map((t) => t.id)).not.toContain(fixtureTaskId);
      expect(latestTasks).toEqual([]);

      await act(async () => {
        renderer.unmount();
      });
    },
  );

  it(
    "the SAME fixture payload, delivered through the engine's ingest path " +
      "instead, DOES appear in tasks -- the engine fully covers what the " +
      "removed listener used to provide",
    async () => {
      const groupId = "group-engine-covers-it";
      const fixtureTaskId = "engine-covers-task-1";
      const taskEvent: TaskEvent = {
        type: "task.created",
        task: fixtureTask(fixtureTaskId),
      };
      const ingestSourceOverride = createFixtureIngestSource([
        messageSignal(groupId, taskEvent, "engine-covers-fact-1"),
      ]);

      let latestTasks: Task[] = [];
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <taskStoreModule.TaskStoreProvider
            groupId={groupId}
            engineIngestSourceOverride={ingestSourceOverride}
          >
            <TasksProbe onRender={(tasks) => (latestTasks = tasks)} />
          </taskStoreModule.TaskStoreProvider>,
        );
      });

      await waitUntil(() => latestTasks.some((t) => t.id === fixtureTaskId));

      expect(latestTasks.map((t) => t.id)).toEqual([fixtureTaskId]);

      await act(async () => {
        renderer.unmount();
      });
    },
  );
});
