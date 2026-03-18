/**
 * Auth helper for the second E2E test identity (User B).
 *
 * Uses the same bunker.mjs script but with BUNKER_PRIVATE_KEY set to the
 * second deterministic test keypair from ndk-client.ts.
 */

import type { Page } from '@playwright/test';

// User B's bunker pubkey (derived from private key 3ad635dc...)
const BUNKER_B_PUBKEY_HEX = 'd2f8e20d603f2f9ceddae1c70f311de027bf887f2f66cf17289b53dbe7f3db3d';
const RELAY_URL = 'ws://localhost:7777';
export const E2E_BUNKER_B_URL = `bunker://${BUNKER_B_PUBKEY_HEX}?relay=${encodeURIComponent(RELAY_URL)}`;

/** User B's npub (for invite input) */
export const USER_B_NPUB = 'npub16tuwyrtq8uheemw6u8rs7vgauqnmlzrl9anv79egndfahelnmv7stjfhcm';

/**
 * Authenticate as User B via bunker:// URL.
 */
export async function authenticateAsBunkerB(page: Page): Promise<void> {
  await page.goto('/');

  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder('bunker://...').fill(E2E_BUNKER_B_URL);
  await page.getByRole('button', { name: 'Connect' }).click();

  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}
