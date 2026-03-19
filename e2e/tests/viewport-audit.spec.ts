import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const outDir = '/tmp/viewport-tests';

// Ensure output directory exists
fs.mkdirSync(outDir, { recursive: true });

async function getAccessibilitySnapshot(page: any) {
  try {
    const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
    return JSON.stringify(snapshot, null, 2);
  } catch (e) {
    return `Error getting snapshot: ${e}`;
  }
}

async function getConsoleErrors(page: any) {
  const errors: any[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errors.push({ level: msg.type(), text: msg.text() });
    }
  });
  page.on('pageerror', err => {
    errors.push({ level: 'error', text: err.toString() });
  });
  return errors;
}

test.describe('Viewport Audit', () => {
  test('Desktop 1440x900', async ({ page, context }) => {
    // Set viewport
    await context.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Take screenshot
    await page.screenshot({ path: `${outDir}/01-desktop-1440x900.png`, fullPage: true });

    // Get accessibility snapshot
    const a11y = await getAccessibilitySnapshot(page);
    fs.writeFileSync(`${outDir}/01-desktop-1440x900-accessibility.json`, a11y);

    console.log('✓ Desktop 1440x900 captured');
  });

  test('Tablet 768x1024', async ({ page, context }) => {
    await context.setViewportSize({ width: 768, height: 1024 });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.screenshot({ path: `${outDir}/02-tablet-768x1024.png`, fullPage: true });

    const a11y = await getAccessibilitySnapshot(page);
    fs.writeFileSync(`${outDir}/02-tablet-768x1024-accessibility.json`, a11y);

    console.log('✓ Tablet 768x1024 captured');
  });

  test('Mobile 375x812', async ({ page, context }) => {
    await context.setViewportSize({ width: 375, height: 812 });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.screenshot({ path: `${outDir}/03-mobile-375x812.png`, fullPage: true });

    const a11y = await getAccessibilitySnapshot(page);
    fs.writeFileSync(`${outDir}/03-mobile-375x812-accessibility.json`, a11y);

    console.log('✓ Mobile 375x812 captured');
  });

  test('Small Mobile 320x568', async ({ page, context }) => {
    await context.setViewportSize({ width: 320, height: 568 });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.screenshot({ path: `${outDir}/04-mobile-320x568.png`, fullPage: true });

    console.log('✓ Small Mobile 320x568 captured');
  });

  test('Dark Mode 1440x900', async ({ page, context }) => {
    await context.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Add dark class
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    await page.waitForTimeout(500);

    await page.screenshot({ path: `${outDir}/05-dark-mode-1440x900.png`, fullPage: true });

    const a11y = await getAccessibilitySnapshot(page);
    fs.writeFileSync(`${outDir}/05-dark-mode-1440x900-accessibility.json`, a11y);

    console.log('✓ Dark Mode 1440x900 captured');
  });

  test('Wide Desktop 1920x1080 Dark', async ({ page, context }) => {
    await context.setViewportSize({ width: 1920, height: 1080 });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Add dark class
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
    });

    await page.waitForTimeout(500);

    await page.screenshot({ path: `${outDir}/06-wide-desktop-1920x1080-dark.png`, fullPage: true });

    console.log('✓ Wide Desktop 1920x1080 Dark captured');
  });
});
