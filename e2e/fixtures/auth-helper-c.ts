/**
 * Auth helper for the third E2E test identity (User C).
 *
 * Used by tests that require a third-party (e.g. invite-chain tests where
 * A invites B, then B invites C). Same bunker.mjs script with a third
 * deterministic private key.
 */

import type { Page } from '@playwright/test';

// User C's bunker pubkey (derived from private key 8b7561c7..., rotated 2026-04-30).
export const E2E_BUNKER_C_PUBKEY_HEX =
  '837f2b3061d526d73e7581c9bef47ebcd474dd7bf3db4d509256381de490aa1e';
const RELAY_URL = 'ws://localhost:7777';
export const E2E_BUNKER_C_URL = `bunker://${E2E_BUNKER_C_PUBKEY_HEX}?relay=${encodeURIComponent(RELAY_URL)}`;

/** User C's npub (for invite input) */
export const USER_C_NPUB = 'npub1sdljkvrp65ndw0n4s8ymaar7hn28fhtm70d565yj2cupmeys4g0q30l7f7';

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
