/**
 * E2E tests: Task creation and board column display.
 *
 * Precondition: bunker is running (globalSetup), relay is up (make e2e-up).
 *
 * Board columns use status values: "open" → "Open", "in_progress" → "In Progress", "done" → "Done"
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    for (const dbName of ['notestr-group-state', 'notestr-key-packages', 'notestr-invite-received', 'notestr-invite-unread', 'notestr-invite-seen']) {
      indexedDB.deleteDatabase(dbName);
    }
  });
  await authenticateViaBunker(page);
});

test('create task: card appears in Open column', async ({ page }) => {
  const GROUP_NAME = 'E2E Task Group';
  const TASK_TITLE = 'E2E Task';

  // Create a group first
  await page.getByPlaceholder('Group name').fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create' }).click();

  // Wait for the group to appear in the sidebar and get selected automatically
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME)).toBeVisible({ timeout: 15000 });

  // The group is auto-selected on creation; wait for the board to appear
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

  // Click "Add Task" to open the create task modal
  await page.getByRole('button', { name: 'Add Task' }).click();

  // Fill in the task title
  await page.getByLabel('Title').fill(TASK_TITLE);

  // Submit the form
  await page.getByRole('button', { name: 'Create' }).last().click();

  // The task card should appear in the "Open" column (data-column="open")
  const openColumn = page.locator('[data-column="open"]');
  await expect(openColumn.getByText(TASK_TITLE)).toBeVisible({ timeout: 15000 });
});
