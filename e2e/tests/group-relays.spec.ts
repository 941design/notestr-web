/**
 * E2E tests: Per-group relay configuration.
 *
 * Precondition: bunker is running (globalSetup), relay is up (make e2e-up).
 *
 * NOTE: The responsive layout renders GroupManager in multiple sidebar
 * containers. Locators must use .first() to avoid strict mode violations.
 * On mobile, the drawer must be opened before interacting with sidebar.
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

function isMobile(page: import('@playwright/test').Page) {
  const vp = page.viewportSize();
  return vp != null && vp.width < 768;
}

async function openDrawerIfMobile(page: import('@playwright/test').Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: /open menu/i }).click();
    await page.waitForTimeout(250);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearAppState(page);
  await authenticateViaBunker(page);
});

test('create group with default relays: chips shown in form and group card', async ({ page }) => {
  await openDrawerIfMobile(page);

  // Default relay chips should be visible in the create form
  const relayChips = page.locator('[data-testid="relay-chip"]');
  await expect(relayChips.first()).toBeVisible({ timeout: 5000 });

  // Create group
  const GROUP_NAME = 'E2E Relay Default';
  await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();

  // Group card should appear with relay info
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });
  await expect(sidebar.locator('[data-testid="group-relays"]').first()).toBeVisible();
});

test('create group with custom relay: add and remove relays', async ({ page }) => {
  await openDrawerIfMobile(page);

  // Count initial relay chips
  const initialChips = page.locator('[data-testid="relay-chip"]');
  const initialCount = await initialChips.count();
  expect(initialCount).toBeGreaterThan(0);

  // Remove the first default relay
  await initialChips.first().locator('button').click();
  expect(await page.locator('[data-testid="relay-chip"]').count()).toBe(initialCount - 1);

  // Add a custom relay
  await page.locator('[data-testid="relay-input"]').first().fill('wss://custom.relay.example');
  await page.locator('[data-testid="relay-add-btn"]').first().click();

  // Verify the custom chip appears
  await expect(page.locator('[data-testid="relay-chip"]').filter({ hasText: 'custom.relay.example' })).toBeVisible();
});

test('group card shows member count after creation', async ({ page }) => {
  await openDrawerIfMobile(page);

  const GROUP_NAME = 'E2E Members Count';
  await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();

  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });

  // Member count should show "1 member" (creator only)
  await expect(sidebar.locator('[data-testid="group-member-count"]').first()).toContainText('1 member');
});

test('selected group shows relay list in sidebar', async ({ page }) => {
  await openDrawerIfMobile(page);

  const GROUP_NAME = 'E2E Relay Display';
  await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();

  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });

  // Group should already be selected after creation — relay list should be visible
  await expect(page.locator('[data-testid="group-relay-list"]').first()).toBeVisible({ timeout: 5000 });
});
