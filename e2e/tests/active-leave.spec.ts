/**
 * E2E tests: leave-group as an active (attached) member, plus re-invite.
 *
 * Covers permutations TP-40, TP-41, TP-42 from
 * `docs/two-party-permutation-matrix.md`.
 *
 * Notes on protocol behaviour:
 *
 *  - `client.groups.leave()` publishes a self-remove *proposal* per leaf and
 *    then destroys local state. RFC 9420 §12.4 forbids a member from
 *    committing a Remove targeting their own leaf, so the proposal sits on
 *    the relay until the next admin commit picks it up.
 *  - There is no auto-commit on the admin side today. That means `A` keeps
 *    `B` in its member view until `A` explicitly commits a Remove.
 *  - Re-invite via the npub flow re-fetches `B`'s current key package and
 *    issues a fresh Welcome, which `B` accepts as a new join.
 *
 * The test intentionally limits itself to behaviour that's actually
 * observable today (B's local-state purge, B's sidebar drop, and re-invite
 * propagating again). Member-count shrinkage on A's side after B's leave
 * proposal is left as a `fixme` until an auto-commit story exists.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import {
  authenticate,
  createGroup,
  inviteByNpub,
  leaveGroup,
  reload,
  selectGroup,
  settle,
} from "../fixtures/two-party.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const TIMEOUT = 120_000;

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;
let skipMobile = false;

const GROUP_NAME = `ActiveLeave ${Date.now()}`;

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

test.describe.serial("active-leave: setup", () => {
  test.setTimeout(TIMEOUT);

  test("auth, group, invite — both ready", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await settle(pageB, 3000);
    await authenticate(pageA, E2E_BUNKER_URL);

    await createGroup(pageA, GROUP_NAME);
    await inviteByNpub(pageA, USER_B_NPUB);

    await selectGroup(pageB, GROUP_NAME);
  });
});

// ---------------------------------------------------------------------------
// TP-40: B.Lg ⇒ B⊥g, A⟂g (group still present on A's side)
// ---------------------------------------------------------------------------
test.describe("TP-40: B leaves an attached group", () => {
  test.setTimeout(TIMEOUT);

  test("B's sidebar no longer shows the group; A's still does", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const sidebarB = pageB.locator("aside");
    await expect(sidebarB.getByText(GROUP_NAME).first()).toBeVisible();

    await leaveGroup(pageB, GROUP_NAME);

    await expect(sidebarB.getByText(GROUP_NAME).first()).not.toBeVisible({
      timeout: 15000,
    });

    // A still has the group locally — the leave is a proposal, not a commit.
    await expect(pageA.locator("aside").getByText(GROUP_NAME).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test.fixme(
    "A's member list shrinks to {A} once the leave proposal is committed",
    async () => {
      // No auto-commit on the admin side today. When auto-commit (or an
      // explicit "process pending proposals" UI) lands, this assertion
      // should pass without further intervention.
      const memberItems = pageA.locator('[data-testid="member-item"]');
      await expect(memberItems).toHaveCount(1, { timeout: 30000 });
    },
  );
});

// ---------------------------------------------------------------------------
// TP-41: A.In(B) again ⇒ B⟂g
// ---------------------------------------------------------------------------
test.describe("TP-41: re-invite after leave", () => {
  test.setTimeout(TIMEOUT);

  test("A re-invites B → B sees the group again", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    // The npub-invite flow re-fetches B's current key package and issues a
    // fresh Welcome. The previous (stale) leaf for B may still be in A's
    // tree until a commit removes it; the new Welcome creates a *new* leaf.
    await inviteByNpub(pageA, USER_B_NPUB);

    // B reloads to trigger device-sync welcome fetch.
    await reload(pageB);

    const sidebarB = pageB.locator("aside");
    await expect(sidebarB.getByText(GROUP_NAME).first()).toBeVisible({
      timeout: 60000,
    });
  });
});
