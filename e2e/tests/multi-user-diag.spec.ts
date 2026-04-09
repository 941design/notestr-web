/**
 * Diagnostic spec for MLS post-join live-delivery.
 *
 * NOT part of the regular e2e suite — gated by `DIAG=1`. Runs the same
 * setup as multi-user.spec.ts (auth → group → invite → task) and then
 * reports the authoritative signals for "did User B actually receive
 * User A's post-join task?":
 *
 *   - A and B epochs (via __notestrTestInspectGroupEvent's currentEpoch)
 *   - relay count of kind-445 events for the group
 *   - B persisted task events (IndexedDB)
 *   - B in-memory task state
 *   - B history entries (test-only TestGroupHistory from ts-mls)
 *
 * Kept around as a "break glass in case of regression" tool. To run:
 *
 *   DIAG=1 npx playwright test --project=chromium \
 *     e2e/tests/multi-user-diag.spec.ts
 *
 * Note on __notestrTestInspectGroupEvent: calling `group.ingest([event])`
 * twice on an already-successfully-processed application message yields
 * `unreadable` both times, because the per-sender ratchet generation was
 * consumed on first ingest and ts-mls drops the key (forward secrecy).
 * This means the hook is a false-negative signal for "was this
 * delivered?". Use __notestrTestSentRumors / __notestrTestPersistedTaskEvents
 * as authoritative signals instead.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import { clearAppState } from "../fixtures/cleanup.js";

const RELAY_URL = "ws://localhost:7777";
const DIAG = process.env.DIAG === "1";

async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto("/");
  await clearAppState(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder("bunker://...").fill(bunkerUrl);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: "visible", timeout: 30000 });
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.beforeAll(async ({ browser }, workerInfo) => {
  if (!DIAG) return;
  if (workerInfo.project.use.isMobile) return;
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
});

test.describe.serial("multi-user live-delivery diagnostic", () => {
  test.setTimeout(180_000);

  const GROUP_NAME = `Diag ${Date.now()}`;

  test("run triangulation", async ({}, workerInfo) => {
    test.skip(!DIAG, "Diagnostic — set DIAG=1 to run");
    test.skip(
      !!workerInfo.project.use.isMobile,
      "Multi-context MLS tests require desktop viewport",
    );

    const readEpoch = async (page: Page, label: string) => {
      const result = await page.evaluate(async () => {
        const groups = window.__notestrTestGroups?.() ?? [];
        if (groups.length === 0) return { count: 0, epoch: null };
        const first = groups[0];
        const inspected = await window.__notestrTestInspectGroupEvent?.(
          first.idStr,
          "0".repeat(64),
        );
        return { count: groups.length, epoch: inspected?.currentEpoch ?? null };
      });
      console.log(`[diag-epoch] ${label}: count=${result.count}, epoch=${result.epoch}`);
      return result;
    };

    // Auth both users
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await pageB.waitForTimeout(3000);
    await authenticate(pageA, E2E_BUNKER_URL);

    // A creates group and invites B
    await pageA.getByPlaceholder("Group name").first().fill(GROUP_NAME);
    await pageA.getByRole("button", { name: "Create", exact: true }).first().click();
    const sidebarA = pageA.locator("aside");
    await expect(sidebarA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });
    await readEpoch(pageA, "A after createGroup");

    await pageA.getByPlaceholder("npub1...").fill(USER_B_NPUB);
    await pageA.getByRole("button", { name: "Invite" }).click();
    await expect(pageA.getByPlaceholder("npub1...")).toHaveValue("", { timeout: 30000 });
    await readEpoch(pageA, "A after invite B");

    // Background settles
    await pageA.waitForTimeout(2000);
    await readEpoch(pageA, "A after 2s settle");

    // B reloads & selects the group
    await pageB.reload();
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: "visible", timeout: 30000 });
    const sidebarB = pageB.locator("aside");
    await expect(sidebarB.getByText(GROUP_NAME)).toBeVisible({ timeout: 60000 });
    await sidebarB.getByText(GROUP_NAME).click();
    await expect(pageB.getByRole("heading", { name: "Tasks" })).toBeVisible({ timeout: 10000 });
    await readEpoch(pageB, "B after select group");
    await readEpoch(pageA, "A at B-ready");

    // A creates a task
    const TASK_TITLE = `Diag task ${Date.now()}`;
    await pageA.getByRole("button", { name: "Add Task" }).click();
    await pageA.getByLabel("Title").fill(TASK_TITLE);
    await pageA.getByRole("button", { name: "Create", exact: true }).last().click();
    const openColumnA = pageA.locator('[data-column="open"]').first();
    await expect(openColumnA).toContainText(TASK_TITLE, { timeout: 15000 });
    await readEpoch(pageA, "A after dispatch task");

    // Give B a moment to ingest
    await pageB.waitForTimeout(3000);
    await readEpoch(pageB, "B after 3s settle");

    // Authoritative signals on B
    const sentRumorsB = await pageB.evaluate(
      () => window.__notestrTestSentRumors?.("") ?? [],
    );
    const persistedB = await pageB.evaluate(
      async () => (await window.__notestrTestPersistedTaskEvents?.()) ?? [],
    );
    const tasksB = await pageB.evaluate(
      () => window.__notestrTestTasks?.() ?? [],
    );
    console.log(
      "[diag] B authoritative signals:",
      "history=", sentRumorsB.length,
      "persisted=", persistedB.length,
      "in-memory=", tasksB.length,
    );

    // Pass unconditionally — this test LOGS, it doesn't assert.
    expect(true).toBe(true);
  });
});
