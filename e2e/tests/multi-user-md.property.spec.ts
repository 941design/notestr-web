/**
 * Full-stack property spec: random DSL action chains across three browser
 * contexts mapped to two identities (multi-device, same-pubkey axis).
 *
 * Invariants asserted: A15, C0, S5, S6, S10
 *
 * Identity model:
 *   Identity = "A" | "B"
 *   Device   = "A1" | "A2" | "B"
 *
 *   pageA1 — bunker A, first device of identity A
 *   pageA2 — bunker A, second device of identity A  (lazy auth via AttachA2Command_MD)
 *   pageB  — bunker B, only device of identity B
 *
 * numRuns: 12 / maxCommands: 8  per spec design-decision §6.
 * Timeout: 720 000 ms  (12 min) per AC-MD-RUN-4.
 * Counterexample format: Device.Verb(args) per AC-MD-CMD-TOSTRING-1.
 *
 * Reproducing a failure:
 *   FAST_CHECK_SEED=<seed> FAST_CHECK_PATH=<path> npx playwright test multi-user-md.property.spec.ts
 *
 * S1 skeleton — commands and assertions land in S2..S6.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import * as fc from "fast-check";
import { v4 as uuidv4 } from "uuid";

import {
  spawnSpecBunker,
  type SpecBunkerHandle,
} from "../fixtures/spec-bunker.js";
import {
  authenticate,
  createGroup,
  currentGroupId,
  dispatchTaskEvent,
  forgetLeafByIndex,
  getGroupEpochHook,
  getGroupMembersHook,
  getPubkeyHex,
  getPubkeyLeafCountHook,
  inviteByNpub,
  leafIndexesFor,
  projectIsMobile,
  quiesceFor,
  reload,
  renameDevice,
  selectGroup,
  settle,
} from "../fixtures/two-party.js";

import { awaitDeviceJoin } from "../fixtures/multi-device.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Explicit KP-slot strings for the two A-identity contexts. Without distinct
 *  slots both contexts would derive the same slot from the bunker pubkey and
 *  only one key package would land on the relay (AC-MD-FILE-7). */
const SLOT_A1 = "A1";
const SLOT_A2 = "A2";

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";

// ---------------------------------------------------------------------------
// Type aliases — Identity vs Device
// ---------------------------------------------------------------------------

/** Nostr identity (pubkey axis). A1 and A2 share identity A. */
type Identity = "A" | "B";

/** Page / browser-context axis. The unit at which UI state differs. */
type Device = "A1" | "A2" | "B";

type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

// ---------------------------------------------------------------------------
// ModelStateMD — tracks expected state across three devices / two identities
// ---------------------------------------------------------------------------

interface ModelTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * S1 stub — fields declared, methods implemented at the class level.
 * Command bodies land in S2..S4; assertion bodies land in S5.
 */
class ModelStateMD {
  groupId: string | null = null;
  groupName: string | null = null;

  /** One pubkey per identity — A1 and A2 share pubkeyA. */
  pubkeyA: string | null = null;
  pubkeyB: string | null = null;

  /** Per-device membership flags. A2 is only set by AttachA2Command_MD. */
  membersA1 = false;
  membersA2 = false;
  membersB = false;

  /**
   * Task map is identity-scoped, not device-scoped.
   * A1 and A2 should always see the same tasks (that is what A15 asserts).
   */
  tasks: Map<string, ModelTask> = new Map();

  /**
   * Epoch is per-device: A1 and A2 may be one epoch apart between commits
   * and applies; they converge at quiescence.
   */
  epochSequenceA1: number[] = [];
  epochSequenceA2: number[] = [];
  epochSequenceB: number[] = [];

  /**
   * Carried over from epic-property-tests-l3-completion ModelState.
   * Unused in S1; retained for structural parity so S5 can add its
   * assertS7-equivalent without a field migration.
   */
  lastSwitched: { context: Device; priorGroupIds: string[] } | null = null;

  // ---- helpers ----

  identityOf(d: Device): Identity {
    return d === "B" ? "B" : "A";
  }

  pubkeyOf(d: Device): string | null {
    return this.identityOf(d) === "A" ? this.pubkeyA : this.pubkeyB;
  }

  deviceIsMember(d: Device): boolean {
    if (d === "A1") return this.membersA1;
    if (d === "A2") return this.membersA2;
    return this.membersB;
  }

  identityIsMember(i: Identity): boolean {
    return i === "A" ? this.membersA1 || this.membersA2 : this.membersB;
  }

  recordEpoch(d: Device, epoch: number | null): void {
    if (epoch === null) return;
    if (d === "A1") this.epochSequenceA1.push(epoch);
    else if (d === "A2") this.epochSequenceA2.push(epoch);
    else this.epochSequenceB.push(epoch);
  }
}

// ---------------------------------------------------------------------------
// RealSystemMD — wraps three Playwright pages
// ---------------------------------------------------------------------------

/**
 * S1 stub — page accessor and quiesce wired; getTasks and dispatchCt/etc.
 * land in S3.
 */
class RealSystemMD {
  constructor(
    readonly pageA1: Page,
    readonly pageA2: Page,
    readonly pageB: Page,
  ) {}

  page(d: Device): Page {
    if (d === "A1") return this.pageA1;
    if (d === "A2") return this.pageA2;
    return this.pageB;
  }

  async getTasks(d: Device): Promise<Map<string, ModelTask>> {
    const tasks = await this.page(d).evaluate(() => {
      const fn = (window as { __notestrTestTasks?: () => unknown[] }).__notestrTestTasks;
      if (typeof fn !== "function") return [];
      return fn();
    });
    const result = new Map<string, ModelTask>();
    for (const t of tasks as ModelTask[]) {
      result.set(t.id, t);
    }
    return result;
  }

  async quiesce(): Promise<void> {
    await quiesceFor([this.pageA1, this.pageA2, this.pageB], {
      maxWaitMs: 15000,
      intervalMs: 500,
    });
  }
}

// ---------------------------------------------------------------------------
// S2: AttachA2Command_MD — the RISER command
// ---------------------------------------------------------------------------

/**
 * `AttachA2Command_MD` — authenticates the second device of identity A and
 * waits for its MLS welcome to propagate.
 *
 * This is the RISER command: every subsequent S3/S4 command that targets A2
 * relies on `m.membersA2 = true` being set here first.
 *
 * check(m): fires exactly once per run, only after A1 is in a group
 *   (AC-MD-ATTACH-1).
 *
 * run(m, r):
 *   1. Authenticates pageA2 with explicit slot SLOT_A2 (AC-MD-ATTACH-2,
 *      AC-MD-FILE-7). Without SLOT_A2 both A-contexts derive the same slot
 *      from the bunker pubkey and only one KP lands on the relay.
 *   2. Awaits the welcome via awaitDeviceJoin — polls leafIndexesFor on A1's
 *      page until leaf count >= 2 (AC-MD-ATTACH-3).
 *   3. Sets m.membersA2 = true (AC-MD-ATTACH-2).
 *   4. Captures initial epoch into m.epochSequenceA2 (AC-MD-ATTACH-2).
 *   5. Postcondition: leafIndexesFor(r.pageA1, ...).length >= 2 (AC-MD-ATTACH-4).
 */
class AttachA2Command_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  check(m: Readonly<ModelStateMD>): boolean {
    // Fire only when A1 is in a group AND A2 has not yet attached.
    // Single-fire gate: m.membersA2 prevents re-attaching (AC-MD-ATTACH-1).
    return m.membersA1 && m.groupId !== null && !m.membersA2;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    // 1. Authenticate pageA2 with explicit slot SLOT_A2 (AC-MD-ATTACH-2).
    //    SLOT_A2 = "A2" — distinct from SLOT_A1 = "A1" so each context
    //    publishes its own KP to the relay, yielding two leaves for pubkeyA.
    await authenticate(r.pageA2, bunkerA.bunkerUrl, SLOT_A2);

    // 2. Wait for A2's welcome to land — poll A1's page until leaf count >= 2.
    await awaitDeviceJoin(r.pageA2, r.pageA1, m.groupId!);

    // 3. Record A2 as a member.
    m.membersA2 = true;

    // 4. Capture the initial epoch seen by A2 (AC-MD-ATTACH-2).
    const epoch = await getGroupEpochHook(r.pageA2, m.groupId!);
    if (epoch !== null) m.epochSequenceA2.push(epoch);

    // 5. Postcondition: pubkeyA now has >= 2 leaves in A1's ratchet-tree view
    //    (AC-MD-ATTACH-4). A failure here means the welcome did not propagate
    //    correctly and should appear as "A2.Attach()" in the shrunk chain.
    const leaves = await leafIndexesFor(r.pageA1, m.groupId!, m.pubkeyA!);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
  }

  toString(): string {
    return "A2.Attach()";
  }
}

// ---------------------------------------------------------------------------
// S4: Group-lifecycle commands
// ---------------------------------------------------------------------------

/**
 * `CgCommand_MD` — A1 creates the shared group on pageA1.
 *
 * check(m): fires only before any group exists (AC-MD-CG-1).
 * run:
 *   1. Generates a unique group name and calls createGroup on pageA1.
 *   2. Captures the new groupId via currentGroupId (snapshot-safe immediately
 *      after creation — pageA1 auto-selects the created group).
 *   3. Sets m.membersA1 = true, m.groupId, m.groupName.
 *   4. Records A1's initial epoch.
 *
 * toString(): "A1.Cg(group)"
 */
class CgCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  check(m: Readonly<ModelStateMD>): boolean {
    // Only fires when no group has been created yet AND pubkeys are cached
    // (AC-MD-CG-1). The pubkey gate mirrors the 2-party CgCommand: downstream
    // per-device commands use m.pubkeyOf(device)! non-null assertions, so we
    // refuse to start a group until the model has been seeded by S6's
    // fc.assert per-run setup.
    return (
      m.groupId === null &&
      !m.membersA1 &&
      m.pubkeyA !== null &&
      m.pubkeyB !== null
    );
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const name = `MDProp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await createGroup(r.pageA1, name);
    const gid = await currentGroupId(r.pageA1);

    m.groupId = gid;
    m.groupName = name;
    m.membersA1 = true;

    // Record initial epoch so assertS6_MD sees a non-empty sequence from run start.
    const epoch = await getGroupEpochHook(r.pageA1, gid);
    m.recordEpoch("A1", epoch);
  }

  toString(): string {
    return "A1.Cg(group)";
  }
}

/**
 * `InCommand_MD` — A1 invites B to the group.
 *
 * check(m): fires only when A1 is in a group and B has not yet been invited
 *   (AC-MD-IN-1).
 * run:
 *   1. 1-second settle so B's key package is indexed on the relay.
 *   2. inviteByNpub on pageA1.
 *   3. Reload pageB and wait for the pubkey chip (welcome path — more reliable
 *      than waiting for live subscription delivery after accumulated groups).
 *   4. selectGroup on pageB so B's view of the group is initialised.
 *   5. Note: m.groupId is identity-scoped (design-decision 4) — B uses the same
 *      groupId that A1 already set. There is no separate m.groupIdB.
 *   6. Sets m.membersB = true, records B's epoch.
 *
 * toString(): "A1.In(B)"
 */
class InCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  check(m: Readonly<ModelStateMD>): boolean {
    // A1 must be in the group and B must not yet be a member (AC-MD-IN-1).
    return m.membersA1 && !m.membersB;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    // Brief settle so B's key package is indexed on the relay before A1 invites.
    await settle(r.pageA1, 1000);
    await inviteByNpub(r.pageA1, bunkerB.npub);

    // Reload B — triggers the device-sync welcome fetch path, which is more
    // reliable than waiting for live subscription delivery after many groups.
    await r.pageB.reload();
    await r.pageB
      .locator('[data-testid="pubkey-chip"]')
      .waitFor({ state: "visible", timeout: 30000 });

    // Select the group on B's page so its task store is mounted.
    await selectGroup(r.pageB, m.groupName!);

    // m.groupId is shared — A1's groupId is the same group B just joined
    // (design-decision 4: tasks are identity-scoped, group is single-entity).
    m.membersB = true;

    // Record A1's epoch (invite creates an MLS commit on A1's side).
    const epochA1 = await getGroupEpochHook(r.pageA1, m.groupId!);
    m.recordEpoch("A1", epochA1);

    // Record B's initial epoch.
    const epochB = await getGroupEpochHook(r.pageB, m.groupId!);
    m.recordEpoch("B", epochB);
  }

  toString(): string {
    return "A1.In(B)";
  }
}

/**
 * `LgCommand_MD` — a device leaves the group via its own page.
 *
 * check(m): device must currently be a member and a group must exist
 *   (AC-MD-LG-1).
 * run:
 *   Uses the locator-direct leave pattern (mirrors 2-party LgCommand at lines
 *   303-365 in multi-user.property.spec.ts — does NOT use the leaveGroup helper
 *   because the 2-party file uses the locator pattern directly).
 *   Identity-A 2→1 semantics (AC-MD-LG-2): when A1 leaves while A2 is still in,
 *   only m.membersA1 is cleared — identity A retains one leaf through A2.
 *
 * A14 wire check: deferred per spec § Scope ("leaf-count consequence only is
 * asserted here"). A14 is not in the MD invariant set; the openNdkSubscriber
 * round-trip would add ~2 s per leave event across 12 runs. Deferral is
 * intentional (architecture.md constraint 12).
 *
 * toString(): "${device}.Lg(group)"
 */
class LgCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(private readonly device: Device) {}

  check(m: Readonly<ModelStateMD>): boolean {
    // Device must be a current member and the group must exist (AC-MD-LG-1).
    return m.deviceIsMember(this.device) && m.groupId !== null;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const page = r.page(this.device);
    const groupName = m.groupName!;

    // Locator-direct leave — mirrors multi-user.property.spec.ts:322-326.
    const groupRow = page
      .locator('nav[aria-label="Groups"] li')
      .filter({ hasText: groupName });
    await groupRow.locator('[data-testid="group-leave-btn"]').click();
    await page.locator('[data-testid="group-leave-confirm"]').click();

    // Update model: only clear the flag for THIS device (AC-MD-LG-1).
    // Identity-A 2→1 semantics (AC-MD-LG-2): when A1 leaves while A2 is still
    // in, identity A retains one leaf (A2). Only m.membersA1 is cleared; A2
    // remains and leafCount(A) is now 1.
    if (this.device === "A1") {
      m.membersA1 = false;
    } else if (this.device === "A2") {
      m.membersA2 = false;
    } else {
      m.membersB = false;
    }

    // Record epoch on a remaining device so assertS6_MD can see the commit.
    // Pick the first device still in the group (A1 → A2 → B priority).
    if (m.membersA1) {
      const epoch = await getGroupEpochHook(r.pageA1, m.groupId!);
      m.recordEpoch("A1", epoch);
    } else if (m.membersA2) {
      const epoch = await getGroupEpochHook(r.pageA2, m.groupId!);
      m.recordEpoch("A2", epoch);
    } else if (m.membersB) {
      const epoch = await getGroupEpochHook(r.pageB, m.groupId!);
      m.recordEpoch("B", epoch);
    }
  }

  toString(): string {
    return `${this.device}.Lg(group)`;
  }
}

/**
 * `RdCommand_MD` — rename a device on the device's own page.
 *
 * check(m): device must be a member and a group must exist so the DeviceList
 *   is mounted (AC-MD-RD-1). DeviceList is only rendered inside a selected
 *   group — checking m.groupId!==null ensures the group panel is open.
 * run:
 *   Uses renameDevice(r.page(device), ...) — the helper finds the first
 *   `[data-testid="device-row"]` with a textbox, fills the new name, and blurs.
 *   Because renameDevice finds a row by its current label text and the current
 *   label is not tracked in the model, we pass an empty string for deviceLabel
 *   and rely on the first-textbox pattern (mirrors RdCommand at lines 431-463).
 *
 * toString(): "${device}.Rd(device, ${newName.slice(0, 12)})"
 */
class RdCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(
    private readonly device: Device,
    private readonly newName: string,
  ) {}

  check(m: Readonly<ModelStateMD>): boolean {
    // Device must be in a group so DeviceList is visible (AC-MD-RD-1).
    return m.deviceIsMember(this.device) && m.groupId !== null;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const page = r.page(this.device);
    // Locate the first device-row with a textbox. The renameDevice helper
    // targets by current label; here we use the locator pattern directly
    // (mirrors RdCommand at multi-user.property.spec.ts:441-449) so we don't
    // need to track the current device label in the model.
    const rows = page.locator('[data-testid="device-row"]');
    const count = await rows.count();
    if (count === 0) return;

    const row = rows.first();
    const input = row.getByRole("textbox");
    const inputCount = await input.count();
    if (inputCount === 0) return;

    await input.fill(this.newName);
    await input.blur();
  }

  toString(): string {
    return `${this.device}.Rd(device, ${this.newName.slice(0, 12)})`;
  }
}

/**
 * `FdCommand_MD` — A1 forgets one of A's own leaves (the multi-leaf same-pubkey
 * case: A1 forgets A2's leaf).
 *
 * This is the core multi-device test: A1 and A2 share pubkeyA, so both appear
 * as leaves in the group's ratchet tree. After forgetLeafByIndex, leafCount(A)
 * drops from 2 to 1. The zero-leaf branch (where A would be fully removed) is
 * unreachable because check requires both m.membersA1 AND m.membersA2 (AC-MD-FD-2).
 *
 * check(m): both A1 and A2 must be members and a group must exist (AC-MD-FD-1).
 *   This gate prevents the zero-leaf branch: if only one of them is in, there
 *   is no "other" leaf to forget without removing identity A entirely.
 *
 * run:
 *   1. Read leafIndexesFor(r.pageA1, m.groupId!, m.pubkeyA!) to find A's current
 *      leaf indexes in the ratchet tree.
 *   2. Defensive: if length < 2, no-op (should not occur given check, but guards
 *      against relay timing edge cases).
 *   3. Pick the leaf index NOT belonging to A1 — use the last index in the array
 *      (both A1 and A2 may be at any position; the convention is "last index is
 *      the most recently added leaf, which is A2 in the typical Cg→Attach flow").
 *   4. forgetLeafByIndex in try/catch (MLS errors silently skipped — same
 *      resilience as FdCommand at multi-user.property.spec.ts:386-390).
 *   5. Poll until leaf count drops by 1 (postcondition for AC-MD-FD-2).
 *   6. Set m.membersA2 = false if leafCount now equals 1 (A2's leaf is gone).
 *
 * A14 wire check: deferred — same rationale as LgCommand_MD.
 *
 * toString(): "A1.Fd(A-leaf)"
 */
class FdCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  check(m: Readonly<ModelStateMD>): boolean {
    // Both A1 and A2 must be in the group. Without A2, there is no second leaf
    // to forget without hitting the zero-leaf branch (AC-MD-FD-1, AC-MD-FD-2).
    return m.membersA1 && m.membersA2 && m.groupId !== null;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const groupId = m.groupId!;
    const pubkeyA = m.pubkeyA!;

    const indexes = await leafIndexesFor(r.pageA1, groupId, pubkeyA);

    // Defensive: should not happen given check, but guards against relay timing.
    if (indexes.length < 2) return;

    const leafCount = indexes.length;

    // Pick the "other" leaf — the last index is the most recently added leaf
    // (A2 in the standard Cg → Attach flow). If for any reason the order is
    // reversed, we still pick a leaf that is not the only one.
    const leafIndex = indexes[indexes.length - 1]!;

    try {
      await forgetLeafByIndex(r.pageA1, groupId, leafIndex);
    } catch {
      // MLS commit error — skip postconditions for this command. Same resilience
      // pattern as FdCommand at multi-user.property.spec.ts:386-390.
      return;
    }

    // Record A1's epoch after the forget commit.
    const epoch = await getGroupEpochHook(r.pageA1, groupId);
    m.recordEpoch("A1", epoch);

    // Poll until leaf count drops by 1 (AC-MD-FD-2 postcondition).
    await expect
      .poll(() => leafIndexesFor(r.pageA1, groupId, pubkeyA), { timeout: 15000 })
      .toHaveLength(leafCount - 1);

    // If leafCount reaches 1, A2's leaf is gone; identity A still has one leaf.
    // Zero-leaf is unreachable here because check required leafCount >= 2 and
    // we forget exactly one leaf (AC-MD-FD-2 — zero-leaf branch unreachable).
    const newLeafCount = leafCount - 1;
    if (newLeafCount <= 1) {
      m.membersA2 = false;
    }
  }

  toString(): string {
    return "A1.Fd(A-leaf)";
  }
}

// ---------------------------------------------------------------------------
// S3: Per-device task commands
// ---------------------------------------------------------------------------

/**
 * `CtCommand_MD` — create a task on any member device.
 *
 * check(m): device must be a group member and a group must exist (AC-MD-CT-1).
 * run:
 *   Dispatches task.created via dispatchTaskEvent on r.page(device).
 *   Records the new task into m.tasks (identity-scoped — A1 and A2 share).
 *   Records epoch for the dispatching device.
 *
 * Postcondition: task present with status:"open", assignee:null,
 *   createdBy: m.pubkeyOf(device) (AC-MD-CT-1).
 *
 * toString(): "${device}.Ct(<title[:20]>)"  (AC-MD-CMD-TOSTRING-1)
 */
class CtCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(
    private readonly device: Device,
    private readonly title: string,
    private readonly description: string,
  ) {}

  check(m: Readonly<ModelStateMD>): boolean {
    // Device must be a current member and a group must exist (AC-MD-CT-1).
    return m.deviceIsMember(this.device) && m.groupId !== null;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const id = uuidv4();
    const now = Date.now();
    const pubkey = m.pubkeyOf(this.device)!;

    await dispatchTaskEvent(r.page(this.device), {
      type: "task.created",
      task: {
        id,
        title: this.title,
        description: this.description,
        status: "open",
        assignee: null,
        createdBy: pubkey,
        createdAt: now,
        updatedAt: now,
      },
    });

    // Record into model (identity-scoped: A1 and A2 share m.tasks).
    m.tasks.set(id, {
      id,
      title: this.title,
      description: this.description,
      status: "open",
      assignee: null,
      createdBy: pubkey,
      createdAt: now,
      updatedAt: now,
    });

    const epoch = await getGroupEpochHook(r.page(this.device), m.groupId!);
    m.recordEpoch(this.device, epoch);

    // Postcondition: task present with expected fields (AC-MD-CT-1).
    const tasks = await r.getTasks(this.device);
    const task = tasks.get(id);
    expect(task).toBeDefined();
    expect(task?.status).toBe("open");
    expect(task?.assignee).toBeNull();
    expect(task?.createdBy).toBe(pubkey);
  }

  toString(): string {
    return `${this.device}.Ct(${this.title.slice(0, 20)})`;
  }
}

/**
 * `UtCommand_MD` — update a task's title on any member device.
 *
 * check(m): device must be a member, group must exist, and at least one task
 *   must be in the model (AC-MD-UT-1).
 * run:
 *   Dispatches task.updated on r.page(device) targeting the first task.
 *   Postcondition: task.title === this.title (A3 pattern).
 *
 * toString(): "${device}.Ut(<title[:20]>)"  (AC-MD-CMD-TOSTRING-1)
 */
class UtCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(
    private readonly device: Device,
    private readonly title: string,
  ) {}

  check(m: Readonly<ModelStateMD>): boolean {
    return (
      m.deviceIsMember(this.device) &&
      m.groupId !== null &&
      m.tasks.size > 0
    );
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const taskIds = [...m.tasks.keys()];
    const targetId = taskIds[0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkeyOf(this.device)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.device), {
      type: "task.updated",
      taskId: targetId,
      changes: { title: this.title },
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, title: this.title, updatedAt });

    const epoch = await getGroupEpochHook(r.page(this.device), m.groupId!);
    m.recordEpoch(this.device, epoch);

    // Postcondition: title updated (AC-MD-UT-1, A3 pattern).
    const tasks = await r.getTasks(this.device);
    const task = tasks.get(targetId);
    if (task) {
      expect(task.title).toBe(this.title);
    }
  }

  toString(): string {
    return `${this.device}.Ut(${this.title.slice(0, 20)})`;
  }
}

/**
 * `ScCommand_MD` — change a task's status on any member device.
 *
 * check(m): device must be a member, group must exist, tasks must be present
 *   (AC-MD-SC-1).
 * run:
 *   Dispatches task.status_changed on r.page(device).
 *   Postcondition: task.status === this.status (A4 pattern).
 *
 * toString(): "${device}.Sc(${status})"  (AC-MD-CMD-TOSTRING-1)
 */
class ScCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(
    private readonly device: Device,
    private readonly status: TaskStatus,
  ) {}

  check(m: Readonly<ModelStateMD>): boolean {
    return (
      m.deviceIsMember(this.device) &&
      m.groupId !== null &&
      m.tasks.size > 0
    );
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const taskIds = [...m.tasks.keys()];
    const targetId = taskIds[0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkeyOf(this.device)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.device), {
      type: "task.status_changed",
      taskId: targetId,
      status: this.status,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, status: this.status, updatedAt });

    const epoch = await getGroupEpochHook(r.page(this.device), m.groupId!);
    m.recordEpoch(this.device, epoch);

    // Postcondition: status updated (AC-MD-SC-1, A4 pattern).
    const tasks = await r.getTasks(this.device);
    const task = tasks.get(targetId);
    if (task) {
      expect(task.status).toBe(this.status);
    }
  }

  toString(): string {
    return `${this.device}.Sc(${this.status})`;
  }
}

/**
 * `AsCommand_MD` — self-assign a task on any member device.
 *
 * Self-assign means the device's identity pubkey (m.pubkeyOf(device)).
 * Both A1 and A2 assign to pubkeyA — one pubkey, two leaves (AC-MD-AS-1).
 *
 * check(m): device must be a member, group must exist, tasks must be present,
 *   and the device's pubkey must be known.
 * run:
 *   Dispatches task.assigned with assignee = m.pubkeyOf(device).
 *   Postcondition: task.assignee === m.pubkeyOf(device) (A4 pattern).
 *
 * toString(): "${device}.As(pubkey)"  (AC-MD-CMD-TOSTRING-1)
 */
class AsCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(private readonly device: Device) {}

  check(m: Readonly<ModelStateMD>): boolean {
    return (
      m.deviceIsMember(this.device) &&
      m.groupId !== null &&
      m.tasks.size > 0 &&
      m.pubkeyOf(this.device) !== null
    );
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const taskIds = [...m.tasks.keys()];
    const targetId = taskIds[0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkeyOf(this.device)!;
    const assignee = pubkey; // self-assign: this device's identity pubkey
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.device), {
      type: "task.assigned",
      taskId: targetId,
      assignee,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, assignee, updatedAt });

    const epoch = await getGroupEpochHook(r.page(this.device), m.groupId!);
    m.recordEpoch(this.device, epoch);

    // Postcondition: assignee equals device's identity pubkey (AC-MD-AS-1, A4 pattern).
    const tasks = await r.getTasks(this.device);
    const task = tasks.get(targetId);
    if (task) {
      expect(task.assignee).toBe(assignee);
    }
  }

  toString(): string {
    return `${this.device}.As(pubkey)`;
  }
}

/**
 * `UnCommand_MD` — unassign a task on any member device.
 *
 * check(m): same gates as As but without pubkey gate (AC-MD-UN-1).
 * run:
 *   Dispatches task.assigned with assignee: null.
 *   Postcondition: task.assignee === null (A4 pattern).
 *
 * toString(): "${device}.Un(task)"  (AC-MD-CMD-TOSTRING-1)
 */
class UnCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(private readonly device: Device) {}

  check(m: Readonly<ModelStateMD>): boolean {
    return (
      m.deviceIsMember(this.device) &&
      m.groupId !== null &&
      m.tasks.size > 0
    );
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const taskIds = [...m.tasks.keys()];
    const targetId = taskIds[0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkeyOf(this.device)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.device), {
      type: "task.assigned",
      taskId: targetId,
      assignee: null,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, assignee: null, updatedAt });

    const epoch = await getGroupEpochHook(r.page(this.device), m.groupId!);
    m.recordEpoch(this.device, epoch);

    // Postcondition: task unassigned (AC-MD-UN-1, A4 pattern).
    const tasks = await r.getTasks(this.device);
    const task = tasks.get(targetId);
    if (task) {
      expect(task.assignee).toBeNull();
    }
  }

  toString(): string {
    return `${this.device}.Un(task)`;
  }
}

/**
 * `DtCommand_MD` — delete a task on any member device.
 *
 * check(m): same gates as Un (AC-MD-DT-1).
 * run:
 *   Dispatches task.deleted, removes from m.tasks.
 *   Postcondition: task absent from device's local state (A5 pattern).
 *
 * toString(): "${device}.Dt(task)"  (AC-MD-CMD-TOSTRING-1)
 */
class DtCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(private readonly device: Device) {}

  check(m: Readonly<ModelStateMD>): boolean {
    return (
      m.deviceIsMember(this.device) &&
      m.groupId !== null &&
      m.tasks.size > 0
    );
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const taskIds = [...m.tasks.keys()];
    const targetId = taskIds[0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkeyOf(this.device)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.device), {
      type: "task.deleted",
      taskId: targetId,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.delete(targetId);

    const epoch = await getGroupEpochHook(r.page(this.device), m.groupId!);
    m.recordEpoch(this.device, epoch);

    // Postcondition: task absent (AC-MD-DT-1, A5 pattern).
    const tasks = await r.getTasks(this.device);
    expect(tasks.has(targetId)).toBe(false);
  }

  toString(): string {
    return `${this.device}.Dt(task)`;
  }
}

/**
 * `RlCommand_MD` — reload a device's page.
 *
 * check(m): device must be a member and a group must exist.
 *   "device is member" implies "page is authenticated" for the MD model
 *   (mirrors 2-party's `m.actorIsAuthenticated` gate — AC-MD-RL-1).
 * run:
 *   1. Snapshot tasks before reload.
 *   2. reload(r.page(device)) — waits for pubkey chip to reappear.
 *   3. 3-second settle (key packages re-publish on mount).
 *   4. Re-select group on the device's page so its task store is remounted.
 *   5. Record epoch.
 *   6. Assert: all pre-reload model tasks still present in post-reload store
 *      (A11 invariant — post-reload visible state is byte-identical to
 *       pre-reload state for persisted tasks).
 *
 * toString(): "${device}.Rl()"  (AC-MD-CMD-TOSTRING-1)
 */
class RlCommand_MD implements fc.AsyncCommand<ModelStateMD, RealSystemMD> {
  constructor(private readonly device: Device) {}

  check(m: Readonly<ModelStateMD>): boolean {
    // "device is member" implies authenticated; group must exist so there is
    // something to re-select after reload (AC-MD-RL-1).
    return m.deviceIsMember(this.device) && m.groupId !== null;
  }

  async run(m: ModelStateMD, r: RealSystemMD): Promise<void> {
    const page = r.page(this.device);
    const tasksBefore = await r.getTasks(this.device);

    // 1. Reload and wait for session-restore (pubkey chip).
    await reload(page);
    // 2. 3-second settle — MarmotProvider re-publishes key packages on mount.
    await settle(page, 3000);

    // 3. Re-select the group so the task store is remounted.
    if (m.groupName) {
      const sidebar = page.locator("aside");
      const groupVisible = await sidebar
        .getByText(m.groupName)
        .first()
        .isVisible()
        .catch(() => false);
      if (!groupVisible) {
        await settle(page, 3000);
      }
      await sidebar.getByText(m.groupName).first().click().catch(() => {});
      await page
        .getByRole("heading", { name: "Tasks" })
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});
    }

    const epoch = await getGroupEpochHook(page, m.groupId!);
    m.recordEpoch(this.device, epoch);

    // 4. A11: all pre-reload model tasks still present post-reload (AC-MD-RL-1).
    const tasksAfter = await r.getTasks(this.device);
    for (const [id] of tasksBefore) {
      if (m.tasks.has(id)) {
        // Task is in the model — it must survive the reload.
        expect(tasksAfter.has(id)).toBe(true);
      }
    }
  }

  toString(): string {
    return `${this.device}.Rl()`;
  }
}

// ---------------------------------------------------------------------------
// S5: Headline assertion functions
// ---------------------------------------------------------------------------

/**
 * `assertA15_MD` — Multi-device same-pubkey self-converge.
 *
 * AC-MD-DEG-1/2: strict form here (test hooks present per
 * epic-property-tests-l3-completion); degraded fallback would call only
 * task-subset and skip member/epoch/leaf assertions.
 *
 * Asserts that at quiescence A1 and A2 — sharing the same pubkey — see an
 * identical view of: (1) tasks, (2) group members, (3) group epoch, and
 * (4) per-pubkey leaf counts. A divergence here indicates either a replication
 * failure or an MLS ratchet-tree inconsistency between the two leaf contexts.
 *
 * AC-MD-A15-1 skip-guard: returns silently when preconditions not met.
 */
async function assertA15_MD(m: ModelStateMD, r: RealSystemMD): Promise<void> {
  // AC-MD-A15-1: guard — only run when both A-devices are members of a group.
  if (!m.groupId || !(m.membersA1 && m.membersA2)) return;

  // AC-MD-A15-2: task-id sets and per-id field equality.
  const tasksA1 = await r.getTasks("A1");
  const tasksA2 = await r.getTasks("A2");
  expect(new Set(tasksA1.keys())).toEqual(new Set(tasksA2.keys()));
  for (const [id, ta1] of tasksA1) {
    const ta2 = tasksA2.get(id)!;
    expect(ta1.status).toBe(ta2.status);
    expect(ta1.assignee).toBe(ta2.assignee);
    expect(ta1.title).toBe(ta2.title);
  }

  // AC-MD-A15-3: member-set equality between A1 and A2.
  const membersA1 = await getGroupMembersHook(r.pageA1, m.groupId);
  const membersA2 = await getGroupMembersHook(r.pageA2, m.groupId);
  expect(new Set(membersA1 ?? [])).toEqual(new Set(membersA2 ?? []));

  // AC-MD-A15-4: epoch equality between A1 and A2.
  const epochA1 = await getGroupEpochHook(r.pageA1, m.groupId);
  const epochA2 = await getGroupEpochHook(r.pageA2, m.groupId);
  expect(epochA1).toBe(epochA2);

  // AC-MD-A15-5: per-pubkey leaf-count equality across A1 and A2 for every
  // member pubkey in the union of both views.
  for (const p of new Set([...(membersA1 ?? []), ...(membersA2 ?? [])])) {
    const lc1 = await getPubkeyLeafCountHook(r.pageA1, m.groupId, p);
    const lc2 = await getPubkeyLeafCountHook(r.pageA2, m.groupId, p);
    expect(lc1).toBe(lc2);
  }
}

/**
 * `assertC0_MD` — Three-way convergence invariant.
 *
 * AC-MD-DEG-1/2: strict form here (test hooks present per
 * epic-property-tests-l3-completion); degraded fallback would call only
 * task-subset and skip member/epoch/leaf assertions.
 *
 * Extends the 2-party `assertC0` (multi-user.property.spec.ts:862-911) to
 * three pages. All four dimensions — tasks, members, epoch, leaf counts —
 * must be equal across A1, A2, and B. Named separately from assertA15_MD per
 * spec design-decision 9: the invariant catalogue name is C0, the failure mode
 * is a three-way split rather than an A1↔A2 split.
 *
 * AC-MD-C0-1 skip-guard: only runs when all three devices are members.
 */
async function assertC0_MD(m: ModelStateMD, r: RealSystemMD): Promise<void> {
  // AC-MD-C0-1: guard — all three devices must be members of the same group.
  if (!m.groupId || !(m.membersA1 && m.membersA2 && m.membersB)) return;

  // Task-id set equality: A1, A2, and B must all see the same task ids.
  const tasksA1 = await r.getTasks("A1");
  const tasksA2 = await r.getTasks("A2");
  const tasksB = await r.getTasks("B");

  const idsA1 = new Set(tasksA1.keys());
  const idsA2 = new Set(tasksA2.keys());
  const idsB = new Set(tasksB.keys());
  expect(idsA1).toEqual(idsA2);
  expect(idsA1).toEqual(idsB);

  // Per-shared-id field equality across all three pages.
  for (const [id, ta1] of tasksA1) {
    const ta2 = tasksA2.get(id);
    const tb = tasksB.get(id);
    if (ta2) {
      expect(ta1.status).toBe(ta2.status);
      expect(ta1.assignee).toBe(ta2.assignee);
      expect(ta1.title).toBe(ta2.title);
    }
    if (tb) {
      expect(ta1.status).toBe(tb.status);
      expect(ta1.assignee).toBe(tb.assignee);
      expect(ta1.title).toBe(tb.title);
    }
  }

  // Member-set equality across all three pages.
  const membersA1 = await getGroupMembersHook(r.pageA1, m.groupId);
  const membersA2 = await getGroupMembersHook(r.pageA2, m.groupId);
  const membersB = await getGroupMembersHook(r.pageB, m.groupId);
  expect(new Set(membersA1 ?? [])).toEqual(new Set(membersA2 ?? []));
  expect(new Set(membersA1 ?? [])).toEqual(new Set(membersB ?? []));

  // Epoch equality: all three pages must agree on the current group epoch.
  const epochA1 = await getGroupEpochHook(r.pageA1, m.groupId);
  const epochA2 = await getGroupEpochHook(r.pageA2, m.groupId);
  const epochB = await getGroupEpochHook(r.pageB, m.groupId);
  expect(epochA1).toBe(epochA2);
  expect(epochA1).toBe(epochB);

  // Per-pubkey leaf-count equality: union of all three member views.
  const allPubkeys = new Set([
    ...(membersA1 ?? []),
    ...(membersA2 ?? []),
    ...(membersB ?? []),
  ]);
  for (const p of allPubkeys) {
    const lc1 = await getPubkeyLeafCountHook(r.pageA1, m.groupId, p);
    const lc2 = await getPubkeyLeafCountHook(r.pageA2, m.groupId, p);
    const lcB = await getPubkeyLeafCountHook(r.pageB, m.groupId, p);
    expect(lc1).toBe(lc2);
    expect(lc1).toBe(lcB);
  }
}

/**
 * `assertS5_MD` — Biconditional membership ↔ leaf-count invariant.
 *
 * AC-MD-DEG-1/2: strict form here (test hooks present per
 * epic-property-tests-l3-completion); degraded fallback would run the
 * positive direction only (isMember implies leafCount >= 1) and skip the
 * reverse direction.
 *
 * For each of pubkeyA and pubkeyB: (p ∈ members) ⟺ (leafCount(g, p) >= 1).
 * pubkeyA has expected leaf count 2 when both A1 and A2 are attached and
 * the FdCommand_MD has not fired; it drops to 1 after Lg or Fd.
 *
 * AC-MD-S5-1: scoped to m.groupId (current group only).
 */
async function assertS5_MD(m: ModelStateMD, r: RealSystemMD): Promise<void> {
  // Guard: group must exist and both pubkeys must be known.
  if (!m.groupId || !m.pubkeyA || !m.pubkeyB) return;

  // Read the ground-truth members list from A1 (the primary device).
  const members = await getGroupMembersHook(r.pageA1, m.groupId);
  if (members === null) return; // group not loaded on A1 — skip

  // AC-MD-S5-1: biconditional for each identity pubkey.
  for (const p of [m.pubkeyA, m.pubkeyB]) {
    const isMember = members.includes(p);
    const leafCount = await getPubkeyLeafCountHook(r.pageA1, m.groupId, p);
    // (p ∈ members) ⟺ (leafCount >= 1)
    expect(isMember).toBe((leafCount ?? 0) >= 1);
  }
}

/**
 * `assertS6_MD` — Per-device epoch monotonicity.
 *
 * AC-MD-DEG-1/2: strict form here (test hooks present per
 * epic-property-tests-l3-completion); degraded fallback would use the proxy
 * approach from the 2-party file (epoch increments inferred from command
 * boundaries rather than from test hooks).
 *
 * Model-only assertion: walks epochSequenceA1, epochSequenceA2, and
 * epochSequenceB and asserts each is non-decreasing. Mirrors assertS6 from
 * the 2-party file (multi-user.property.spec.ts:932-941) extended to three
 * sequences.
 *
 * AC-MD-S6-1: each sequence must be non-decreasing.
 */
async function assertS6_MD(m: ModelStateMD): Promise<void> {
  // AC-MD-S6-1: non-decreasing check for each of the three epoch sequences.
  for (const seq of [m.epochSequenceA1, m.epochSequenceA2, m.epochSequenceB]) {
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]!);
    }
  }
}

/**
 * `assertS10_MD` — DeviceList row-count matches leaf count on A1 and A2.
 *
 * AC-MD-DEG-1/2: strict form here (test hooks present per
 * epic-property-tests-l3-completion); degraded fallback would assert
 * deviceRows >= 0 only (no hook-derived expected count).
 *
 * Reads [data-testid="device-row"] count on BOTH pageA1 and pageA2. Each
 * count must equal getPubkeyLeafCountHook(page, groupId, pubkeyA). The
 * DeviceList shows A's own leaves in the current group.
 *
 * AC-MD-S10-1 skip-guard: only runs when groupId and pubkeyA are known.
 */
async function assertS10_MD(m: ModelStateMD, r: RealSystemMD): Promise<void> {
  // AC-MD-S10-1: guard — group and pubkeyA must be known.
  if (!m.groupId || !m.pubkeyA) return;
  // Additional guard: A1 and A2 must both be members for DeviceList to be
  // meaningful across two devices. S10 is a no-op if only one device is in.
  if (!m.membersA1 || !m.membersA2) return;

  // pageA1: row count vs leaf count.
  const rowCountA1 = await r.pageA1.locator('[data-testid="device-row"]').count();
  const leafCountA1 = await getPubkeyLeafCountHook(r.pageA1, m.groupId, m.pubkeyA);
  expect(rowCountA1).toBe(leafCountA1);

  // pageA2: row count vs leaf count.
  const rowCountA2 = await r.pageA2.locator('[data-testid="device-row"]').count();
  const leafCountA2 = await getPubkeyLeafCountHook(r.pageA2, m.groupId, m.pubkeyA);
  expect(rowCountA2).toBe(leafCountA2);
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let contextA1: BrowserContext;
let contextA2: BrowserContext;
let contextB: BrowserContext;
let pageA1: Page;
let pageA2: Page;
let pageB: Page;
let skipMobile = false;

/** Captured once in beforeAll after both A1 and B are authenticated.
 *  A2 reuses cachedPubkeyA — there is no cachedPubkeyA2 (AC-MD-FILE-6). */
let cachedPubkeyA: string;
let cachedPubkeyB: string;
// Per-spec bunkers — sharing the global bunkers across all suite specs leaks
// KPs and pending invitations between unrelated specs. A15 asserts member-set
// equality between A1 and A2 (same pubkey, two devices) and the pollution
// surfaces here as transient divergence in the full-suite ordering. Same
// pattern as multi-user.property.spec.ts.
let bunkerA: SpecBunkerHandle;
let bunkerB: SpecBunkerHandle;

test.beforeAll(async ({ browser }, workerInfo) => {
  skipMobile = projectIsMobile(workerInfo.project);
  if (skipMobile) return;

  [bunkerA, bunkerB] = await Promise.all([
    spawnSpecBunker("mu-md-A"),
    spawnSpecBunker("mu-md-B"),
  ]);

  contextA1 = await browser.newContext();
  contextA2 = await browser.newContext();
  contextB = await browser.newContext();
  pageA1 = await contextA1.newPage();
  pageA2 = await contextA2.newPage();
  pageB = await contextB.newPage();

  // B authenticates first so its key package is on the relay before A1
  // calls InCommand_MD (AC-MD-FILE-8).
  await authenticate(pageB, bunkerB.bunkerUrl);
  await settle(pageB, 3000);

  // A1 authenticates with explicit slot SLOT_A1 (AC-MD-FILE-7).
  // A2 is NOT authenticated here — that is deferred to AttachA2Command_MD
  // (AC-MD-FILE-5).
  await authenticate(pageA1, bunkerA.bunkerUrl, SLOT_A1);

  // Poll until test hooks are installed (useEffect runs slightly after
  // the pubkey-chip appears in the authenticated UI).
  await expect
    .poll(
      () => pageA1.evaluate(() => typeof (window as { __notestrTestPubkey?: unknown }).__notestrTestPubkey === "function"),
      { timeout: 10000 },
    )
    .toBe(true);
  await expect
    .poll(
      () => pageB.evaluate(() => typeof (window as { __notestrTestPubkey?: unknown }).__notestrTestPubkey === "function"),
      { timeout: 10000 },
    )
    .toBe(true);

  // Cache pubkeys once; A2 shares cachedPubkeyA (AC-MD-FILE-6).
  cachedPubkeyA = await getPubkeyHex(pageA1);
  cachedPubkeyB = await getPubkeyHex(pageB);
});

test.afterAll(async () => {
  await contextA1?.close();
  await contextA2?.close();
  await contextB?.close();
  await bunkerA?.dispose();
  await bunkerB?.dispose();
});

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

test.describe.serial("[A15,C0,S5,S6,S10] multi-device property", () => {
  test.setTimeout(720_000);

  test("[A15,C0,S5,S6,S10] multi-device convergence holds for any 5-8 action chain", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    const real = new RealSystemMD(pageA1, pageA2, pageB);

    // Arbitraries for device-parameterised commands.
    // NOTE: MD has no SwCommand_MD, so there is no identity-restore step
    // at end-of-run (contrast with 2-party file lines 1085-1090). This is
    // intentional per architecture.md constraint 11: no Sw means no drift.
    const arbDevice = fc.constantFrom<Device>("A1", "A2", "B");

    // String arbitraries — mirror 2-party sizes (multi-user.property.spec.ts:1035-1042).
    const arbTitle = fc.string({ minLength: 1, maxLength: 30 });
    const arbDesc = fc.string({ maxLength: 50 });
    const arbStatus = fc.constantFrom<TaskStatus>(
      "open",
      "in_progress",
      "done",
      "cancelled",
    );
    const arbNewName = fc.string({ minLength: 1, maxLength: 20 });

    // 13 command arbitraries per spec.md § Single test wiring (lines 235-249).
    const commands: fc.Arbitrary<fc.AsyncCommand<ModelStateMD, RealSystemMD>>[] = [
      fc.constant(new CgCommand_MD()),
      fc.constant(new InCommand_MD()),
      fc.constant(new AttachA2Command_MD()),
      fc.tuple(arbDevice, arbTitle, arbDesc).map(([d, title, desc]) => new CtCommand_MD(d, title, desc)),
      fc.tuple(arbDevice, arbTitle).map(([d, title]) => new UtCommand_MD(d, title)),
      fc.tuple(arbDevice, arbStatus).map(([d, status]) => new ScCommand_MD(d, status)),
      arbDevice.map((d) => new AsCommand_MD(d)),
      arbDevice.map((d) => new UnCommand_MD(d)),
      arbDevice.map((d) => new DtCommand_MD(d)),
      arbDevice.map((d) => new RlCommand_MD(d)),
      arbDevice.map((d) => new LgCommand_MD(d)),
      fc.tuple(arbDevice, arbNewName).map(([d, name]) => new RdCommand_MD(d, name)),
      fc.constant(new FdCommand_MD()),
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.commands(commands, { maxCommands: 8 }),
        async (cmds) => {
          // Reset only the model per run — browser authentication persists
          // across runs (same pattern as 2-party file lines 1076-1078).
          // Each run creates a new uniquely-named group via CgCommand_MD so
          // leftover groups from prior runs are ignored.
          const model = new ModelStateMD();
          model.pubkeyA = cachedPubkeyA;
          model.pubkeyB = cachedPubkeyB;

          await fc.asyncModelRun(() => ({ model, real }), cmds);

          // No identity-restore step: MD has no SwCommand_MD, so pubkeyA
          // never changes across runs (architecture.md constraint 11).

          // Post-chain quiescence then invariant assertions.
          await real.quiesce();

          await assertA15_MD(model, real);
          await assertC0_MD(model, real);
          await assertS5_MD(model, real);
          await assertS6_MD(model);
          await assertS10_MD(model, real);
        },
      ),
      {
        // AC-X-RUNS-MD-1: env override for CI tuning; default 12 per spec §6.
        numRuns: parseInt(process.env.FAST_CHECK_NUM_RUNS ?? "0") || 12,
        verbose: true,
        // AC-MD-RUN-3: deterministic reproduction via seed + path.
        seed: parseInt(process.env.FAST_CHECK_SEED ?? "0") || undefined,
        path: process.env.FAST_CHECK_PATH ?? undefined,
      },
    );
  });
});
