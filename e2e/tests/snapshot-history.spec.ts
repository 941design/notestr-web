/**
 * E2E tests: NIP-44 task-snapshot at invite time captures merged history.
 *
 * Covers permutations TP-31 and TP-32 from
 * `docs/two-party-permutation-matrix.md`. The existing
 * `task-sync.spec.ts` already covers TP-30 (`task.created` survives the
 * snapshot path); these tests pin that the snapshot reflects all event
 * variants, not just creates.
 *
 * The snapshot publisher (`publishTaskSnapshot` in `marmot/device-sync.ts`)
 * runs `replayEvents` over the inviter's persisted task event log and ships
 * the merged `Task[]` as a `task.snapshot`. That means status/assign/update/
 * delete should all be reflected in the joiner's first view of the board.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import {
  authenticate,
  createGroup,
  dispatchTaskEvent,
  getPubkeyHex,
  inviteByNpub,
  reload,
  selectGroup,
  settle,
} from "../fixtures/two-party.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const TIMEOUT = 180_000;

// ---------------------------------------------------------------------------
// TP-31: A creates a task, mutates it, THEN invites B → B sees merged state.
// ---------------------------------------------------------------------------
test.describe.serial("TP-31: snapshot reflects status + assign", () => {
  test.setTimeout(TIMEOUT);

  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let skipMobile = false;
  const GROUP_NAME = `Snap31 ${Date.now()}`;
  const TASK_TITLE = `Snap31 task ${Date.now()}`;

  test.beforeAll(async ({ browser }, workerInfo) => {
    skipMobile = !!workerInfo.project.use.isMobile;
    if (skipMobile) return;
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test("seed task → status → assign, all on A before invite", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await settle(pageB, 3000);
    await authenticate(pageA, E2E_BUNKER_URL);

    const pubkeyA = await getPubkeyHex(pageA);

    await createGroup(pageA, GROUP_NAME);

    const t = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: t,
        title: TASK_TITLE,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });
    await dispatchTaskEvent(pageA, {
      type: "task.status_changed",
      taskId: t,
      status: "in_progress",
      updatedAt: now + 1,
      updatedBy: pubkeyA,
    });
    await dispatchTaskEvent(pageA, {
      type: "task.assigned",
      taskId: t,
      assignee: pubkeyA,
      updatedAt: now + 2,
      updatedBy: pubkeyA,
    });

    await expect(pageA.locator('[data-column="in_progress"]')).toContainText(
      TASK_TITLE,
      { timeout: 15000 },
    );
  });

  test("A invites B → B sees task in in_progress with assignee=A", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await inviteByNpub(pageA, USER_B_NPUB);
    // Give the snapshot a moment to publish.
    await settle(pageA, 2000);

    await reload(pageB);
    await selectGroup(pageB, GROUP_NAME);

    // Status preserved: task is in the in_progress column.
    await expect(pageB.locator('[data-column="in_progress"]')).toContainText(
      TASK_TITLE,
      { timeout: 30000 },
    );

    // Assignee preserved: the card shows A's shortened pubkey.
    const pubkeyA = await getPubkeyHex(pageA);
    const shortA = `${pubkeyA.slice(0, 8)}...${pubkeyA.slice(-4)}`;
    await expect(pageB.locator('[data-testid="task-card"]').first()).toContainText(
      shortA,
      { timeout: 15000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-32: A creates AND deletes a task before inviting → B never sees it.
// ---------------------------------------------------------------------------
test.describe.serial("TP-32: snapshot honours deletes", () => {
  test.setTimeout(TIMEOUT);

  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let skipMobile = false;
  const GROUP_NAME = `Snap32 ${Date.now()}`;
  const KEEP_TITLE = `Snap32 keep ${Date.now()}`;
  const DELETED_TITLE = `Snap32 deleted ${Date.now()}`;

  test.beforeAll(async ({ browser }, workerInfo) => {
    skipMobile = !!workerInfo.project.use.isMobile;
    if (skipMobile) return;
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test("seed: create+delete one task, create+keep another", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await settle(pageB, 3000);
    await authenticate(pageA, E2E_BUNKER_URL);

    const pubkeyA = await getPubkeyHex(pageA);

    await createGroup(pageA, GROUP_NAME);

    const tDel = crypto.randomUUID();
    const tKeep = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: tDel,
        title: DELETED_TITLE,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: tKeep,
        title: KEEP_TITLE,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });
    await dispatchTaskEvent(pageA, {
      type: "task.deleted",
      taskId: tDel,
      updatedAt: now + 1,
      updatedBy: pubkeyA,
    });
  });

  test("A invites B → B sees the kept task but not the deleted one", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await inviteByNpub(pageA, USER_B_NPUB);
    await settle(pageA, 2000);

    await reload(pageB);
    await selectGroup(pageB, GROUP_NAME);

    await expect(pageB.locator('[data-column="open"]').first()).toContainText(
      KEEP_TITLE,
      { timeout: 30000 },
    );
    await expect(pageB.getByText(DELETED_TITLE)).toHaveCount(0, { timeout: 5000 });
  });
});
