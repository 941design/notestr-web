/**
 * E2E tests: Group creation and sidebar display.
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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearAppState(page);
  // Authenticate before each test
  await authenticateViaBunker(page);
});

test('create group: name appears in sidebar', async ({ page }) => {
  const GROUP_NAME = 'E2E Test Group';

  // On mobile, open drawer first to access sidebar
  if (isMobile(page)) {
    await page.getByRole('button', { name: /open menu/i }).click();
    await page.waitForTimeout(250);
  }

  // Fill in the group name input in the sidebar — use .first() for duplicate containers
  await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);

  // Click the Create button
  await page.getByRole('button', { name: 'Create' }).first().click();

  // Group name must appear in the sidebar group list
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });
});
