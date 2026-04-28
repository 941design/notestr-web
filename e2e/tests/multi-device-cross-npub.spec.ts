/**
 * E2E tests: multi-device for one party + distinct-npub second party.
 *
 * Covers permutations TP-80, TP-81, TP-82 from
 * `docs/two-party-permutation-matrix.md`.
 *
 * Topology:
 *  - A1, A2 — two browser contexts, same npub (User A's bunker)
 *  - B     — one browser context, distinct npub (User B's bunker)
 *
 * The auto-invite logic in `device-sync.ts` invites sibling devices of the
 * creator's own pubkey, so A2 should join automatically once A1 publishes a
 * second key package by authenticating in its context. B is invited by the
 * normal `inviteByNpub` flow.
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
  selectGroup,
  settle,
} from "../fixtures/two-party.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const TIMEOUT = 240_000;

let contextA1: BrowserContext;
let contextA2: BrowserContext;
let contextB: BrowserContext;
let pageA1: Page;
let pageA2: Page;
let pageB: Page;
let skipMobile = false;

const GROUP_NAME = `MdCrossNpub ${Date.now()}`;

test.beforeAll(async ({ browser }, workerInfo) => {
  skipMobile = !!workerInfo.project.use.isMobile;
  if (skipMobile) return;
  contextA1 = await browser.newContext();
  contextA2 = await browser.newContext();
  contextB = await browser.newContext();
  pageA1 = await contextA1.newPage();
  pageA2 = await contextA2.newPage();
  pageB = await contextB.newPage();
});

test.afterAll(async () => {
  await contextA1?.close();
  await contextA2?.close();
  await contextB?.close();
});

test.describe.serial("TP-80: A1+A2 (same npub) + B (distinct) all in one group", () => {
  test.setTimeout(TIMEOUT);

  test("auth all three contexts", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // B first so its key package is on the relay before A invites.
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await settle(pageB, 3000);
    // A1 second so it's the "creator" device. A2 third so it joins via
    // auto-invite from A1's MarmotProvider.
    await authenticate(pageA1, E2E_BUNKER_URL);
    await settle(pageA1, 3000);
    await authenticate(pageA2, E2E_BUNKER_URL);
    await settle(pageA2, 3000);
  });

  test("A1 creates group, invites B → A2 auto-joins, B joins", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await createGroup(pageA1, GROUP_NAME);
    await inviteByNpub(pageA1, USER_B_NPUB);

    // A2 should pick up the group via auto-invite (same npub as creator).
    await selectGroup(pageA2, GROUP_NAME);
    // B should pick up the group via Welcome.
    await selectGroup(pageB, GROUP_NAME);
  });
});

// ---------------------------------------------------------------------------
// TP-81: A1's task lands on both A2 and B
// ---------------------------------------------------------------------------
test.describe("TP-81: A1's task lands on A2 and B", () => {
  test.setTimeout(TIMEOUT);

  test("a task A1 dispatches is visible to both A2 and B", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const pubkeyA = await getPubkeyHex(pageA1);
    const t = crypto.randomUUID();
    const title = `From A1 ${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    await dispatchTaskEvent(pageA1, {
      type: "task.created",
      task: {
        id: t,
        title,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(pageA2.locator('[data-column="open"]').first()).toContainText(title, {
      timeout: 30000,
    });
    await expect(pageB.locator('[data-column="open"]').first()).toContainText(title, {
      timeout: 30000,
    });
  });
});

// ---------------------------------------------------------------------------
// TP-82: B status-changes the task → both A1 and A2 observe
// ---------------------------------------------------------------------------
test.describe("TP-82: B's status change reaches A1 and A2", () => {
  test.setTimeout(TIMEOUT);

  test("a status change by B propagates to both A devices", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const pubkeyA = await getPubkeyHex(pageA1);
    const pubkeyB = await getPubkeyHex(pageB);

    const t = crypto.randomUUID();
    const title = `For-B-move ${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    await dispatchTaskEvent(pageA1, {
      type: "task.created",
      task: {
        id: t,
        title,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });
    await expect(pageB.locator('[data-column="open"]')).toContainText(title, {
      timeout: 30000,
    });

    await dispatchTaskEvent(pageB, {
      type: "task.status_changed",
      taskId: t,
      status: "in_progress",
      updatedAt: now + 1,
      updatedBy: pubkeyB,
    });

    await expect(pageA1.locator('[data-column="in_progress"]')).toContainText(title, {
      timeout: 30000,
    });
    await expect(pageA2.locator('[data-column="in_progress"]')).toContainText(title, {
      timeout: 30000,
    });
  });
});
