/**
 * Auth helper for the third E2E test identity (User C).
 *
 * Used by tests that require a third-party (e.g. invite-chain tests where
 * A invites B, then B invites C). Same bunker.mjs script with a third
 * deterministic private key.
 */

import type { Page } from '@playwright/test';

// User C's bunker pubkey (derived from private key 6a7c89e4...)
export const E2E_BUNKER_C_PUBKEY_HEX =
  '2ea0d688f883325946f7756821a3b6496a8702722f455b6845d437f2d41ecd68';
const RELAY_URL = 'ws://localhost:7777';
export const E2E_BUNKER_C_URL = `bunker://${E2E_BUNKER_C_PUBKEY_HEX}?relay=${encodeURIComponent(RELAY_URL)}`;

/** User C's npub (for invite input) */
export const USER_C_NPUB = 'npub196sddz8csve9j3hhw45zrgakf94gwqnj9az4k6z96sml94q7e45qxfuche';

/**
 * Authenticate as User C via bunker:// URL.
 */
export async function authenticateAsBunkerC(page: Page): Promise<void> {
  await page.goto('/');

  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder('bunker://...').fill(E2E_BUNKER_C_URL);
  await page.getByRole('button', { name: 'Connect' }).click();

  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}
