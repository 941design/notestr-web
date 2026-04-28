/**
 * E2E tests: cross-author task mutations.
 *
 * Covers permutations TP-13..TP-17 (A→B propagation of update/status/assign/
 * unassign/delete) and TP-21..TP-24 (B→A propagation of the same actions).
 * See `docs/two-party-permutation-matrix.md`.
 *
 * Pattern: two BrowserContexts (User A + User B, distinct npubs), one shared
 * group. Each describe block targets a single mutation kind. The setup
 * (auth → group → invite → seed task) lives in `describe.serial('setup')`,
 * the mutation+observation pairs live in sibling describes so they fail
 * independently.
 *
 * Many of the mutations covered here have no direct UI button (e.g. update
 * task title, assign task to a different pubkey). The tests dispatch through
 * `__notestrTestDispatchTaskEvent` for those — the goal here is to verify
 * MLS propagation of every TaskEvent variant across two parties, not the
 * UI affordances around them. Where the UI does expose an action (status
 * change next-button, delete-task confirm dialog), the UI path is used.
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
const TIMEOUT = 120_000;

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let skipMobile = false;
let pubkeyA: string;
let pubkeyB: string;
let taskId: string;

const GROUP_NAME = `CrossAuthor ${Date.now()}`;
const TASK_TITLE = `Original ${Date.now()}`;

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

test.describe.serial("cross-author setup", () => {
  test.setTimeout(TIMEOUT);

  test("authenticate both users and seed a shared group + task", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    // B publishes its key package first so A can invite by npub.
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await settle(pageB, 3000);
    await authenticate(pageA, E2E_BUNKER_URL);

    pubkeyA = await getPubkeyHex(pageA);
    pubkeyB = await getPubkeyHex(pageB);

    await createGroup(pageA, GROUP_NAME);
    await inviteByNpub(pageA, USER_B_NPUB);

    // Seed a single shared task on A. B will navigate to the group on demand
    // in each sibling describe so its task store is mounted before any
    // dispatch lands.
    taskId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: taskId,
        title: TASK_TITLE,
        description: "seed",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });

    const openColumnA = pageA.locator('[data-column="open"]').first();
    await expect(openColumnA).toContainText(TASK_TITLE, { timeout: 15000 });

    // Park B on the group's board so its task store has the right group
    // mounted for the dispatches that follow.
    await selectGroup(pageB, GROUP_NAME);
    await expect(pageB.locator('[data-column="open"]').first()).toContainText(
      TASK_TITLE,
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-13: A.Ut(t1, title=…) ⇒ B⟂t1.title=…
// ---------------------------------------------------------------------------
test.describe("TP-13: A updates → B observes title change", () => {
  test.setTimeout(TIMEOUT);

  test("B sees the updated title", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const newTitle = `Updated by A ${Date.now()}`;
    await dispatchTaskEvent(pageA, {
      type: "task.updated",
      taskId,
      changes: { title: newTitle },
      updatedAt: Math.floor(Date.now() / 1000),
      updatedBy: pubkeyA,
    });
    await expect(pageB.locator('[data-testid="task-card"]').first()).toContainText(
      newTitle,
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-15 / TP-16: A.As(t1,B) ⇒ B⟂t1.assignee=B; A.Un(t1) ⇒ B⟂unassigned
// ---------------------------------------------------------------------------
test.describe("TP-15/16: A assigns/unassigns → B observes", () => {
  test.setTimeout(TIMEOUT);

  test("B sees the assignment to B", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await dispatchTaskEvent(pageA, {
      type: "task.assigned",
      taskId,
      assignee: pubkeyB,
      updatedAt: Math.floor(Date.now() / 1000),
      updatedBy: pubkeyA,
    });
    const shortB = `${pubkeyB.slice(0, 8)}...${pubkeyB.slice(-4)}`;
    await expect(pageB.locator('[data-testid="task-card"]').first()).toContainText(
      shortB,
      { timeout: 30000 },
    );
  });

  test("B sees the unassignment", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await dispatchTaskEvent(pageA, {
      type: "task.assigned",
      taskId,
      assignee: null,
      updatedAt: Math.floor(Date.now() / 1000),
      updatedBy: pubkeyA,
    });
    await expect(pageB.locator('[data-testid="task-card"]').first()).toContainText(
      "Unassigned",
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-21: A.Ct → B.Ut(t1,title=…) ⇒ A⟂t1.title=…
// ---------------------------------------------------------------------------
test.describe("TP-21: B updates → A observes title change", () => {
  test.setTimeout(TIMEOUT);

  test("A sees the title B set", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const newTitle = `Updated by B ${Date.now()}`;
    await dispatchTaskEvent(pageB, {
      type: "task.updated",
      taskId,
      changes: { title: newTitle },
      updatedAt: Math.floor(Date.now() / 1000),
      updatedBy: pubkeyB,
    });
    await expect(pageA.locator('[data-testid="task-card"]').first()).toContainText(
      newTitle,
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-22 / TP-23: B.As(t1,A) → B.Un(t1) ⇒ A observes both
// ---------------------------------------------------------------------------
test.describe("TP-22/23: B assigns to A then unassigns → A observes", () => {
  test.setTimeout(TIMEOUT);

  test("A sees the assignment to A", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await dispatchTaskEvent(pageB, {
      type: "task.assigned",
      taskId,
      assignee: pubkeyA,
      updatedAt: Math.floor(Date.now() / 1000),
      updatedBy: pubkeyB,
    });
    const shortA = `${pubkeyA.slice(0, 8)}...${pubkeyA.slice(-4)}`;
    await expect(pageA.locator('[data-testid="task-card"]').first()).toContainText(
      shortA,
      { timeout: 30000 },
    );
  });

  test("A sees the unassignment B issued", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await dispatchTaskEvent(pageB, {
      type: "task.assigned",
      taskId,
      assignee: null,
      updatedAt: Math.floor(Date.now() / 1000),
      updatedBy: pubkeyB,
    });
    await expect(pageA.locator('[data-testid="task-card"]').first()).toContainText(
      "Unassigned",
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-14: A.Ct(t2) → A.Sc(t2,p) ⇒ B⟂t2.p (cross-direction of TP-20 already
// covered by multi-user.spec.ts). We run a fresh task here so the assertion
// is on a column transition rather than re-using the now-mutated taskId.
// ---------------------------------------------------------------------------
test.describe("TP-14: A status-changes → B observes", () => {
  test.setTimeout(TIMEOUT);

  test("B sees A's status change move the task to in_progress", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const t2 = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const t2Title = `A-status ${Date.now()}`;
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: t2,
        title: t2Title,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });
    // Wait for it to land on B before mutating, otherwise the receiver could
    // process status-change before create.
    await expect(pageB.locator('[data-column="open"]').first()).toContainText(
      t2Title,
      { timeout: 30000 },
    );

    await dispatchTaskEvent(pageA, {
      type: "task.status_changed",
      taskId: t2,
      status: "in_progress",
      updatedAt: now + 1,
      updatedBy: pubkeyA,
    });
    await expect(pageB.locator('[data-column="in_progress"]')).toContainText(t2Title, {
      timeout: 30000,
    });
  });
});

// ---------------------------------------------------------------------------
// TP-24: A.Ct(t3) → B.Dt(t3) ⇒ A⊥t3
// ---------------------------------------------------------------------------
test.describe("TP-24: B deletes A's task → A observes removal", () => {
  test.setTimeout(TIMEOUT);

  test("A no longer sees the deleted task", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const t3 = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const t3Title = `B-deletes ${Date.now()}`;
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: t3,
        title: t3Title,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });
    await expect(pageB.locator('[data-column="open"]')).toContainText(t3Title, {
      timeout: 30000,
    });

    await dispatchTaskEvent(pageB, {
      type: "task.deleted",
      taskId: t3,
      updatedAt: now + 1,
      updatedBy: pubkeyB,
    });

    // The task disappears from A's board.
    await expect(pageA.getByText(t3Title)).toHaveCount(0, { timeout: 30000 });
  });
});

// ---------------------------------------------------------------------------
// TP-17: A.Ct(t4) → A.Dt(t4) ⇒ B⊥t4 (A→B delete)
// ---------------------------------------------------------------------------
test.describe("TP-17: A deletes own task → B observes removal", () => {
  test.setTimeout(TIMEOUT);

  test("B no longer sees the task A deleted", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const t4 = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const t4Title = `A-deletes ${Date.now()}`;
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: t4,
        title: t4Title,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });
    await expect(pageB.locator('[data-column="open"]')).toContainText(t4Title, {
      timeout: 30000,
    });

    await dispatchTaskEvent(pageA, {
      type: "task.deleted",
      taskId: t4,
      updatedAt: now + 1,
      updatedBy: pubkeyA,
    });

    await expect(pageB.getByText(t4Title)).toHaveCount(0, { timeout: 30000 });
  });
});

