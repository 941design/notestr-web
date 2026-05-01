/**
 * E2E tests: Identity-scoped group visibility.
 *
 * Tests that groups belonging to a different identity appear as detached
 * (visually disabled) and that interaction is restricted.
 *
 * Uses a single browser context (shared IndexedDB) with identity switching:
 * - User A creates a group, then disconnects
 * - User B authenticates in the same context and sees the group as detached
 */

import { devices } from '@playwright/test';

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { authenticateAsBunkerB, USER_B_NPUB } from '../fixtures/auth-helper-b.js';
import { clearAppState } from '../fixtures/cleanup.js';

test.describe('identity-visibility', () => {
  test.setTimeout(120_000);

  const GROUP_NAME = `Detached-Test ${Date.now()}`;

  test('detached group shows opacity-50 and data-detached after identity switch', async ({ page }) => {
    // Clean slate
    await page.goto('/');
    await clearAppState(page);

    // User A authenticates and creates a group
    await authenticateViaBunker(page);

    // Open sidebar on mobile if needed
    const hamburger = page.locator('button[aria-label="Open menu"]');
    if (await hamburger.isVisible()) {
      await hamburger.click();
    }

    await page.getByPlaceholder('Group name').first().fill(GROUP_NAME);
    await page.getByRole('button', { name: 'Create', exact: true }).first().click();

    // Wait for group to appear in sidebar
    await expect(page.getByLabel('Groups').getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

    // Disconnect User A — force click to bypass QR button overlap on mobile
    await page.locator('[data-testid="disconnect-button"]').click({ force: true });

    // Wait for login screen
    await page.getByText('Sign in to notestr').waitFor({ state: 'visible', timeout: 15000 });

    // User B authenticates in the same context (shared IndexedDB)
    await authenticateAsBunkerB(page);

    // Open sidebar on mobile if needed
    if (await hamburger.isVisible()) {
      await hamburger.click();
    }

    // The group should be visible but detached
    const detachedItem = page.locator('[data-detached="true"]').first();
    await expect(detachedItem).toBeVisible({ timeout: 15000 });
    await expect(detachedItem).toHaveClass(/opacity-50/);

    // Clicking the group name should NOT select it (no board columns visible)
    await detachedItem.locator('span').first().click();
    await expect(page.locator('[data-column="open"]')).not.toBeVisible({ timeout: 3000 });

    // AC-012: Invite form should not be visible (detached group cannot be selected)
    await expect(page.locator('form:has([placeholder="npub1..."])')).not.toBeVisible({ timeout: 3000 });
  });

  test('leave button works on detached group', async ({ page }) => {
    // Clean slate
    await page.goto('/');
    await clearAppState(page);

    // User A authenticates and creates a group
    await authenticateViaBunker(page);

    const hamburger = page.locator('button[aria-label="Open menu"]');
    if (await hamburger.isVisible()) {
      await hamburger.click();
    }

    const leaveGroupName = `Leave-Test ${Date.now()}`;
    await page.getByPlaceholder('Group name').first().fill(leaveGroupName);
    await page.getByRole('button', { name: 'Create', exact: true }).first().click();
    await expect(page.getByLabel('Groups').getByText(leaveGroupName)).toBeVisible({ timeout: 30000 });

    // Disconnect User A — force click to bypass QR button overlap on mobile
    await page.locator('[data-testid="disconnect-button"]').click({ force: true });
    await page.getByText('Sign in to notestr').waitFor({ state: 'visible', timeout: 15000 });

    // User B authenticates
    await authenticateAsBunkerB(page);

    if (await hamburger.isVisible()) {
      await hamburger.click();
    }

    // Find the detached group's leave button and click it
    const detachedItem = page.locator('[data-detached="true"]').first();
    await expect(detachedItem).toBeVisible({ timeout: 15000 });
    await detachedItem.locator('[data-testid="group-leave-btn"]').click();

    // Confirm in AlertDialog
    await page.locator('[data-testid="group-leave-confirm"]').click();

    // Group should disappear from sidebar (use .first() — GroupManager renders in multiple containers)
    await expect(page.getByLabel('Groups').getByText(leaveGroupName).first()).not.toBeVisible({ timeout: 15000 });
  });

  test('identity switch restores full interactivity for member', async ({ browser }) => {
    // This test needs two separate browser contexts:
    // - Context B: User B authenticates first to publish key package
    // - Context A: User A creates group, invites User B
    // Then in a shared single context: User A creates group, invites User B,
    // disconnects, User B logs in and sees the group as fully interactive.

    const groupName = `Switch-Test ${Date.now()}`;

    const BASE_URL = 'http://localhost:3100';
    const contextOpts = { baseURL: BASE_URL, ...devices['Desktop Chrome'] };

    // Step 1: User B publishes key package in a separate context
    const contextB = await browser.newContext(contextOpts);
    const pageB = await contextB.newPage();
    await pageB.goto('/');
    await clearAppState(pageB);
    await pageB.goto('/');
    await pageB.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
    await pageB.getByPlaceholder('bunker://...').fill(
      (await import('../fixtures/auth-helper-b.js')).E2E_BUNKER_B_URL,
    );
    await pageB.getByRole('button', { name: 'Connect' }).click();
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
    // Wait for key package to be published
    await pageB.waitForTimeout(3000);
    await contextB.close();

    // Step 2: User A creates group and invites User B in a single-context flow
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);

    const hamburger = page.locator('button[aria-label="Open menu"]');
    if (await hamburger.isVisible()) {
      await hamburger.click();
    }

    await page.getByPlaceholder('Group name').fill(groupName);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByLabel('Groups').getByText(groupName)).toBeVisible({ timeout: 30000 });

    // Click the group to select it
    await page.getByLabel('Groups').getByText(groupName).click();

    // Invite User B
    await page.getByPlaceholder('npub1...').fill(USER_B_NPUB);
    await page.getByRole('button', { name: 'Invite' }).click();

    // Wait for invite to succeed (input clears)
    await expect(page.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });

    // Disconnect User A — force click to bypass QR button overlap on mobile
    await page.locator('[data-testid="disconnect-button"]').click({ force: true });
    await page.getByText('Sign in to notestr').waitFor({ state: 'visible', timeout: 15000 });

    // User B authenticates in the same context (shared IndexedDB)
    await authenticateAsBunkerB(page);

    if (await hamburger.isVisible()) {
      await hamburger.click();
    }

    // Wait for the group to appear for User B (may take time for MLS welcome)
    await expect(page.getByLabel('Groups').getByText(groupName)).toBeVisible({ timeout: 45000 });

    // The group should NOT be detached for User B (they are a member)
    await expect(page.locator('[data-detached="true"]')).not.toBeVisible({ timeout: 3000 });

    // Click the group to select it
    await page.getByLabel('Groups').getByText(groupName).click();

    // Board should show full interactive state (not detached overlay)
    await expect(page.locator('[data-testid="detached-overlay"]')).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Add Task' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('region', { name: 'Open' }).first()).toBeVisible({ timeout: 5000 });

    await context.close();
  });
});
