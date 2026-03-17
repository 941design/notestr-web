import type { Task, TaskEvent } from "./task-events";

export type TaskState = Map<string, Task>;

export function applyEvent(state: TaskState, event: TaskEvent): TaskState {
  const next = new Map(state);

  switch (event.type) {
    case "task.created": {
      next.set(event.task.id, event.task);
      break;
    }

    case "task.updated": {
      const existing = next.get(event.taskId);
      if (existing && event.updatedAt >= existing.updatedAt) {
        next.set(event.taskId, {
          ...existing,
          ...event.changes,
          updatedAt: event.updatedAt,
        });
      }
      break;
    }

    case "task.status_changed": {
      const existing = next.get(event.taskId);
      if (existing && event.updatedAt >= existing.updatedAt) {
        next.set(event.taskId, {
          ...existing,
          status: event.status,
          updatedAt: event.updatedAt,
        });
      }
      break;
    }

    case "task.assigned": {
      const existing = next.get(event.taskId);
      if (existing && event.updatedAt >= existing.updatedAt) {
        next.set(event.taskId, {
          ...existing,
          assignee: event.assignee,
          updatedAt: event.updatedAt,
        });
      }
      break;
    }

    case "task.deleted": {
      const existing = next.get(event.taskId);
      if (existing && event.updatedAt >= existing.updatedAt) {
        next.delete(event.taskId);
      }
      break;
    }

    case "task.snapshot": {
      next.clear();
      for (const task of event.tasks) {
        next.set(task.id, task);
      }
      break;
    }
  }

  return next;
}

export function replayEvents(events: TaskEvent[]): TaskState {
  let state: TaskState = new Map();
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}
