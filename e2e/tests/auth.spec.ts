/**
 * E2E tests: NIP-46 bunker authentication flows.
 *
 * Covers:
 *  1. Full auth flow — paste bunker URL, connect, assert pubkey chip visible
 *  2. Session restore — reload the page, assert pubkey chip still visible
 *  3. Disconnect — click disconnect, assert sign-in UI returns and session cleared
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

test.beforeEach(async ({ page }) => {
  // Clear localStorage and IndexedDB before every test
  await page.goto('/');
  await clearAppState(page);
});

test('full auth flow: bunker URL → pubkey chip visible', async ({ page }) => {
  await authenticateViaBunker(page);

  // Pubkey chip should be visible in the header
  await expect(page.locator('[data-testid="pubkey-chip"]')).toBeVisible();

  // localStorage should contain the session payload
  const payload = await page.evaluate(() =>
    localStorage.getItem('notestr-nip46-payload'),
  );
  expect(payload).not.toBeNull();
});

test('session restore: pubkey chip persists after page reload', async ({ page }) => {
  await authenticateViaBunker(page);

  // Reload the page — restoreNip46Session() should re-authenticate automatically
  await page.reload();

  // Pubkey chip should still be visible without re-entering the bunker URL
  await expect(page.locator('[data-testid="pubkey-chip"]')).toBeVisible({ timeout: 30000 });
});

test('disconnect: clears session and returns to sign-in screen', async ({ page }) => {
  await authenticateViaBunker(page);

  // Click the disconnect button (force: badge may overlap on narrow viewports).
  // Opens the sign-out confirmation dialog (added by MLS Leaf Identity UX).
  await page.locator('[data-testid="disconnect-button"]').click({ force: true });

  // Choose the plain "Sign out" path (not "Forget this device and sign out"),
  // which matches the historical behaviour this test was written against.
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out', exact: true }).click();

  // Pubkey chip must no longer be visible
  await expect(page.locator('[data-testid="pubkey-chip"]')).not.toBeVisible();

  // Sign-in heading must reappear
  await expect(page.getByText('Sign in to notestr')).toBeVisible();

  // localStorage session must be cleared
  const payload = await page.evaluate(() =>
    localStorage.getItem('notestr-nip46-payload'),
  );
  expect(payload).toBeNull();
});
