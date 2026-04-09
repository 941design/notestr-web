/**
 * Shared auth helper for E2E tests.
 *
 * Performs the NIP-46 bunker authentication flow via the app UI.
 * Re-use this in any test that requires an authenticated session.
 */

import type { Page } from '@playwright/test';

// Imported from bunker.mjs — keep in sync with that file.
// bunker pubkey: 3e0057f09a2d9fcc231485409929af4f2c95479e5c369fade8ea0ed37e3c9ae0
export const E2E_BUNKER_PUBKEY_HEX = '3e0057f09a2d9fcc231485409929af4f2c95479e5c369fade8ea0ed37e3c9ae0';
const RELAY_URL = 'ws://localhost:7777';
export const E2E_BUNKER_URL = `bunker://${E2E_BUNKER_PUBKEY_HEX}?relay=${encodeURIComponent(RELAY_URL)}`;

/**
 * Navigate to the app, select the "bunker:// URL" tab, paste the E2E_BUNKER_URL,
 * click Connect, and wait for the pubkey chip to appear.
 *
 * Idempotent: if the NIP-46 session has already been restored from
 * IndexedDB/localStorage (as happens after `page.reload()`), the pubkey chip
 * will appear on its own and this helper just waits for it instead of trying
 * to click the sign-in tab — which no longer exists in the authenticated UI.
 */
export async function authenticateViaBunker(page: Page): Promise<void> {
  await page.goto('/');

  const pubkeyChip = page.locator('[data-testid="pubkey-chip"]');
  const bunkerTab = page.getByRole('tab', { name: /bunker:\/\/ URL/i });

  // After `page.reload()` the app may auto-restore the previous bunker
  // session from IndexedDB. When that happens the stored NIP-46 payload in
  // localStorage is already populated — use that as the signal to wait for
  // the pubkey chip instead of clicking through the sign-in form (which
  // doesn't render in the authenticated UI).
  const hasSavedSession = await page.evaluate(
    () => localStorage.getItem('notestr-nip46-payload') != null,
  );
  if (hasSavedSession) {
    await pubkeyChip.waitFor({ state: 'visible', timeout: 30000 });
    return;
  }

  // Click the "bunker:// URL" tab
  await bunkerTab.click();

  // Fill in the bunker URL input
  await page.getByPlaceholder('bunker://...').fill(E2E_BUNKER_URL);

  // Click Connect
  await page.getByRole('button', { name: 'Connect' }).click();

  // Wait for the pubkey chip to appear (indicates successful auth)
  await pubkeyChip.waitFor({ state: 'visible', timeout: 30000 });
}
