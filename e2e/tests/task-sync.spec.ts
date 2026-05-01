/**
 * E2E test: Tasks created before a member joins should be visible after joining.
 *
 * Scenario:
 * 1. User A creates a group and adds a task
 * 2. User A invites User B (publishes NIP-44 encrypted task snapshot)
 * 3. User B joins the group via device-sync
 * 4. User B should see the pre-existing task (loaded from NIP-44 snapshot)
 *
 * MLS application messages from before the join epoch are undecryptable by
 * new members by design. The fix is to publish a NIP-44 encrypted task
 * snapshot as a standard Nostr event when inviting, which the new member
 * fetches and decrypts outside MLS.
 */

import { type BrowserContext, type Page } from '@playwright/test';

import { test, expect } from '@playwright/test';
import { E2E_BUNKER_URL } from '../fixtures/auth-helper.js';
import { E2E_BUNKER_B_URL, USER_B_NPUB } from '../fixtures/auth-helper-b.js';
import { clearAppState } from '../fixtures/cleanup.js';

async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto('/');
  await clearAppState(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder('bunker://...').fill(bunkerUrl);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let skipMobile = false;

test.beforeAll(async ({ browser }, workerInfo) => {
  // Multi-context MLS tests need desktop viewport — skip on mobile projects
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

test.describe.serial('task-sync: older tasks visible after joining', () => {
  test.setTimeout(180_000);

  const GROUP_NAME = `TaskSync E2E ${Date.now()}`;
  const TASK_TITLE = `Pre-join task ${Date.now()}`;

  test('User B authenticates first (publishes key package)', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await authenticate(pageB, E2E_BUNKER_B_URL);
    // Wait for key package publication
    await pageB.waitForTimeout(3000);
  });

  test('User A authenticates', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await authenticate(pageA, E2E_BUNKER_URL);
  });

  test('User A creates group and a task', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Create group
    await pageA.getByPlaceholder('Group name').first().fill(GROUP_NAME);
    await pageA.getByRole('button', { name: 'Create', exact: true }).first().click();

    const sidebarA = pageA.locator('aside');
    await expect(sidebarA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

    // Wait for the task board to appear (group auto-selected)
    await expect(pageA.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

    // Create a task
    await pageA.getByRole('button', { name: 'Add Task' }).click();
    await pageA.getByLabel('Title').fill(TASK_TITLE);
    await pageA.getByRole('button', { name: 'Create', exact: true }).last().click();

    // Verify task appears in Open column for User A
    const openColumn = pageA.locator('[data-column="open"]').first();
    await expect(openColumn).toContainText(TASK_TITLE, { timeout: 15000 });
  });

  test('User A invites User B', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await pageA.getByPlaceholder('npub1...').fill(USER_B_NPUB);
    await pageA.getByRole('button', { name: 'Invite' }).click();

    // Wait for invite to complete — input clears on success
    await expect(pageA.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });

    // Give the NIP-44 snapshot a moment to be published to the relay
    await pageA.waitForTimeout(2000);
  });

  test('User B sees the group after joining', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Reload to trigger device-sync welcome fetch
    await pageB.reload();
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });

    const sidebarB = pageB.locator('aside');
    await expect(sidebarB.getByText(GROUP_NAME)).toBeVisible({ timeout: 60000 });
  });

  test('User B sees the pre-existing task', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Click on the group to select it
    const sidebarB = pageB.locator('aside');
    await sidebarB.getByText(GROUP_NAME).click();

    // Wait for the task board to load
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

    // The pre-existing task should appear in the Open column
    const openColumn = pageB.locator('[data-column="open"]').first();
    await expect(openColumn).toContainText(TASK_TITLE, { timeout: 30000 });
  });
});
