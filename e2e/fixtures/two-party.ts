/**
 * Shared helpers for two-party (and multi-party) e2e tests.
 *
 * All helpers operate on a single Page; the caller is responsible for managing
 * BrowserContexts and pairing pages with bunker URLs.
 *
 * The DSL used by these tests is documented in
 * `docs/two-party-permutation-matrix.md` — the helpers below correspond
 * 1:1 to the verbs there (`Au`, `Cg`, `In`, `Lg`, `Fd`, `Ct`, `Sc`, `Dt`,
 * `Ut`, `As`, `Un`, `Sw`, `Rl`).
 */

import { expect, type Page } from "@playwright/test";

import type { TaskEvent } from "../../src/store/task-events.ts";
import { clearAppState } from "./cleanup.js";

/**
 * Pin the marmot clientId (KP slot identifier) for this page so the same
 * logical role across test sessions publishes to the same kind 30443 slot.
 * Without this, each fresh browser context generates a new random UUID and
 * the relay accumulates one ghost KP per past session — every accumulated
 * ghost looks like a sibling device the auto-invite scan should pull into
 * every new group, and the per-ghost MLS commits drown the test timeout.
 *
 * `getOrCreateClientId` (`src/marmot/storage.ts`) reads
 * `window.__notestrTestClientId` when `NEXT_PUBLIC_E2E === "1"`. Replaceable
 * event semantics on kind 30443 then collapse repeated publishes at the same
 * slot to a single entry on the relay.
 *
 * Default: derive from the bunker pubkey so single-context-per-role tests
 * implicitly share a slot per role (A → one slot, B → one slot, etc.).
 * Tests that spawn multiple contexts on the same bunker (multi-device) must
 * pass an explicit `slot` to disambiguate.
 */
export async function pinClientSlot(
  page: Page,
  bunkerUrl: string,
  slot?: string,
): Promise<void> {
  const bunkerPubkey = bunkerUrl.replace(/^bunker:\/\//, "").split("?", 1)[0]!;
  const effectiveSlot = slot ?? `e2e-${bunkerPubkey.slice(0, 8)}`;
  await page.addInitScript((s: string) => {
    (window as { __notestrTestClientId?: string }).__notestrTestClientId = s;
  }, `notestr-${effectiveSlot}`);
}

/**
 * `Au` — authenticate via bunker URL.
 *
 * Performs the same flow as `auth-helper.ts` / `auth-helper-b.ts` but is
 * parameterised over the bunker URL so a single helper covers A, B, C, …
 * Clears app state first so each call yields a clean session in the given
 * browser context.
 *
 * `slot` (optional) labels this context's KP slot. When omitted, derived
 * from the bunker pubkey so a single context per role gets a stable slot
 * across tests; pass an explicit value (e.g. `"A1"`, `"A2"`) when one
 * test spawns multiple contexts on the same bunker.
 */
export async function authenticate(
  page: Page,
  bunkerUrl: string,
  slot?: string,
): Promise<void> {
  await pinClientSlot(page, bunkerUrl, slot);
  await page.goto("/");
  await clearAppState(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder("bunker://...").fill(bunkerUrl);
  await page.getByRole("button", { name: "Connect" }).click();
  await page
    .locator('[data-testid="pubkey-chip"]')
    .waitFor({ state: "visible", timeout: 30000 });
  // Test hooks are installed by a useEffect inside MarmotProvider that
  // depends on `state.client`, which initialises after the pubkey-chip
  // appears. Without this poll, callers that immediately invoke
  // `getPubkeyHex` (or any other test-hook helper) race the install and
  // throw "__notestrTestPubkey is not installed".
  await expect
    .poll(
      () => page.evaluate(() => typeof window.__notestrTestPubkey === "function"),
      { timeout: 15000 },
    )
    .toBe(true);
}

/**
 * `Cg(g)` — create a group with the given name. The page must already be
 * authenticated. Resolves once the group's task board is visible (the
 * group-creation flow auto-selects the new group).
 */
export async function createGroup(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder("Group name").first().fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).first().click();
  await expect(page.locator("aside").getByText(name).first()).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({
    timeout: 10000,
  });
}

/**
 * `In(X)` — invite a member by npub on whichever group is currently selected.
 * Waits for the invite input to clear (the success signal in `GroupManager`).
 */
export async function inviteByNpub(page: Page, inviteeNpub: string): Promise<void> {
  await page.getByPlaceholder("npub1...").fill(inviteeNpub);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByPlaceholder("npub1...")).toHaveValue("", {
    timeout: 30000,
  });
}

/**
 * Wait for `name` to surface in the sidebar and click it to select. Used by
 * pages that reach a group via Welcome rather than by creating it locally.
 */
export async function selectGroup(page: Page, name: string): Promise<void> {
  const sidebar = page.locator("aside");
  await expect(sidebar.getByText(name).first()).toBeVisible({ timeout: 60000 });
  await sidebar.getByText(name).first().click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible({
    timeout: 10000,
  });
}

/**
 * `Lg(g)` — leave the group whose card has the given name in the sidebar.
 * Confirms the AlertDialog. The group must be currently visible in the
 * sidebar (not detached).
 *
 * The leave button is scoped to the `<li>` whose text contains `name` so
 * dense multi-group sessions cannot accidentally leave the wrong group.
 */
export async function leaveGroup(page: Page, name: string): Promise<void> {
  const groupRow = page
    .locator('nav[aria-label="Groups"] li')
    .filter({ hasText: name });
  await groupRow.locator('[data-testid="group-leave-btn"]').click();
  await page.locator('[data-testid="group-leave-confirm"]').click();
}

/**
 * `Rl` — reload, then wait for re-auth (session-restore) to complete by
 * watching for the pubkey chip.
 */
export async function reload(page: Page): Promise<void> {
  await page.reload();
  await page
    .locator('[data-testid="pubkey-chip"]')
    .waitFor({ state: "visible", timeout: 30000 });
}

/**
 * `Ct(t,T)` — create a task via the UI. Returns nothing; tests should assert
 * via the board or via the `__notestrTestTasks()` hook.
 */
export async function addTaskViaUi(
  page: Page,
  title: string,
  description = "",
): Promise<void> {
  await page.getByRole("button", { name: "Add Task" }).click();
  await page.getByLabel("Title").fill(title);
  if (description) {
    await page.getByLabel("Description").fill(description);
  }
  await page.getByRole("button", { name: "Create", exact: true }).last().click();
  const openColumn = page.locator('[data-column="open"]').first();
  await expect(openColumn).toContainText(title, { timeout: 15000 });
}

/**
 * Dispatch a TaskEvent directly through the store hook. Used by tests that
 * need to exercise events the UI does not surface (cross-actor `task.assigned`
 * to another pubkey, `task.updated` field edits, etc.).
 *
 * The page must have the relevant group selected so its task store is mounted.
 * Throws loudly if the hook is missing — silent fall-through would let weak
 * assertions pass for the wrong reason.
 */
export async function dispatchTaskEvent(
  page: Page,
  event: TaskEvent,
): Promise<void> {
  await page.evaluate(async (e) => {
    const fn = window.__notestrTestDispatchTaskEvent;
    if (typeof fn !== "function") {
      throw new Error(
        "__notestrTestDispatchTaskEvent is not installed — is a group selected and TaskStoreProvider mounted?",
      );
    }
    await fn(e);
  }, event);
}

/** Read the current pubkey of the authenticated identity (hex). */
export async function getPubkeyHex(page: Page): Promise<string> {
  const result = await page.evaluate(() => {
    const fn = window.__notestrTestPubkey;
    if (typeof fn !== "function") {
      throw new Error("__notestrTestPubkey is not installed");
    }
    return fn();
  });
  expect(result).toMatch(/^[0-9a-f]{64}$/);
  return result;
}

/**
 * Read the marmot id of the most recently appended group from the
 * `__notestrTestGroups()` test hook. Returns the LAST element of the array,
 * not the actually-selected group (the selected id is not exposed to tests).
 *
 * Safe usage: capture the id IMMEDIATELY after `createGroup` / `selectGroup`,
 * then pass it explicitly to subsequent operations. Do NOT call this after
 * later group-mutating operations (auto-join, re-invite, detach) — array
 * order may have shifted and you would silently target the wrong group.
 */
export async function currentGroupId(page: Page): Promise<string> {
  const groups = await page.evaluate(() => {
    const fn = window.__notestrTestGroups;
    if (typeof fn !== "function") {
      throw new Error("__notestrTestGroups is not installed");
    }
    return fn();
  });
  expect(groups.length).toBeGreaterThan(0);
  return groups[groups.length - 1]!.idStr;
}

/**
 * Read the Nostr group id hex for the group matching `groupIdStr` from the
 * `__notestrTestGroups()` test hook.
 *
 * Used by A14 assertions to subscribe via `waitForDuration` with a filter on
 * `#h: [groupNostrIdHex]`, verifying at the wire level that no kind-445
 * events arrive after a leave/forget-last-leaf.
 *
 * Throws if the hook is absent or no group with the given `idStr` is found.
 */
export async function getNostrGroupIdHex(page: Page, groupIdStr: string): Promise<string> {
  return page.evaluate((id) => {
    const fn = window.__notestrTestGroups;
    if (typeof fn !== "function") {
      throw new Error("__notestrTestGroups hook not installed");
    }
    const entry = fn().find((g) => g.idStr === id);
    if (!entry) {
      throw new Error(`group not found: ${id}`);
    }
    return entry.nostrGroupIdHex;
  }, groupIdStr);
}

/** True iff the worker's project is mobile (multi-context tests skip on mobile). */
export function projectIsMobile(workerProject: { use: { isMobile?: boolean } }): boolean {
  return !!workerProject.use.isMobile;
}

/**
 * Click the "Move to <next>" button on the task card whose title matches.
 *
 * The button on a card advances the task to the next status in the
 * open → in_progress → done lattice. There is no UI button to send a task
 * to `cancelled` from the board — use `dispatchTaskEvent` for that.
 *
 * The action is scoped to the `[data-testid="task-card"]` whose text
 * contains `title` so dense boards cannot accidentally advance the wrong
 * task.
 */
export async function moveTaskToNext(page: Page, title: string): Promise<void> {
  const taskCard = page
    .locator('[data-testid="task-card"]')
    .filter({ hasText: title });
  await taskCard
    .getByRole("button", { name: /Move to (In Progress|Done)/i })
    .click();
}

/**
 * Click the delete button on the task card whose title matches, then
 * confirm. Scoped by title to avoid clicking the wrong card on a dense
 * board.
 */
export async function deleteTaskViaUi(page: Page, title: string): Promise<void> {
  const taskCard = page
    .locator('[data-testid="task-card"]')
    .filter({ hasText: title });
  await taskCard.locator('[data-testid="task-delete-btn"]').click();
  await page.locator('[data-testid="task-delete-confirm"]').click();
}

/** Sleep helper — wraps page.waitForTimeout for readability in dispatch sequences. */
export async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * `Sw(B)` — switch identity on page by disconnecting and re-authenticating.
 *
 * Clicks the disconnect button, waits for the login screen, then calls
 * authenticate() with the new bunker URL. Clears app state as part of
 * authenticate().
 */
export async function switchIdentity(page: Page, bunkerUrl: string): Promise<void> {
  await page.locator('[data-testid="disconnect-button"]').click({ force: true });
  await page
    .getByText("Sign in to notestr")
    .waitFor({ state: "visible", timeout: 15000 });
  await authenticate(page, bunkerUrl);
}

/**
 * `Dc` — disconnect the current identity without re-authenticating.
 *
 * Clicks the disconnect button and waits for the login screen.
 */
export async function disconnect(page: Page): Promise<void> {
  await page.locator('[data-testid="disconnect-button"]').click({ force: true });
  await page
    .getByText("Sign in to notestr")
    .waitFor({ state: "visible", timeout: 15000 });
}

/**
 * `Rd(d, n)` — rename a device row in the DeviceList.
 *
 * Locates the device row by its current label text, fills in the new name,
 * and blurs to commit the rename. Only non-local rows are targetable because
 * the DeviceList only renders remote rows with `data-local="false"`.
 */
export async function renameDevice(
  page: Page,
  deviceLabel: string,
  newName: string,
): Promise<void> {
  const row = page
    .locator('[data-testid="device-row"]')
    .filter({ hasText: deviceLabel })
    .first();
  const input = row.getByRole("textbox");
  await input.fill(newName);
  await input.blur();
}

/**
 * Relay-drain quiescence: poll `__notestrTestTasks()` on both pages until
 * two consecutive reads 500ms apart are deep-equal (same JSON). Falls back to
 * a 5-second hard wait if the hook is absent on either page.
 *
 * Avoids the NDK-subscriber private-key collision issue where the subscriber
 * uses User B's key and cannot observe A-side events.
 */
export async function quiesceFor(
  pages: Page[],
  opts: { maxWaitMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const { maxWaitMs = 15000, intervalMs = 500 } = opts;

  const getSnapshot = async (): Promise<(string | null)[]> => {
    return Promise.all(
      pages.map((page) =>
        page
          .evaluate(() => {
            const fn = window.__notestrTestTasks;
            if (typeof fn !== "function") return null;
            return JSON.stringify(fn());
          })
          .catch(() => null),
      ),
    );
  };

  const deadline = Date.now() + maxWaitMs;
  let prev = await getSnapshot();

  while (Date.now() < deadline) {
    await pages[0]!.waitForTimeout(intervalMs);
    const curr: (string | null)[] = await getSnapshot();
    const allNull = curr.every((s) => s === null);
    if (!allNull && JSON.stringify(curr) === JSON.stringify(prev)) {
      return;
    }
    prev = curr;
  }
}

/**
 * `Fd(d)` — invoke the test-only forget-leaf hook.
 *
 * Bypasses the DeviceList UI (which only renders the local user's own leaves)
 * so a spec can forget any leaf in a currently-loaded group, including
 * cross-npub ones. This calls `removeLeafByIndex` directly, which is the same
 * primitive `DeviceList` uses behind the Forget button.
 *
 * Throws loudly if the hook is missing — silent fall-through would mask a
 * destructive no-op.
 */
export async function forgetLeafByIndex(
  page: Page,
  groupIdStr: string,
  leafIndex: number,
): Promise<void> {
  await page.evaluate(
    async ({ groupId, idx }) => {
      const fn = window.__notestrTestForgetLeaf;
      if (typeof fn !== "function") {
        throw new Error(
          "__notestrTestForgetLeaf is not installed — MarmotProvider not mounted?",
        );
      }
      await fn(groupId, idx);
    },
    { groupId: groupIdStr, idx: leafIndex },
  );
}

/** Read the current leaf indexes for the given pubkey in a group. */
export async function leafIndexesFor(
  page: Page,
  groupIdStr: string,
  pubkeyHex: string,
): Promise<number[]> {
  return page.evaluate(
    ({ groupId, pk }) => {
      const fn = window.__notestrTestPubkeyLeafIndexes;
      if (typeof fn !== "function") {
        throw new Error("__notestrTestPubkeyLeafIndexes is not installed");
      }
      return fn(groupId, pk);
    },
    { groupId: groupIdStr, pk: pubkeyHex },
  );
}

/** Read the MLS epoch (number) for the given group. Returns null if the group is not loaded. */
export async function getGroupEpochHook(
  page: Page,
  groupIdStr: string,
): Promise<number | null> {
  return page.evaluate((id) => {
    const fn = window.__notestrTestGroupEpoch;
    if (typeof fn !== "function") {
      throw new Error("__notestrTestGroupEpoch is not installed");
    }
    return fn(id);
  }, groupIdStr);
}

/** Read the sorted member pubkey array for the given group. Returns null if the group is not loaded. */
export async function getGroupMembersHook(
  page: Page,
  groupIdStr: string,
): Promise<string[] | null> {
  return page.evaluate((id) => {
    const fn = window.__notestrTestGroupMembers;
    if (typeof fn !== "function") {
      throw new Error("__notestrTestGroupMembers is not installed");
    }
    return fn(id);
  }, groupIdStr);
}

/** Count MLS leaf nodes belonging to pubkeyHex in the given group. Returns 0 for unknown pubkeys or absent groups. */
export async function getPubkeyLeafCountHook(
  page: Page,
  groupIdStr: string,
  pubkeyHex: string,
): Promise<number> {
  return page.evaluate(
    ({ id, pk }) => {
      const fn = window.__notestrTestPubkeyLeafCount;
      if (typeof fn !== "function") {
        throw new Error("__notestrTestPubkeyLeafCount is not installed");
      }
      return fn(id, pk);
    },
    { id: groupIdStr, pk: pubkeyHex },
  );
}
