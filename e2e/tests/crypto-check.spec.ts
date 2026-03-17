/**
 * E2E test: graceful degradation when Web Crypto API is unavailable.
 *
 * Simulates a non-secure context (HTTP on mobile) by deleting
 * crypto.subtle before app code runs. Verifies the app shows a
 * user-friendly error instead of crashing with a raw TypeError.
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';

test.use({ browserName: 'chromium' });

test('shows friendly error when crypto.subtle is unavailable', async ({ page }) => {
  // Remove crypto.subtle before any app code executes
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'subtle', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  await authenticateViaBunker(page);

  // The MarmotProvider should catch the missing crypto and show a clear message
  await expect(
    page.getByText('Web Crypto API is not available'),
  ).toBeVisible({ timeout: 15000 });

  // The raw TypeError should NOT appear
  await expect(
    page.getByText('Cannot read properties of undefined'),
  ).not.toBeVisible();
});
