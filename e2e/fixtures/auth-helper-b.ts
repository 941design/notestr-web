/**
 * Auth helper for the second E2E test identity (User B).
 *
 * Uses the same bunker.mjs script but with BUNKER_PRIVATE_KEY set to the
 * second deterministic test keypair from ndk-client.ts.
 */

import type { Page } from '@playwright/test';

// User B's bunker pubkey (derived from private key 645b5c22..., rotated 2026-04-30).
const BUNKER_B_PUBKEY_HEX = '05b9cae746cd7f029084feac706bf67c28448ff0eab15a5c223e3b7a73a68bc8';
const RELAY_URL = 'ws://localhost:7777';
export const E2E_BUNKER_B_URL = `bunker://${BUNKER_B_PUBKEY_HEX}?relay=${encodeURIComponent(RELAY_URL)}`;

/** User B's npub (for invite input) */
export const USER_B_NPUB = 'npub1qkuu4e6xe4ls9yyyl6k8q6lk0s5yfrlsa2c45hpz8cah5uax30yqcurp9j';

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
