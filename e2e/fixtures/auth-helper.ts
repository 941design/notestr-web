/**
 * Shared auth helper for E2E tests.
 *
 * Performs the NIP-46 bunker authentication flow via the app UI.
 * Re-use this in any test that requires an authenticated session.
 *
 * Bunker URLs / pubkeys are freshly generated per `globalSetup` run and
 * read from `e2e/.bunker-keys.json`. This isolates every test session
 * from kind-30443 KeyPackages left on the relay by prior sessions —
 * which the auto-invite scan would otherwise treat as sibling devices
 * and add as phantom leaves in every group.
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

export const E2E_BUNKER_PUBKEY_HEX = keys.A.pubkeyHex;
export const E2E_BUNKER_URL = keys.A.bunkerUrl;

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
