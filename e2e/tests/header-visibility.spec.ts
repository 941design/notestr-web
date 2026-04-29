/**
 * Regression test: top bar must stay pinned to the top of the viewport on
 * mobile, even when sub-view content + browser chrome (address bar / soft
 * keyboard) push the page taller than the visible viewport.
 *
 * Repro: short viewport (mimicking iOS Safari with the address bar visible)
 * makes the sign-in screen overflow. With the original `min-h-screen` layout
 * the document itself becomes scrollable and the static `<header>` scrolls
 * off-screen with it.
 */

import { test, expect } from '@playwright/test';

test.describe('Header visibility (mobile)', () => {
  test('header stays pinned and document does not scroll on short viewport', async ({ page }) => {
    // Short viewport simulates a real mobile browser with the address bar
    // visible (or soft keyboard up). The bug only emerges when the visible
    // viewport is shorter than the rendered content.
    await page.setViewportSize({ width: 390, height: 500 });

    await page.goto('/');
    await expect(page.getByText('Sign in to notestr')).toBeVisible({ timeout: 15000 });

    // Try the most permissive scroll attempts the user could make.
    await page.evaluate(() => {
      window.scrollTo(0, 99999);
      document.documentElement.scrollTop = 99999;
      document.body.scrollTop = 99999;
    });

    const measurements = await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) throw new Error('no header element');
      const rect = header.getBoundingClientRect();
      return {
        headerTop: rect.top,
        headerBottom: rect.bottom,
        docScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        docScrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      };
    });

    expect(measurements.headerTop).toBe(0);
    expect(measurements.headerBottom).toBeGreaterThan(0);
    expect(measurements.docScrollTop).toBe(0);
    expect(measurements.bodyScrollTop).toBe(0);
    // The document itself must not be scrollable beyond the viewport;
    // overflowing content belongs to <main>, which has its own overflow-y-auto.
    expect(measurements.docScrollHeight).toBeLessThanOrEqual(measurements.innerHeight);
  });
});
