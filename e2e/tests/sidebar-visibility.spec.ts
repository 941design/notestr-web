/**
 * Regression test: the mobile drawer sidebar must not cover the page header.
 *
 * The previous layout used `fixed inset-y-0 z-30` for the `<aside>`, so when
 * the drawer was open on mobile the aside painted over the entire viewport
 * — including the header's hamburger/X close button and (on iOS notch
 * devices) the safe-area-inset region. The expected behaviour: aside slides
 * out below the header, leaving the close button reachable.
 */

import { test, expect } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

test.describe('Sidebar visibility (mobile drawer)', () => {
  test.beforeEach(async ({ page }) => {
    // Force a short mobile viewport so the responsive CSS picks the drawer
    // layout and the bug surface is visible.
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);
  });

  test('open drawer does not overlap the page header', async ({ page }) => {
    await page.getByRole('button', { name: /open menu/i }).click();
    // Allow the slide-in transition to settle.
    await page.waitForTimeout(300);

    const m = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      const header = document.querySelector('header');
      if (!aside || !header) throw new Error('missing element');
      const a = aside.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      return {
        asideTop: a.top,
        asideBottom: a.bottom,
        headerTop: h.top,
        headerBottom: h.bottom,
        innerHeight: window.innerHeight,
      };
    });

    // Header must remain pinned at top of viewport.
    expect(m.headerTop).toBe(0);

    // Aside must start at or below the header (no overlap with header content
    // such as the X close button or notch safe-area).
    expect(m.asideTop).toBeGreaterThanOrEqual(m.headerBottom);

    // Aside bottom must not extend beyond the visible viewport.
    expect(m.asideBottom).toBeLessThanOrEqual(m.innerHeight);
  });

  test('header X close button is reachable while drawer is open', async ({ page }) => {
    await page.getByRole('button', { name: /open menu/i }).click();
    await page.waitForTimeout(300);

    // The same button toggles between "Open menu" and "Close menu".
    const closeBtn = page.getByRole('button', { name: /close menu/i });
    await expect(closeBtn).toBeVisible();

    // Above all other elements at its viewport coordinate (i.e. nothing
    // covers it). elementFromPoint at the button's center should be the
    // button itself or one of its descendants.
    const isOnTop = await closeBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return hit === el || el.contains(hit);
    });
    expect(isOnTop).toBe(true);
  });
});
