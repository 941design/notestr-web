/**
 * E2E tests: three-party scenarios.
 *
 * Covers permutations TP-70..TP-72 from
 * `docs/two-party-permutation-matrix.md`.
 *
 * **Protocol note:** MIP-03 restricts commits to group admins. The notestr-web
 * UI does not promote invitees to admin, so a non-admin invitee `B` cannot
 * directly invite `C` — `inviteByKeyPackageEvent` requires a commit and would
 * throw "Not a group admin. Cannot commit proposals." That blocks the chain
 * variant of TP-70 (`A.In(B) → B.In(C)`); the chain test below is therefore
 * `fixme`-marked and the active variant exercises a three-party group reached
 * via two admin-issued invites (`A.In(B)` and `A.In(C)`).
 *
 * The product can light up the chain variant later by either (a) supporting
 * "promote to admin" or (b) auto-committing pending Add proposals from
 * non-admin members on the admin's side. When that ships, flip the
 * `test.fixme` to a real `test`.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import { E2E_BUNKER_C_URL, USER_C_NPUB } from "../fixtures/auth-helper-c.js";
import {
  authenticate,
  createGroup,
  dispatchTaskEvent,
  getPubkeyHex,
  inviteByNpub,
  selectGroup,
  settle,
} from "../fixtures/two-party.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const TIMEOUT = 180_000;

let contextA: BrowserContext;
let contextB: BrowserContext;
let contextC: BrowserContext;
let pageA: Page;
let pageB: Page;
let pageC: Page;
let skipMobile = false;
let pubkeyA: string;
const GROUP_NAME = `ThreeParty ${Date.now()}`;

test.beforeAll(async ({ browser }, workerInfo) => {
  skipMobile = !!workerInfo.project.use.isMobile;
  if (skipMobile) return;
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  contextC = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  pageC = await contextC.newPage();
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
  await contextC?.close();
});

test.describe.serial("TP-70 (admin variant): A.In(B), A.In(C) → both see g", () => {
  test.setTimeout(TIMEOUT);

  test("auth all three users (B and C publish key packages first)", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await settle(pageB, 3000);
    await authenticate(pageC, E2E_BUNKER_C_URL);
    await settle(pageC, 3000);
    await authenticate(pageA, E2E_BUNKER_URL);
    pubkeyA = await getPubkeyHex(pageA);
  });

  test("A creates group, invites B, invites C → B and C both see g", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    await createGroup(pageA, GROUP_NAME);
    await inviteByNpub(pageA, USER_B_NPUB);
    await inviteByNpub(pageA, USER_C_NPUB);

    await selectGroup(pageB, GROUP_NAME);
    await selectGroup(pageC, GROUP_NAME);

    // A's member list: {A, B, C}
    await expect(pageA.locator('[data-testid="member-item"]')).toHaveCount(3, {
      timeout: 30000,
    });
  });
});

// ---------------------------------------------------------------------------
// TP-71: A.Ct(t1) ⇒ B⟂t1 ∧ C⟂t1
// ---------------------------------------------------------------------------
test.describe("TP-71: A's task lands on both B and C", () => {
  test.setTimeout(TIMEOUT);

  test("a task A creates is visible on both invitees", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const t1 = crypto.randomUUID();
    const title = `Three-party ${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    await dispatchTaskEvent(pageA, {
      type: "task.created",
      task: {
        id: t1,
        title,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyA,
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(pageB.locator('[data-column="open"]').first()).toContainText(title, {
      timeout: 30000,
    });
    await expect(pageC.locator('[data-column="open"]').first()).toContainText(title, {
      timeout: 30000,
    });
  });
});

// ---------------------------------------------------------------------------
// TP-72: a task created by C lands on both A and B (both predecessors).
// ---------------------------------------------------------------------------
test.describe("TP-72: a task by C lands on A and B", () => {
  test.setTimeout(TIMEOUT);

  test("C creates → both A and B observe", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);
    const pubkeyC = await getPubkeyHex(pageC);
    const t = crypto.randomUUID();
    const title = `From C ${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    await dispatchTaskEvent(pageC, {
      type: "task.created",
      task: {
        id: t,
        title,
        description: "",
        status: "open",
        assignee: null,
        createdBy: pubkeyC,
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(pageA.locator('[data-column="open"]').first()).toContainText(title, {
      timeout: 30000,
    });
    await expect(pageB.locator('[data-column="open"]').first()).toContainText(title, {
      timeout: 30000,
    });
  });
});

// ---------------------------------------------------------------------------
// TP-70 (chain variant): A.In(B) → B.In(C) → C⟂g
// Blocked by MIP-03 admin-only-commits and the absence of a "promote to
// admin" UI. Re-enable when admin promotion or auto-commit-of-Add ships.
// ---------------------------------------------------------------------------
test.describe("TP-70 (chain variant)", () => {
  test.setTimeout(TIMEOUT);

  test.fixme(
    "B (non-admin invitee) invites C → C sees the group",
    async () => {
      // Would call `inviteByNpub(pageB, USER_C_NPUB)`. Fails today because
      // `MarmotGroup#commit` enforces `groupData.adminPubkeys.includes(B)`
      // and B was not promoted on join.
    },
  );
});
