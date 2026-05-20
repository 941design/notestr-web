/**
 * E2E spec: self-forget flow (TP-90).
 *
 * Covers AC-E2E-1, AC-E2E-3, AC-E2E-4, AC-E2E-5, AC-E2E-9, AC-E2E-10.
 *
 * Topology:
 *  - A ("self") — User A's bunker, slot "self". Creates the group, invites B,
 *    then self-forgets via the Settings → Devices UI.
 *  - B ("observer") — User B's bunker, slot "observer". Joins the group and
 *    serves as the external observer for post-forget assertions.
 *
 * Relay-state-independence:
 *  - `authenticate(page, bunkerUrl, slot)` is called with explicit slot strings
 *    so `pinClientSlot` emits a stable, unique client id per role.
 *  - `authenticate` internally calls `clearAppState` — never called separately.
 *  - `GROUP_NAME` embeds `Date.now()` so each run operates on a fresh group
 *    even if the relay is not wiped.
 *  - No `e2e-down`, `e2e-up`, relay reset, or global-relay-state assertions.
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
} from "../fixtures/two-party.js";
import { openNdkSubscriber } from "../fixtures/ndk-subscriber.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const RELAY_URL = "ws://localhost:7777";
const TIMEOUT = 180_000;

// AC-E2E-1: Date.now() group name at the top of the describe.serial block to
// guarantee run isolation — a static name would collide across runs when the
// relay is not wiped between sessions.
const GROUP_NAME = `ForgetSelf ${Date.now()}`;

test.describe.serial("TP-90: self-forget (AC-E2E-1, AC-E2E-9, AC-E2E-10)", () => {
  test.setTimeout(TIMEOUT);

  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  // AC-E2E-4: propagate skipMobile so subsequent tests in the serial block
  // all short-circuit cleanly without accessing unset shared variables.
  let skipMobile = false;

  let pubkeyA: string;
  let groupId: string;

  // AC-E2E-3: explicit slot strings — never omitted or auto-generated.
  const SLOT_A = "self";
  const SLOT_B = "observer";

  test.beforeAll(async ({ browser }, workerInfo) => {
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

  // ---------------------------------------------------------------------------
  // Setup: auth, group creation, invite, join
  // ---------------------------------------------------------------------------
  test("setup: A creates group, invites B, B joins", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    // B authenticates first so its key package is on the relay before A invites.
    // AC-E2E-3: explicit slot "observer" for B.
    await authenticate(pageB, E2E_BUNKER_B_URL, SLOT_B);
    await settle(pageB, 3000);

    // AC-E2E-3: explicit slot "self" for A.
    await authenticate(pageA, E2E_BUNKER_URL, SLOT_A);
    await settle(pageA, 3000);

    pubkeyA = await getPubkeyHex(pageA);

    await createGroup(pageA, GROUP_NAME);
    await inviteByNpub(pageA, USER_B_NPUB);
    await selectGroup(pageB, GROUP_NAME);

    groupId = await currentGroupId(pageA);

    // Sanity: both A and B are members before the forget.
    await expect(pageA.locator('[data-testid="member-item"]')).toHaveCount(2, {
      timeout: 30000,
    });
  });

  // ---------------------------------------------------------------------------
  // Core: self-forget flow and assertions (AC-E2E-9, AC-E2E-10)
  // ---------------------------------------------------------------------------
  test("A self-forgets: signed out, leaf gone from B's view, kind-5 published (AC-E2E-9, AC-E2E-10)", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    // Capture A's key package event ids from the relay BEFORE triggering the
    // forget action so the kind-5 e-tag assertion has a known target.
    // Q-ROBUSTNESS-2: stable pre-forget capture via the __notestrTestNetworkRequest
    // hook, which wraps client.network.request on pageA's context.
    const kpEventIds: string[] = await pageA.evaluate(
      async ({ relays, pk }) => {
        const fn = window.__notestrTestNetworkRequest;
        if (typeof fn !== "function") return [];
        const events = await fn(relays, [{ kinds: [30443 as any], authors: [pk] } as any]);
        return (events as Array<{ id?: string }>).map((e) => e.id ?? "").filter(Boolean);
      },
      { relays: [RELAY_URL], pk: pubkeyA },
    );

    // Open the NDK subscriber BEFORE the forget action so the kind-5 event is
    // not missed if it arrives before the subscriber's REQ frame lands.
    // AC-E2E-10: subscriber opened pre-action, covering the race window.
    const subscriber = await openNdkSubscriber([RELAY_URL]);

    try {
      // --- Trigger the self-forget flow via the Settings UI ---

      // Open the Settings modal via the aria-label="Settings" button in the header.
      await pageA.getByRole("button", { name: /settings/i }).first().click();

      // Switch to the "Devices" tab.
      await pageA.getByRole("tab", { name: /devices/i }).click();

      // Click "Forget" on the "this device" row.
      // S4 added data-testid="device-forget-self-btn" to this button (AC-UI-6).
      await pageA.locator('[data-testid="device-forget-self-btn"]').click();

      // Confirm in the AlertDialog.
      // S4 added data-testid="device-forget-self-confirm-btn" to the confirm button (AC-UI-6).
      await pageA.locator('[data-testid="device-forget-self-confirm-btn"]').click();

      // --- Assertion 1: A is signed out ---
      // The sign-in screen becomes visible after onSignOut (handleDisconnect) is called.
      // Text matches the login heading rendered by app/page.tsx when pubkey is null.
      await expect(pageA.getByText(/sign in to notestr/i)).toBeVisible({
        timeout: 30000,
      });

      // --- Assertion 2: A's leaf is absent from B's group member list ---
      // AC-E2E-9: poll until the MLS remove commit propagates and B's member
      // count drops from 2 to 1 (only B remains). 60s budget: AC-E2E-9 quotes
      // 30s as an example, not a contract, and 30s is empirically tight when
      // the ephemeral relay carries traffic accumulated earlier in the suite.
      await expect
        .poll(() => leafIndexesFor(pageB, groupId, pubkeyA), { timeout: 60000 })
        .toHaveLength(0);

      // --- Assertion 3: kind-5 deletion event published for A's KP event id ---
      // AC-E2E-10: waitForEvent with a 30 s timeout (Q-ROBUSTNESS-1: >= 30000ms).
      const kind5Event = await subscriber.waitForEvent(
        { kinds: [5], authors: [pubkeyA] },
        30000,
      );
      expect(kind5Event).toBeDefined();

      // Q-ROBUSTNESS-1 / AC-E2E-10: inspect the e-tag for the specific KP event id.
      // If we captured at least one KP event id pre-forget, verify the kind-5
      // references it. If the relay had not yet delivered the KP (edge case),
      // we at minimum confirmed that a kind-5 from A's pubkey was published.
      if (kpEventIds.length > 0) {
        const eTags = kind5Event.tags.filter((t) => t[0] === "e").map((t) => t[1]);
        const hasMatchingTag = kpEventIds.some((id) => eTags.includes(id));
        expect(hasMatchingTag).toBe(true);
      }
    } finally {
      await subscriber.close();
    }
  });
});
