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
  syncedAt: number;       // Unix epoch seconds
  inviterPubkey: string;  // hex pubkey
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
