/**
 * E2E spec: sibling-forget flow (TP-91).
 *
 * Covers AC-E2E-2, AC-E2E-11, AC-E2E-12.
 *
 * Topology:
 *  - A1 ("sibling-a1") — User A's bunker, slot "sibling-a1". Group admin.
 *    Creates the group, invites B by npub, then performs sibling-forget on A2
 *    via the Settings → Devices UI.
 *  - A2 ("sibling-a2") — User A's bunker (same key as A1), slot "sibling-a2".
 *    Joins the group via the auto-invite scan (same npub, different slot).
 *    Is the target of the sibling-forget action.
 *  - B  ("observer") — User B's bunker (distinct npub), slot "observer".
 *    Joins the group via Welcome. External observer for post-forget leaf-absence
 *    assertions.
 *
 * Relay-state-independence:
 *  - `authenticate(page, bunkerUrl, slot)` is called with explicit slot strings
 *    so `pinClientSlot` emits a stable, unique clientId per role.
 *  - `authenticate` internally calls `clearAppState` — never called separately.
 *  - `GROUP_NAME` embeds `Date.now()` so each run operates on a fresh group
 *    even if the relay is not wiped.
 *  - No `e2e-down`, `e2e-up`, relay reset, or global-relay-state assertions.
 *
 * Design notes:
 *  - No kind-5 relay assertion: sibling-forget cannot publish kind-5 from A1
 *    because A2's KP secrets belong to A2 (Design Decision #2 in architecture.md).
 *    The slot is marked in A1's `notestr-forgotten-slots` IDB instead.
 *  - After sibling-forget, pubkeyA has exactly 1 leaf (A1's own). The assertion
 *    is `toHaveLength(1)`, not `toHaveLength(0)`.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import {
  authenticate,
  createGroup,
  currentGroupId,
  getPubkeyHex,
  inviteByNpub,
  leafIndexesFor,
  selectGroup,
  settle,
  slotIdentifierFor,
} from "../fixtures/two-party.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const TIMEOUT = 240_000;

// AC-E2E-2: Date.now() group name at the top of the describe.serial block to
// guarantee run isolation — a static name would collide with prior runs' group
// state on the relay and make member-count assertions ambiguous.
const GROUP_NAME = `ForgetSibling ${Date.now()}`;

// AC-E2E-3: explicit slot strings — never omitted or auto-generated.
const SLOT_A1 = "sibling-a1";
const SLOT_A2 = "sibling-a2";
const SLOT_B = "observer";

test.describe.serial("TP-91: sibling-forget (AC-E2E-2, AC-E2E-11, AC-E2E-12)", () => {
  test.setTimeout(TIMEOUT);

  let contextA1: BrowserContext;
  let contextA2: BrowserContext;
  let contextB: BrowserContext;
  let pageA1: Page;
  let pageA2: Page;
  let pageB: Page;

  // AC-E2E-4: propagate skipMobile so subsequent tests in the serial block
  // all short-circuit cleanly without accessing unset shared variables.
  let skipMobile = false;

  let pubkeyA: string;
  let groupId: string;

  test.beforeAll(async ({ browser }, workerInfo) => {
    skipMobile = !!workerInfo.project.use.isMobile;
    if (skipMobile) return;

    contextA1 = await browser.newContext();
    contextA2 = await browser.newContext();
    contextB = await browser.newContext();
    pageA1 = await contextA1.newPage();
    pageA2 = await contextA2.newPage();
    pageB = await contextB.newPage();
  });

  test.afterAll(async () => {
    await contextA1?.close();
    await contextA2?.close();
    await contextB?.close();
  });

  // ---------------------------------------------------------------------------
  // Setup: auth all three contexts, group creation, invites, join
  // ---------------------------------------------------------------------------
  test("setup: A1 creates group, invites B, A2 auto-joins via same-npub scan", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    // B authenticates first so its key package is on the relay before A1 invites.
    // AC-E2E-3: explicit slot "observer" for B.
    await authenticate(pageB, E2E_BUNKER_B_URL, SLOT_B);
    await settle(pageB, 3000);

    // A2 authenticates second so its KP is on the relay for the auto-invite scan
    // that runs when A1 creates the group.
    // AC-E2E-3: explicit slot "sibling-a2" for A2.
    await authenticate(pageA2, E2E_BUNKER_URL, SLOT_A2);
    await settle(pageA2, 3000);

    // A1 authenticates last; as the group creator it will be admin.
    // AC-E2E-3: explicit slot "sibling-a1" for A1.
    await authenticate(pageA1, E2E_BUNKER_URL, SLOT_A1);
    await settle(pageA1, 3000);

    pubkeyA = await getPubkeyHex(pageA1);

    await createGroup(pageA1, GROUP_NAME);
    await inviteByNpub(pageA1, USER_B_NPUB);

    // Wait for the auto-invite scan to process A2's key package (same pubkey as
    // A1, different slot) and issue an invite commit for A2.
    await settle(pageA1, 8000);

    // A2 should surface the group via auto-invite (same npub as A1).
    await selectGroup(pageA2, GROUP_NAME);
    // B should surface the group via Welcome.
    await selectGroup(pageB, GROUP_NAME);

    groupId = await currentGroupId(pageA1);

    // Sanity: A1 and A2 (both pubkeyA) contribute 2 leaves; B contributes 1.
    // Total leaves for pubkeyA should be 2 before the forget.
    await expect
      .poll(() => leafIndexesFor(pageA1, groupId, pubkeyA), { timeout: 30000 })
      .toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Core: sibling-forget flow and assertions (AC-E2E-2, AC-E2E-11, AC-E2E-12)
  // ---------------------------------------------------------------------------
  test("A1 forgets A2: A2 leaf gone from all views, slot in A1's forgotten-slots IDB (AC-E2E-2, AC-E2E-11, AC-E2E-12)", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    // --- Trigger the sibling-forget flow via the Settings UI on A1 ---

    // Open the Settings modal via the aria-label="Settings" button in the header.
    await pageA1.getByRole("button", { name: /settings/i }).first().click();

    // Switch to the "Devices" tab.
    await pageA1.getByRole("tab", { name: /devices/i }).click();

    // Find A2's device row. A2's row is the non-local row (data-local="false")
    // whose text contains A2's slot. S4 added data-testid="device-forget-sibling-btn"
    // to the Forget button on non-local rows.
    //
    // Strategy: scope to the row whose visible text contains the slot identifier,
    // then click its sibling-forget button. If the Devices tab renders exactly one
    // non-local row (a common case in clean test runs), the testid alone suffices.
    const a2Row = pageA1
      .locator('[data-testid="device-row"][data-local="false"]')
      .filter({ hasText: SLOT_A2 });

    // Fall back to the first non-local row if the slot text is not rendered
    // (e.g. the row displays a human-friendly name only).
    const forgetBtn = (await a2Row.count()) > 0
      ? a2Row.locator('[data-testid="device-forget-sibling-btn"]').first()
      : pageA1.locator('[data-testid="device-forget-sibling-btn"]').first();

    await forgetBtn.click();

    // Confirm in the AlertDialog.
    // S4 added data-testid="device-forget-sibling-confirm-btn" to this button.
    await pageA1.locator('[data-testid="device-forget-sibling-confirm-btn"]').click();

    // --- Assertion 1: A2's leaf is gone from A1's view (AC-E2E-2 + AC-E2E-11) ---
    // After sibling-forget, pubkeyA has exactly 1 leaf (A1's own). A2's leaf is
    // removed. toHaveLength(1), not toHaveLength(0), because A1's leaf remains.
    await expect
      .poll(() => leafIndexesFor(pageA1, groupId, pubkeyA), { timeout: 30000 })
      .toHaveLength(1);

    // --- Assertion 2: A2's leaf is gone from B's view (AC-E2E-11) ---
    // Confirms the MLS Remove commit was accepted globally, not only on A1.
    await expect
      .poll(() => leafIndexesFor(pageB, groupId, pubkeyA), { timeout: 30000 })
      .toHaveLength(1);

    // --- Assertion 3: A2's slot is in A1's forgotten-slots IDB (AC-E2E-12) ---
    // The outer `await` covers Playwright's serialization of the inner Promise
    // so there is no race between the IDB write and the hook read.
    //
    // The IDB stores the 64-char hex MIP-00 slot identifier (SHA-256 of
    // "notestr-" + label), not the human-readable label. Use slotIdentifierFor
    // to derive the expected hex so the assertion compares like-for-like.
    const forgottenSlots = await pageA1.evaluate(
      () => window.__notestrTestForgottenSlots?.() ?? Promise.resolve([] as string[]),
    );
    const expectedSlotHex = await slotIdentifierFor(SLOT_A2);
    expect(forgottenSlots).toContain(expectedSlotHex);
  });
});
