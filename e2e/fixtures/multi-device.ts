/**
 * Multi-device fixture helpers.
 *
 * Owned by epic-property-tests-l3-multi-device.
 *
 * Exports:
 *   - awaitDeviceJoin — welcome-propagation poll used by AttachA2Command_MD.
 *
 * Signature choice: Option A (3-param).
 * The spec.md Technical Approach (line 169) and architecture.md seam contract
 * both declare `awaitDeviceJoin(pageNew, primaryPage, groupId)`.  pubkeyA is
 * resolved inside the helper via `__notestrTestPubkey()` on `primaryPage` so
 * the seam stays narrow.  The S1 stub used 4 params (Option B); this S2
 * implementation replaces it with the canonical 3-param form.
 *
 * Import contract (consumers must use this path):
 *   import { awaitDeviceJoin } from "../fixtures/multi-device.js";
 */

import { expect, type Page } from "@playwright/test";

import { leafIndexesFor } from "./two-party.js";

/**
 * `awaitDeviceJoin(pageNew, primaryPage, groupId)` — wait for the second
 * device of identity A to be welcomed into the group.
 *
 * Polls `leafIndexesFor(primaryPage, groupId, pubkeyA)` until the result
 * has length >= 2, indicating that A2's leaf has been committed by the MLS
 * ratchet-tree on A1's side.
 *
 * - `pageNew`     — the newly-authenticated A2 page (present so callers
 *                   signal "A2 is now online"; not used in the poll itself)
 * - `primaryPage` — A1's page, already in the group; leaf count is observed
 *                   here because A1 is the group admin and receives the
 *                   commit acknowledgement before A2 does
 * - `groupId`     — hex group ID (marmot idStr) to watch
 *
 * `pubkeyA` is read from `primaryPage` via `__notestrTestPubkey()` so the
 * helper is self-contained and callers need not pass it (Option A).
 *
 * Throws on 30-second timeout so fast-check shrinks to the minimal failing
 * chain (AC-MD-ATTACH-3).
 *
 * Pattern mirrors `forget-device-sibling.spec.ts:136-138`:
 *   expect.poll(() => leafIndexesFor(...), { timeout: 30000 }).toHaveLength(2)
 */
export async function awaitDeviceJoin(
  // pageNew is present so the call-site in AttachA2Command_MD.run can pass
  // r.pageA2 explicitly, matching the seam signature and making it obvious
  // to readers that this helper is called immediately after A2 authenticates.
  // The poll itself only needs primaryPage and groupId.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _pageNew: Page,
  primaryPage: Page,
  groupId: string,
): Promise<void> {
  // Read the shared pubkey from the primary (A1) page.  __notestrTestPubkey
  // is guaranteed installed because A1 authenticated in beforeAll.
  const pubkeyA = await primaryPage.evaluate(() => {
    const fn = (window as { __notestrTestPubkey?: () => string }).__notestrTestPubkey;
    if (typeof fn !== "function") {
      throw new Error("__notestrTestPubkey is not installed on primaryPage");
    }
    return fn();
  });

  // Poll until A2's leaf appears in A1's ratchet-tree view (leaf count >= 2).
  // Mirrors the forget-device-sibling.spec.ts:136-138 idiom.
  await expect
    .poll(
      async () => {
        const indexes = await leafIndexesFor(primaryPage, groupId, pubkeyA);
        return indexes.length;
      },
      { timeout: 30000 },
    )
    .toBeGreaterThanOrEqual(2);
}
