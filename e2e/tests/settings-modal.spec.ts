/**
 * Tests for the Settings modal: bunker/NIP-07 badge and the share QR are no
 * longer mounted in the page header. They live behind a Settings entry, and
 * the resulting modal must be dismissible even on short mobile viewports
 * (the previous symptom: a centered modal taller than the visible viewport
 * pushed the X close button off-screen, leaving no way back to the task list).
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

test.describe('Settings modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);
  });

  test('header has no bunker badge and no share/QR button', async ({ page }) => {
    const header = page.locator('header');

    // The "bunker" / "NIP-07" badge has been moved to settings.
    await expect(header).not.toContainText(/bunker|NIP-07/i);

    // The share-your-npub QR button has been moved to settings.
    await expect(header.locator('[data-testid="show-own-npub-qr-btn"]')).toHaveCount(0);
  });

  test('settings entry opens a modal containing bunker badge and QR', async ({ page }) => {
    // The settings entry should be reachable from the visible UI without
    // hidden scrolling. We assert by role to keep the test selector-agnostic.
    const settingsTrigger = page.getByRole('button', { name: /settings/i }).first();
    await expect(settingsTrigger).toBeVisible();

    await settingsTrigger.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    // The bunker / NIP-07 badge now lives inside settings.
    await expect(modal).toContainText(/bunker|NIP-07/i);

    // The share QR is rendered inside settings.
    await expect(modal.locator('svg').first()).toBeVisible();
  });

  test('settings modal X close button is reachable on a short viewport', async ({ page }) => {
    await page.getByRole('button', { name: /settings/i }).first().click();

    const closeBtn = page.getByRole('dialog').getByRole('button', { name: /close/i }).first();
    await expect(closeBtn).toBeVisible();

    // Close button must sit fully inside the visible viewport so the user
    // can actually tap it — the previous bug was a centered dialog whose
    // top extended above y=0, dragging the X off-screen.
    const onScreen = await closeBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
    });
    expect(onScreen).toBe(true);

    // And nothing should cover it.
    const isHittable = await closeBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return hit === el || el.contains(hit);
    });
    expect(isHittable).toBe(true);

    await closeBtn.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
