/**
 * task-events.ts (src/domain)
 *
 * TaskEvent wire type + related task shapes — relocated here from
 * src/store/task-events.ts by S2 (mandatory obligation from S1's review
 * cycle, DECIDER GATE: "the pure inner core owns the domain wire type").
 * src/store/task-events.ts is now a pure re-export shim
 * (`export * from "../domain/task-events"`) so every pre-existing importer
 * keeps working unchanged; see it for the full importer inventory.
 *
 * Content below is a VERBATIM relocation of the prior src/store/task-events.ts
 * — exports, names, and shapes are unchanged. This file exists so that
 * src/domain/domain-events.ts (whose `AcceptedDomainEvent.payload` field is
 * `TaskEvent`) can reference TaskEvent without violating the "src/domain/* ->
 * nothing" boundary rule: TaskEvent living IN src/domain, rather than being
 * imported from src/store, is what makes that rule satisfiable.
 *
 * Boundary compliance (architecture.md Boundary Rule: `src/domain/* ->
 * nothing`; Forbidden Rule 2): zero imports of src/engine/, src/persistence/,
 * src/integration/, src/store/, src/marmot/, or any external package.
 * `crypto.randomUUID()` and `Date.now()` below are GLOBAL references (Web
 * Crypto / ECMAScript globals available in both browser and Node), not
 * imports — they do not reference the DOM-specific globals this epic's
 * boundary rule forbids. Enforced by ./domain-boundary.structural.test.ts.
 */

export const TASK_EVENT_KIND = 31337;

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null; // npub/hex pubkey
  createdBy: string; // hex pubkey
  createdAt: number; // unix timestamp
  updatedAt: number; // unix timestamp
  updatedBy: string; // hex pubkey of last writer; set to createdBy on creation
  /** MLS clientId of the device that last wrote this task (sorts sibling-device same-second edits). "" = backward compat for persisted tasks. */
  updatedByDevice?: string;
}

export type TaskEvent =
  | { type: "task.created"; task: Task }
  | {
      type: "task.updated";
      taskId: string;
      changes: Partial<Pick<Task, "title" | "description">>;
      updatedAt: number;
      updatedBy: string;
      updatedByDevice?: string; // default "" for backward compat
    }
  | {
      type: "task.status_changed";
      taskId: string;
      status: TaskStatus;
      updatedAt: number;
      updatedBy: string;
      updatedByDevice?: string; // default "" for backward compat
    }
  | {
      type: "task.assigned";
      taskId: string;
      assignee: string | null;
      updatedAt: number;
      updatedBy: string;
      updatedByDevice?: string; // default "" for backward compat
    }
  | {
      type: "task.deleted";
      taskId: string;
      updatedAt: number;
      updatedBy: string;
      updatedByDevice?: string; // default "" for backward compat
    };

export const TASK_STATE_SYNC_KIND = 30078;

export interface TaskStateSyncPayload {
  version: 1;
  type: "task.state_sync";
  groupId: string;
  tasks: Task[];
  syncedAt: number; // Unix epoch seconds
  inviterPubkey: string; // hex pubkey
}

export function createTask(
  title: string,
  description: string,
  createdBy: string,
  updatedByDevice = "",
): Task {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: crypto.randomUUID(),
    title,
    description,
    status: "open",
    assignee: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
    updatedBy: createdBy,
    updatedByDevice,
  };
}
