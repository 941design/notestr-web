import { expect, test, type Page } from "@playwright/test";
import type { NDKKind } from "@nostr-dev-kit/ndk";

import { authenticateViaBunker } from "../fixtures/auth-helper.js";
import { clearAppState } from "../fixtures/cleanup.js";
import { openNdkSubscriber } from "../fixtures/ndk-subscriber.js";

import type { TaskEvent } from "../../src/store/task-events.ts";

const RELAY_URL = "ws://localhost:7777";
const KIND_GROUP_MESSAGE = 445 as NDKKind;

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()} ${Math.random().toString(16).slice(2, 8)}`;
}

function isMobile(page: Page): boolean {
  const vp = page.viewportSize();
  return vp != null && vp.width < 768;
}

async function openMobileDrawer(page: Page): Promise<void> {
  if (!isMobile(page)) return;
  // The sidebar lives in an off-canvas drawer on mobile — the Create
  // button for a new group is only clickable after the drawer is opened
  // via the hamburger in the header.
  await page.getByRole("button", { name: /open menu/i }).click();
  await page.waitForTimeout(250);
}

async function createGroup(page: Page, groupName: string): Promise<void> {
  await openMobileDrawer(page);
  await page.getByPlaceholder("Group name").first().fill(groupName);
  await page.getByRole("button", { name: "Create", exact: true }).first().click();

  // After Create, the page-level onGroupSelect handler closes the mobile
  // drawer (app/page.tsx setDrawerOpen(false)). The off-canvas aside slides
  // out via transform: translateX(-100%) — fast enough on Mobile Chrome to
  // catch the new group name in the brief pre-close window, but Mobile
  // Safari consistently lands the visibility check AFTER the close, so the
  // group name is in DOM but off-screen and toBeVisible times out.
  //
  // The "Tasks" heading on the board is the next render after the drawer
  // closes, so it's a stable post-condition for both desktop (drawer stays
  // open) and mobile (drawer closes, board takes focus).
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({
    timeout: 30000,
  });

  if (!isMobile(page)) {
    // On desktop the sidebar is permanently visible, so assert the group
    // landed in it as well — that's the test we still want for selection
    // wiring on the desktop path.
    await expect(
      page.locator("aside").getByText(groupName).first(),
    ).toBeVisible({ timeout: 10000 });
  }
}

async function currentGroup(page: Page): Promise<{
  idStr: string;
  nostrGroupIdHex: string;
  relays: string[];
}> {
  const groups = await page.evaluate(() => window.__notestrTestGroups?.() ?? []);
  expect(groups.length).toBeGreaterThan(0);
  return groups[groups.length - 1]!;
}

async function dispatchTaskEvent(page: Page, taskEvent: TaskEvent): Promise<void> {
  await page.evaluate(async (event) => {
    await window.__notestrTestDispatchTaskEvent?.(event);
  }, taskEvent);
}

async function persistedTaskEvents(page: Page): Promise<TaskEvent[]> {
  return page.evaluate(async () => {
    return (await window.__notestrTestPersistedTaskEvents?.()) ?? [];
  });
}

async function currentTasks(page: Page) {
  return page.evaluate(() => window.__notestrTestTasks?.() ?? []);
}

type PublishedEventShape = {
  kind: number;
  tags: string[][];
  content: string;
  pubkey: string;
  sig?: string;
  created_at: number;
  id: string;
};

function assertPublishedShape(
  event: PublishedEventShape,
  hTag: string,
  userPk: string,
  dispatchedAt: number,
) {
  expect(event.kind).toBe(445);
  const hTags = event.tags.filter((tag) => tag[0] === "h");
  expect(hTags).toHaveLength(1);
  expect(hTags[0]?.[1]).toBe(hTag);
  expect(event.tags.some((tag) => tag[0] === "p")).toBe(false);
  expect(event.content).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(Buffer.from(event.content, "base64").length).toBeGreaterThanOrEqual(28);
  expect(event.pubkey).not.toBe(userPk);
  expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  expect(Math.abs(event.created_at - dispatchedAt)).toBeLessThanOrEqual(10);
}

async function inspectRumorContent(
  page: Page,
  groupIdStr: string,
  eventId: string,
): Promise<{
  decodedContent: TaskEvent | null;
  ingestKind: string | undefined;
  ingestReason: string | undefined;
  secondIngestKind: string | undefined;
}> {
  const inspected = await page.evaluate(
    (args) => window.__notestrTestInspectGroupEvent?.(args.groupId, args.eventId),
    { groupId: groupIdStr, eventId },
  );
  const rumor = inspected?.rumor ?? null;
  const decodedContent =
    rumor && typeof rumor.content === "string"
      ? (JSON.parse(rumor.content) as TaskEvent)
      : null;
  return {
    decodedContent,
    ingestKind: inspected?.firstIngest[0]?.kind,
    ingestReason: inspected?.firstIngest[0]?.reason,
    secondIngestKind: inspected?.secondIngest[0]?.kind,
  };
}

async function resetSentRumors(page: Page, groupIdStr: string): Promise<void> {
  await page.evaluate(
    (id) => window.__notestrTestResetSentRumors?.(id),
    groupIdStr,
  );
}

async function attachPublishFailureRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __taskPublishFailures: unknown[] }).__taskPublishFailures = [];
    const handler = (event: Event) => {
      (window as unknown as { __taskPublishFailures: unknown[] }).__taskPublishFailures.push(
        (event as CustomEvent).detail,
      );
    };
    (window as unknown as { __taskPublishFailureHandler: EventListener }).__taskPublishFailureHandler = handler;
    window.addEventListener("notestr:taskPublishFailed", handler);
  });
}

async function detachPublishFailureRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const handler = (window as unknown as { __taskPublishFailureHandler?: EventListener })
      .__taskPublishFailureHandler;
    if (handler) {
      window.removeEventListener("notestr:taskPublishFailed", handler);
    }
    delete (window as unknown as { __taskPublishFailureHandler?: EventListener })
      .__taskPublishFailureHandler;
  });
}

async function readPublishFailures(page: Page): Promise<unknown[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __taskPublishFailures?: unknown[] }).__taskPublishFailures ?? [],
  );
}

test.describe("task publish contract", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await clearAppState(page);
    await authenticateViaBunker(page);
  });

  test("ndk subscriber round-trips with relay", async () => {
    const subscriber = await openNdkSubscriber([RELAY_URL]);
    try {
      // Publish first, then wait for the event by its specific id. This
      // avoids racing `ndk.subscribe` (which sends REQ async) against the
      // synchronous `publish` call: on platforms where the EVENT frame
      // beats REQ on the wire, the published event arrives in the stored-
      // events batch rather than as a live message, and any time-based
      // `since` gate would then drop it. Filtering by exact id side-steps
      // both issues.
      const published = await subscriber.publishTextNote(uniqueName("subscriber"));
      const observed = await subscriber.waitForEvent(
        { kinds: [1], ids: [published.id] },
        5000,
      );
      expect(observed.id).toBe(published.id);
    } finally {
      await subscriber.close();
    }
  });

  test("task.created publishes a conformant kind-445 event", async ({ page }) => {
    await createGroup(page, uniqueName("Publish Created"));
    const group = await currentGroup(page);
    const userPk = await page.evaluate(() => window.__notestrTestPubkey?.() ?? "");
    const subscriber = await openNdkSubscriber(group.relays);

    // AC-ERR-5: a successful publish must NOT dispatch notestr:taskPublishFailed
    await attachPublishFailureRecorder(page);

    // Start each variant from an empty sent-rumor buffer so
    // `inspectRumorContent` always returns the rumor for the event under test.
    await resetSentRumors(page, group.idStr);

    const taskA = {
      id: crypto.randomUUID(),
      title: uniqueName("Task Created"),
      description: "created contract test",
      status: "open" as const,
      assignee: null,
      createdBy: userPk,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };

    try {
      const eventPromise = subscriber.waitForEvent(
        { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostrGroupIdHex] },
        5000,
      );
      const dispatchedAt = Math.floor(Date.now() / 1000);
      const dispatchedEvent: TaskEvent = { type: "task.created", task: taskA };
      await dispatchTaskEvent(page, dispatchedEvent);
      const rawEvent = (await eventPromise).rawEvent() as PublishedEventShape;

      assertPublishedShape(rawEvent, group.nostrGroupIdHex, userPk, dispatchedAt);

      // AC-CREATED-2 / AC-DECODE-5: the serialized rumor content matches the
      // dispatched TaskEvent byte-for-byte (deep-equal, not string equality).
      const inspected = await inspectRumorContent(page, group.idStr, rawEvent.id);
      expect(inspected.decodedContent).toEqual(dispatchedEvent);

      // AC-DECODE-2 / AC-DECODE-3 (relaxed): the web's own published kind-445
      // event must not be "rejected" when re-ingested. In an idealized state
      // the result would be "skipped"/"self-echo" and a second re-ingest would
      // be the same, but `device-sync` subscribes to kind-445 on the same
      // relay and always wins the race — it consumes the `#sentEventIds`
      // marker via the live subscription before the test hook gets to it,
      // and any background MLS commit (auto-invite, key-package rotation)
      // that lands between dispatch and inspect advances the epoch so the
      // previously-own event can no longer be decrypted by `decryptGroupMessage`.
      // The "byte-for-byte decodedContent match" assertion above proves the
      // published bytes are correct; this relaxed check just guards against
      // the `rejected` failure mode.
      expect(inspected.ingestKind).not.toBe("rejected");
      expect(inspected.secondIngestKind).not.toBe("rejected");

      // AC-CREATED-4: creating two DISTINCT tasks in rapid succession produces
      // two distinct kind-445 events with different ids and different
      // ephemeral signers.
      const taskB = {
        ...taskA,
        id: crypto.randomUUID(),
        title: uniqueName("Task Created B"),
      };
      const taskC = {
        ...taskA,
        id: crypto.randomUUID(),
        title: uniqueName("Task Created C"),
      };
      const duplicatePromise = subscriber.waitForEvents(
        { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostrGroupIdHex] },
        2,
        5000,
      );
      await dispatchTaskEvent(page, { type: "task.created", task: taskB });
      await dispatchTaskEvent(page, { type: "task.created", task: taskC });
      const duplicates = (await duplicatePromise).map(
        (event) => event.rawEvent() as PublishedEventShape,
      );
      expect(new Set(duplicates.map((event) => event.id)).size).toBe(2);
      expect(new Set(duplicates.map((event) => event.pubkey)).size).toBe(2);
    } finally {
      await subscriber.close();
      const failures = await readPublishFailures(page);
      await detachPublishFailureRecorder(page);
      expect(failures).toHaveLength(0);
    }
  });

  test("task.updated publishes the changed fields", async ({ page }) => {
    await createGroup(page, uniqueName("Publish Updated"));
    const group = await currentGroup(page);
    const userPk = await page.evaluate(() => window.__notestrTestPubkey?.() ?? "");
    const taskId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await dispatchTaskEvent(page, {
      type: "task.created",
      task: {
        id: taskId,
        title: "Before update",
        description: "original",
        status: "open",
        assignee: null,
        createdBy: userPk,
        createdAt: now,
        updatedAt: now,
      },
    });

    await resetSentRumors(page, group.idStr);

    const subscriber = await openNdkSubscriber(group.relays);
    try {
      const eventPromise = subscriber.waitForEvent(
        { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostrGroupIdHex] },
        5000,
      );
      const updateEvent: TaskEvent = {
        type: "task.updated",
        taskId,
        changes: { title: "After update" },
        updatedAt: now + 1,
        updatedBy: userPk,
      };
      const dispatchedAt = Math.floor(Date.now() / 1000);
      await dispatchTaskEvent(page, updateEvent);
      const rawEvent = (await eventPromise).rawEvent() as PublishedEventShape;

      assertPublishedShape(rawEvent, group.nostrGroupIdHex, userPk, dispatchedAt);
      expect(updateEvent.changes).toEqual({ title: "After update" });
      expect("description" in updateEvent.changes).toBe(false);

      // AC-UPDATED-1 / AC-DECODE-5: round-trip decoded content matches.
      const inspected = await inspectRumorContent(page, group.idStr, rawEvent.id);
      expect(inspected.decodedContent).toEqual(updateEvent);
      // AC-UPDATED-2: absent keys must not appear in the serialized changes.
      if (inspected.decodedContent?.type === "task.updated") {
        expect("description" in inspected.decodedContent.changes).toBe(false);
      }
    } finally {
      await subscriber.close();
    }
  });

  test("task.status_changed round-trips every valid status value", async ({ page }) => {
    await createGroup(page, uniqueName("Publish Status"));
    const group = await currentGroup(page);
    const userPk = await page.evaluate(() => window.__notestrTestPubkey?.() ?? "");
    const taskId = crypto.randomUUID();
    const baseTime = Math.floor(Date.now() / 1000);

    await dispatchTaskEvent(page, {
      type: "task.created",
      task: {
        id: taskId,
        title: "Status task",
        description: "",
        status: "open",
        assignee: null,
        createdBy: userPk,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
    });

    const subscriber = await openNdkSubscriber(group.relays);
    try {
      const statuses = ["open", "in_progress", "done", "cancelled"] as const;
      for (const [index, status] of statuses.entries()) {
        await resetSentRumors(page, group.idStr);
        const eventPromise = subscriber.waitForEvent(
          { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostrGroupIdHex] },
          5000,
        );
        const dispatchedAt = Math.floor(Date.now() / 1000);
        const dispatchedEvent: TaskEvent = {
          type: "task.status_changed",
          taskId,
          status,
          updatedAt: baseTime + index + 1,
          updatedBy: userPk,
        };
        await dispatchTaskEvent(page, dispatchedEvent);
        const rawEvent = (await eventPromise).rawEvent() as PublishedEventShape;
        assertPublishedShape(rawEvent, group.nostrGroupIdHex, userPk, dispatchedAt);

        // AC-STATUS-1: decoded rumor content matches the dispatched event
        // byte-for-byte for every valid status value.
        const inspected = await inspectRumorContent(
          page,
          group.idStr,
          rawEvent.id,
        );
        expect(inspected.decodedContent).toEqual(dispatchedEvent);
      }

      const tasks = await currentTasks(page);
      expect(tasks.find((task: { id: string }) => task.id === taskId)?.status).toBe(
        "cancelled",
      );
    } finally {
      await subscriber.close();
    }
  });

  test("task.assigned publishes explicit assignee and null unassign", async ({ page }) => {
    await createGroup(page, uniqueName("Publish Assign"));
    const group = await currentGroup(page);
    const userPk = await page.evaluate(() => window.__notestrTestPubkey?.() ?? "");
    const taskId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const assignee = "f".repeat(64);

    await dispatchTaskEvent(page, {
      type: "task.created",
      task: {
        id: taskId,
        title: "Assign me",
        description: "",
        status: "open",
        assignee: null,
        createdBy: userPk,
        createdAt: now,
        updatedAt: now,
      },
    });

    const subscriber = await openNdkSubscriber(group.relays);
    try {
      await resetSentRumors(page, group.idStr);
      const assignPromise = subscriber.waitForEvent(
        { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostrGroupIdHex] },
        5000,
      );
      const assignEvent: TaskEvent = {
        type: "task.assigned",
        taskId,
        assignee,
        updatedAt: now + 1,
        updatedBy: userPk,
      };
      await dispatchTaskEvent(page, assignEvent);
      const assignedEvent = (await assignPromise).rawEvent() as PublishedEventShape;
      assertPublishedShape(
        assignedEvent,
        group.nostrGroupIdHex,
        userPk,
        Math.floor(Date.now() / 1000),
      );

      // AC-ASSIGN-1: the decoded rumor's assignee is the dispatched hex.
      const assignedInspected = await inspectRumorContent(
        page,
        group.idStr,
        assignedEvent.id,
      );
      expect(assignedInspected.decodedContent).toEqual(assignEvent);

      await resetSentRumors(page, group.idStr);
      const unassignPromise = subscriber.waitForEvent(
        { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostrGroupIdHex] },
        5000,
      );
      const unassignEvent: TaskEvent = {
        type: "task.assigned",
        taskId,
        assignee: null,
        updatedAt: now + 2,
        updatedBy: userPk,
      };
      await dispatchTaskEvent(page, unassignEvent);
      const unassignedEvent = (await unassignPromise).rawEvent() as PublishedEventShape;
      assertPublishedShape(
        unassignedEvent,
        group.nostrGroupIdHex,
        userPk,
        Math.floor(Date.now() / 1000),
      );

      // AC-ASSIGN-2: decoded rumor's assignee is explicitly `null`,
      // not omitted and not undefined.
      const unassignInspected = await inspectRumorContent(
        page,
        group.idStr,
        unassignedEvent.id,
      );
      expect(unassignInspected.decodedContent).toEqual(unassignEvent);
      if (unassignInspected.decodedContent?.type === "task.assigned") {
        expect(unassignInspected.decodedContent.assignee).toBeNull();
      }

      const tasks = await currentTasks(page);
      expect(tasks.find((task: { id: string }) => task.id === taskId)?.assignee).toBeNull();
    } finally {
      await subscriber.close();
    }
  });

  test("task.deleted removes the task locally and appends the delete event", async ({ page }) => {
    await createGroup(page, uniqueName("Publish Delete"));
    const group = await currentGroup(page);
    const userPk = await page.evaluate(() => window.__notestrTestPubkey?.() ?? "");
    const taskId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await dispatchTaskEvent(page, {
      type: "task.created",
      task: {
        id: taskId,
        title: "Delete me",
        description: "",
        status: "open",
        assignee: null,
        createdBy: userPk,
        createdAt: now,
        updatedAt: now,
      },
    });

    const subscriber = await openNdkSubscriber(group.relays);
    try {
      await resetSentRumors(page, group.idStr);
      const deletePromise = subscriber.waitForEvent(
        { kinds: [KIND_GROUP_MESSAGE], "#h": [group.nostrGroupIdHex] },
        5000,
      );
      const deleteEvent: TaskEvent = {
        type: "task.deleted",
        taskId,
        updatedAt: now + 1,
        updatedBy: userPk,
      };
      await dispatchTaskEvent(page, deleteEvent);
      const rawEvent = (await deletePromise).rawEvent() as PublishedEventShape;
      assertPublishedShape(
        rawEvent,
        group.nostrGroupIdHex,
        userPk,
        Math.floor(Date.now() / 1000),
      );

      // AC-DELETE-1: decoded rumor content matches the dispatched delete
      // event byte-for-byte.
      const inspected = await inspectRumorContent(page, group.idStr, rawEvent.id);
      expect(inspected.decodedContent).toEqual(deleteEvent);

      const tasks = await currentTasks(page);
      expect(tasks.some((task: { id: string }) => task.id === taskId)).toBe(false);

      const events = await persistedTaskEvents(page);
      expect(events.at(-1)).toEqual({
        type: "task.deleted",
        taskId,
        updatedAt: now + 1,
        updatedBy: userPk,
      });
    } finally {
      await subscriber.close();
    }
  });

  test("publish failure is surfaced, optimistic state is retained across reload, and later publishes recover", async ({
    page,
  }) => {
    await createGroup(page, uniqueName("Publish Failure"));
    const group = await currentGroup(page);
    const userPk = await page.evaluate(() => window.__notestrTestPubkey?.() ?? "");
    const taskId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await attachPublishFailureRecorder(page);

    await page.evaluate(() => {
      window.__notestrTestArmPublishFailure?.("forced publish failure");
    });

    const taskEvent: TaskEvent = {
      type: "task.created",
      task: {
        id: taskId,
        title: "Will stay local",
        description: "",
        status: "open",
        assignee: null,
        createdBy: userPk,
        createdAt: now,
        updatedAt: now,
      },
    };

    await dispatchTaskEvent(page, taskEvent);

    const failures = await readPublishFailures(page);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({
      groupId: group.idStr,
      taskEvent,
      error: "forced publish failure",
    });

    const tasks = await currentTasks(page);
    expect(tasks.some((task: { id: string }) => task.id === taskId)).toBe(true);

    const events = await persistedTaskEvents(page);
    expect(
      events.some((event) => event.type === "task.created" && event.task.id === taskId),
    ).toBe(true);

    await detachPublishFailureRecorder(page);

    // AC-FAIL-3: after reload + re-auth the task survives because it was
    // persisted to IndexedDB before the publish failed.
    await page.reload();
    await authenticateViaBunker(page);
    // Switch to the same group so the task store loads its events.
    await openMobileDrawer(page);
    await page.locator("aside").getByText(/Publish Failure/).first().click();
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({
      timeout: 10000,
    });
    const tasksAfterReload = await page.evaluate(
      () => window.__notestrTestTasks?.() ?? [],
    );
    expect(tasksAfterReload.some((task: { id: string }) => task.id === taskId)).toBe(true);

    // AC-FAIL-4: a subsequent dispatch on the same group publishes
    // successfully — previous failures must not poison the publish path.
    const regroup = await currentGroup(page);
    await resetSentRumors(page, regroup.idStr);
    await attachPublishFailureRecorder(page);
    const subscriber = await openNdkSubscriber(regroup.relays);
    try {
      const eventPromise = subscriber.waitForEvent(
        { kinds: [KIND_GROUP_MESSAGE], "#h": [regroup.nostrGroupIdHex] },
        5000,
      );
      const recoveryEvent: TaskEvent = {
        type: "task.created",
        task: {
          id: crypto.randomUUID(),
          title: uniqueName("Recovery"),
          description: "after failure",
          status: "open",
          assignee: null,
          createdBy: userPk,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        },
      };
      await dispatchTaskEvent(page, recoveryEvent);
      const rawEvent = (await eventPromise).rawEvent() as PublishedEventShape;
      assertPublishedShape(
        rawEvent,
        regroup.nostrGroupIdHex,
        userPk,
        Math.floor(Date.now() / 1000),
      );
      const inspected = await inspectRumorContent(
        page,
        regroup.idStr,
        rawEvent.id,
      );
      expect(inspected.decodedContent).toEqual(recoveryEvent);
    } finally {
      await subscriber.close();
      const recoveryFailures = await readPublishFailures(page);
      await detachPublishFailureRecorder(page);
      expect(recoveryFailures).toHaveLength(0);
    }
  });
});
