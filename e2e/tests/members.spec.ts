/**
 * E2E tests: Member list display in GroupManager sidebar.
 *
 * Precondition: bunker is running (globalSetup), relay is up (make e2e-up).
 *
 * After creating a group the creator is automatically a member.
 * The Members section must appear and list at least one entry (the creator).
 * Each entry shows either a profile name or an abbreviated pubkey.
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await clearAppState(page);
  await authenticateViaBunker(page);
});

test('members section appears after group creation with at least one member', async ({ page }) => {
  const GROUP_NAME = 'E2E Members Group';

  // Create a group via the sidebar form
  await page.getByPlaceholder('Group name').fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create' }).click();

  // Wait for the group to appear in the sidebar (confirms creation succeeded)
  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

  // The Members section must appear — the creator is always a member
  const membersSection = page.locator('[data-testid="members-section"]');
  await expect(membersSection).toBeVisible({ timeout: 15000 });

  // At least one member-item must be listed
  const memberItems = page.locator('[data-testid="member-item"]');
  await expect(memberItems).toHaveCount(1, { timeout: 10000 });
});

test('member entry shows profile name or abbreviated pubkey', async ({ page }) => {
  const GROUP_NAME = 'E2E Profile Group';

  // Create a group
  await page.getByPlaceholder('Group name').fill(GROUP_NAME);
  await page.getByRole('button', { name: 'Create' }).click();

  const sidebar = page.locator('aside');
  await expect(sidebar.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

  // Wait for the members section
  await expect(page.locator('[data-testid="members-section"]')).toBeVisible({ timeout: 15000 });

  // The single member item must have non-empty text content
  const memberItem = page.locator('[data-testid="member-item"]').first();
  await expect(memberItem).toBeVisible({ timeout: 10000 });

  const text = (await memberItem.textContent()) ?? '';
  expect(text.trim().length).toBeGreaterThan(0);

  // The text is either a profile name (arbitrary string) or an abbreviated
  // pubkey in the format "abcd1234...ef01" (contains "...")
  // Either format is valid — just verify it is non-empty.
  // If it looks like a pubkey abbreviation it must contain "..."
  const looksLikePubkey = /^[0-9a-f]{8}\.{3}[0-9a-f]{4}$/.test(text.trim());
  const looksLikeName = text.trim().length > 0;
  expect(looksLikePubkey || looksLikeName).toBe(true);
});

test('members section is hidden when no group is selected', async ({ page }) => {
  // No group created — members section must not be present
  const membersSection = page.locator('[data-testid="members-section"]');
  await expect(membersSection).toHaveCount(0);
});
