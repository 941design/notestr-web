/**
 * E2E tests: Multi-user group invite flow.
 *
 * Uses two separate browser contexts with distinct bunker identities:
 * - User A: bunker keypair (7d556f5a..., rotated 2026-04-30)
 * - User B: second keypair (645b5c22..., rotated 2026-04-30)
 *
 * Precondition: both bunkers running (globalSetup), relay up (make e2e-up).
 *
 * Suite structure:
 * - `describe.serial('multi-user setup')` — auth, invite, group-visible.
 *   Each step is an outcome dependency for the next, so skip-on-failure
 *   cascade is the correct behavior here.
 * - `describe.serial('task created by User A')` — A creates, B observes via
 *   live MLS or device-sync. Both tests live in one serial block so they
 *   share one task creation (avoiding duplicate tasks on the board).
 * - `describe.serial('task moved by User B')` — A creates, B moves, A observes
 *   via live MLS or device-sync. Serial for the same reason.
 *
 * Cross-describe ordering relies on `fullyParallel: false` + `workers: 1`
 * in playwright.config.ts. If a setup describe fails, subsequent
 * describes' `beforeAll` will fail too — that's an acceptable signal
 * shape (real outcome dependency across describes), just not a skip.
 */

import { type BrowserContext, type Page } from '@playwright/test';

import { test, expect } from '@playwright/test';
import {
  spawnSpecBunker,
  type SpecBunkerHandle,
} from '../fixtures/spec-bunker.js';
import { clearAppState } from '../fixtures/cleanup.js';

// Helper: authenticate in a given page via bunker URL
async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto('/');
  await clearAppState(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder('bunker://...').fill(bunkerUrl);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}

// Declare shared state for the two-context test flow
let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
// Per-spec bunkers — see e2e/fixtures/spec-bunker.ts.
let bunkerA: SpecBunkerHandle;
let bunkerB: SpecBunkerHandle;
let skipMobile = false;

// Stable identifiers shared across the sibling describes.
const GROUP_NAME = `Multi-User E2E ${Date.now()}`;
const TASK_TITLE = `Sync task ${Date.now()}`;

const SKIP_MOBILE_REASON = 'Multi-context MLS tests require desktop viewport';

test.beforeAll(async ({ browser }, workerInfo) => {
  // Multi-context MLS tests need desktop viewport — skip on mobile projects
  skipMobile = !!workerInfo.project.use.isMobile;
  if (skipMobile) return;

  [bunkerA, bunkerB] = await Promise.all([
    spawnSpecBunker('multi-user-A'),
    spawnSpecBunker('multi-user-B'),
  ]);

  // Create two isolated browser contexts (separate storage)
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
  await bunkerA?.dispose();
  await bunkerB?.dispose();
});

// Multi-user MLS tests are inherently slow (crypto + relay roundtrips)
const MULTI_USER_TIMEOUT = 120_000;

test.describe.serial('multi-user setup', () => {
  test.setTimeout(MULTI_USER_TIMEOUT);

  test('Both users authenticate (User B publishes key package)', async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // User B must authenticate first so their key package is published
    // to the relay before User A tries to invite them.
    await authenticate(pageB, bunkerB.bunkerUrl);

    // Wait for key package to be published (MarmotProvider publishes on init)
    await pageB.waitForTimeout(3000);

    await authenticate(pageA, bunkerA.bunkerUrl);
  });

  test('User A creates group and invites User B', async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // Create group
    await pageA.getByPlaceholder('Group name').first().fill(GROUP_NAME);
    await pageA.getByRole('button', { name: 'Create', exact: true }).first().click();

    const sidebarA = pageA.locator('aside');
    await expect(sidebarA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

    // Invite User B by npub
    await pageA.getByPlaceholder('npub1...').fill(bunkerB.npub);
    await pageA.getByRole('button', { name: 'Invite' }).click();

    // Wait for invite to complete — input clears on success
    await expect(pageA.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });

    // Give B time to receive the invite and establish MLS subscription.
    // Without this, the subsequent describe's beforeAll may race B's live
    // subscription and the "Tasks" heading may not yet be present.
    await pageA.waitForTimeout(5000);
  });

  test('User B sees the group after the invite', async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // B stays live (no reload) so the MLS subscription remains active.
    if (pageB.isClosed()) { pageB = await contextB.newPage(); await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 }); }
    await pageB.locator('aside').getByText(GROUP_NAME).click({ timeout: 15000 });
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 30000 });
    // Ensure MarmotClient is fully loaded before next describe's beforeAll runs.
    // Without this, the subsequent beforeAll may race the stateChanged listener
    // setup and find the group in an incomplete state.
    await pageB.waitForTimeout(2000);
  });
});

test.describe.serial('task created by User A', () => {
  test.setTimeout(MULTI_USER_TIMEOUT);

  test.beforeAll(async () => {
    if (skipMobile) return;

    // Guard: pages may have been closed by a previous test's timeout or crash.
    if (pageA.isClosed()) {
      pageA = await contextA.newPage();
      await pageA.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
    }
    if (pageB.isClosed()) {
      pageB = await contextB.newPage();
      await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
    }

    // Re-navigate to the group.
    await pageA.locator('aside').getByText(GROUP_NAME).click({ timeout: 15000 });
    await expect(pageA.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15000 });

    // Dispatch task creation directly. Bypasses the UI form path which can
    // time out under relay load. The assertions below verify propagation.
    const pubkeyA = await pageA.evaluate(() => {
      const fn = (window as { __notestrTestPubkey?: () => string }).__notestrTestPubkey;
      return fn ? fn() : null;
    });
    const now = Math.floor(Date.now() / 1000);
    await pageA.evaluate(
      async (data: { id: string; title: string; pk: string; now: number }) => {
        const fn = (window as { __notestrTestDispatchTaskEvent?: (e: unknown) => Promise<void> }).__notestrTestDispatchTaskEvent;
        if (!fn) throw new Error('__notestrTestDispatchTaskEvent not installed');
        await fn({
          type: 'task.created',
          task: {
            id: data.id,
            title: data.title,
            description: '',
            status: 'open',
            assignee: null,
            createdBy: data.pk,
            createdAt: data.now,
            updatedAt: data.now,
            updatedBy: data.pk,
          },
        });
      },
      { id: TASK_TITLE, title: TASK_TITLE, pk: pubkeyA!, now },
    );
    // Wait for dispatch → optimistic apply → React render.
    await pageA.locator('[data-testid="board"] [data-testid="task-card"]').first().waitFor({ state: 'visible', timeout: 20000 });

    // Position User B on the group board.
    await pageB.locator('aside').getByText(GROUP_NAME).click({ timeout: 15000 });
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15000 });
  });

  test('User B sees the task via live MLS subscription', async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // Strict live-delivery assertion. Under heavy parallel relay load
    // this can flake (the kind-445 commit is occasionally missed); CI
    // retries cover that. Persistent failures here are a real regression
    // in live MLS delivery.
    // Use .last() to target the visible desktop column (mobile panel is display:none).
    const openColumnB = pageB.locator('[data-column="open"]').last();
    await expect(openColumnB.getByRole('heading', { name: TASK_TITLE, level: 4 })).toBeVisible({ timeout: 30000 });
  });

  test('User B sees the task after reload (device-sync recovery path)', async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // Independent assertion: even if live delivery missed, a reload
    // must re-fetch via device-sync and re-initialize MLS state to
    // surface the task. Failure here means MLS replay is broken.
    //
    // Use close() instead of reload() so context is fresh. The context retains
    // auth state (localStorage) so the new page is immediately authenticated.
    const prevClosed = pageB.isClosed();
    if (!prevClosed) { try { await pageB.close(); } catch { /* already gone */ } }
    pageB = await contextB.newPage();
    await pageB.goto('/');
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 60000 });
    await pageB.waitForTimeout(8000);
    await pageB.locator('aside').getByText(GROUP_NAME).click({ timeout: 15000 });
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15000 });
    const openColumnB = pageB.locator('[data-column="open"]').last();
    await expect(openColumnB.getByRole('heading', { name: TASK_TITLE, level: 4 })).toBeVisible({ timeout: 30000 });
  });
});

test.describe.serial('task moved by User B', () => {
  test.setTimeout(MULTI_USER_TIMEOUT);

  test.beforeAll(async () => {
    if (skipMobile) return;

    // Guard: pages may have been closed by a previous test's timeout.
    if (pageA.isClosed()) {
      pageA = await contextA.newPage();
      await pageA.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
    }
    if (pageB.isClosed()) {
      pageB = await contextB.newPage();
      await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
    }

    // Ensure both pages are on the group board.
    await pageA.locator('aside').getByText(GROUP_NAME).click({ timeout: 15000 });
    await expect(pageA.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15000 });
    await pageB.locator('aside').getByText(GROUP_NAME).click({ timeout: 15000 });
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15000 });

    // B moves the task to in_progress. Scope to board to avoid any
    // mobile panel elements that could match on desktop viewport.
    await pageB
      .locator('[data-testid="board"]')
      .getByRole('button', { name: /Move to In Progress/i })
      .click({ timeout: 15000 });
    await expect(
      pageB.locator('[data-column="in_progress"] [data-testid="task-card"]'),
    ).toHaveCount(1, { timeout: 15000 });
  });

  test('User A sees the move via live MLS subscription', async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // Use .last() to target the visible desktop column.
    await expect(
      pageA.locator('[data-column="in_progress"]').last().locator('[data-testid="task-card"]'),
    ).toHaveCount(1, { timeout: 30000 });
  });

  test('User A sees the move after reload (device-sync recovery path)', async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    // Use close() instead of reload() so context is fresh. The context retains
    // auth state so the new page is immediately authenticated.
    const prevClosed = pageA.isClosed();
    if (!prevClosed) { try { await pageA.close(); } catch { /* already gone */ } }
    pageA = await contextA.newPage();
    await pageA.goto('/');
    await pageA.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 60000 });
    await pageA.waitForTimeout(8000);
    await pageA.locator('aside').getByText(GROUP_NAME).click({ timeout: 15000 });
    await expect(pageA.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15000 });
    await expect(
      pageA.locator('[data-column="in_progress"] [data-testid="task-card"]'),
    ).toHaveCount(1, { timeout: 30000 });
  });
});
