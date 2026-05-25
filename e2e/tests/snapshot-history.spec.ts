/**
 * E2E tests: new member task state bootstrap via kind-30078 NIP-44 encrypted event.
 *
 * After a successful invite, the inviter (A) calls publishTaskStateSync which
 * publishes a kind-30078 NIP-44 encrypted event containing the current task state
 * to B's Nostr pubkey. On B's first load after joining via a welcome message,
 * the task store calls fetchAndApplyTaskBootstrap which fetches that event and
 * merges it into the local CRDT — so B sees pre-join tasks within seconds of
 * the board loading.
 *
 * Covers permutations TP-30, TP-31, TP-32 from `docs/two-party-permutation-matrix.md`.
 *
 * The earlier epoch-boundary model (MLS forward secrecy blocks pre-join epochs)
 * was superseded by the kind-30078 bootstrap: A publishes a snapshot of current
 * task state encrypted to B's pubkey, so B has everything A had at the moment
 * of invite, regardless of which MLS epoch the tasks were created in.
 *
 * Verified by: docs/task-protocol.md § New Member Task State Sync (kind 30078).
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
// TP-31: A creates a task, mutates it, THEN invites B → B sees empty board.
// ---------------------------------------------------------------------------
test.describe.serial("TP-31: B sees all pre-join mutations via kind-30078 bootstrap", () => {
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
        updatedBy: pubkeyA,
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

  test("A invites B → B sees all pre-join mutations via kind-30078 bootstrap", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await inviteByNpub(pageA, USER_B_NPUB);
    await settle(pageA, 2000);

    await reload(pageB);
    await selectGroup(pageB, GROUP_NAME);

    // B sees pre-join task state via kind-30078 bootstrap. The task was created,
    // moved to in_progress, and self-assigned — all before the invite.
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 30000 });
    // Use the In Progress column to avoid matching sidebar group name.
    const inProgressColumn = pageB.locator('[data-column="in_progress"]').last();
    await expect(inProgressColumn.getByRole('heading', { name: TASK_TITLE, level: 4 })).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// TP-32: A creates+keeps and creates+deletes before inviting → B sees neither.
// ---------------------------------------------------------------------------
test.describe.serial("TP-32: B sees all pre-join tasks via kind-30078 bootstrap", () => {
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
        updatedBy: pubkeyA,
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
        updatedBy: pubkeyA,
      },
    });
    await dispatchTaskEvent(pageA, {
      type: "task.deleted",
      taskId: tDel,
      updatedAt: now + 1,
      updatedBy: pubkeyA,
    });
  });

  test("A invites B → B sees only the surviving task via kind-30078 bootstrap", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await inviteByNpub(pageA, USER_B_NPUB);
    await settle(pageA, 2000);

    await reload(pageB);
    await selectGroup(pageB, GROUP_NAME);

    // B sees the task state via kind-30078 bootstrap. The deleted task (tDel) is gone;
    // the kept task (tKeep) is present with status:open.
    // Use a board-scoped heading locator to avoid matching the sidebar group name
    // (which can contain the same text as a task card heading).
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 30000 });
    const openColumn = pageB.locator('[data-column="open"]').last();
    await expect(openColumn.getByRole('heading', { name: KEEP_TITLE, level: 4 })).toBeVisible({ timeout: 5000 });
    await expect(openColumn.locator('[data-testid="task-card"]')).toHaveCount(1, { timeout: 5000 });
  });
});
