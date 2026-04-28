/**
 * E2E tests: concurrent edits to the same task.
 *
 * Covers permutations TP-90 and TP-91 from
 * `docs/two-party-permutation-matrix.md`.
 *
 * Merge semantics:
 *
 *  `task-reducer.applyEvent` is last-writer-wins on `updatedAt`. The
 *  conditional `event.updatedAt >= existing.updatedAt` makes the higher
 *  `updatedAt` win order-independently; on a *tie*, the later-applied
 *  event wins (so the outcome depends on per-page ingestion order).
 *
 * The deterministic-LWW assertion below uses a 1-second updatedAt
 * separation so both pages converge to the same winner regardless of
 * arrival order. The truly-concurrent (same `updatedAt`) case is left as a
 * `fixme` documenting the known nondeterminism — it surfaces a real
 * product question (CRDT? per-field LWW with deterministic tiebreaker?)
 * that's not yet decided.
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
const TIMEOUT = 180_000;

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let skipMobile = false;
let pubkeyA: string;
let pubkeyB: string;
let taskId: string;

const GROUP_NAME = `Concurrent ${Date.now()}`;
const TASK_TITLE = `Concurrent task ${Date.now()}`;

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

test.describe.serial("concurrent-edits setup", () => {
  test.setTimeout(TIMEOUT);

  test("auth, group, invite, seed task", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await settle(pageB, 3000);
    await authenticate(pageA, E2E_BUNKER_URL);

    pubkeyA = await getPubkeyHex(pageA);
    pubkeyB = await getPubkeyHex(pageB);

    await createGroup(pageA, GROUP_NAME);
    await inviteByNpub(pageA, USER_B_NPUB);

    taskId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: taskId,
        title: TASK_TITLE,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });

    await selectGroup(pageB, GROUP_NAME);
    await expect(pageB.locator('[data-column="open"]').first()).toContainText(
      TASK_TITLE,
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-90 (deterministic LWW): A and B both update title; B's update has the
// later updatedAt. Both pages must converge to B's title.
// ---------------------------------------------------------------------------
test.describe("TP-90: title race with deterministic LWW (B wins by 1s)", () => {
  test.setTimeout(TIMEOUT);

  test("both pages converge to the later-updatedAt title", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    const tA = `A-wins-${Date.now()}`;
    const tB = `B-wins-${Date.now() + 1}`;
    const baseAt = Math.floor(Date.now() / 1000);

    // Issue both updates in the same wall-clock instant (no awaiting between
    // them). updatedAt values differ by 1, so the merge is deterministic.
    await Promise.all([
      dispatchTaskEvent(pageA, {
        type: "task.updated",
        taskId,
        changes: { title: tA },
        updatedAt: baseAt + 1,
        updatedBy: pubkeyA,
      }),
      dispatchTaskEvent(pageB, {
        type: "task.updated",
        taskId,
        changes: { title: tB },
        updatedAt: baseAt + 2,
        updatedBy: pubkeyB,
      }),
    ]);

    // Both pages eventually settle on B's title (later updatedAt).
    await expect(pageA.locator('[data-testid="task-card"]').first()).toContainText(
      tB,
      { timeout: 30000 },
    );
    await expect(pageB.locator('[data-testid="task-card"]').first()).toContainText(
      tB,
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-91 (deterministic LWW on status): same shape, different field.
// ---------------------------------------------------------------------------
test.describe("TP-91: status race with deterministic LWW (B wins by 1s)", () => {
  test.setTimeout(TIMEOUT);

  test("both pages converge to the later-updatedAt status", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    const baseAt = Math.floor(Date.now() / 1000);

    await Promise.all([
      dispatchTaskEvent(pageA, {
        type: "task.status_changed",
        taskId,
        status: "in_progress",
        updatedAt: baseAt + 10,
        updatedBy: pubkeyA,
      }),
      dispatchTaskEvent(pageB, {
        type: "task.status_changed",
        taskId,
        status: "done",
        updatedAt: baseAt + 11,
        updatedBy: pubkeyB,
      }),
    ]);

    await expect(pageA.locator('[data-column="done"]').first()).toContainText(
      TASK_TITLE,
      { timeout: 30000 },
    );
    await expect(pageB.locator('[data-column="done"]').first()).toContainText(
      TASK_TITLE,
      { timeout: 30000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-90/-91 nondeterministic-tie variant: same updatedAt → outcome depends on
// per-page event-arrival order, which is not guaranteed equal across pages.
// Until the merge has a deterministic tiebreaker, this is left as fixme.
// ---------------------------------------------------------------------------
test.describe("concurrent ties: same updatedAt", () => {
  test.setTimeout(TIMEOUT);

  test.fixme(
    "ties on updatedAt resolve identically on both pages",
    async () => {
      // The reducer uses `>=` so ties take the later-applied event on each
      // page. Without a deterministic tiebreaker (e.g. lexicographic on the
      // dispatcher pubkey, or a CRDT), the per-page convergence is not
      // guaranteed. This test is intentionally left red until the product
      // makes a call on the tie semantics.
    },
  );
});
