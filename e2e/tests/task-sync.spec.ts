/**
 * E2E tests: new-member task-state bootstrap via kind-30078 NIP-44 encrypted event.
 *
 * Feature: After a successful invite, the inviter (A) calls
 * publishTaskStateSync(groupId, recipientPubkey, signer, client, relays) which
 * publishes a kind-30078 NIP-44 encrypted event containing the current task state
 * to B's Nostr pubkey.
 *
 * On first load after joining via a welcome message (isGroupJoinedFromWelcome),
 * B's task store calls fetchAndApplyTaskBootstrap which fetches that event and
 * merges it into the local CRDT — so B sees pre-join tasks within a few seconds
 * of the board loading.
 *
 * TP-30: new member DOES see pre-join tasks (kind-30078 bootstrap path)
 * TP-31: empty group — new member sees an empty board with no error (AC-3)
 */

import { type BrowserContext, type Page } from '@playwright/test';

import { test, expect } from '@playwright/test';
import { E2E_BUNKER_URL } from '../fixtures/auth-helper.js';
import { E2E_BUNKER_B_URL, USER_B_NPUB } from '../fixtures/auth-helper-b.js';
import { clearAppState } from '../fixtures/cleanup.js';

async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto('/');
  await clearAppState(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder('bunker://...').fill(bunkerUrl);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let skipMobile = false;

test.beforeAll(async ({ browser }, workerInfo) => {
  // Multi-context MLS tests need desktop viewport — skip on mobile projects
  skipMobile = !!workerInfo.project.use.isMobile;
  if (skipMobile) return;

  contextA = await browser.newContext();
  contextB = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
});

test.describe.serial('task-sync: new member receives pre-join task bootstrap (TP-30)', () => {
  test.setTimeout(180_000);

  const GROUP_NAME = `TaskSync E2E ${Date.now()}`;
  const TASK_TITLE = `Pre-join task ${Date.now()}`;

  test('User B authenticates first (publishes key package)', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await authenticate(pageB, E2E_BUNKER_B_URL);
    // Wait for key package publication
    await pageB.waitForTimeout(3000);
  });

  test('User A authenticates', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await authenticate(pageA, E2E_BUNKER_URL);
  });

  test('User A creates group and a task', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Create group
    await pageA.getByPlaceholder('Group name').first().fill(GROUP_NAME);
    await pageA.getByRole('button', { name: 'Create', exact: true }).first().click();

    const sidebarA = pageA.locator('aside');
    await expect(sidebarA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });

    // Wait for the task board to appear (group auto-selected)
    await expect(pageA.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

    // Create a task
    await pageA.getByRole('button', { name: 'Add Task' }).click();
    await pageA.getByLabel('Title').fill(TASK_TITLE);
    await pageA.getByRole('button', { name: 'Create', exact: true }).last().click();

    // Verify task appears in Open column for User A
    const openColumn = pageA.locator('[data-column="open"]').first();
    await expect(openColumn).toContainText(TASK_TITLE, { timeout: 15000 });
  });

  test('User A invites User B', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await pageA.getByPlaceholder('npub1...').fill(USER_B_NPUB);
    await pageA.getByRole('button', { name: 'Invite' }).click();

    // Wait for invite to complete — input clears on success
    await expect(pageA.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });

    // Brief settle so the invite and kind-30078 publish have propagated before B reloads.
    await pageA.waitForTimeout(2000);
  });

  test('User B sees the group after joining', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Reload to trigger device-sync welcome fetch
    await pageB.reload();
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });

    const sidebarB = pageB.locator('aside');
    await expect(sidebarB.getByText(GROUP_NAME)).toBeVisible({ timeout: 60000 });
  });

  test('User B sees pre-join task via kind-30078 bootstrap within 5 seconds', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Click on the group to select it
    const sidebarB = pageB.locator('aside');
    await sidebarB.getByText(GROUP_NAME).click();

    // Wait for the task board to load
    await expect(pageB.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

    // AC-1: The pre-join task MUST appear within 5 seconds of the task board loading.
    // The kind-30078 bootstrap payload was published by A after the invite succeeded;
    // B's task store fetches and applies it on first load for a welcome-joined group.
    // Use .last() to target the desktop board column (the mobile single-column
    // panel renders first in DOM order and is display:none on desktop viewports).
    const openColumnB = pageB.locator('[data-column="open"]').last();
    await expect(openColumnB.getByRole('heading', { name: TASK_TITLE, level: 4 })).toBeVisible({ timeout: 5000 });
  });
});

test.describe.serial('task-sync: empty group — new member sees empty board (TP-31)', () => {
  test.setTimeout(180_000);

  const GROUP_NAME_EMPTY = `TaskSync Empty E2E ${Date.now()}`;

  let contextA2: BrowserContext;
  let contextB2: BrowserContext;
  let pageA2: Page;
  let pageB2: Page;

  test.beforeAll(async ({ browser }) => {
    if (skipMobile) return;
    contextA2 = await browser.newContext();
    contextB2 = await browser.newContext();
    pageA2 = await contextA2.newPage();
    pageB2 = await contextB2.newPage();
  });

  test.afterAll(async () => {
    await contextA2?.close();
    await contextB2?.close();
  });

  test('User B2 authenticates first', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await authenticate(pageB2, E2E_BUNKER_B_URL);
    await pageB2.waitForTimeout(3000);
  });

  test('User A2 authenticates', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await authenticate(pageA2, E2E_BUNKER_URL);
  });

  test('User A2 creates empty group (no tasks) and invites User B2', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    // Create group with no tasks
    await pageA2.getByPlaceholder('Group name').first().fill(GROUP_NAME_EMPTY);
    await pageA2.getByRole('button', { name: 'Create', exact: true }).first().click();
    const sidebarA2 = pageA2.locator('aside');
    await expect(sidebarA2.getByText(GROUP_NAME_EMPTY)).toBeVisible({ timeout: 30000 });

    // Invite B2 with no tasks in the group
    await pageA2.getByPlaceholder('npub1...').fill(USER_B_NPUB);
    await pageA2.getByRole('button', { name: 'Invite' }).click();
    await expect(pageA2.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });
    await pageA2.waitForTimeout(2000);
  });

  test('User B2 joins and sees empty task board — no error (AC-3)', async () => {
    test.skip(skipMobile, 'Multi-context MLS tests require desktop viewport');
    await pageB2.reload();
    await pageB2.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
    const sidebarB2 = pageB2.locator('aside');
    await expect(sidebarB2.getByText(GROUP_NAME_EMPTY)).toBeVisible({ timeout: 60000 });
    await sidebarB2.getByText(GROUP_NAME_EMPTY).click();

    // Wait for board to load
    await expect(pageB2.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 });

    // AC-3: empty group — B starts with empty board and no error.
    // The board columns render (no crash) and contain zero task cards.
    // fetchAndApplyTaskBootstrap degrades gracefully when the relay returns
    // an empty payload — no user-facing error is shown.
    // NOTE: .last() targets the visible desktop [data-column="open"] element.
    // .first() would resolve to the hidden mobile single-column panel (first
    // in DOM order), causing toBeVisible to fail on desktop viewports.
    await expect(pageB2.locator('[data-column="open"]').last()).toBeVisible({ timeout: 5000 });
    await expect(pageB2.locator('[data-testid="task-card"]')).toHaveCount(0, { timeout: 5000 });
  });
});
