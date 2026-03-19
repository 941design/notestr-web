/**
 * E2E tests: Task creation and board column display.
 *
 * Precondition: bunker is running (globalSetup), relay is up (make e2e-up).
 *
 * Board columns use status values: "open" → "Open", "in_progress" → "In Progress", "done" → "Done"
 *
 * NOTE: The responsive layout renders both mobile (tabpanel) and desktop (grid)
 * board layouts in the DOM. Similarly, GroupManager appears in multiple sidebar
 * containers. Locators must use .first() to avoid strict mode violations.
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
  await authenticateViaBunker(page);
});

test('create task: card appears in Open column', async ({ page }) => {
  const GROUP_NAME = 'E2E Task Group';
  const TASK_TITLE = 'E2E Task';

  // On mobile, open drawer first to access sidebar
  if (isMobile(page)) {
    await page.getByRole('button', { name: /open menu/i }).click();
    await page.waitForTimeout(250);
  }

  // Create a group first — use .first() since GroupManager may render in multiple containers
  await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create' }).first().click();

  // Wait for the group to appear in the sidebar and get selected automatically
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });

  // The group is auto-selected on creation; wait for the board to appear
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

  // Click "Add Task" to open the create task modal
  await page.getByRole('button', { name: 'Add Task' }).click();

  // Fill in the task title
  await page.getByLabel('Title').fill(TASK_TITLE);

  // Submit the form
  await page.getByRole('button', { name: 'Create' }).last().click();

  // The task card should appear in the "Open" column (data-column="open").
  // Use .first() and toContainText: both mobile and desktop layouts exist in DOM.
  const openColumn = page.locator('[data-column="open"]').first();
  await expect(openColumn).toContainText(TASK_TITLE, { timeout: 15000 });
});
