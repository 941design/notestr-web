/**
 * E2E tests: NIP-46 bunker authentication flows.
 *
 * Covers:
 *  1. Full auth flow — paste bunker URL, connect, assert pubkey chip visible
 *  2. Session restore — reload the page, assert pubkey chip still visible
 *  3. Disconnect — click disconnect, assert sign-in UI returns and session cleared
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker, type EphemeralBunker } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

test.beforeEach(async ({ page }) => {
  // Clear localStorage and IndexedDB before every test
  await page.goto('/');
  await clearAppState(page);
});

test('full auth flow: bunker URL → pubkey chip visible', async ({ page }) => {
  const result = await authenticateViaBunker(page);
  // Return the bunker handle so it stays alive through to end-of-test
  // (not needed here but signals the pattern; we stop it in afterEach).
  if (result) result.stop();

  // Pubkey chip should be visible in the header
  await expect(page.locator('[data-testid="pubkey-chip"]')).toBeVisible();

  // localStorage should contain the session payload
  const payload = await page.evaluate(() =>
    localStorage.getItem('notestr-nip46-payload'),
  );
  expect(payload).not.toBeNull();
});

test('session restore: pubkey chip persists after page reload', async ({ page }) => {
  // The bunker must stay alive across page.reload() because
  // restoreNip46Session → NDKNip46Signer.fromPayload → blockUntilReady
  // re-issues the NIP-46 "connect" RPC over the relay. The same keypair that
  // created the session must be online to answer it.
  let bunker: EphemeralBunker | null = null;
  try {
    const result = await authenticateViaBunker(page);
    if (!result) {
      // Session already present (shouldn't happen in a fresh beforeEach), but
      // existing pubkey chip on reload is sufficient proof either way.
      await expect(page.locator('[data-testid="pubkey-chip"]')).toBeVisible();
      return;
    }
    bunker = result;

    // Reload — restoreNip46Session() deserialises the payload, re-connects
    // to the relay, subscribes for kind-24133 messages, then sends "connect".
    // The live bunker answers with "ack" so the session restores cleanly.
    await page.reload();

    await expect(page.locator('[data-testid="pubkey-chip"]')).toBeVisible({ timeout: 30000 });
  } finally {
    bunker?.stop();
  }
});

test('disconnect: clears session and returns to sign-in screen', async ({ page }) => {
  const result = await authenticateViaBunker(page);
  if (result) result.stop();

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
