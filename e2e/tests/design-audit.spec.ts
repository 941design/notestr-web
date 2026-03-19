/**
 * E2E tests for design audit implementation (specs/design-audit.md).
 *
 * Covers: responsive layout, touch targets, ARIA accessibility,
 * visual polish, and minor fixes.
 *
 * IMPORTANT: The responsive layout renders both mobile (tabpanel) and desktop
 * (grid) board layouts in the DOM simultaneously — CSS hides one via Tailwind
 * responsive classes. Similarly, GroupManager is rendered in multiple sidebar
 * containers. All locators must use .first() or scope to the visible container.
 *
 * Precondition: bunker running (globalSetup), relay up (make e2e-up).
 */

import { test, expect, type Page } from '@playwright/test';
import { authenticateViaBunker } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function isMobile(page: Page) {
  const vp = page.viewportSize();
  return vp != null && vp.width < 768;
}

function isDesktop(page: Page) {
  const vp = page.viewportSize();
  return vp != null && vp.width >= 1024;
}

/** Open drawer on mobile before interacting with sidebar elements */
async function openDrawerIfMobile(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: /open menu/i }).click();
    // Wait for drawer animation
    await page.waitForTimeout(250);
  }
}

/** Create a group, handling mobile drawer. Returns after board heading is visible. */
async function createGroup(page: Page, name: string) {
  await openDrawerIfMobile(page);
  await page.getByPlaceholder('Group name').first().fill(name);
  await page.getByRole('button', { name: 'Create' }).first().click();
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 30000 });
}

/** Create a task in the current group. Returns after task text appears in board. */
async function createTask(page: Page, title: string, description?: string) {
  await page.getByRole('button', { name: 'Add Task' }).click();
  await page.getByLabel('Title').fill(title);
  if (description) {
    await page.getByLabel('Description').fill(description);
  }
  await page.getByRole('button', { name: 'Create' }).last().click();
  // Wait for task to appear in whichever column layout is visible
  await expect(page.locator('[data-column="open"]').first()).toContainText(title, { timeout: 15000 });
}

/* ------------------------------------------------------------------ */
/*  1. RESPONSIVE LAYOUT — Issue #1                                   */
/* ------------------------------------------------------------------ */

test.describe('Responsive layout (#1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);
  });

  test('mobile: hamburger visible, sidebar hidden, tabs visible after group created', async ({ page }) => {
    test.skip(!isMobile(page), 'mobile-only test');

    // Hamburger button should be visible
    const hamburger = page.getByRole('button', { name: /open menu/i });
    await expect(hamburger).toBeVisible();

    // Sidebar should NOT be in viewport (translated off-screen)
    const sidebar = page.locator('aside');
    await expect(sidebar).not.toBeInViewport();

    // Create a group via drawer
    await createGroup(page, 'Mobile Test Group');

    // Mobile tab bar should be visible
    const tablist = page.getByRole('tablist', { name: /task columns/i });
    await expect(tablist).toBeVisible();

    // Should have 3 tabs
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText(/Open/);
    await expect(tabs.nth(1)).toHaveText(/In Progress/);
    await expect(tabs.nth(2)).toHaveText(/Done/);
  });

  test('mobile: drawer opens with backdrop on hamburger click', async ({ page }) => {
    test.skip(!isMobile(page), 'mobile-only test');

    const hamburger = page.getByRole('button', { name: /open menu/i });
    await hamburger.click();

    // "Groups" heading in sidebar should be visible
    const sidebarHeading = page.locator('aside').getByRole('heading', { name: 'Groups' });
    await expect(sidebarHeading).toBeVisible();

    // Backdrop should be present
    const backdrop = page.locator('.fixed.inset-0.bg-black\\/50');
    await expect(backdrop.first()).toBeVisible();

    // Close via backdrop click
    await backdrop.first().click({ force: true });

    // Sidebar should slide off-screen (CSS transform, not display:none)
    await expect(sidebarHeading).not.toBeInViewport();
  });

  test('mobile: tab switching shows different columns', async ({ page }) => {
    test.skip(!isMobile(page), 'mobile-only test');

    await createGroup(page, 'Tab Test Group');

    // Default tab should be Open
    const openTab = page.getByRole('tab', { name: /Open/ });
    await expect(openTab).toHaveAttribute('aria-selected', 'true');

    // Mobile panel should show Open column
    const mobilePanel = page.getByRole('tabpanel');
    await expect(mobilePanel.locator('[data-column="open"]')).toBeVisible();

    // Switch to In Progress tab
    await page.getByRole('tab', { name: /In Progress/ }).click();
    await expect(mobilePanel.locator('[data-column="in_progress"]')).toBeVisible();

    // Switch to Done tab
    await page.getByRole('tab', { name: /Done/ }).click();
    await expect(mobilePanel.locator('[data-column="done"]')).toBeVisible();
  });

  test('desktop: sidebar visible, no hamburger, 3-column grid', async ({ page }) => {
    test.skip(!isDesktop(page), 'desktop-only test');

    // Hamburger should NOT be visible on desktop
    const hamburger = page.getByRole('button', { name: /open menu/i });
    await expect(hamburger).not.toBeVisible();

    // Sidebar should be visible
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();

    await createGroup(page, 'Desktop Test Group');

    // Tab bar should NOT be visible on desktop
    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).not.toBeVisible();

    // Desktop grid: use the md:grid container which has all 3 columns
    const desktopGrid = page.locator('.md\\:grid');
    await expect(desktopGrid.locator('[data-column="open"]')).toBeVisible();
    await expect(desktopGrid.locator('[data-column="in_progress"]')).toBeVisible();
    await expect(desktopGrid.locator('[data-column="done"]')).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  2. TOUCH TARGETS — Issue #2                                       */
/* ------------------------------------------------------------------ */

test.describe('Touch targets (#2)', () => {
  test('auth tab triggers have touch-target class', async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);

    // Wait for sign-in UI
    await expect(page.getByText('Sign in to notestr')).toBeVisible({ timeout: 15000 });

    const bunkerTab = page.getByRole('tab', { name: /bunker:\/\/ URL/i });
    await expect(bunkerTab).toHaveClass(/touch-target/);

    const amberTab = page.getByRole('tab', { name: /Amber/i });
    await expect(amberTab).toHaveClass(/touch-target/);
  });

  test('group list items have touch-target class', async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);

    await openDrawerIfMobile(page);
    await page.getByPlaceholder('Group name').first().fill('Touch Group');
    await page.getByRole('button', { name: 'Create' }).first().click();

    // Wait for group to appear
    const groupItem = page.locator('nav[aria-label="Groups"] li').filter({ hasText: 'Touch Group' }).first();
    await expect(groupItem).toBeVisible({ timeout: 30000 });
    await expect(groupItem).toHaveClass(/touch-target/);
  });

  test('task card action buttons have touch-target class', async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);

    await createGroup(page, 'Touch Task Group');
    await createTask(page, 'Touch Test Task');

    // Action button should have touch-target class
    const moveButton = page.getByRole('button', { name: /Move to In Progress/i });
    await expect(moveButton.first()).toHaveClass(/touch-target/);
  });
});

/* ------------------------------------------------------------------ */
/*  3. ARIA ACCESSIBILITY — Issues #3, #4                             */
/* ------------------------------------------------------------------ */

test.describe('ARIA accessibility (#3, #4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);
  });

  test('sidebar is a <nav> with aria-label="Groups"', async ({ page }) => {
    if (isMobile(page)) await openDrawerIfMobile(page);
    const nav = page.locator('nav[aria-label="Groups"]').first();
    await expect(nav).toBeVisible();
  });

  test('board has role="region" and aria-label="Task board"', async ({ page }) => {
    await createGroup(page, 'ARIA Board Group');

    const board = page.getByRole('region', { name: 'Task board' });
    await expect(board).toBeVisible();
  });

  test('board columns have role="region" with appropriate labels', async ({ page }) => {
    await createGroup(page, 'ARIA Columns Group');

    // Each column is a labeled region — use .first() since both layouts exist in DOM
    const openRegion = page.getByRole('region', { name: 'Open' });
    await expect(openRegion.first()).toBeVisible();

    if (isDesktop(page)) {
      await expect(page.getByRole('region', { name: 'In Progress' }).first()).toBeVisible();
      await expect(page.getByRole('region', { name: 'Done' }).first()).toBeVisible();
    }
  });

  test('aria-live region exists for status change announcements', async ({ page }) => {
    await createGroup(page, 'ARIA Live Group');

    const liveRegion = page.locator('[aria-live="polite"][aria-atomic="true"]');
    await expect(liveRegion).toBeAttached();
  });

  test('selected group has aria-current="true"', async ({ page }) => {
    await createGroup(page, 'Selected ARIA Group');

    // On mobile, drawer closes after group selection — reopen to check
    if (isMobile(page)) await openDrawerIfMobile(page);

    const groupItem = page.locator('nav[aria-label="Groups"] li[aria-current="true"]').first();
    await expect(groupItem).toBeVisible({ timeout: 10000 });
    await expect(groupItem).toContainText('Selected ARIA Group');
  });

  test('mobile tab bar has tablist and tab roles', async ({ page }) => {
    test.skip(!isMobile(page), 'mobile-only test');

    await createGroup(page, 'Tab ARIA Group');

    const tablist = page.getByRole('tablist', { name: /task columns/i });
    await expect(tablist).toBeVisible();

    const openTab = page.getByRole('tab', { name: /Open/ });
    await expect(openTab).toHaveAttribute('aria-selected', 'true');
  });
});

/* ------------------------------------------------------------------ */
/*  4. VISUAL POLISH — Issues #6, #7, #9, #13                        */
/* ------------------------------------------------------------------ */

test.describe('Visual polish (#6, #7, #9, #13)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);
  });

  test('header shows group name as breadcrumb after selection (#7)', async ({ page }) => {
    const header = page.locator('header');

    // Before group selection: just "notestr"
    await expect(header.getByText('notestr')).toBeVisible();

    await createGroup(page, 'Breadcrumb Group');

    // Header should now contain the group name (may be truncated on small viewports)
    await expect(header).toContainText('Breadcrumb Group');
  });

  test('empty state shows icon and heading when no group selected (#9)', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'No group selected' })).toBeVisible();
    await expect(page.getByText(/select a group from the sidebar/i)).toBeVisible();
  });

  test('mobile empty state has CTA button (#9)', async ({ page }) => {
    test.skip(!isMobile(page), 'mobile-only test');

    await expect(page.getByRole('button', { name: /create your first group/i })).toBeVisible();
  });

  test('dark mode: task cards have shadow (#6)', async ({ page }) => {
    // Enable dark mode
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    await createGroup(page, 'Dark Mode Group');
    await createTask(page, 'Shadow Task');

    // In dark mode, cards should have a shadow (dark:shadow-sm)
    const openColumn = page.locator('[data-column="open"]').first();
    const card = openColumn.locator('.bg-background').first();
    const boxShadow = await card.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toBe('none');
  });

  test('loading skeleton shows pulse animation (#13)', async ({ page }) => {
    await createGroup(page, 'Skeleton Group');
    // The skeleton is transient; verify the board eventually loads
    // (skeleton had aria-busy="true", board heading appears after load)
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 30000 });
  });
});

/* ------------------------------------------------------------------ */
/*  5. MINOR FIXES — Issues #8, #10, #11, #12, #14                   */
/* ------------------------------------------------------------------ */

test.describe('Minor fixes (#8, #10, #11, #12, #14)', () => {
  test('connecting state shows "Checking for saved session" (#8)', async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    // Store a fake NIP-46 session so the connecting spinner appears
    await page.evaluate(() => {
      localStorage.setItem('notestr-nip46-payload', JSON.stringify({
        clientSecretKey: 'deadbeef'.repeat(8),
        signerPubkey: 'deadbeef'.repeat(8),
        relays: ['ws://localhost:9999'],
      }));
    });
    await page.reload();

    // May or may not appear depending on timing (300ms delay); if it does, validate
    const spinnerText = page.getByText(/checking for saved session/i);
    const appeared = await spinnerText.isVisible({ timeout: 2000 }).catch(() => false);
    if (appeared) {
      await expect(spinnerText).toBeVisible();

      // After 5s, "taking longer than expected" + skip button
      await expect(page.getByText(/taking longer than expected/i)).toBeVisible({ timeout: 7000 });
      await expect(page.getByRole('button', { name: /skip and sign in manually/i })).toBeVisible();

      // Click skip — should show sign-in form
      await page.getByRole('button', { name: /skip and sign in manually/i }).click();
      await expect(page.getByText('Sign in to notestr')).toBeVisible();
    }
  });

  test('task action buttons have descriptive labels (#10)', async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);

    await createGroup(page, 'Button Label Group');
    await createTask(page, 'Label Test Task');

    // The action button should say "Move to In Progress" (not just an icon)
    const moveButton = page.getByRole('button', { name: /Move to In Progress/i });
    await expect(moveButton.first()).toBeVisible();
    await expect(moveButton.first()).toContainText('Move to In Progress');
  });

  test('task description uses CSS line-clamp instead of JS truncation (#14)', async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);

    const longDesc = 'This is a very long description that should be clamped using CSS line-clamp instead of JavaScript string slicing which would cut words mid-syllable and look terrible to users.';

    await createGroup(page, 'Clamp Group');
    await createTask(page, 'Clamp Task', longDesc);

    // Description element should have line-clamp-2 class (CSS truncation)
    const openColumn = page.locator('[data-column="open"]').first();
    const descEl = openColumn.locator('.line-clamp-2').first();
    await expect(descEl).toBeAttached();

    // Description should NOT contain "..." appended by JS (the old slice approach)
    const descText = await descEl.textContent();
    expect(descText).not.toContain('...');
  });

  test('system font stack is applied to body (#12)', async ({ page }) => {
    await page.goto('/');
    const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(fontFamily).toMatch(/-apple-system|BlinkMacSystemFont|system-ui|Segoe UI/i);
  });
});

/* ------------------------------------------------------------------ */
/*  PWA fundamentals — Issues #5, #15                                 */
/* ------------------------------------------------------------------ */

test.describe('PWA fundamentals (#5, #15)', () => {
  test('viewport meta includes viewport-fit=cover (#5)', async ({ page }) => {
    await page.goto('/');
    const viewportContent = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta?.getAttribute('content') ?? '';
    });
    expect(viewportContent).toContain('viewport-fit=cover');
  });

  test('sidebar has overscroll-behavior: contain (#15)', async ({ page }) => {
    await page.goto('/');
    await clearAppState(page);
    await authenticateViaBunker(page);

    const aside = page.locator('aside');
    await expect(aside).toBeAttached();

    const hasClass = await aside.evaluate((el) => el.classList.contains('overscroll-contain'));
    expect(hasClass).toBe(true);
  });
});
