import { type BrowserContext, type Page } from "@playwright/test";

import { test, expect } from "../fixtures/ndk-client.js";
import {
  E2E_BUNKER_PUBKEY_HEX,
  E2E_BUNKER_URL,
} from "../fixtures/auth-helper.js";
import { clearAppState } from "../fixtures/cleanup.js";

async function authenticate(page: Page): Promise<void> {
  await page.goto("/");
  await clearAppState(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder("bunker://...").fill(E2E_BUNKER_URL);
  await page.getByRole("button", { name: "Connect" }).click();
  await page
    .locator('[data-testid="pubkey-chip"]')
    .waitFor({ state: "visible", timeout: 30000 });
}

async function countRecentGroupEvents(ndkClient: any, pubkey: string): Promise<number> {
  const events = await ndkClient.fetchEvents({
    kinds: [445],
    authors: [pubkey],
    since: Math.floor(Date.now() / 1000) - 300,
  });

  return events.size;
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let skipMobile = false;

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

test.describe.serial("multi-device sync", () => {
  test.setTimeout(180_000);

  const groupName = `Multi-Device ${Date.now()}`;
  const taskTitle = `Device B task ${Date.now()}`;
  const renamedDevice = `Laptop ${Date.now()}`;

  test("same npub contexts auto-sync groups and show devices", async ({
    ndkClient,
  }) => {
    test.skip(skipMobile, "Multi-context MLS tests require desktop viewport");
    // Known limitations that block this test from being green today:
    //
    //   1. Test-pollution sensitivity: earlier tests in the suite leave
    //      live kind-30443 key packages on the shared e2e relay. When
    //      multi-device-sync runs after them, pageA's auto-invite picks
    //      up those stale slots and the initial 2-device assertion fails
    //      with 4–5 "leaf-*" ghost rows. Runs in isolation pass this
    //      gate.
    //
    //   2. MLS remove semantics: once pageA forgets pageB's leaf, pageB
    //      is no longer a member of the group, so the final assertion
    //      that pageB still has `data-local="true"` count == 1 cannot
    //      hold. The test needs to be redesigned — either by forgetting
    //      a third sibling or by not checking pageB's local count after
    //      it has been removed.
    //
    // Marking fixme until the test is redesigned and/or the e2e harness
    // wipes relay state between test files.
    //
    // NOTE (2026-04-09): The MLS live-delivery fix in `device-sync.ts`
    // (dropping the post-join pre-seed so historical kind-445s flow
    // through ts-mls naturally) un-fixmed multi-user.spec.ts but does
    // NOT clear this test's blockers above — they are test-design
    // issues, not live-delivery issues.
    test.fixme(true, "multi-device auto-sync test needs redesign — see inline comment");

    await authenticate(pageB);
    await pageB.waitForTimeout(3000);
    await authenticate(pageA);

    await pageA.getByPlaceholder("Group name").first().fill(groupName);
    await pageA.getByRole("button", { name: "Create", exact: true }).first().click();

    const sidebarA = pageA.locator("aside");
    await expect(sidebarA.getByText(groupName).first()).toBeVisible({
      timeout: 30000,
    });

    await expect(pageB.locator("aside").getByText(groupName).first()).toBeVisible({
      timeout: 60000,
    });

    await pageB.locator("aside").getByText(groupName).first().click();
    await expect(pageB.getByRole("heading", { name: "Tasks" })).toBeVisible({
      timeout: 10000,
    });

    await expect(pageA.locator('[data-testid="device-list"]').first()).toBeVisible({
      timeout: 15000,
    });
    await expect(pageA.locator('[data-testid="device-row"]')).toHaveCount(2, {
      timeout: 15000,
    });
    await expect(pageB.locator('[data-testid="device-row"]')).toHaveCount(2, {
      timeout: 15000,
    });

    await pageB.getByRole("button", { name: "Add Task" }).click();
    await pageB.getByLabel("Title").fill(taskTitle);
    await pageB.getByRole("button", { name: "Create", exact: true }).last().click();
    await expect(pageB.locator('[data-column="open"]').first()).toContainText(
      taskTitle,
      { timeout: 15000 },
    );

    const remoteDeviceRow = pageA
      .locator('[data-testid="device-row"]')
      .filter({ hasNot: pageA.getByText("this device") })
      .first();
    await remoteDeviceRow.getByRole("textbox").fill(renamedDevice);
    await remoteDeviceRow.getByRole("textbox").blur();

    const groupEventCountBeforeReload = await countRecentGroupEvents(
      ndkClient,
      E2E_BUNKER_PUBKEY_HEX,
    );

    await pageA.reload();
    await pageA
      .locator('[data-testid="pubkey-chip"]')
      .waitFor({ state: "visible", timeout: 30000 });
    await pageA.locator("aside").getByText(groupName).first().click();
    await pageB.reload();
    await pageB
      .locator('[data-testid="pubkey-chip"]')
      .waitFor({ state: "visible", timeout: 30000 });
    await pageB.locator("aside").getByText(groupName).first().click();

    await expect(pageA.locator('[data-testid="device-list"]').first()).toContainText(
      renamedDevice,
      { timeout: 15000 },
    );

    const groupEventCountAfterReload = await countRecentGroupEvents(
      ndkClient,
      E2E_BUNKER_PUBKEY_HEX,
    );
    expect(groupEventCountAfterReload).toBe(groupEventCountBeforeReload);

    const remoteDeviceAfterReload = pageA
      .locator('[data-testid="device-row"][data-local="false"]')
      .first();
    await remoteDeviceAfterReload
      .getByRole("button", { name: /forget/i })
      .click();

    await expect(pageA.locator('[data-testid="device-row"]')).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(pageB.locator('[data-testid="device-row"]')).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(
      pageA.locator('[data-testid="device-row"][data-local="true"]'),
    ).toHaveCount(1);
    await expect(
      pageB.locator('[data-testid="device-row"][data-local="true"]'),
    ).toHaveCount(1);
    await expect(pageA.locator('[data-testid="member-item"]')).toHaveCount(1);
    await expect(pageB.locator('[data-testid="member-item"]')).toHaveCount(1);
  });
});
