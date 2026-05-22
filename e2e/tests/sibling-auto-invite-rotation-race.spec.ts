/**
 * E2E spec: sibling auto-invite must pick the freshest KeyPackage per slot
 * after a rotation (auto-invite-freshness epic, S2).
 *
 * Covers AC-TEST-1, AC-TEST-2.
 *
 * Bug reproduced
 * --------------
 * `syncKnownKeyPackages` in `src/marmot/device-sync.ts` iterates `knownEvents`
 * in insertion order. After the sibling joins Group A its KP is rotated; the
 * admin's cache now holds both the old and the new KP for the same `d` slot.
 * On the next auto-invite (Group B), insertion-order iteration picks the OLDER
 * event first; the dedup key `groupB:slotB` is consumed; the newer event is
 * skipped. The Welcome for Group B targets a stale KP that the sibling has
 * already deprecated — `joinGroupFromWelcome` throws `"no_matching_kp"` and
 * the sibling never sees Group B in its sidebar.
 *
 * Fix (S1)
 * --------
 * Before iterating, `syncKnownKeyPackages` now collapses `knownEvents` to one
 * event per slot (highest `created_at` wins), mirroring the manual-invite sort
 * at `GroupManager.tsx:165-170`. This test FAILS on master HEAD (pre-fix) and
 * PASSES after S1's fix is applied.
 *
 * Relay-state-independence
 * ------------------------
 * - Group names embed `Date.now()` — each run targets fresh group names that
 *   cannot collide with prior relay state.
 * - `authenticate(page, url, slot)` calls `clearAppState` internally; IDB is
 *   wiped before each context starts.
 * - No relay reset, no `e2e-down`/`e2e-up`, no relay-state assertions.
 *
 * Slot discipline
 * ---------------
 * Two distinct slot strings ('sibling-fresh-1', 'sibling-fresh-2') are passed
 * to `authenticate()`. Without distinct slots both contexts would derive the
 * same KP `d`-tag from the shared bunker pubkey, collapsing them to a single
 * leaf and making the test pass for the wrong reason regardless of the bug.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import {
  spawnSpecBunker,
  type SpecBunkerHandle,
} from "../fixtures/spec-bunker.js";
import {
  authenticate,
  createGroup,
  settle,
} from "../fixtures/two-party.js";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";
const TIMEOUT = 300_000;

// Date.now() prefix ensures relay-state-independence across runs.
const ts = Date.now();
const GROUP_A_NAME = `SiblingFreshA ${ts}`;
const GROUP_B_NAME = `SiblingFreshB ${ts}`;

// Explicit distinct slot strings — MANDATORY when two contexts share a bunker URL.
const SLOT_1 = "sibling-fresh-1";
const SLOT_2 = "sibling-fresh-2";

test.describe.serial(
  "auto-invite-freshness: sibling sees Group B after KP rotation (AC-TEST-1, AC-TEST-2)",
  () => {
    test.setTimeout(TIMEOUT);

    let context1: BrowserContext;
    let context2: BrowserContext;
    let page1: Page;
    let page2: Page;
    // Per-spec bunker — this spec asserts the auto-invite freshness path
    // where page2's KP is the only sibling KP on the relay under this
    // pubkey. With the shared global bunker A, prior tests' KPs under the
    // same pubkey become ghost siblings and the freshness assertion fails.
    let bunker: SpecBunkerHandle;

    let skipMobile = false;

    test.beforeAll(async ({ browser }, workerInfo) => {
      skipMobile = !!workerInfo.project.use.isMobile;
      if (skipMobile) return;

      bunker = await spawnSpecBunker("sibling-fresh");

      context1 = await browser.newContext();
      context2 = await browser.newContext();
      page1 = await context1.newPage();
      page2 = await context2.newPage();
    });

    test.afterAll(async () => {
      await context1?.close();
      await context2?.close();
      await bunker?.dispose();
    });

    // -------------------------------------------------------------------------
    // Step 1: Authenticate both contexts with the same bunker URL.
    // page2 (the sibling) must authenticate first so its KP is on the relay
    // before page1 creates the first group and triggers the auto-invite scan.
    // -------------------------------------------------------------------------
    test("setup: both contexts authenticate to the same bunker (same npub, distinct slots)", async () => {
      test.skip(skipMobile, SKIP_MOBILE_REASON);

      // page2 (sibling) authenticates first — its KP must be visible on the
      // relay before the auto-invite scan fires on page1.
      await authenticate(page2, bunker.bunkerUrl, SLOT_2);
      await settle(page2, 3000);

      // page1 (admin) authenticates second.
      await authenticate(page1, bunker.bunkerUrl, SLOT_1);
      await settle(page1, 3000);
    });

    // -------------------------------------------------------------------------
    // Step 2: page1 creates Group A. The auto-invite scan fires and invites
    // page2 (same npub, different slot). We wait for Group A to surface in
    // page2's sidebar, confirming the first auto-invite succeeded and page2's
    // KP was rotated (on("joined") handler in client.tsx).
    // -------------------------------------------------------------------------
    test("page1 creates Group A; sibling (page2) receives auto-invite and joins (AC-TEST-1 precondition)", async () => {
      test.skip(skipMobile, SKIP_MOBILE_REASON);

      await createGroup(page1, GROUP_A_NAME);

      // Wait up to 60 s for page2 to see Group A in its sidebar.
      // This confirms: auto-invite sent, Welcome delivered, page2 joined, and
      // — critically — page2's "joined" handler ran and rotated its KP.
      await expect(
        page2.locator("aside").getByText(GROUP_A_NAME),
      ).toBeVisible({ timeout: 60_000 });

      // Allow relay propagation of the rotated KP event to page1 so that
      // page1's knownEvents cache receives the new KP before Group B is created.
      // Matches the 8000ms drain used by forget-device-sibling.spec.ts for the
      // analogous sibling-relay-propagation wait — gives CI a safer margin.
      await settle(page1, 8000);
    });

    // -------------------------------------------------------------------------
    // Step 3: page1 creates Group B. The auto-invite scan must now pick page2's
    // NEWEST KP (post-rotation) for the slot — not the stale one that was used
    // for Group A. The primary assertion is sidebar visibility of Group B on
    // page2 (AC-TEST-2). The belt-and-braces IDB check is secondary.
    // -------------------------------------------------------------------------
    test("page1 creates Group B; sibling sees Group B in sidebar within 60 s (AC-TEST-1, AC-TEST-2)", async () => {
      test.skip(skipMobile, SKIP_MOBILE_REASON);

      await createGroup(page1, GROUP_B_NAME);

      // PRIMARY assertion (AC-TEST-2): Group B appears in page2's sidebar.
      // This assertion FAILS on master HEAD (pre-fix) because the auto-invite
      // uses the stale pre-rotation KP and marmot-ts cannot decrypt the Welcome.
      // It PASSES after S1's freshness-collapse fix.
      await expect(
        page2.locator("aside").getByText(GROUP_B_NAME),
      ).toBeVisible({ timeout: 60_000 });

      // BELT-AND-BRACES (optional, supplementary — does NOT gate pass/fail):
      // Read the FailedWelcomeRecord count from the notestr-failed-welcomes IDB
      // store on page2. We do not assert count === 0 here because the ephemeral
      // relay is NOT wiped between runs; old Welcome events from prior test-run
      // groups (same slot, different group ID) accumulate on the relay and are
      // re-delivered to the fresh page2 context, producing unrelated failures
      // that would cause a false negative. The sidebar assertion above is the
      // authoritative gate. This read is kept for diagnostic transparency.
      //
      // To verify the fix manually: in a clean relay environment (or first run),
      // this count should be 0 when Group B's Welcome is correctly built from
      // the fresh KP. On a relay with prior-run state it may be > 0 due to
      // stale Welcomes from old groups — that is expected and does not indicate
      // a regression in the KP-freshness fix.
      const failedCount = await page2.evaluate(async () => {
        const dbs = await indexedDB.databases();
        const has = dbs.some((d) => d.name === "notestr-failed-welcomes");
        if (!has) return 0;
        return new Promise<number>((resolve) => {
          const req = indexedDB.open("notestr-failed-welcomes");
          req.onsuccess = () => {
            const db = req.result;
            if (db.objectStoreNames.length === 0) {
              resolve(0);
              return;
            }
            const tx = db.transaction(db.objectStoreNames, "readonly");
            const store = tx.objectStore(db.objectStoreNames[0]!);
            const count = store.count();
            count.onsuccess = () => resolve(count.result);
          };
          req.onerror = () => resolve(0);
        });
      });
      // Diagnostic only — not a test assertion. If this count is unexpectedly
      // high on a clean relay, investigate whether the freshness-collapse fix
      // in syncKnownKeyPackages (device-sync.ts) has regressed.
      void failedCount;
    });
  },
);
