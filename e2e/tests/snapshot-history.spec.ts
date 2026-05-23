/**
 * E2E tests: MLS epoch boundary — pre-join task mutations are not visible
 * to a newly invited member.
 *
 * Covers permutations TP-31 and TP-32 from
 * `docs/two-party-permutation-matrix.md` under the post-snapshot-removal
 * protocol (v2). The NIP-44 side-channel snapshot mechanism has been
 * deliberately removed because it caused CRDT divergence (fan-out of empty
 * snapshots wiping task state on all devices).
 *
 * Under the new protocol:
 * - All task events flow as kind-445 MLS application messages only.
 * - A new member joining at epoch N cannot decrypt application messages
 *   from epochs < N (MLS forward secrecy).
 * - Tasks created and mutated before the invite are in epoch 0; the joiner
 *   holds keys only from their join epoch onward.
 * - Result: the joiner's initial board is empty for pre-join tasks.
 *
 * These tests verify that the epoch boundary behaves as documented rather
 * than accidentally leaking pre-join state through a side channel.
 *
 * Pre-join task visibility is an accepted trade-off documented in
 * docs/task-protocol.md § State Bootstrap.
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
test.describe.serial("TP-31: epoch boundary — pre-join mutations invisible", () => {
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

  test("A invites B → B sees empty board (pre-join epoch unreadable)", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await inviteByNpub(pageA, USER_B_NPUB);
    await settle(pageA, 2000);

    await reload(pageB);
    await selectGroup(pageB, GROUP_NAME);

    // B cannot decrypt epoch-0 messages (MLS forward secrecy). The task board
    // loads but is empty — pre-join task state is permanently unrecoverable.
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 30000 });
    await expect(pageB.getByText(TASK_TITLE)).toHaveCount(0, { timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// TP-32: A creates+keeps and creates+deletes before inviting → B sees neither.
// ---------------------------------------------------------------------------
test.describe.serial("TP-32: epoch boundary — board empty for all pre-join tasks", () => {
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

  test("A invites B → B sees neither task (both pre-join epoch)", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await inviteByNpub(pageA, USER_B_NPUB);
    await settle(pageA, 2000);

    await reload(pageB);
    await selectGroup(pageB, GROUP_NAME);

    // B cannot decrypt epoch-0 messages. The board loads but is empty for all
    // pre-join tasks — including the "kept" one. CRDT delete semantics are moot
    // because neither event is decryptable by B.
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 30000 });
    await expect(pageB.getByText(KEEP_TITLE)).toHaveCount(0, { timeout: 5000 });
    await expect(pageB.getByText(DELETED_TITLE)).toHaveCount(0, { timeout: 5000 });
  });
});
