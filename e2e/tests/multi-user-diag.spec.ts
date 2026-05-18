/**
 * Diagnostic spec for MLS post-join live-delivery.
 *
 * NOT part of the regular e2e suite — gated by `DIAG=1`. Runs the same
 * setup as multi-user.spec.ts (auth → group → invite → task) and then
 * reports the authoritative signals for "did User B actually receive
 * User A's post-join task?":
 *
 *   - A and B epochs (via __notestrTestInspectGroupEvent's currentEpoch)
 *   - relay count of kind-445 events for the group
 *   - B persisted task events (IndexedDB)
 *   - B in-memory task state
 *   - B history entries (test-only TestGroupHistory from ts-mls)
 *
 * Kept around as a "break glass in case of regression" tool. To run:
 *
 *   DIAG=1 npx playwright test --project=chromium \
 *     e2e/tests/multi-user-diag.spec.ts
 *
 * Note on __notestrTestInspectGroupEvent: calling `group.ingest([event])`
 * twice on an already-successfully-processed application message yields
 * `unreadable` both times, because the per-sender ratchet generation was
 * consumed on first ingest and ts-mls drops the key (forward secrecy).
 * This means the hook is a false-negative signal for "was this
 * delivered?". Use __notestrTestSentRumors / __notestrTestPersistedTaskEvents
 * as authoritative signals instead.
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import { clearAppState } from "../fixtures/cleanup.js";
import {
  classify,
  formatClassifyLine,
  type TraceEvent,
} from "../fixtures/mls-trace-classify.js";

const RELAY_URL = "ws://localhost:7777";
const DIAG = process.env.DIAG === "1";
// Per GAP-4 (baked into stories.json): DIAG=1 keeps the existing skip
// gate; NEXT_PUBLIC_E2E_TRACE_MLS=1 layers on top to switch the harness
// from vanilla rerun mode (DIAG only) to full trace-capture +
// classification mode (both flags set). AC-DIAG-1 / AC-DIAG-4.
const TRACE_MODE = DIAG && process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1";

const TRIAGE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  ".triage",
);
const CLASSIFY_LOG = path.join(TRIAGE_DIR, "mls-trace-classify.log");
const MAX_RUNS = 3;

function ensureTriageDir(): void {
  if (!existsSync(TRIAGE_DIR)) {
    mkdirSync(TRIAGE_DIR, { recursive: true });
  }
}

async function dumpTrace(page: Page, label: "A" | "B" | "C", run: number): Promise<TraceEvent[]> {
  const trace = await page.evaluate(() => window.__notestrTestMlsTrace?.() ?? []);
  ensureTriageDir();
  writeFileSync(
    path.join(TRIAGE_DIR, `mls-trace-${label}-${run}.json`),
    JSON.stringify(trace, null, 2),
  );
  return trace as TraceEvent[];
}

async function readDispatchedRumorId(page: Page, groupIdStr: string): Promise<string | null> {
  // Per Q12 option (a): the most recent sent rumor on this group is the
  // task we just dispatched. __notestrTestSentRumors returns rumors in
  // insertion order; the last one is ours.
  const rumors = await page.evaluate(
    (gid) => window.__notestrTestSentRumors?.(gid) ?? [],
    groupIdStr,
  );
  if (rumors.length === 0) return null;
  return rumors[rumors.length - 1].id;
}

async function getGroupIdStr(page: Page): Promise<string | null> {
  const groups = await page.evaluate(() => window.__notestrTestGroups?.() ?? []);
  return groups[0]?.idStr ?? null;
}

async function authenticate(page: Page, bunkerUrl: string): Promise<void> {
  await page.goto("/");
  await clearAppState(page);
  await page.goto("/");
  await page.getByRole("tab", { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder("bunker://...").fill(bunkerUrl);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: "visible", timeout: 30000 });
}

let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.beforeAll(async ({ browser }, workerInfo) => {
  if (!DIAG) return;
  if (workerInfo.project.use.isMobile) return;
  contextA = await browser.newContext();
  contextB = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
});

test.describe.serial("multi-user live-delivery diagnostic", () => {
  test.setTimeout(180_000);

  const GROUP_NAME = `Diag ${Date.now()}`;

  test("run triangulation", async ({}, workerInfo) => {
    test.skip(!DIAG, "Diagnostic — set DIAG=1 to run");
    test.skip(
      !!workerInfo.project.use.isMobile,
      "Multi-context MLS tests require desktop viewport",
    );

    const readEpoch = async (page: Page, label: string) => {
      const result = await page.evaluate(async () => {
        const groups = window.__notestrTestGroups?.() ?? [];
        if (groups.length === 0) return { count: 0, epoch: null };
        const first = groups[0];
        const inspected = await window.__notestrTestInspectGroupEvent?.(
          first.idStr,
          "0".repeat(64),
        );
        return { count: groups.length, epoch: inspected?.currentEpoch ?? null };
      });
      console.log(`[diag-epoch] ${label}: count=${result.count}, epoch=${result.epoch}`);
      return result;
    };

    // Auth both users
    await authenticate(pageB, E2E_BUNKER_B_URL);
    await pageB.waitForTimeout(3000);
    await authenticate(pageA, E2E_BUNKER_URL);

    // A creates group and invites B
    await pageA.getByPlaceholder("Group name").first().fill(GROUP_NAME);
    await pageA.getByRole("button", { name: "Create", exact: true }).first().click();
    const sidebarA = pageA.locator("aside");
    await expect(sidebarA.getByText(GROUP_NAME)).toBeVisible({ timeout: 30000 });
    await readEpoch(pageA, "A after createGroup");

    await pageA.getByPlaceholder("npub1...").fill(USER_B_NPUB);
    await pageA.getByRole("button", { name: "Invite" }).click();
    await expect(pageA.getByPlaceholder("npub1...")).toHaveValue("", { timeout: 30000 });
    await readEpoch(pageA, "A after invite B");

    // Background settles
    await pageA.waitForTimeout(2000);
    await readEpoch(pageA, "A after 2s settle");

    // B reloads & selects the group
    await pageB.reload();
    await pageB.locator('[data-testid="pubkey-chip"]').waitFor({ state: "visible", timeout: 30000 });
    const sidebarB = pageB.locator("aside");
    await expect(sidebarB.getByText(GROUP_NAME)).toBeVisible({ timeout: 60000 });
    await sidebarB.getByText(GROUP_NAME).click();
    await expect(pageB.getByRole("heading", { name: "Tasks" })).toBeVisible({ timeout: 10000 });
    await readEpoch(pageB, "B after select group");
    await readEpoch(pageA, "A at B-ready");

    // A creates a task
    const TASK_TITLE = `Diag task ${Date.now()}`;
    await pageA.getByRole("button", { name: "Add Task" }).click();
    await pageA.getByLabel("Title").fill(TASK_TITLE);
    await pageA.getByRole("button", { name: "Create", exact: true }).last().click();
    const openColumnA = pageA.locator('[data-column="open"]').first();
    await expect(openColumnA).toContainText(TASK_TITLE, { timeout: 15000 });
    await readEpoch(pageA, "A after dispatch task");

    // Give B a moment to ingest
    await pageB.waitForTimeout(3000);
    await readEpoch(pageB, "B after 3s settle");

    // Authoritative signals on B
    const sentRumorsB = await pageB.evaluate(
      () => window.__notestrTestSentRumors?.("") ?? [],
    );
    const persistedB = await pageB.evaluate(
      async () => (await window.__notestrTestPersistedTaskEvents?.()) ?? [],
    );
    const tasksB = await pageB.evaluate(
      () => window.__notestrTestTasks?.() ?? [],
    );
    console.log(
      "[diag] B authoritative signals:",
      "history=", sentRumorsB.length,
      "persisted=", persistedB.length,
      "in-memory=", tasksB.length,
    );

    // Pass unconditionally — this test LOGS, it doesn't assert.
    expect(true).toBe(true);
  });

  /**
   * Trace-capture harness extension (S3).
   *
   * Runs the multi-user.spec.ts:145 scenario (User B sees A's task via
   * live MLS subscription) up to MAX_RUNS times. On each failure, dumps
   * traces from both pages to e2e/.triage/mls-trace-{A,B}-{run}.json
   * and classifies via the e2e/fixtures/mls-trace-classify.ts pure
   * module, appending one line per failure to e2e/.triage/mls-trace-classify.log.
   *
   * Gate: requires DIAG=1 (the outer skip from the parent describe) AND
   * NEXT_PUBLIC_E2E_TRACE_MLS=1 (TRACE_MODE flag at top of file).
   * When TRACE_MODE is false, the test logs that it skipped trace
   * capture and exits — vanilla rerun-on-failure shape per AC-DIAG-4.
   *
   * The harness emulates ONE representative scenario from the failing
   * 6-test cluster (multi-user live-delivery) rather than re-running
   * every member of the cluster as black boxes — modifying the existing
   * failing-cluster tests would violate AC-X-NO-TEST-WEAKEN-1, and
   * cross-spec-file orchestration is not supported by Playwright. The
   * scenario it runs IS the canonical F-class trigger (see spec.md
   * problem section); other cluster tests share the same architectural
   * shape and would classify under the same F-classes.
   */
  test("trace-capture harness (multi-user live-delivery)", async ({}, workerInfo) => {
    test.skip(!DIAG, "Diagnostic — set DIAG=1 to run");
    test.skip(
      !!workerInfo.project.use.isMobile,
      "Multi-context MLS tests require desktop viewport",
    );
    if (!TRACE_MODE) {
      console.log(
        "[diag-harness] NEXT_PUBLIC_E2E_TRACE_MLS not set — skipping trace capture (AC-DIAG-4: vanilla rerun mode).",
      );
      expect(true).toBe(true);
      return;
    }

    test.setTimeout(720_000); // 12 min wall-clock budget per AC-DIAG-6.

    ensureTriageDir();
    const TEST_NAME = "multi-user-diag.spec.ts: trace-capture harness";

    let success = false;
    for (let run = 1; run <= MAX_RUNS && !success; run++) {
      const runId = `harness-run-${run}-${Date.now()}`;
      console.log(`[diag-harness] run ${run} of ${MAX_RUNS}: ${runId}`);

      const ctxA = await pageA.context().browser()!.newContext();
      const ctxB = await pageB.context().browser()!.newContext();
      const pA = await ctxA.newPage();
      const pB = await ctxB.newPage();

      try {
        // Auth both contexts from a fresh state per run.
        await authenticate(pB, E2E_BUNKER_B_URL);
        await pB.waitForTimeout(1000);
        await authenticate(pA, E2E_BUNKER_URL);

        // A creates group + invites B.
        const groupName = `Harness ${runId}`;
        await pA.getByPlaceholder("Group name").first().fill(groupName);
        await pA
          .getByRole("button", { name: "Create", exact: true })
          .first()
          .click();
        const sidebarA = pA.locator("aside");
        await expect(sidebarA.getByText(groupName)).toBeVisible({
          timeout: 30000,
        });
        await pA.getByPlaceholder("npub1...").fill(USER_B_NPUB);
        await pA.getByRole("button", { name: "Invite" }).click();
        await expect(pA.getByPlaceholder("npub1...")).toHaveValue("", {
          timeout: 30000,
        });

        // B selects the group.
        await pB.reload();
        await pB
          .locator('[data-testid="pubkey-chip"]')
          .waitFor({ state: "visible", timeout: 30000 });
        const sidebarB = pB.locator("aside");
        await expect(sidebarB.getByText(groupName)).toBeVisible({
          timeout: 60000,
        });
        await sidebarB.getByText(groupName).click();
        await expect(pB.getByRole("heading", { name: "Tasks" })).toBeVisible({
          timeout: 10000,
        });

        // A creates a task. We need its rumor.id afterwards.
        const taskTitle = `Harness task ${runId}`;
        await pA.getByRole("button", { name: "Add Task" }).click();
        await pA.getByLabel("Title").fill(taskTitle);
        await pA
          .getByRole("button", { name: "Create", exact: true })
          .last()
          .click();
        const openColumnA = pA.locator('[data-column="open"]').first();
        await expect(openColumnA).toContainText(taskTitle, {
          timeout: 15000,
        });

        // Capture the rumor id on A's side. Per Q12: most recent sent
        // rumor on this group IS the task we just dispatched.
        const groupIdStr = await getGroupIdStr(pA);
        const rumorId = groupIdStr
          ? await readDispatchedRumorId(pA, groupIdStr)
          : null;
        if (rumorId) {
          writeFileSync(
            path.join(TRIAGE_DIR, `expected-task-${run}.json`),
            JSON.stringify({ rumorId, taskTitle, runId }, null, 2),
          );
        }

        // The actual assertion that times out in the failing cluster:
        // does B see the task within the live-delivery window?
        const openColumnB = pB.locator('[data-column="open"]').first();
        let assertionPassed = false;
        try {
          await expect(openColumnB).toContainText(taskTitle, {
            timeout: 30000,
          });
          assertionPassed = true;
        } catch {
          assertionPassed = false;
        }

        if (assertionPassed) {
          console.log(
            `[diag-harness] run ${run}: assertion PASSED — no trace dump needed.`,
          );
          success = true;
        } else {
          console.log(
            `[diag-harness] run ${run}: assertion FAILED — dumping traces and classifying.`,
          );
          const senderTrace = await dumpTrace(pA, "A", run);
          const receiverTrace = await dumpTrace(pB, "B", run);
          if (rumorId) {
            const result = classify({
              senderTrace,
              receiverTrace,
              expectedRumorId: rumorId,
            });
            const line = formatClassifyLine({
              testName: TEST_NAME,
              run,
              result,
            });
            appendFileSync(CLASSIFY_LOG, line + "\n");
            console.log(line);
          } else {
            const line = `[${new Date().toISOString()}] run=${run} test="${TEST_NAME}" verdict=unknown eventId=n/a rationale="rumor.id capture failed (no group or no sent rumors)"`;
            appendFileSync(CLASSIFY_LOG, line + "\n");
            console.log(line);
          }
        }
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    }

    // The harness ALWAYS passes — failures are reported via trace dumps
    // and the classify log. S4's report.md is the consumer of the
    // verdicts; this test is the producer.
    expect(true).toBe(true);
  });
});
