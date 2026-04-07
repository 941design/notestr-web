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
 */
export async function authenticateViaBunker(page: Page): Promise<void> {
  await page.goto('/');

  // Click the "bunker:// URL" tab
  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();

  // Fill in the bunker URL input
  await page.getByPlaceholder('bunker://...').fill(E2E_BUNKER_URL);

  // Click Connect
  await page.getByRole('button', { name: 'Connect' }).click();

  // Wait for the pubkey chip to appear (indicates successful auth)
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}
