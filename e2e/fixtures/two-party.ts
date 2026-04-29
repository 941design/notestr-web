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
 * `Au` — authenticate via bunker URL.
 *
 * Performs the same flow as `auth-helper.ts` / `auth-helper-b.ts` but is
 * parameterised over the bunker URL so a single helper covers A, B, C, …
 * Clears app state first so each call yields a clean session in the given
 * browser context.
 */
export async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto("/");
  await clearAppState(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder("bunker://...").fill(bunkerUrl);
  await page.getByRole("button", { name: "Connect" }).click();
  await page
    .locator('[data-testid="pubkey-chip"]')
    .waitFor({ state: "visible", timeout: 30000 });
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
