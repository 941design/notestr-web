import React from "react";
import { shortenPubkey } from "../lib/nostr";
import type { Task, TaskStatus } from "../store/task-events";

interface TaskCardProps {
  task: Task;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onAssign: (taskId: string, assignee: string | null) => void;
  currentUserPubkey: string | null;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_CLASSES: Record<TaskStatus, string> = {
  open: "badge-open",
  in_progress: "badge-in-progress",
  done: "badge-done",
  cancelled: "badge-cancelled",
};

function getNextStatus(current: TaskStatus): TaskStatus | null {
  switch (current) {
    case "open":
      return "in_progress";
    case "in_progress":
      return "done";
    default:
      return null;
  }
}

export function TaskCard({
  task,
  onStatusChange,
  onAssign,
  currentUserPubkey,
}: TaskCardProps) {
  const nextStatus = getNextStatus(task.status);
  const isAssignedToMe =
    currentUserPubkey != null && task.assignee === currentUserPubkey;

  return (
    <div className="task-card">
      <div className="task-card-header">
        <h4 className="task-title">{task.title}</h4>
        <span className={`badge ${STATUS_CLASSES[task.status]}`}>
          {STATUS_LABELS[task.status]}
        </span>
      </div>

      {task.description && (
        <p className="task-description">
          {task.description.length > 120
            ? task.description.slice(0, 120) + "..."
            : task.description}
        </p>
      )}

      <div className="task-meta">
        <span className="task-assignee">
          {task.assignee ? shortenPubkey(task.assignee) : "Unassigned"}
        </span>
      </div>

      <div className="task-actions">
        {nextStatus && (
          <button
            className="btn btn-sm btn-outline"
            onClick={() => onStatusChange(task.id, nextStatus)}
          >
            Move to {STATUS_LABELS[nextStatus]}
          </button>
        )}
        {currentUserPubkey && !isAssignedToMe && (
          <button
            className="btn btn-sm btn-outline"
            onClick={() => onAssign(task.id, currentUserPubkey)}
          >
            Assign to me
          </button>
        )}
        {isAssignedToMe && (
          <button
            className="btn btn-sm btn-outline"
            onClick={() => onAssign(task.id, null)}
          >
            Unassign
          </button>
        )}
      </div>
    </div>
  );
}
