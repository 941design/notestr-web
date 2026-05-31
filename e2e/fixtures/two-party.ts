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
 * Without this, each fresh browser context generates a new random hex slot
 * and the relay accumulates one ghost KP per past session — every accumulated
 * ghost looks like a sibling device the auto-invite scan should pull into
 * every new group, and the per-ghost MLS commits drown the test timeout.
 *
 * `getOrCreateClientId` (`src/marmot/storage.ts`) reads
 * `window.__notestrTestClientId` when `NEXT_PUBLIC_E2E === "1"`. The override
 * is validated against MIP-00's 64-hex shape (MDK enforces this hard) so
 * fixtures here must produce a deterministic 64-char lowercase hex string.
 * We derive it by SHA-256 of the human-readable slot label, which gives a
 * stable hex value while keeping the labels readable in test diagnostics.
 *
 * Default: derive from the bunker pubkey so single-context-per-role tests
 * implicitly share a slot per role (A → one slot, B → one slot, etc.).
 * Tests that spawn multiple contexts on the same bunker (multi-device) must
 * pass an explicit `slot` to disambiguate.
 */
async function hashToHex64(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Returns the 64-char hex slot identifier for a human-readable slot label.
 *
 * Mirrors the derivation in `pinClientSlot` — SHA-256 of `"notestr-" + label`.
 * Use this in test assertions that need to compare against the slot stored in
 * IDB (which always holds the hex form, not the human-readable label).
 *
 * @example
 * const hexSlot = await slotIdentifierFor("sibling-a2");
 * expect(forgottenSlots).toContain(hexSlot);
 */
export async function slotIdentifierFor(label: string): Promise<string> {
  return hashToHex64(`notestr-${label}`);
}

export async function pinClientSlot(
  page: Page,
  bunkerUrl: string,
  slot?: string,
): Promise<void> {
  const bunkerPubkey = bunkerUrl.replace(/^bunker:\/\//, "").split("?", 1)[0]!;
  const label = slot ?? `e2e-${bunkerPubkey.slice(0, 8)}`;
  const slotHex = await hashToHex64(`notestr-${label}`);
  await page.addInitScript((s: string) => {
    (window as { __notestrTestClientId?: string }).__notestrTestClientId = s;
  }, slotHex);
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

  // The NIP-46 `connect` request is an *ephemeral* nostr event (kind 24133):
  // strfry does not store it, so if it reaches the relay a beat before the
  // bunker's subscription is live (or the bunker's relay connection briefly
  // flaps), it is silently dropped and the UI sits on "Connecting" forever —
  // there is no client-side resend today. That manifests as an intermittent
  // 30s `pubkey-chip` timeout in this setup step. Retry the connect a few
  // times: clearing state and reloading re-issues a fresh request, which the
  // bunker (reliably subscribed by then) answers. Keep per-attempt waits short
  // so a lost first request is re-sent quickly rather than burning one long wait.
  const CONNECT_ATTEMPT_TIMEOUT = 12_000;
  const MAX_CONNECT_ATTEMPTS = 3;
  const pubkeyChip = page.locator('[data-testid="pubkey-chip"]');
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    await page.getByRole("tab", { name: /bunker:\/\/ URL/i }).click();
    await page.getByPlaceholder("bunker://...").fill(bunkerUrl);
    await page.getByRole("button", { name: "Connect" }).click();
    try {
      await pubkeyChip.waitFor({ state: "visible", timeout: CONNECT_ATTEMPT_TIMEOUT });
      break;
    } catch (err) {
      if (attempt === MAX_CONNECT_ATTEMPTS) throw err;
      // Wipe the half-finished session so the reload returns to the sign-in
      // form (not a stuck "restoring session" screen) and retry.
      await clearAppState(page);
      await page.goto("/");
    }
  }
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
  // Disconnect now opens a two-path AlertDialog ("Sign out" vs
  // "Forget this device and sign out"). Choose the plain path —
  // identity switching preserves group state for the next user.
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
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
  // Disconnect now opens a two-path AlertDialog — choose plain Sign out.
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
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

/**
 * Wait until every page reports the SAME MLS epoch for `groupId`.
 *
 * Multi-party specs that run late in the suite inherit stale kind-30443 key
 * packages left on the shared relay by earlier specs (each `authenticate()`
 * publishes one; the multi-device specs publish several per identity). When the
 * admin creates a group, its sibling auto-invite scan pulls each stale KP in as
 * a dead leaf, and every Add is a commit that bumps the epoch WITHOUT changing
 * the member-npub set. A peer still at its own join epoch cannot decrypt an
 * application message authored at the admin's later epoch (MLS epoch isolation),
 * so a task created by one member is silently invisible to a lagging peer until
 * it catches up — an intermittent, suite-position-dependent failure of the
 * "X creates → Y observes" assertions. Member COUNT does not catch this (ghost
 * Adds don't change membership); epoch equality does. Poll until all agree.
 *
 * `groupId` is the marmot `idStr` (the MLS GroupId), which is identical across
 * all devices in the group — capture it once (e.g. from the admin) and pass the
 * same value for every page.
 */
export async function waitForEpochConvergence(
  pages: Page[],
  groupId: string,
  timeoutMs = 30000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const epochs = await Promise.all(
          pages.map((p) => getGroupEpochHook(p, groupId).catch(() => null)),
        );
        // Converged iff every page has the group loaded and reports one epoch.
        if (epochs.some((e) => e === null)) return false;
        return new Set(epochs).size === 1;
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toBe(true);
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
