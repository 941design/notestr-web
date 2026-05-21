/**
 * E2E test: Switching the selected group updates the Members section
 * in the sidebar.
 *
 * Repro for the reported bug — "selecting a group does not alter the
 * group members in sidebar", observed in production with two groups
 * that share the same member count but different identities.
 *
 *   1. User A, B, C all authenticate (publish key packages).
 *   2. User A creates G_AB and invites User B  →  members = { A, B }.
 *   3. User A creates G_AC and invites User C  →  members = { A, C }.
 *   4. User A clicks G_AB  →  Members list must contain B (not C).
 *   5. User A clicks G_AC  →  Members list must contain C (not B).
 *   6. Repeat the toggle  →  must keep flipping accurately.
 *
 * Asserts on member-item TEXT (the displayed pubkey/profile-name slug)
 * rather than just count — count alone could match even with stale data
 * (both groups have 2 members) and miss the underlying bug.
 */

import { test, expect, type Page } from '@playwright/test';
import { E2E_BUNKER_URL, E2E_BUNKER_PUBKEY_HEX } from '../fixtures/auth-helper.js';
import { E2E_BUNKER_B_URL, E2E_BUNKER_B_PUBKEY_HEX, USER_B_NPUB } from '../fixtures/auth-helper-b.js';
import { E2E_BUNKER_C_URL, E2E_BUNKER_C_PUBKEY_HEX, USER_C_NPUB } from '../fixtures/auth-helper-c.js';
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

const TIMEOUT = 180_000;

// Short forms of the pubkeys, as rendered by shortenPubkey()
//   "<first8>...<last4>"
const SHORT_B = `${E2E_BUNKER_B_PUBKEY_HEX.slice(0, 8)}...${E2E_BUNKER_B_PUBKEY_HEX.slice(-4)}`;
const SHORT_C = `${E2E_BUNKER_C_PUBKEY_HEX.slice(0, 8)}...${E2E_BUNKER_C_PUBKEY_HEX.slice(-4)}`;

test.describe('selecting a group updates the sidebar members list', () => {
  test.setTimeout(TIMEOUT);

  test('member identities flip correctly when switching between same-size groups', async ({ browser }, workerInfo) => {
    test.skip(!!workerInfo.project.use.isMobile, 'desktop only — relies on always-visible sidebar');

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const pageC = await ctxC.newPage();

    try {
      // B and C must authenticate first so their key packages are on-relay.
      await authenticate(pageB, E2E_BUNKER_B_URL);
      await authenticate(pageC, E2E_BUNKER_C_URL);
      await pageB.waitForTimeout(3000);
      await pageC.waitForTimeout(3000);

      await authenticate(pageA, E2E_BUNKER_URL);

      const sidebar = pageA.locator('aside').first();
      const membersSection = pageA.locator('[data-testid="members-section"]').first();
      const memberItems = membersSection.locator('[data-testid="member-item"]');

      const G_AB = `G-AB-${Date.now()}`;
      const G_AC = `G-AC-${Date.now()}`;

      // Create G_AB and invite User B
      await pageA.getByPlaceholder('Group name').first().fill(G_AB);
      await pageA.getByRole('button', { name: 'Create', exact: true }).first().click();
      await expect(sidebar.getByText(G_AB)).toBeVisible({ timeout: 30000 });
      await expect(membersSection).toBeVisible({ timeout: 15000 });
      await pageA.getByPlaceholder('npub1...').fill(USER_B_NPUB);
      await pageA.getByRole('button', { name: 'Invite' }).click();
      await expect(pageA.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });
      await expect(memberItems).toHaveCount(2, { timeout: 30000 });

      // Create G_AC and invite User C
      await pageA.getByPlaceholder('Group name').first().fill(G_AC);
      await pageA.getByRole('button', { name: 'Create', exact: true }).first().click();
      await expect(sidebar.getByText(G_AC)).toBeVisible({ timeout: 30000 });
      await pageA.getByPlaceholder('npub1...').fill(USER_C_NPUB);
      await pageA.getByRole('button', { name: 'Invite' }).click();
      await expect(pageA.getByPlaceholder('npub1...')).toHaveValue('', { timeout: 30000 });
      await expect(memberItems).toHaveCount(2, { timeout: 30000 });

      // *** Bug under test ***
      // Click G_AB — Members list must contain B, must NOT contain C.
      await sidebar.getByText(G_AB).click();
      await expect(membersSection).toContainText(SHORT_B, { timeout: 15000 });
      await expect(membersSection).not.toContainText(SHORT_C);

      // Click G_AC — Members list must contain C, must NOT contain B.
      await sidebar.getByText(G_AC).click();
      await expect(membersSection).toContainText(SHORT_C, { timeout: 15000 });
      await expect(membersSection).not.toContainText(SHORT_B);

      // Repeat the toggle once more to catch any one-shot staleness.
      await sidebar.getByText(G_AB).click();
      await expect(membersSection).toContainText(SHORT_B, { timeout: 15000 });
      await expect(membersSection).not.toContainText(SHORT_C);
    } finally {
      await ctxA.close();
      await ctxB.close();
      await ctxC.close();
    }
  });
});
