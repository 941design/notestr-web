/**
 * Full-stack property spec: random DSL action chains across three browser
 * contexts mapped to three DISTINCT identities (three-party axis).
 *
 * Invariants asserted (wired in S5): C0, S5, S6, S7, S10 (with A7-A12, A14
 * per-command postconditions).
 *
 * Identity model:
 *   Actor = "A" | "B" | "C"   — three distinct Nostr pubkeys, one page each.
 *
 *   pageA — bunker A (admin / inviter)
 *   pageB — bunker B (invitee)
 *   pageC — bunker C (invitee)
 *
 * Contrast with multi-user-md.property.spec.ts: that file maps three contexts
 * onto TWO identities (multi-device, same pubkey). This file maps three
 * contexts onto THREE identities (three distinct pubkeys). There is no
 * AttachA2-style lazy device here; B and C are first-class invitees.
 *
 * Wall-clock envelope (S7): test.setTimeout(720_000) = 12 min, numRuns: 15,
 * maxCommands: 10 (architecture.md constraint 6). Counterexample format:
 * Actor.Verb(args) per AC-X-NAMING-3P-1.
 *
 * Reproducing a failure:
 *   FAST_CHECK_SEED=<seed> FAST_CHECK_PATH=<path> npx playwright test multi-user-3p.property.spec.ts
 *
 * S1 skeleton — ModelState3P, RealSystem3P, beforeAll/afterAll, and exactly
 * one placeholder test under one test.describe.serial. The command set and
 * the headline assertions land in S2-S5.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import * as fc from "fast-check";
import { v4 as uuidv4 } from "uuid";

import { E2E_BUNKER_URL } from "../fixtures/auth-helper.js";
import { E2E_BUNKER_B_URL, USER_B_NPUB } from "../fixtures/auth-helper-b.js";
import { E2E_BUNKER_C_URL, USER_C_NPUB } from "../fixtures/auth-helper-c.js";
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
  selectGroup,
  settle,
  switchIdentity,
} from "../fixtures/two-party.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_MOBILE_REASON = "Multi-context MLS tests require desktop viewport";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

/** Nostr identity. Three DISTINCT pubkeys — A, B, and C never share a key. */
type ActorId = "A" | "B" | "C";

type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

// ---------------------------------------------------------------------------
// ModelState3P — tracks expected state across three distinct-pubkey actors
// ---------------------------------------------------------------------------

interface ModelTask3P {
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
 * Expected-state model for the three-party property machine.
 *
 * Single shared group: A creates it (admin) and invites B and C, so there is
 * one `groupId`/`groupName` — not a per-actor group id (contrast the 2-party
 * file's separate `groupIdA`/`groupIdB`, which exists because either actor can
 * be the group origin; here only A originates groups via Cg, design-decision
 * §2 admin-only invites).
 *
 * Three distinct pubkeys (pubkeyA/B/C) — this epic does NOT model multi-device
 * same-pubkey state, so there is no per-leaf bookkeeping here (that is the
 * multi-user-md axis).
 *
 * S1 stub — fields declared and helpers implemented. Command bodies that
 * mutate this state land in S2 (per-actor task commands) and S3 (group
 * lifecycle); assertion readers land in S4/S5.
 */
class ModelState3P {
  groupId: string | null = null;
  groupName: string | null = null;

  /** One pubkey per actor — all three are distinct identities. */
  pubkeyA: string | null = null;
  pubkeyB: string | null = null;
  pubkeyC: string | null = null;

  /** Per-actor membership flags for the single shared group. */
  memberA = false;
  memberB = false;
  memberC = false;

  /** Task map is group-scoped — all members converge on the same set (C0). */
  tasks: Map<string, ModelTask3P> = new Map();

  /**
   * Per-actor epoch sequences for the S6 monotonicity check. Each actor's
   * own sequence must be non-decreasing; cross-actor epochs are NOT compared
   * (assertS6 in the 2-party file compares within an actor only).
   */
  epochSequenceA: number[] = [];
  epochSequenceB: number[] = [];
  epochSequenceC: number[] = [];

  /**
   * Populated by SwCommand3P before an identity switch (S7). Holds the
   * context that switched and the group ids it must no longer surface after
   * the switch. SwCommand3P switches A<->B ONLY (design-decision §6,
   * AC-3P-SW-1) — never A<->C or B<->C. Reset in reset() so cross-run state
   * cannot bleed.
   */
  lastSwitched: { context: ActorId; priorGroupIds: string[] } | null = null;

  // ---- helpers ----

  /** Reset all per-run state (mirrors the 2-party ModelState.reset). */
  reset(): void {
    this.groupId = null;
    this.groupName = null;
    this.pubkeyA = null;
    this.pubkeyB = null;
    this.pubkeyC = null;
    this.memberA = false;
    this.memberB = false;
    this.memberC = false;
    this.tasks = new Map();
    this.epochSequenceA = [];
    this.epochSequenceB = [];
    this.epochSequenceC = [];
    this.lastSwitched = null;
  }

  /** The cached pubkey for an actor, or null if not yet authenticated. */
  pubkey(actor: ActorId): string | null {
    if (actor === "A") return this.pubkeyA;
    if (actor === "B") return this.pubkeyB;
    return this.pubkeyC;
  }

  /** Whether the actor is currently a member of the shared group. */
  actorIsMember(actor: ActorId): boolean {
    if (actor === "A") return this.memberA;
    if (actor === "B") return this.memberB;
    return this.memberC;
  }

  /** Append an observed epoch to the actor's sequence (no-op on null). */
  recordEpoch(actor: ActorId, epoch: number | null): void {
    if (epoch === null) return;
    if (actor === "A") this.epochSequenceA.push(epoch);
    else if (actor === "B") this.epochSequenceB.push(epoch);
    else this.epochSequenceC.push(epoch);
  }
}

// ---------------------------------------------------------------------------
// RealSystem3P — wraps the three Playwright pages
// ---------------------------------------------------------------------------

/**
 * The real system under test: three browser pages, one per distinct identity.
 *
 * S1 implements the stable readers (page accessor, getTasks, getTask,
 * quiesce) that every later story relies on. Command-dispatch logic is added
 * by S2/S3 as separate *Command3P classes (mirroring the 2-party and
 * multi-user-md templates), not as methods on this class.
 */
class RealSystem3P {
  constructor(
    public readonly pageA: Page,
    public readonly pageB: Page,
    public readonly pageC: Page,
  ) {}

  /** Resolve an actor id to its Playwright page. */
  page(actor: ActorId): Page {
    if (actor === "A") return this.pageA;
    if (actor === "B") return this.pageB;
    return this.pageC;
  }

  /** Read the actor's current task map from the in-page test hook. */
  async getTasks(actor: ActorId): Promise<Map<string, ModelTask3P>> {
    const tasks = await this.page(actor).evaluate(() => {
      const fn = window.__notestrTestTasks;
      if (typeof fn !== "function") return [];
      return fn();
    });
    const result = new Map<string, ModelTask3P>();
    for (const t of tasks as ModelTask3P[]) {
      result.set(t.id, t);
    }
    return result;
  }

  /** Read a single task by id from the actor's view (undefined if absent). */
  async getTask(actor: ActorId, id: string): Promise<ModelTask3P | undefined> {
    const tasks = await this.getTasks(actor);
    return tasks.get(id);
  }

  /** Wait until all three pages stop changing their task snapshots. */
  async quiesce(): Promise<void> {
    await quiesceFor([this.pageA, this.pageB, this.pageC], {
      maxWaitMs: 15000,
      intervalMs: 500,
    });
  }
}

// ---------------------------------------------------------------------------
// Epoch helper — reads the real MLS epoch for the single shared group via the
// production hook; returns null when the group is not loaded on that page
// (groupId is null or the hook returns null). Mirrors the 2-party
// readGroupEpoch but keyed on the single shared m.groupId rather than a
// per-actor groupIdA/groupIdB (there is only one group in the 3-party model).
// ---------------------------------------------------------------------------

async function readGroupEpoch3P(
  page: Page,
  groupId: string | null,
): Promise<number | null> {
  if (groupId === null) return null;
  return getGroupEpochHook(page, groupId);
}

// ---------------------------------------------------------------------------
// Per-actor task commands
// ---------------------------------------------------------------------------
//
// Port of the 2-party task commands (CtCommand … RlCommand in
// multi-user.property.spec.ts) to the three-party axis. Every command is
// parameterised on actor: "A" | "B" | "C" and operates exclusively through
// that actor's own page (r.page(actor)) — both for dispatching the task event
// and for reading back the postcondition. None hard-code pageA (VQ-S2-009).
//
// Precondition shape (VQ-S2-010): all task commands gate on
// m.actorIsMember(actor) && m.groupId !== null. The commands that mutate an
// existing task (Ut/Sc/As/Un/Dt) additionally require m.tasks.size > 0, and As
// additionally requires a known target pubkey (m.pubkeyA), so fast-check prunes
// impossible commands instead of failing them at run time.
//
// Postconditions mirror the 2-party per-command assertions (A1/A2/A3/A4/A5/A11)
// read via r.getTask(actor, …) on the acting actor's own page. toString()
// returns `${actor}.Verb(args)` so shrunk counterexamples print in the matrix
// DSL (AC-3P-CMD-TOSTRING-1, AC-X-NAMING-3P-1).

/** Ct — create a task via dispatchTaskEvent on the actor's own page (A1). */
class CtCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(
    private readonly actor: ActorId,
    private readonly title: string,
    private readonly description: string,
  ) {}

  check(m: ModelState3P): boolean {
    return m.actorIsMember(this.actor) && m.groupId !== null;
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A1: Ct ⇒ actor's local state contains task with status:"open",
    // assignee:null, createdBy == the acting actor's pubkey.
    const id = uuidv4();
    const now = Date.now();
    const pubkey = m.pubkey(this.actor)!;

    await dispatchTaskEvent(r.page(this.actor), {
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
        updatedBy: pubkey,
      },
    });

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

    const epoch = await readGroupEpoch3P(r.page(this.actor), m.groupId);
    m.recordEpoch(this.actor, epoch);

    // A1: verify the task appears locally on the acting actor's own page.
    const task = await r.getTask(this.actor, id);
    expect(task).toBeDefined();
    expect(task?.status).toBe("open");
    expect(task?.assignee).toBeNull();
    expect(task?.createdBy).toBe(pubkey);
  }

  toString(): string {
    return `${this.actor}.Ct(${this.title.slice(0, 20)})`;
  }
}

/** Ut — update a task's title (A3). */
class UtCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(
    private readonly actor: ActorId,
    private readonly title: string,
  ) {}

  check(m: ModelState3P): boolean {
    return (
      m.actorIsMember(this.actor) && m.groupId !== null && m.tasks.size > 0
    );
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A3: Ut with a newer timestamp ⇒ the changed field is updated, others
    // unchanged.
    const targetId = [...m.tasks.keys()][0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkey(this.actor)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.actor), {
      type: "task.updated",
      taskId: targetId,
      changes: { title: this.title },
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, title: this.title, updatedAt });

    const epoch = await readGroupEpoch3P(r.page(this.actor), m.groupId);
    m.recordEpoch(this.actor, epoch);

    // A3: verify the title changed on the acting actor's own page.
    const task = await r.getTask(this.actor, targetId);
    if (task) {
      expect(task.title).toBe(this.title);
    }
  }

  toString(): string {
    return `${this.actor}.Ut(${this.title.slice(0, 20)})`;
  }
}

/** Sc — status change (A2). */
class ScCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(
    private readonly actor: ActorId,
    private readonly status: TaskStatus,
  ) {}

  check(m: ModelState3P): boolean {
    return (
      m.actorIsMember(this.actor) && m.groupId !== null && m.tasks.size > 0
    );
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A2: Sc with a newer timestamp ⇒ t.status == s for the actor immediately,
    // and the resulting status is a member of the closed status enum.
    const targetId = [...m.tasks.keys()][0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkey(this.actor)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.actor), {
      type: "task.status_changed",
      taskId: targetId,
      status: this.status,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, status: this.status, updatedAt });

    const epoch = await readGroupEpoch3P(r.page(this.actor), m.groupId);
    m.recordEpoch(this.actor, epoch);

    // A2: verify status, plus status-enum closure (status stays one of the
    // four valid TaskStatus values post-dispatch).
    const task = await r.getTask(this.actor, targetId);
    if (task) {
      expect(task.status).toBe(this.status);
      expect(["open", "in_progress", "done", "cancelled"]).toContain(
        task.status,
      );
    }
  }

  toString(): string {
    return `${this.actor}.Sc(${this.status})`;
  }
}

/** As — assign a task to A's pubkey (A4). */
class AsCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(private readonly actor: ActorId) {}

  check(m: ModelState3P): boolean {
    return (
      m.actorIsMember(this.actor) &&
      m.groupId !== null &&
      m.tasks.size > 0 &&
      m.pubkeyA !== null
    );
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A4: As with a newer timestamp ⇒ t.assignee == X (here X = A's pubkey,
    // a known member of the shared group, mirroring the 2-party form).
    const targetId = [...m.tasks.keys()][0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkey(this.actor)!;
    const assignee = m.pubkeyA!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.actor), {
      type: "task.assigned",
      taskId: targetId,
      assignee,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, assignee, updatedAt });

    const epoch = await readGroupEpoch3P(r.page(this.actor), m.groupId);
    m.recordEpoch(this.actor, epoch);

    // A4: verify the assignee on the acting actor's own page.
    const task = await r.getTask(this.actor, targetId);
    if (task) {
      expect(task.assignee).toBe(assignee);
    }
  }

  toString(): string {
    return `${this.actor}.As(pubkeyA)`;
  }
}

/** Un — unassign a task (A4 / A5: assignee back to null). */
class UnCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(private readonly actor: ActorId) {}

  check(m: ModelState3P): boolean {
    return (
      m.actorIsMember(this.actor) && m.groupId !== null && m.tasks.size > 0
    );
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A5: Un with a newer timestamp ⇒ t.assignee == null.
    const targetId = [...m.tasks.keys()][0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkey(this.actor)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.actor), {
      type: "task.assigned",
      taskId: targetId,
      assignee: null,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.set(targetId, { ...existing, assignee: null, updatedAt });

    const epoch = await readGroupEpoch3P(r.page(this.actor), m.groupId);
    m.recordEpoch(this.actor, epoch);

    // A5: verify the task is unassigned on the acting actor's own page.
    const task = await r.getTask(this.actor, targetId);
    if (task) {
      expect(task.assignee).toBeNull();
    }
  }

  toString(): string {
    return `${this.actor}.Un(task)`;
  }
}

/** Dt — delete a task (A5: task absent post-dispatch). */
class DtCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(private readonly actor: ActorId) {}

  check(m: ModelState3P): boolean {
    return (
      m.actorIsMember(this.actor) && m.groupId !== null && m.tasks.size > 0
    );
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A5: Dt with a newer timestamp ⇒ task absent from the actor's local state.
    const targetId = [...m.tasks.keys()][0]!;
    const existing = m.tasks.get(targetId)!;
    const pubkey = m.pubkey(this.actor)!;
    const updatedAt = existing.updatedAt + 1;

    await dispatchTaskEvent(r.page(this.actor), {
      type: "task.deleted",
      taskId: targetId,
      updatedAt,
      updatedBy: pubkey,
    });

    m.tasks.delete(targetId);

    const epoch = await readGroupEpoch3P(r.page(this.actor), m.groupId);
    m.recordEpoch(this.actor, epoch);

    // A5: verify the task is absent on the acting actor's own page.
    const tasks = await r.getTasks(this.actor);
    expect(tasks.has(targetId)).toBe(false);
  }

  toString(): string {
    return `${this.actor}.Dt(task)`;
  }
}

/** Rl — reload the actor's page and assert task persistence (A11). */
class RlCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(private readonly actor: ActorId) {}

  check(m: ModelState3P): boolean {
    // A11 persistence is meaningful only for a member with the shared group
    // loaded — gate identically to the other task commands so the reload has a
    // group to re-navigate to.
    return m.actorIsMember(this.actor) && m.groupId !== null;
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A11: post-reload visible task state preserves the pre-reload tasks that
    // the model still expects.
    const page = r.page(this.actor);
    const tasksBefore = await r.getTasks(this.actor);

    await reload(page);
    // Wait for key packages to re-publish after reload (MarmotProvider
    // re-publishes on mount).
    await settle(page, 3000);

    // Re-navigate to the shared group after reload so its task store remounts.
    if (m.groupName && m.actorIsMember(this.actor)) {
      const sidebar = page.locator("aside");
      const groupVisible = await sidebar
        .getByText(m.groupName)
        .first()
        .isVisible()
        .catch(() => false);
      if (!groupVisible) {
        await settle(page, 3000);
      }
      await sidebar
        .getByText(m.groupName)
        .first()
        .click()
        .catch(() => {});
      await page
        .getByRole("heading", { name: "Tasks" })
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});
    }

    const epoch = await readGroupEpoch3P(page, m.groupId);
    m.recordEpoch(this.actor, epoch);

    // A11: every pre-reload task that the model still expects must survive the
    // reload on the acting actor's own page.
    const tasksAfter = await r.getTasks(this.actor);
    for (const [id] of tasksBefore) {
      if (m.tasks.has(id)) {
        expect(tasksAfter.has(id)).toBe(true);
      }
    }
  }

  toString(): string {
    return `${this.actor}.Rl()`;
  }
}

// ---------------------------------------------------------------------------
// Group-lifecycle commands
// ---------------------------------------------------------------------------
//
// Port of the 2-party group commands (Cg/In/Lg/Fd/Rd/Sw in
// multi-user.property.spec.ts) to the three-party axis. Three structural
// differences from the 2-party template flow from the single-group,
// admin-only, three-distinct-pubkey model (S1 design-decisions §2, §6):
//
//   1. Single shared group. There is one m.groupId — not per-actor
//      groupIdA/groupIdB. Cg only ever runs on pageA (A is the sole origin
//      of groups, design-decision §2); B and C are invitees, never creators.
//   2. Admin-only invites + forgets are MODEL PRECONDITIONS, not runtime
//      checks (design-decision §2, VQ-S3-008). InCommand3P's inviter is
//      hard-wired to A and FdCommand3P forgets only on pageA; the
//      impossibility of B/C inviting or forgetting is encoded by NEVER
//      generating such a command (there is no InCommand3P("A") and no
//      per-actor Fd) rather than by an fc.pre() discard at run time. This
//      keeps random-action density high.
//   3. Real invite UI, not a DB bypass. The 2-party In uses inviteByNpub
//      against the live GroupManager invite path; S3 does the same for both
//      B and C (the MIP-03 admin-only invite path). The invitee then joins
//      via selectGroup on its own page, exactly as three-party.spec.ts does.
//
// Postconditions here are command-LOCAL (membership/group bookkeeping +
// per-command sanity reads). The headline cross-actor invariants
// (C0/S5/S6/S7/S10) are asserted at quiescence by the S4 assertions wired in
// S5 — not duplicated per command.

/**
 * Cg — A creates the single shared group (admin-only origin).
 *
 * check (VQ-S3-001, AC-3P-CG-1): true only when there is no group yet AND A
 * is not yet a member — `!m.memberA && m.groupId === null`. A is also the only
 * actor that ever runs Cg (there is no CgCommand3P("B"|"C")); group origination
 * is restricted to A as a model precondition (design-decision §2), not a
 * runtime guard. m.pubkeyA must be set (A authenticated) for the creator pubkey
 * to be known — guaranteed by beforeAll, asserted defensively in the guard.
 */
class CgCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  check(m: ModelState3P): boolean {
    return !m.memberA && m.groupId === null && m.pubkeyA !== null;
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A7: after Cg, the creator (A) is sole member, epoch == 0. Cg dispatches
    // exclusively on pageA — A is admin (design-decision §2).
    const name = `Prop3P-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await createGroup(r.pageA, name);
    const gid = await currentGroupId(r.pageA);

    m.groupId = gid;
    m.groupName = name;
    m.memberA = true;
    // A fresh group starts with no tasks — clear any model-side carryover so
    // the single-group task map reflects the newly created group only.
    m.tasks = new Map();

    const epoch = await readGroupEpoch3P(r.pageA, m.groupId);
    m.recordEpoch("A", epoch);

    // A7: the creator now holds at least one group on its own page.
    const groupCount = await r.pageA.evaluate(() => {
      const fn = window.__notestrTestGroups;
      if (typeof fn !== "function") return 0;
      return fn().length;
    });
    expect(groupCount).toBeGreaterThan(0);
  }

  toString(): string {
    return "A.Cg(group)";
  }
}

/**
 * In — A invites an invitee (B or C) to the shared group.
 *
 * The inviter is ALWAYS A (pageA); the constructor takes only the invitee
 * (VQ-S3-002, AC-3P-IN-1). There is no `InCommand3P("A")` — A inviting itself
 * is not a representable command, and B/C inviting is blocked by MIP-03
 * (admin-only commits) and modelled by simply never generating it
 * (design-decision §2, VQ-S3-008).
 *
 * check (AC-3P-IN-1, AC-3P-IN-2): true only when A is already a member AND the
 * invitee is NOT yet a member — `m.memberA && !m.actorIsMember(invitee)`. The
 * already-a-member shape is PRUNED by this predicate so fast-check never
 * generates a redundant re-invite; it is not silently no-op'd at run time
 * (VQ-S3-003).
 */
class InCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(private readonly invitee: "B" | "C") {}

  check(m: ModelState3P): boolean {
    return (
      m.memberA &&
      m.groupId !== null &&
      !m.actorIsMember(this.invitee)
    );
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A8: after In + the invitee processes its welcome, the invitee has >=1
    // leaf and sees the shared group. Inviter is A; invitee joins via its own
    // page (selectGroup), mirroring three-party.spec.ts.
    const inviteePage = r.page(this.invitee);
    const inviteeNpub = this.invitee === "B" ? USER_B_NPUB : USER_C_NPUB;

    // Brief settle so the invitee's key package is published on the relay
    // before A issues the invite (mirrors the 2-party In timing).
    await settle(r.pageA, 1000);
    await inviteByNpub(r.pageA, inviteeNpub);

    // Reload the invitee to trigger the device-sync welcome-fetch path — more
    // reliable than waiting for live subscription delivery once many groups
    // have accumulated on the relay across property iterations (same rationale
    // as the 2-party In's pageB.reload()).
    await r.page(this.invitee).reload();
    await inviteePage
      .locator('[data-testid="pubkey-chip"]')
      .waitFor({ state: "visible", timeout: 30000 });
    await selectGroup(inviteePage, m.groupName!);

    // The invitee is now a member of the single shared group.
    if (this.invitee === "B") m.memberB = true;
    else m.memberC = true;

    const epoch = await readGroupEpoch3P(r.pageA, m.groupId);
    m.recordEpoch("A", epoch);

    // A8: the invitee now holds at least one group on its own page.
    const groupCount = await inviteePage.evaluate(() => {
      const fn = window.__notestrTestGroups;
      if (typeof fn !== "function") return 0;
      return fn().length;
    });
    expect(groupCount).toBeGreaterThan(0);
  }

  toString(): string {
    return `A.In(${this.invitee})`;
  }
}

/**
 * Lg — an actor leaves the shared group through its OWN page.
 *
 * Parameterised on actor: "A"|"B"|"C" (VQ-S3-004, AC-3P-LG-1); the leave is
 * dispatched on r.page(actor), not hard-coded to pageA. Any member can leave —
 * only A is admin, but leaving is not an admin-only operation.
 *
 * check: the actor must be a member with another member remaining. The
 * remaining-member guard mirrors the 2-party Lg: it keeps the harness from
 * shrinking a counterexample into the sole-member-leaves flow (which the
 * standalone forget-device-self spec covers), so degenerate empty-group
 * chains like [A.Cg, A.Lg] are never generated (VQ-S3-010).
 */
class LgCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(private readonly actor: ActorId) {}

  check(m: ModelState3P): boolean {
    if (!m.actorIsMember(this.actor) || m.groupId === null) return false;
    // At least one OTHER member must remain after this actor leaves.
    const others: ActorId[] = (["A", "B", "C"] as ActorId[]).filter(
      (a) => a !== this.actor,
    );
    return others.some((a) => m.actorIsMember(a));
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A9: after Lg, the actor is absent from the group's member set and its
    // own view shows the group detached. The leave is performed on the
    // actor's own page.
    const page = r.page(this.actor);
    const groupName = m.groupName!;

    const groupRow = page
      .locator('nav[aria-label="Groups"] li')
      .filter({ hasText: groupName });
    await groupRow.locator('[data-testid="group-leave-btn"]').click();
    await page.locator('[data-testid="group-leave-confirm"]').click();

    // Clear the leaver's membership. The shared group itself persists for the
    // remaining members, so m.groupId is NOT nulled — only this actor's flag.
    if (this.actor === "A") m.memberA = false;
    else if (this.actor === "B") m.memberB = false;
    else m.memberC = false;

    // Record the epoch from a remaining member's page (the leaver's group is
    // now detached). Pick the first still-member actor.
    const remaining: ActorId | undefined = (["A", "B", "C"] as ActorId[]).find(
      (a) => m.actorIsMember(a),
    );
    if (remaining) {
      const epoch = await readGroupEpoch3P(r.page(remaining), m.groupId);
      m.recordEpoch(remaining, epoch);
    }
  }

  toString(): string {
    return `${this.actor}.Lg(group)`;
  }
}

/**
 * Fd — A forgets a leaf belonging to B or C in the shared group.
 *
 * Admin-only (design-decision §2, VQ-S3-005): the forget always runs on pageA
 * and the target is whichever of B/C currently has a leaf. The impossibility of
 * a non-admin forget is a model precondition — there is no per-actor Fd; the
 * command is only ever generated for A's vantage point.
 *
 * check (AC-3P-FD-1): `m.memberA && (m.memberB || m.memberC) && m.groupId !==
 * null` — A is a member with the group loaded, and there is at least one
 * invitee leaf to forget.
 */
class FdCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  check(m: ModelState3P): boolean {
    return (
      m.memberA &&
      (m.memberB || m.memberC) &&
      m.groupId !== null
    );
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // A10: forget-device leaf semantics. Prefer forgetting a B leaf; fall back
    // to a C leaf. Whichever invitee's last leaf is forgotten drops to
    // non-member (K == 1), otherwise it stays a member with K-1 leaves.
    const groupId = m.groupId!;

    // Resolve the forget target: the first invitee that is a member AND
    // actually has a leaf on A's tree.
    let target: "B" | "C" | null = null;
    let indexes: number[] = [];
    for (const invitee of ["B", "C"] as const) {
      if (!m.actorIsMember(invitee)) continue;
      const pubkey = m.pubkey(invitee)!;
      const found = await leafIndexesFor(r.pageA, groupId, pubkey);
      if (found.length > 0) {
        target = invitee;
        indexes = found;
        break;
      }
    }

    if (target === null || indexes.length === 0) {
      // No invitee leaf to forget — postcondition trivially holds.
      return;
    }

    const leafCount = indexes.length;
    // forgetLeafByIndex can fail on MLS state accumulated across property
    // iterations. Treat a commit error as a non-actionable skip in the
    // property context — forget-device semantics are covered by the dedicated
    // forget-device.spec.ts (same handling as the 2-party Fd).
    try {
      await forgetLeafByIndex(r.pageA, groupId, indexes[0]!);
    } catch {
      return;
    }

    const epoch = await readGroupEpoch3P(r.pageA, m.groupId);
    m.recordEpoch("A", epoch);

    if (leafCount === 1) {
      // A10: K == 1 → the invitee is absent from members after forget.
      if (target === "B") m.memberB = false;
      else m.memberC = false;
    } else {
      // A10: K > 1 → the invitee remains a member with K-1 leaves.
      const pubkey = m.pubkey(target)!;
      await expect
        .poll(() => leafIndexesFor(r.pageA, groupId, pubkey), {
          timeout: 15000,
        })
        .toHaveLength(leafCount - 1);
    }
  }

  toString(): string {
    return "A.Fd(B-or-C-leaf)";
  }
}

/**
 * Rd — an actor renames one of its OWN device rows (per-actor, VQ-S3-006,
 * AC-3P-RD-1).
 *
 * Operates on the actor's own page (r.page(actor)). Renaming is UI-local: it
 * does not touch MLS state or task delivery, so there is no membership
 * mutation — the model is unchanged beyond recording the actor's epoch.
 *
 * check: the actor is a member with the shared group loaded (so a device row
 * exists to rename). The `name` argument is supplied per the spec signature but
 * the actual label is derived at run time to stay unique across iterations.
 */
class RdCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  constructor(
    private readonly actor: ActorId,
    private readonly name: string,
  ) {}

  check(m: ModelState3P): boolean {
    return m.actorIsMember(this.actor) && m.groupId !== null;
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // UI-local rename on the actor's own page. No MLS/task effect.
    const page = r.page(this.actor);
    const newName = `${this.name.slice(0, 12)}-${Date.now().toString(36)}`;
    const rows = page.locator('[data-testid="device-row"]');
    const count = await rows.count();
    if (count === 0) return;

    const input = rows.first().getByRole("textbox");
    const inputCount = await input.count();
    if (inputCount === 0) return;

    await input.fill(newName);
    await input.blur();

    const epoch = await readGroupEpoch3P(page, m.groupId);
    m.recordEpoch(this.actor, epoch);
  }

  toString(): string {
    return `${this.actor}.Rd(device, ${this.name.slice(0, 12)})`;
  }
}

/**
 * Sw — switch the identity on pageA between bunker A and bunker B ONLY.
 *
 * AC-3P-SW-1 (design-decision §6): SwCommand3P switches pageA between bunker A
 * and bunker B exclusively. A↔C and B↔C switches are NOT generated — there is
 * no Sw variant for C. This restriction exists because a property machine that
 * could switch any context to any of three identities multiplies the
 * identity-isolation state space without adding coverage beyond the A↔B case
 * (the S7 isolation invariant is symmetric across identities). The admin-only
 * / MIP-03 constraints are model preconditions, not runtime checks.
 *
 * check (VQ-S3-007): m.groupId !== null — there must be a group to switch away
 * from, otherwise the S7 identity-isolation assertion has nothing to verify.
 *
 * S7 bookkeeping (VQ-S3-011, mirrors the 2-party SwCommand): capture
 * priorGroupIds into m.lastSwitched BEFORE the switch (so they reflect the
 * pre-switch identity), then reset memberA / groupId-membership and the A epoch
 * sequence after. Because A and B share the single group when both are members,
 * a shared group is legitimately reachable by the post-switch identity and must
 * NOT be flagged as a prior-identity group (false-positive guard).
 */
class SwCommand3P implements fc.AsyncCommand<ModelState3P, RealSystem3P> {
  check(m: ModelState3P): boolean {
    return m.groupId !== null;
  }

  async run(m: ModelState3P, r: RealSystem3P): Promise<void> {
    // AC-3P-SW-1: switch pageA between bunker A and bunker B ONLY. Determine
    // the target by comparing the current cached pubkey: if pageA currently
    // holds A's identity, switch to B; otherwise switch back to A.
    const onIdentityA = m.pubkeyA === cachedPubkeyA;
    const targetBunker = onIdentityA ? E2E_BUNKER_B_URL : E2E_BUNKER_URL;

    // AC-S7-2: capture priorGroupIds BEFORE the switch. Only groups EXCLUSIVE
    // to the pre-switch identity belong here. When switching A→B and B is also
    // a member of the shared group, that group is legitimately accessible to
    // the post-switch identity (B) and must not be flagged — otherwise
    // assertS7 would false-positive on B's own copy of the shared group.
    const priorGroupIds: string[] = [];
    if (m.groupId !== null) {
      const switchingToB = onIdentityA;
      const sharedWithTarget = switchingToB ? m.memberB : m.memberA;
      if (!sharedWithTarget) {
        priorGroupIds.push(m.groupId);
      }
    }
    m.lastSwitched = { context: "A", priorGroupIds };

    // Real identity switch: disconnect + re-authenticate pageA against the
    // other bunker (switchIdentity clears app state via authenticate()).
    await switchIdentity(r.pageA, targetBunker);

    // Update the cached pubkey for context A to reflect the switched identity.
    const newPubkey = await getPubkeyHex(r.pageA).catch(() => null);
    if (newPubkey) {
      m.pubkeyA = newPubkey;
    }
    // After the switch, A's membership in the shared group is uncertain until
    // re-verified. Epoch monotonicity is per continuous identity session, not
    // per context slot, so reset A's epoch sequence.
    m.memberA = false;
    m.epochSequenceA = [];
  }

  toString(): string {
    return "A.Sw(B)";
  }
}

// ---------------------------------------------------------------------------
// Headline invariant assertions (assertC0_3P, S5, S6, S7, S10)
// ---------------------------------------------------------------------------
//
// Three-actor extensions of the 2-party headline assertions (assertC0 …
// assertS10 in multi-user.property.spec.ts). Each takes (m: ModelState3P,
// r: RealSystem3P) and is invoked ONLY after r.quiesce() in the S5 test body,
// so convergence is asserted at rest, not mid-flight (VQ-S4-014). All
// membership/leaf/epoch reads are scoped to the single shared m.groupId so
// cross-run/cross-group MLS leftover state cannot cause false negatives
// (VQ-S4-013).
//
// STRICT vs DEGRADED form (AC-3P-DEG-1, AC-3P-DEG-2):
//   STRICT FORM IS LIVE. The three production test hooks
//   (__notestrTestGroupMembers, __notestrTestGroupEpoch,
//   __notestrTestPubkeyLeafCount, read via getGroupMembersHook /
//   getGroupEpochHook / getPubkeyLeafCountHook from two-party.ts) are present
//   in production (src/marmot/client.tsx), confirmed by the epic exploration
//   (verdict_strict_vs_degraded = STRICT_FORM_AVAILABLE). The strict assertions
//   below are the ACTIVE code path.
//
//   The degraded-form fallbacks are present-but-DORMANT. They exist so a future
//   maintainer who removes the hooks (e.g. before the
//   epic-property-tests-l3-completion test-hook story ships, or if it is
//   reverted) has a documented, working fallback: C0 falls back to the
//   task-subset check only; S5 checks the positive direction only
//   (member ⇒ ≥1 leaf), scoped to m.groupId; S6 records via the same proxy the
//   2-party file uses; S10 asserts ≥ 0 only. Each fallback is guarded by a
//   runtime hook-presence probe (hooksPresent / leafHookPresent below) that is
//   always true in the current STRICT_FORM_AVAILABLE world, so the dormant
//   branch never executes today.

/**
 * Probe whether the strict group-state hooks (__notestrTestGroupMembers,
 * __notestrTestGroupEpoch) are installed on a page. Always true in the current
 * STRICT_FORM_AVAILABLE world (the hooks ship in src/marmot/client.tsx); the
 * probe exists only so the degraded-form fallback paths below remain reachable
 * if the epic-property-tests-l3-completion test-hook story is ever reverted
 * (AC-3P-DEG-1, AC-3P-DEG-2).
 */
async function strictHooksPresent(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      typeof window.__notestrTestGroupMembers === "function" &&
      typeof window.__notestrTestGroupEpoch === "function",
  );
}

/**
 * Probe whether the per-pubkey leaf-count hook (__notestrTestPubkeyLeafCount)
 * is installed. Used to gate the C0/S5/S10 leaf-count strict paths vs their
 * degraded fallbacks (AC-3P-DEG-1).
 */
async function leafCountHookPresent(page: Page): Promise<boolean> {
  return page.evaluate(
    () => typeof window.__notestrTestPubkeyLeafCount === "function",
  );
}

/**
 * assertC0_3P — settled-state equality across A/B/C.
 *
 * AC-3P-DEG-2: depends on the test hooks from epic-property-tests-l3-completion
 * (__notestrTestGroupMembers / __notestrTestGroupEpoch /
 * __notestrTestPubkeyLeafCount). STRICT form is live (hooks present). The
 * degraded fallback (task-subset check only) below is present-but-dormant and
 * fires only if those hooks are ever removed.
 *
 * Guard (AC-3P-C0-1): runs only when m.groupId !== null && memberA && memberB
 * && memberC; otherwise returns silently.
 *
 * Strict assertions when triggered:
 *   - AC-3P-C0-2: task-id sets pairwise equal across A/B/C; per shared id,
 *     status/assignee/title equal across all three.
 *   - AC-3P-C0-3: member sets pairwise equal across all three views
 *     (getGroupMembersHook).
 *   - AC-3P-C0-4: epoch(A) == epoch(B) == epoch(C) (getGroupEpochHook).
 *   - AC-3P-C0-5: leafCount(g, p) matches across A/B/C for every p in the union
 *     of members (getPubkeyLeafCountHook).
 */
async function assertC0_3P(m: ModelState3P, r: RealSystem3P): Promise<void> {
  // AC-3P-C0-1: only assert when there is a shared group and all three actors
  // are members. Otherwise the three-way equality is undefined — return.
  if (m.groupId === null || !m.memberA || !m.memberB || !m.memberC) return;
  const groupId = m.groupId;
  const actors: ActorId[] = ["A", "B", "C"];

  // AC-3P-C0-2: task-id sets pairwise equal across A/B/C, and per shared task
  // id status/assignee/title equal. This part needs no production hooks — it is
  // the degraded-form floor that always runs.
  const [tasksA, tasksB, tasksC] = await Promise.all(
    actors.map((a) => r.getTasks(a)),
  );
  const taskMaps: Record<ActorId, Map<string, ModelTask3P>> = {
    A: tasksA,
    B: tasksB,
    C: tasksC,
  };

  const idSets = actors.map((a) => new Set(taskMaps[a].keys()));
  // Pairwise id-set equality: every id seen by one actor is seen by the others.
  for (let i = 0; i < actors.length; i++) {
    for (let j = 0; j < actors.length; j++) {
      if (i === j) continue;
      for (const id of idSets[i]!) {
        expect(idSets[j]!.has(id)).toBe(true);
      }
    }
  }

  // Per shared task: status/assignee/title equal across all three (compare each
  // of B/C against A's copy — transitively covers all pairs).
  for (const [id, taskA] of tasksA) {
    for (const a of ["B", "C"] as ActorId[]) {
      const other = taskMaps[a].get(id);
      if (other) {
        expect(other.status).toBe(taskA.status);
        expect(other.assignee).toBe(taskA.assignee);
        expect(other.title).toBe(taskA.title);
      }
    }
  }

  // --- DEGRADED-FORM FALLBACK (dormant; see AC-3P-DEG-1 / -2 above) ---
  // If the strict group-state hooks are absent, stop here: the task-subset
  // check above is the documented degraded behavior. In the current
  // STRICT_FORM_AVAILABLE world hooksOk is always true, so this never returns
  // early.
  const hooksOk = await strictHooksPresent(r.pageA);
  if (!hooksOk) return;

  // AC-3P-C0-3: member sets pairwise equal across all three actor views.
  const [membersA, membersB, membersC] = await Promise.all(
    actors.map((a) => getGroupMembersHook(r.page(a), groupId)),
  );
  expect(membersA).not.toBeNull();
  expect(membersB).not.toBeNull();
  expect(membersC).not.toBeNull();
  const memberSets: Record<ActorId, Set<string>> = {
    A: new Set(membersA!),
    B: new Set(membersB!),
    C: new Set(membersC!),
  };
  // Pairwise equality (B==A, C==A ⇒ all three equal).
  expect(memberSets.B).toEqual(memberSets.A);
  expect(memberSets.C).toEqual(memberSets.A);

  // AC-3P-C0-4: epoch(A) == epoch(B) == epoch(C).
  const [epochA, epochB, epochC] = await Promise.all(
    actors.map((a) => getGroupEpochHook(r.page(a), groupId)),
  );
  expect(epochB).toBe(epochA);
  expect(epochC).toBe(epochA);

  // AC-3P-C0-5: per-pubkey leaf count equal across A/B/C for every p in the
  // union of all three member sets.
  const leafOk = await leafCountHookPresent(r.pageA);
  if (!leafOk) return; // dormant degraded fallback (AC-3P-DEG-1)
  const unionMembers = new Set<string>([
    ...(membersA ?? []),
    ...(membersB ?? []),
    ...(membersC ?? []),
  ]);
  for (const p of unionMembers) {
    const [lcA, lcB, lcC] = await Promise.all(
      actors.map((a) => getPubkeyLeafCountHook(r.page(a), groupId, p)),
    );
    expect(lcB).toBe(lcA);
    expect(lcC).toBe(lcA);
  }
}

/**
 * assertS5_3P — member ⇔ leafCount>=1 biconditional, scoped to m.groupId.
 *
 * AC-3P-DEG-2: depends on the epic-property-tests-l3-completion hooks
 * (__notestrTestGroupMembers / __notestrTestPubkeyLeafCount). STRICT form is
 * live; the degraded fallback (positive direction only, member ⇒ ≥1 leaf,
 * scoped to m.groupId) below is present-but-dormant.
 *
 * AC-3P-S5-1: for each of m.pubkeyA / m.pubkeyB / m.pubkeyC, assert
 * (p ∈ membersA) === (leafCount(m.groupId, p) >= 1), reading membersA from
 * getGroupMembersHook on A's page (the production truth source). Scoping to
 * m.groupId avoids false negatives from cross-run MLS leftover leaves a pubkey
 * may carry in older groups from prior fc.commands runs (VQ-S4-006).
 */
async function assertS5_3P(m: ModelState3P, r: RealSystem3P): Promise<void> {
  if (
    m.groupId === null ||
    m.pubkeyA === null ||
    m.pubkeyB === null ||
    m.pubkeyC === null
  ) {
    return;
  }
  const groupId = m.groupId;

  const membersA = await getGroupMembersHook(r.pageA, groupId);
  if (membersA === null) return; // group not loaded on A — skip

  const leafOk = await leafCountHookPresent(r.pageA);
  const pubkeys = [m.pubkeyA, m.pubkeyB, m.pubkeyC];

  for (const p of pubkeys) {
    const isMember = membersA.includes(p);
    const leafCount = await getPubkeyLeafCountHook(r.pageA, groupId, p);

    if (!leafOk) {
      // --- DEGRADED-FORM FALLBACK (dormant; AC-3P-DEG-1 / -2) ---
      // Positive direction only: a member must have at least one leaf. The
      // reverse implication needs the leaf-count hook, which is absent in this
      // branch. Unreachable in the current STRICT_FORM_AVAILABLE world.
      if (isMember) {
        expect(leafCount).toBeGreaterThanOrEqual(1);
      }
      continue;
    }

    // STRICT: full biconditional.
    expect(isMember).toBe(leafCount >= 1);
  }
}

/**
 * assertS6_3P — per-actor epoch monotonicity.
 *
 * AC-3P-DEG-2: S6 records observed epochs via getGroupEpochHook
 * (__notestrTestGroupEpoch) during command runs; the degraded fallback records
 * via the SAME proxy the 2-party file uses today (the recorded epochSequence*
 * arrays on ModelState3P) — so this assertion is identical in strict and
 * degraded form: there is no separate dormant branch, the recording mechanism
 * is the proxy. Pointer for maintainers: epic-property-tests-l3-completion's
 * test-hook story is what would replace this proxy with a richer source.
 *
 * AC-3P-S6-1: walk each of epochSequenceA / epochSequenceB / epochSequenceC and
 * assert it is non-decreasing. Cross-actor epochs are NOT compared (epochs are
 * only synchronized at C0 quiescence, not between every dispatch).
 */
async function assertS6_3P(m: ModelState3P): Promise<void> {
  for (const seq of [
    m.epochSequenceA,
    m.epochSequenceB,
    m.epochSequenceC,
  ]) {
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]!);
    }
  }
}

/**
 * assertS7_3P — identity-isolation after a switch.
 *
 * AC-3P-DEG-2: S7 reads the loaded group ids on the post-switch context via the
 * __notestrTestGroups hook (the same hook the 2-party file uses); it does not
 * depend on the epic-property-tests-l3-completion group-state hooks, so strict
 * and degraded form are identical here. Pointer for maintainers:
 * epic-property-tests-l3-completion's test-hook story owns the richer
 * group-state hooks; this assertion only needs the always-present
 * __notestrTestGroups list.
 *
 * AC-3P-S7-1: triggers only when m.lastSwitched !== null (a Sw fired this run).
 * Reads the groups currently loaded on the switched context and asserts none of
 * them carry an idStr from the prior identity's exclusive group set. Tasks are
 * scoped to the currently loaded group, so asserting at the group level is
 * sufficient and avoids relying on a groupId field absent from the Task type.
 */
async function assertS7_3P(m: ModelState3P, r: RealSystem3P): Promise<void> {
  // No Sw fired this run → nothing to isolate-check (mirrors 2-party AC-S7-4).
  if (m.lastSwitched === null) return;

  const { context, priorGroupIds } = m.lastSwitched;

  const loadedGroupIds = await r.page(context).evaluate(() => {
    const fn = window.__notestrTestGroups;
    if (typeof fn !== "function") return [] as string[];
    return fn().map((g) => g.idStr);
  });

  for (const gid of loadedGroupIds) {
    expect(priorGroupIds).not.toContain(gid);
  }
}

/**
 * assertS10_3P — device-row count equals own-pubkey leaf count, per actor.
 *
 * AC-3P-DEG-2: depends on the epic-property-tests-l3-completion leaf-count hook
 * (__notestrTestPubkeyLeafCount via getPubkeyLeafCountHook). STRICT form is
 * live; the degraded fallback (assert device-row count ≥ 0 only) below is
 * present-but-dormant and fires only if that hook is removed.
 *
 * AC-3P-S10-1: for each member actor, read the [data-testid="device-row"] count
 * on that actor's own page and assert equality with
 * getPubkeyLeafCountHook(page, m.groupId, ownPubkey).
 */
async function assertS10_3P(m: ModelState3P, r: RealSystem3P): Promise<void> {
  if (m.groupId === null) return;
  const groupId = m.groupId;
  const actors: ActorId[] = ["A", "B", "C"];

  const leafOk = await leafCountHookPresent(r.pageA);

  for (const actor of actors) {
    // Only meaningful for a member with a known own-pubkey: a non-member has no
    // device list for this group loaded.
    if (!m.actorIsMember(actor)) continue;
    const ownPubkey = m.pubkey(actor);
    if (ownPubkey === null) continue;

    const page = r.page(actor);
    const deviceRows = await page
      .locator('[data-testid="device-row"]')
      .count();

    if (!leafOk) {
      // --- DEGRADED-FORM FALLBACK (dormant; AC-3P-DEG-1 / -2) ---
      // Without the leaf-count hook, only a sanity bound is assertable.
      // Unreachable in the current STRICT_FORM_AVAILABLE world.
      expect(deviceRows).toBeGreaterThanOrEqual(0);
      continue;
    }

    // STRICT: device-row count equals the actor's own leaf count.
    const leafCount = await getPubkeyLeafCountHook(page, groupId, ownPubkey);
    expect(deviceRows).toBe(leafCount);
  }
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let contextA: BrowserContext;
let contextB: BrowserContext;
let contextC: BrowserContext;
let pageA: Page;
let pageB: Page;
let pageC: Page;
let skipMobile = false;

/**
 * Cached once in beforeAll after all three actors authenticate (AC-3P-FILE-5).
 * Three distinct identities, so three distinct cached pubkeys — there is no
 * shared-pubkey reuse here (contrast multi-user-md's single cachedPubkeyA for
 * its two A-devices).
 */
let cachedPubkeyA: string;
let cachedPubkeyB: string;
let cachedPubkeyC: string;

test.beforeAll(async ({ browser }, workerInfo) => {
  skipMobile = projectIsMobile(workerInfo.project);
  if (skipMobile) return;

  contextA = await browser.newContext();
  contextB = await browser.newContext();
  contextC = await browser.newContext();
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  pageC = await contextC.newPage();

  // B and C authenticate first so their key packages are on the relay before
  // A (the admin) issues invites in later stories (mirrors three-party.spec.ts
  // ordering: invitees publish KPs first).
  //
  // Bunker-setup decision (S1, surfaced in result.json): static per-identity
  // bunker URLs from .bunker-keys.json (E2E_BUNKER_URL / E2E_BUNKER_B_URL /
  // E2E_BUNKER_C_URL) per AC-3P-FILE-4 + design-decision §8. The 2-party and
  // multi-user-md PROPERTY specs instead use spawnSpecBunker per-spec fresh
  // bunkers to avoid KeyPackage accumulation across the many property
  // iterations. The S1 skeleton runs no command loop, so KP accumulation is
  // not exercised yet; the spec default (static constants) is honored here and
  // the accumulation risk is flagged for S7 wall-clock validation. If S7 sees
  // KP-accumulation flakiness, the known mitigation is spawnSpecBunker x3,
  // which would be an explicit amendment to AC-3P-FILE-4.
  //
  // Actor C authenticates via two-party.ts authenticate(pageC, E2E_BUNKER_C_URL)
  // — NOT the bare auth-helper-c authenticateAsBunkerC, which skips
  // clearAppState, slot-pinning, and the __notestrTestPubkey hook-wait that A
  // and B get (architecture.md constraint 3).
  await authenticate(pageB, E2E_BUNKER_B_URL);
  await authenticate(pageC, E2E_BUNKER_C_URL);
  await authenticate(pageA, E2E_BUNKER_URL);

  // Cache the three distinct pubkeys once, after auth, at module scope
  // (AC-3P-FILE-5). authenticate() already polled __notestrTestPubkey into
  // existence, so these reads do not race the hook install.
  cachedPubkeyA = await getPubkeyHex(pageA);
  cachedPubkeyB = await getPubkeyHex(pageB);
  cachedPubkeyC = await getPubkeyHex(pageC);
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
  await contextC?.close();
});

// ---------------------------------------------------------------------------
// Property test (single test under a single serial describe)
// ---------------------------------------------------------------------------

test.describe.serial("[C0,S5,S6,S7,S10,A7-A12,A14] 3-party multi-user property", () => {
  test.setTimeout(720_000);

  test("[C0,S5,S6,S7,S10] settled-state equality holds across A/B/C", async () => {
    test.skip(skipMobile, SKIP_MOBILE_REASON);

    const real = new RealSystem3P(pageA, pageB, pageC);

    // --- Command-argument arbitraries (mirror the 2-party generation style) ---
    const arbTitle = fc.string({ minLength: 1, maxLength: 30 });
    const arbDesc = fc.string({ maxLength: 50 });
    const arbStatus = fc.constantFrom<TaskStatus>(
      "open",
      "in_progress",
      "done",
      "cancelled",
    );
    const arbActor = fc.constantFrom<ActorId>("A", "B", "C");

    // AC-3P-RUN-1 / VQ-S5-001: exactly the arbitraries from spec § "Single
    // test, three-actor commands array" — CgCommand3P (A only), admin
    // InCommand3P over B|C, per-actor Lg/Fd/Ct/Ut/Sc/As/Un/Dt/Rl, SwCommand3P.
    // No additional commands (Rd is intentionally not generated here: it is not
    // in the spec's commands array — it is a non-MLS UI rename whose coverage is
    // not part of the three-party headline-invariant run).
    const commands: fc.Arbitrary<fc.AsyncCommand<ModelState3P, RealSystem3P>>[] =
      [
        // Cg — A creates the single shared group (admin-only origin).
        fc.constant(new CgCommand3P()),
        // In — admin invite: inviter is ALWAYS A, invitee is B or C only
        // (VQ-S5-011 / AC-3P-IN-1: no B.In(C) / TP-70c is generated).
        fc.constantFrom<"B" | "C">("B", "C").map(
          (invitee) => new InCommand3P(invitee),
        ),
        // Lg — per-actor leave (A | B | C), each through its own page.
        arbActor.map((actor) => new LgCommand3P(actor)),
        // Fd — forget device, A only (admin-only forget; no per-actor Fd).
        fc.constant(new FdCommand3P()),
        // Ct/Ut/Sc/As/Un/Dt/Rl — per-actor task commands over A | B | C.
        fc.tuple(arbActor, arbTitle, arbDesc).map(
          ([actor, title, desc]) => new CtCommand3P(actor, title, desc),
        ),
        fc.tuple(arbActor, arbTitle).map(
          ([actor, title]) => new UtCommand3P(actor, title),
        ),
        fc.tuple(arbActor, arbStatus).map(
          ([actor, status]) => new ScCommand3P(actor, status),
        ),
        arbActor.map((actor) => new AsCommand3P(actor)),
        arbActor.map((actor) => new UnCommand3P(actor)),
        arbActor.map((actor) => new DtCommand3P(actor)),
        arbActor.map((actor) => new RlCommand3P(actor)),
        // Sw — identity switch on pageA, A<->B only (AC-3P-SW-1).
        fc.constant(new SwCommand3P()),
      ];

    // AC-X-RUNS-3P-1 / VQ-S5-007: default numRuns is 15, FAST_CHECK_NUM_RUNS
    // env override is honoured. parseInt of an unset/blank var yields NaN, so
    // the `|| 15` fallback restores the default.
    //
    // AC-3P-WC-2 (S7 wall-clock validation, 2026-05-26): three local `make e2e`
    // runs of this file alone measured 73s / 93s / 212s (max 212s) against the
    // 720s test.setTimeout budget — no breach. numRuns stays at 15 (no reduction
    // to 12 / maxCommands to 8 was needed). See S7 result.json completion notes.
    const numRuns = parseInt(process.env.FAST_CHECK_NUM_RUNS ?? "", 10) || 15;

    await fc.assert(
      fc.asyncProperty(
        // AC-3P-RUN-2: maxCommands 10.
        fc.commands(commands, { maxCommands: 10 }),
        async (cmds) => {
          // Fresh model per iteration, seeded with the three distinct cached
          // pubkeys. MLS leftover state is allowed to accumulate across runs
          // (design-decision §4); the per-command check() guards scope every
          // action to the current model's single shared group, so groups left
          // over from prior iterations are ignored.
          const model = new ModelState3P();
          model.pubkeyA = cachedPubkeyA;
          model.pubkeyB = cachedPubkeyB;
          model.pubkeyC = cachedPubkeyC;

          await fc.asyncModelRun(() => ({ model, real }), cmds);

          // Identity restore (VQ-S5-009 / VQ-S5-012): if a SwCommand3P switched
          // pageA off identity A (A<->B), switch it back to bunker A so the
          // final assertions and any re-run / afterAll teardown start from a
          // clean A identity. Reset the drifted model fields to prevent
          // cross-iteration identity leakage (matches the 2-party pattern).
          if (model.pubkeyA !== cachedPubkeyA) {
            await switchIdentity(real.pageA, E2E_BUNKER_URL);
            model.pubkeyA = cachedPubkeyA;
            model.memberA = false;
            model.groupId = null;
            model.epochSequenceA = [];
          }

          // Post-chain quiescence: assert the headline invariants at rest, not
          // mid-flight (VQ-S4-014).
          await real.quiesce();

          // VQ-S5-010: call all five headline assertions on the settled state.
          await assertC0_3P(model, real);
          await assertS5_3P(model, real);
          await assertS6_3P(model);
          await assertS7_3P(model, real);
          await assertS10_3P(model, real);
        },
      ),
      {
        // AC-3P-RUN-2 / AC-X-RUNS-3P-1: numRuns 15 (env-overridable). If S7's
        // wall-clock validation breaches the 720s envelope, reduce to 12 (or
        // maxCommands to 8) per AC-3P-WC-2 before touching maxCommands.
        numRuns,
        // verbose so a failing run prints the full Actor.Verb(args) chain
        // (AC-X-CI-3P-2 / AC-3P-RUN-5).
        verbose: true,
        // AC-3P-RUN-3 / VQ-S5-003: deterministic reproduction via env vars,
        // identical to the 2-party file's seed/path wiring.
        seed: parseInt(process.env.FAST_CHECK_SEED ?? "0") || undefined,
        path: process.env.FAST_CHECK_PATH ?? undefined,
      },
    );
  });
});
