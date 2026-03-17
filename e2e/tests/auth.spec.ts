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

test.beforeEach(async ({ page }) => {
  // Clear localStorage and IndexedDB before every test
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    // Clear marmot-ts IndexedDB stores
    for (const dbName of ['notestr-group-state', 'notestr-key-packages', 'notestr-invite-received', 'notestr-invite-unread', 'notestr-invite-seen']) {
      indexedDB.deleteDatabase(dbName);
    }
  });
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

  // Click the disconnect button
  await page.locator('[data-testid="disconnect-button"]').click();

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
