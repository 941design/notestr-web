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

test.beforeAll(async ({ browser }) => {
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
    // User B must authenticate first so their key package is published
    // to the relay before User A tries to invite them.
    await authenticate(pageB, E2E_BUNKER_B_URL);

    // Wait for key package to be published (MarmotProvider publishes on init)
    await pageB.waitForTimeout(3000);

    await authenticate(pageA, E2E_BUNKER_URL);
  });

  test('User A creates group and invites User B', async () => {
    // Create group
    await pageA.getByPlaceholder('Group name').fill(GROUP_NAME);
    await pageA.getByRole('button', { name: 'Create' }).click();

    const sidebarA = pageA.locator('aside');
    await expect(sidebarA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

    // Invite User B by npub
    await pageA.getByPlaceholder('npub1...').fill(USER_B_NPUB);
    await pageA.getByRole('button', { name: 'Invite' }).click();

    // Wait for invite to complete — input clears on success
    await expect(pageA.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });
  });

  test('User B sees the group after the invite', async () => {
    // User B is already authenticated. Reload to trigger device-sync
    // Welcome fetch in case the subscription missed it.
    await pageB.reload();
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });

    // The group should appear in User B's sidebar via device-sync
    const sidebarB = pageB.locator('aside');
    await expect(sidebarB.getByText(GROUP_NAME)).toBeVisible({ timeout: 60000 });
  });

  // Task propagation requires MLS epoch convergence across both clients.
  // Currently, the selfUpdate commit from User B causes epoch divergence
  // that prevents decryption of application messages. This is a known
  // marmot-ts protocol limitation tracked separately.
  test.skip('User A creates a task, User B sees it', async () => {});
  test.skip('User B moves task to In Progress, User A sees it', async () => {});
});
