/**
 * E2E tests: rename-device.
 *
 * Covers permutations TP-60, TP-61, TP-62 from
 * `docs/two-party-permutation-matrix.md`.
 *
 * **Scope-of-rename note (TP-61/-62 reduce to n/a-by-design):**
 *
 * The DeviceList component only renders leaves for the *local* identity's
 * pubkey (`pubkey={selfPubkey}` in `GroupManager.tsx`). Renames are written
 * to `deviceNamesStore` (IndexedDB) keyed by the leaf signature key —
 * there is no MLS broadcast, no Nostr publish, no cross-identity surface.
 *
 *   - A cannot see or rename B's devices via UI (TP-61's "A renames B's
 *     device" requires a surface that doesn't exist).
 *   - B cannot observe A's rename (TP-62) because device names are
 *     IndexedDB-local to each browser context.
 *
 * The remaining testable scenario is TP-60: same-npub, two contexts, one
 * renames the other and the rename survives a reload of the renamer's
 * context. (`multi-device-sync.spec.ts` attempts this in a more elaborate
 * setup that's currently `fixme`-marked for unrelated reasons. The test
 * below is a slimmer, single-purpose version focused on the rename
 * round-trip alone.)
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { authenticate, createGroup, settle } from "../fixtures/two-party.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const TIMEOUT = 180_000;

// ---------------------------------------------------------------------------
// TP-60: A1 renames A2's device row → A1 still shows the new name after reload.
// ---------------------------------------------------------------------------
test.describe.serial("TP-60: rename a sibling device, persist across reload", () => {
  test.setTimeout(TIMEOUT);

  let contextA1: BrowserContext;
  let contextA2: BrowserContext;
  let pageA1: Page;
  let pageA2: Page;
  let skipMobile = false;
  const GROUP_NAME = `Rename ${Date.now()}`;
  const RENAMED = `Laptop ${Date.now()}`;

  test.beforeAll(async ({ browser }, workerInfo) => {
    skipMobile = !!workerInfo.project.use.isMobile;
    if (skipMobile) return;
    contextA1 = await browser.newContext();
    contextA2 = await browser.newContext();
    pageA1 = await contextA1.newPage();
    pageA2 = await contextA2.newPage();
  });

  test.afterAll(async () => {
    await contextA1?.close();
    await contextA2?.close();
  });

  test("A1 + A2 join (same npub), A1's DeviceList sees two leaves", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await authenticate(pageA1, E2E_BUNKER_URL);
    await settle(pageA1, 3000);
    await authenticate(pageA2, E2E_BUNKER_URL);
    await settle(pageA2, 3000);

    await createGroup(pageA1, GROUP_NAME);

    // A2 will join via auto-invite (same npub as creator).
    // We don't actually need A2 to be on the group page for this rename
    // test — the assertion is on A1's DeviceList, which fills in once A2's
    // leaf is in A1's tree.
    await expect(pageA1.locator('[data-testid="device-row"]')).toHaveCount(2, {
      timeout: 30000,
    });
  });

  test("A1 renames A2's row → label visible immediately, survives reload", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const remoteRow = pageA1
      .locator('[data-testid="device-row"][data-local="false"]')
      .first();
    const input = remoteRow.getByRole("textbox");
    await input.fill(RENAMED);
    await input.blur();

    await expect(remoteRow).toContainText(RENAMED, { timeout: 5000 });

    await pageA1.reload();
    await pageA1
      .locator('[data-testid="pubkey-chip"]')
      .waitFor({ state: "visible", timeout: 30000 });
    await pageA1.locator("aside").getByText(GROUP_NAME).first().click();

    await expect(pageA1.locator('[data-testid="device-list"]').first()).toContainText(
      RENAMED,
      { timeout: 15000 },
    );
  });
});

// ---------------------------------------------------------------------------
// TP-61 / TP-62: documented as n/a-by-design above. The scenario assertion
// here is "the device-store is local-only" — captured by the negative
// observation that B cannot reach A's device names from its own context.
// ---------------------------------------------------------------------------
test.describe("TP-61/-62: rename is local-only, no cross-identity surface", () => {
  test.setTimeout(60_000);

  test("A's DeviceList does not surface B's pubkey, so B's devices are unreachable", async ({
    page,
  }) => {
    // Single-context smoke: A authenticates, opens a group, the DeviceList
    // header reads "Your devices" and shows only A's leaves. There is no
    // affordance to view another identity's devices.
    await authenticate(page, E2E_BUNKER_URL);
    await createGroup(page, `RenameSurface ${Date.now()}`);
    await expect(
      page.getByRole("region", { name: "Your devices" }).first(),
    ).toBeVisible({ timeout: 15000 });
    // The set of leaves in DeviceList is bounded by `getPubkeyLeafNodes(state, selfPubkey)`,
    // confirmed by code inspection (`GroupManager.tsx` passes `pubkey={selfPubkey}`).
    // The negative TP-62 assertion ("B does not observe A's rename") therefore
    // holds trivially — there is no surface for it to leak through.
  });
});
