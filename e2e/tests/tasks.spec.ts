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

async function swipe(
  panel: import('@playwright/test').Locator,
  direction: 'left' | 'right',
) {
  const box = await panel.boundingBox();
  if (!box) throw new Error('Mobile panel has no bounding box');
  const startFrac = direction === 'left' ? 0.85 : 0.15;
  const endFrac = direction === 'left' ? 0.15 : 0.85;
  const startX = box.x + box.width * startFrac;
  const endX = box.x + box.width * endFrac;
  const y = box.y + box.height / 2;

  await panel.evaluate(
    (el, args) => {
      const target = el as HTMLElement;
      const make = (x: number, yy: number) =>
        new Touch({
          identifier: 0,
          target,
          clientX: x,
          clientY: yy,
          pageX: x,
          pageY: yy,
        });
      target.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [make(args.startX, args.y)],
          targetTouches: [make(args.startX, args.y)],
          changedTouches: [make(args.startX, args.y)],
        }),
      );
      target.dispatchEvent(
        new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [make(args.endX, args.y)],
        }),
      );
    },
    { startX, endX, y },
  );
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
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();

  // Wait for the group to appear in the sidebar and get selected automatically
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });

  // The group is auto-selected on creation; wait for the board to appear
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

  // Click "Add Task" to open the create task modal
  await page.getByRole('button', { name: 'Add Task' }).click();

  // Fill in the task title
  await page.getByLabel('Title').fill(TASK_TITLE);

  // Submit the form (modal Create button)
  await page.getByRole('button', { name: 'Create', exact: true }).last().click();

  // The task card should appear in the "Open" column (data-column="open").
  // Use .first() and toContainText: both mobile and desktop layouts exist in DOM.
  const openColumn = page.locator('[data-column="open"]').first();
  await expect(openColumn).toContainText(TASK_TITLE, { timeout: 15000 });
});

test('delete task: card removed from board after confirmation', async ({ page }) => {
  const GROUP_NAME = 'E2E Delete Task Group';
  const TASK_TITLE = 'Task To Delete';

  // On mobile, open drawer first
  if (isMobile(page)) {
    await page.getByRole('button', { name: /open menu/i }).click();
    await page.waitForTimeout(250);
  }

  // Create a group and task
  await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Add Task' }).click();
  await page.getByLabel('Title').fill(TASK_TITLE);
  await page.getByRole('button', { name: 'Create', exact: true }).last().click();
  // Use last() on desktop (mobile panel is first in DOM but hidden); first() on mobile
  const openColumn = isMobile(page)
    ? page.locator('[data-column="open"]').first()
    : page.locator('[data-column="open"]').last();
  await expect(openColumn).toContainText(TASK_TITLE, { timeout: 15000 });

  // Click Delete — use the visible delete button (scoped to visible column)
  await openColumn.locator('[data-testid="task-delete-btn"]').click();
  await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 });

  // Cancel — task should still be there
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(openColumn).toContainText(TASK_TITLE, { timeout: 5000 });

  // Delete again and confirm
  await openColumn.locator('[data-testid="task-delete-btn"]').click();
  await page.locator('[data-testid="task-delete-confirm"]').click();

  // Task should be gone from all columns
  await expect(openColumn).not.toContainText(TASK_TITLE, { timeout: 10000 });
});

test('mobile: left/right swipes navigate between board lanes', async ({ page }) => {
  test.skip(!isMobile(page), 'Lane swipe is a mobile-only interaction');

  const GROUP_NAME = 'E2E Swipe Group';

  await page.getByRole('button', { name: /open menu/i }).click();
  await page.waitForTimeout(250);
  await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME).first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

  const panel = page.getByTestId('board-mobile-panel');
  await expect(panel).toBeVisible();
  const tabFor = (name: RegExp) => page.getByRole('tab', { name });
  const openTab = tabFor(/^Open\b/);
  const inProgressTab = tabFor(/In Progress/);
  const doneTab = tabFor(/Done/);

  // Default state: Open is selected.
  await expect(openTab).toHaveAttribute('aria-selected', 'true');

  // Swipe left → In Progress.
  await swipe(panel, 'left');
  await expect(inProgressTab).toHaveAttribute('aria-selected', 'true');

  // Swipe left → Done.
  await swipe(panel, 'left');
  await expect(doneTab).toHaveAttribute('aria-selected', 'true');

  // Swipe left at the right edge: stays on Done (no wrap).
  await swipe(panel, 'left');
  await expect(doneTab).toHaveAttribute('aria-selected', 'true');

  // Swipe right → In Progress.
  await swipe(panel, 'right');
  await expect(inProgressTab).toHaveAttribute('aria-selected', 'true');

  // Swipe right → Open.
  await swipe(panel, 'right');
  await expect(openTab).toHaveAttribute('aria-selected', 'true');

  // Swipe right at the left edge: stays on Open (no wrap).
  await swipe(panel, 'right');
  await expect(openTab).toHaveAttribute('aria-selected', 'true');
});
