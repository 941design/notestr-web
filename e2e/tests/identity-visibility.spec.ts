/**
 * E2E tests: Identity-scoped group visibility under per-pubkey IDB partitioning.
 *
 * Per-pubkey IndexedDB partitioning (epic-multi-user-idb-scoping) supersedes the
 * old cross-identity "detached group" view: a different identity no longer SEES
 * another identity's groups at all (they live in a separate partition), so there
 * is nothing to render as detached. The detached UI still applies to the
 * same-identity case (a group you've lost membership in — e.g. after forgetting
 * this device), which is exercised by the forget-device specs.
 *
 * - Isolation: User A creates a group, signs out, User B signs in to the SAME
 *   browser and does NOT see A's group.
 * - Membership: a user genuinely invited (via MLS Welcome) DOES see the group as
 *   a full member after authenticating — membership flows over the network, not
 *   through shared local storage.
 */

import { devices } from '@playwright/test';

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { authenticateAsBunkerB, USER_B_NPUB } from '../fixtures/auth-helper-b.js';
import { clearAppState } from '../fixtures/cleanup.js';

test.describe('identity-visibility', () => {
  test.setTimeout(120_000);

  const GROUP_NAME = `Detached-Test ${Date.now()}`;

  test('a different identity does NOT see the prior identity\'s group (per-pubkey isolation)', async ({ page }) => {
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

    // Disconnect User A — force click to bypass QR button overlap on mobile.
    // Disconnect now opens a two-path AlertDialog ("Sign out" vs "Forget this
    // device and sign out"). Identity-visibility tests choose the plain path
    // so the group state survives for the next user to observe as detached.
    await page.locator('[data-testid="disconnect-button"]').click({ force: true });
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Sign out', exact: true })
      .click();

    // Wait for login screen
    await page.getByText('Sign in to notestr').waitFor({ state: 'visible', timeout: 15000 });

    // User B authenticates in the same context (shared IndexedDB)
    await authenticateAsBunkerB(page);

    // Open sidebar on mobile if needed
    if (await hamburger.isVisible()) {
      await hamburger.click();
    }

    // Per-pubkey IDB partitioning: B has its own partition, so A's group is
    // ISOLATED — not visible at all (not merely shown 'detached'). This is the
    // privacy fix that supersedes the old cross-identity detached-group view.
    await expect(page.getByLabel('Groups').getByText(GROUP_NAME)).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-detached="true"]')).not.toBeVisible({ timeout: 3000 });
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

    // Disconnect User A — force click to bypass QR button overlap on mobile.
    // Confirm plain "Sign out" so the group state survives for B.
    await page.locator('[data-testid="disconnect-button"]').click({ force: true });
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Sign out', exact: true })
      .click();
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
