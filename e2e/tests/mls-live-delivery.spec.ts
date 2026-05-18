/**
 * S7 F2 regression test — deterministic commit+app-message race (AC-REG-1).
 *
 * Sequence: pageA2 publishes a sibling KP → pageA creates group + invites B →
 * B joins → pageA arms auto-invite (epoch-2 Welcome commit) → pageA dispatches
 * task → commit + app-message race on B's subscription → assert within 5 s.
 *
 * AC-REG-5 procedure (not committed): revert Solution B drain block, run 3×,
 * confirm all fail, re-apply. Documented in report.md.
 */

import { type BrowserContext, type Page } from "@playwright/test";

import { test, expect } from "@playwright/test";
import { E2E_BUNKER_URL, E2E_BUNKER_PUBKEY_HEX } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import { clearAppState } from "../fixtures/cleanup.js";
import { quiesceFor } from "../fixtures/two-party.js";

const RELAY_URL = "ws://localhost:7777";

let contextA: BrowserContext;
let contextA2: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageA2: Page;
let pageB: Page;

const GROUP_NAME = `F2-Regression ${Date.now()}`;
const TASK_TITLE = `F2-task ${Date.now()}`;

async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto("/");
  await clearAppState(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder("bunker://...").fill(bunkerUrl);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: "visible", timeout: 30000 });
}

test.beforeAll(async ({ browser }, workerInfo) => {
  if (workerInfo.project.use.isMobile) return;
  contextA = await browser.newContext();
  contextA2 = await browser.newContext();
  contextB = await browser.newContext();
  pageA = await contextA.newPage();
  pageA2 = await contextA2.newPage();
  pageB = await contextB.newPage();
});

test.afterAll(async () => {
  await contextA?.close();
  await contextA2?.close();
  await contextB?.close();
});

test("F2 regression — auto-invite race: B sees task within 5 s", async ({}, workerInfo) => {
  // AC-REG-6: multi-context tests don't run on mobile
  test.skip(!!workerInfo.project.use.isMobile, "multi-context tests don't run on mobile");
  test.setTimeout(120_000);

  // Step 1: Authenticate sibling device (pageA2) → publishes its kind-30443 KP
  await authenticate(pageA2, E2E_BUNKER_URL);
  await pageA2.waitForTimeout(4000);

  // Step 2: Authenticate User B
  await authenticate(pageB, E2E_BUNKER_B_URL);
  await pageB.waitForTimeout(2000);

  // Step 3: Authenticate User A (main context)
  await authenticate(pageA, E2E_BUNKER_URL);

  // Step 4: A creates group and invites B
  await pageA.getByPlaceholder("Group name").first().fill(GROUP_NAME);
  await pageA.getByRole("button", { name: "Create", exact: true }).first().click();
  await expect(pageA.locator("aside").getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });
  await pageA.getByPlaceholder("npub1...").fill(USER_B_NPUB);
  await pageA.getByRole("button", { name: "Invite" }).click();
  await expect(pageA.getByPlaceholder("npub1...")).toHaveValue("", { timeout: 30000 });

  // Step 5: B reloads, sees group, selects it
  await pageB.reload();
  await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: "visible", timeout: 30000 });
  await expect(pageB.locator("aside").getByText(GROUP_NAME)).toBeVisible({ timeout: 60000 });
  await pageB.locator("aside").getByText(GROUP_NAME).click();
  await expect(pageB.getByRole("heading", { name: "Tasks" })).toBeVisible({ timeout: 10000 });

  // Step 6: Fetch the sibling's KP event from relay via pageA's network hook
  const siblingKpEvent = await pageA.evaluate(
    async ({ pubkeyHex, relayUrl }) => {
      const fn = window.__notestrTestNetworkRequest;
      if (typeof fn !== "function") throw new Error("network request hook not available");
      const events = await fn([relayUrl], [{ kinds: [30443], authors: [pubkeyHex] }]);
      return events[0] ?? null;
    },
    { pubkeyHex: E2E_BUNKER_PUBKEY_HEX, relayUrl: RELAY_URL },
  );
  if (!siblingKpEvent) throw new Error("No kind-30443 KP found — sibling context may not have published");

  // Step 7: Arm auto-invite (AC-REG-3) — triggers a Welcome commit racing
  // A's imminent task dispatch. No artificial ordering between the two.
  await pageA.evaluate(async (kpEvent) => {
    const fn = window.__notestrTestArmAutoInvite;
    if (typeof fn !== "function") throw new Error("__notestrTestArmAutoInvite not installed");
    await fn(kpEvent as any);
  }, siblingKpEvent);

  // Step 8: A dispatches task (app-message at epoch 2)
  await pageA.getByRole("button", { name: "Add Task" }).click();
  await pageA.getByLabel("Title").fill(TASK_TITLE);
  await pageA.getByRole("button", { name: "Create", exact: true }).last().click();
  await expect(pageA.locator('[data-column="open"]').first()).toContainText(TASK_TITLE, { timeout: 15000 });

  // Step 9: Assert B sees the task within 5 s (AC-REG-4 strict window)
  await expect(pageB.locator('[data-column="open"]').first()).toContainText(TASK_TITLE, { timeout: 5000 });

  // Quiesce before test ends to avoid relay-state interference
  await quiesceFor([pageA, pageB], { maxWaitMs: 5000 });
});
