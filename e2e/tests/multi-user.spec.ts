/**
 * E2E tests: Multi-user group invite flow.
 *
 * Uses two separate browser contexts with distinct bunker identities:
 * - User A: bunker keypair (a1233c40...)
 * - User B: second keypair (3ad635dc...)
 *
 * Precondition: both bunkers running (globalSetup), relay up (make e2e-up).
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { E2E_BUNKER_URL } from '../fixtures/auth-helper.js';
import { E2E_BUNKER_B_URL, USER_B_NPUB } from '../fixtures/auth-helper-b.js';
import { clearAppState } from '../fixtures/cleanup.js';

// Helper: authenticate in a given page via bunker URL
async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto('/');
  await clearAppState(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder('bunker://...').fill(bunkerUrl);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}

// Declare shared state for the two-context test flow
let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let skipMobile = false;

test.beforeAll(async ({ browser }, workerInfo) => {
  // Multi-context MLS tests need desktop viewport — skip on mobile projects
  skipMobile = !!workerInfo.project.use.isMobile;
  if (skipMobile) return;

  // Create two isolated browser contexts (separate storage)
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
});

test.describe.serial('multi-user', () => {
  // Multi-user MLS tests are inherently slow (crypto + relay roundtrips)
  test.setTimeout(120_000);

  const GROUP_NAME = `Multi-User E2E ${Date.now()}`;

  test('Both users authenticate (User B publishes key package)', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // User B must authenticate first so their key package is published
    // to the relay before User A tries to invite them.
    await authenticate(pageB, E2E_BUNKER_B_URL);

    // Wait for key package to be published (MarmotProvider publishes on init)
    await pageB.waitForTimeout(3000);

    await authenticate(pageA, E2E_BUNKER_URL);
  });

  test('User A creates group and invites User B', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Create group
    await pageA.getByPlaceholder('Group name').first().fill(GROUP_NAME);
    await pageA.getByRole('button', { name: 'Create', exact: true }).first().click();

    const sidebarA = pageA.locator('aside');
    await expect(sidebarA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

    // Invite User B by npub
    await pageA.getByPlaceholder('npub1...').fill(USER_B_NPUB);
    await pageA.getByRole('button', { name: 'Invite' }).click();

    // Wait for invite to complete — input clears on success
    await expect(pageA.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });
  });

  test('User B sees the group after the invite', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // User B is already authenticated. Reload to trigger device-sync
    // Welcome fetch in case the subscription missed it.
    await pageB.reload();
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });

    // The group should appear in User B's sidebar via device-sync
    const sidebarB = pageB.locator('aside');
    await expect(sidebarB.getByText(GROUP_NAME)).toBeVisible({ timeout: 60000 });
  });

  test('User A creates a task, User B sees it', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Known issue: MLS application messages sent after User B joins don't
    // reliably arrive via the relay subscription or survive a page reload.
    // Pre-join tasks work via NIP-44 snapshots (tested in task-sync.spec.ts).
    // Verified still broken on 2026-04-09: test reaches the task-creation
    // step, User A sees the task, User B's Open column stays empty even
    // after the reload retry path in the catch block.
    test.fixme(true, 'MLS live message delivery to joined members is unreliable — needs app-level fix');
    // User A should have the group selected already (auto-selected on create)
    await expect(pageA.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

    const TASK_TITLE = `Sync task ${Date.now()}`;
    await pageA.getByRole('button', { name: 'Add Task' }).click();
    await pageA.getByLabel('Title').fill(TASK_TITLE);
    await pageA.getByRole('button', { name: 'Create', exact: true }).last().click();

    // Verify task appears for User A
    const openColumnA = pageA.locator('[data-column="open"]').first();
    await expect(openColumnA).toContainText(TASK_TITLE, { timeout: 15000 });

    // User B: select the group and wait for the task to appear via MLS.
    // Give the live subscription time first, then retry with reload.
    const sidebarB = pageB.locator('aside');
    await sidebarB.getByText(GROUP_NAME).click();
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

    const openColumnB = pageB.locator('[data-column="open"]').first();
    try {
      await expect(openColumnB).toContainText(TASK_TITLE, { timeout: 30000 });
    } catch {
      // Live subscription may have missed the message — reload to re-fetch
      // from the relay and re-initialize the MLS state
      await pageB.reload();
      await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
      // Wait for MLS to re-initialize and process pending messages
      await pageB.waitForTimeout(5000);
      await sidebarB.getByText(GROUP_NAME).click();
      await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });
      await expect(openColumnB).toContainText(TASK_TITLE, { timeout: 30000 });
    }
  });

  test('User B moves task to In Progress, User A sees it', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    test.fixme(true, 'Depends on MLS live message delivery — see previous test');
    // User B clicks "Move to In Progress" on the first task in Open column
    const openColumnB = pageB.locator('[data-column="open"]').first();
    await openColumnB
      .getByRole('button', { name: /Move to In Progress/i })
      .first()
      .click();

    // Verify it moved for User B
    const inProgressB = pageB.locator('[data-column="in_progress"]').first();
    await expect(inProgressB.locator('[data-testid="task-card"]')).toHaveCount(1, { timeout: 15000 });

    // User A should see the task move to In Progress
    const inProgressA = pageA.locator('[data-column="in_progress"]').first();
    await expect(inProgressA.locator('[data-testid="task-card"]')).toHaveCount(1, { timeout: 30000 });
  });
});
