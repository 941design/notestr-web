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
}

export type TaskEvent =
  | { type: "task.created"; task: Task }
  | {
      type: "task.updated";
      taskId: string;
      changes: Partial<Pick<Task, "title" | "description">>;
      updatedAt: number;
      updatedBy: string;
    }
  | {
      type: "task.status_changed";
      taskId: string;
      status: TaskStatus;
      updatedAt: number;
      updatedBy: string;
    }
  | {
      type: "task.assigned";
      taskId: string;
      assignee: string | null;
      updatedAt: number;
      updatedBy: string;
    }
  | {
      type: "task.deleted";
      taskId: string;
      updatedAt: number;
      updatedBy: string;
    }
  | { type: "task.snapshot"; tasks: Task[] };

export function createTask(
  title: string,
  description: string,
  createdBy: string,
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
  };
}
