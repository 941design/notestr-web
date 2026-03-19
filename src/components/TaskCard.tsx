import React from "react";
import { ArrowRight, UserCheck, UserX } from "lucide-react";
import { shortenPubkey } from "@/lib/nostr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus } from "@/store/task-events";

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

const STATUS_STYLES: Record<TaskStatus, string> = {
  open: "bg-primary/15 text-primary border-transparent",
  in_progress: "bg-warning/15 text-warning border-transparent",
  done: "bg-success/15 text-success border-transparent",
  cancelled: "bg-destructive/15 text-destructive border-transparent",
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
    <div className="rounded-lg border bg-background p-3 shadow-none transition-colors hover:border-muted-foreground dark:shadow-sm">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <h4 className="min-w-0 flex-1 text-sm font-semibold leading-snug">
          {task.title}
        </h4>
        <Badge className={cn("shrink-0", STATUS_STYLES[task.status])}>
          {STATUS_LABELS[task.status]}
        </Badge>
      </div>

      {task.description && (
        <p className="mb-2 line-clamp-2 overflow-hidden text-xs leading-relaxed text-muted-foreground">
          {task.description}
        </p>
      )}

      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {task.assignee ? shortenPubkey(task.assignee) : "Unassigned"}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {nextStatus && (
          <Button
            variant="default"
            size="xs"
            className="touch-target"
            onClick={() => onStatusChange(task.id, nextStatus)}
            aria-label={`Move to ${STATUS_LABELS[nextStatus]}`}
          >
            <ArrowRight className="size-3" />
            Move to {STATUS_LABELS[nextStatus]}
          </Button>
        )}
        {currentUserPubkey && !isAssignedToMe && (
          <Button
            variant="outline"
            size="xs"
            className="touch-target"
            onClick={() => onAssign(task.id, currentUserPubkey)}
          >
            <UserCheck className="size-3" />
            Assign to me
          </Button>
        )}
        {isAssignedToMe && (
          <Button
            variant="outline"
            size="xs"
            className="touch-target"
            onClick={() => onAssign(task.id, null)}
          >
            <UserX className="size-3" />
            Unassign
          </Button>
        )}
      </div>
    </div>
  );
}
