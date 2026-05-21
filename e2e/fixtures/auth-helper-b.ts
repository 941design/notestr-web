/**
 * Auth helper for the second E2E test identity (User B).
 *
 * Bunker URL and npub are loaded from `e2e/.bunker-keys.json`, which is
 * regenerated every `globalSetup` run with a fresh keypair. See
 * `e2e/fixtures/auth-helper.ts` for the rationale.
 */

import type { Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.resolve(__dirname, '..', '.bunker-keys.json');

interface BunkerKey {
  privkeyHex: string;
  pubkeyHex: string;
  npub: string;
  bunkerUrl: string;
}

const keys = JSON.parse(readFileSync(KEYS_FILE, 'utf-8')) as {
  A: BunkerKey;
  B: BunkerKey;
  C: BunkerKey;
};

export const E2E_BUNKER_B_PUBKEY_HEX = keys.B.pubkeyHex;
export const E2E_BUNKER_B_URL = keys.B.bunkerUrl;

/** User B's npub (for invite input) */
export const USER_B_NPUB = keys.B.npub;

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
