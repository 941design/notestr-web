/**
 * Auth helper for the third E2E test identity (User C).
 *
 * Used by tests that require a third party (e.g. invite-chain tests where
 * A invites B, then B invites C). Bunker URL and npub are loaded from
 * `e2e/.bunker-keys.json`, regenerated every `globalSetup` run with a
 * fresh keypair. See `e2e/fixtures/auth-helper.ts` for the rationale.
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

export const E2E_BUNKER_C_PUBKEY_HEX = keys.C.pubkeyHex;
export const E2E_BUNKER_C_URL = keys.C.bunkerUrl;

/** User C's npub (for invite input) */
export const USER_C_NPUB = keys.C.npub;

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
