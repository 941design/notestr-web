import React, { useState, useRef, useCallback } from "react";
import { Plus } from "lucide-react";
import { useTaskStore } from "@/store/task-store";
import { createTask, type TaskStatus } from "@/store/task-events";
import { TaskCard } from "@/components/TaskCard";
import { CreateTaskModal } from "@/components/CreateTaskModal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface BoardProps {
  currentUserPubkey: string | null;
}

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "open", label: "Open" },
  { status: "in_progress", label: "In Progress" },
  { status: "done", label: "Done" },
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
};

export function Board({ currentUserPubkey }: BoardProps) {
  const { tasks, dispatch, loading } = useTaskStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TaskStatus>("open");
  const [liveMessage, setLiveMessage] = useState("");
  const liveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announceStatusChange = useCallback((status: TaskStatus) => {
    if (liveTimeoutRef.current) clearTimeout(liveTimeoutRef.current);
    setLiveMessage(`Task moved to ${STATUS_LABELS[status]}`);
    liveTimeoutRef.current = setTimeout(() => setLiveMessage(""), 3000);
  }, []);

  async function handleCreate(title: string, description: string) {
    const task = createTask(
      title,
      description,
      currentUserPubkey ?? "unknown",
    );
    await dispatch({ type: "task.created", task });
  }

  async function handleStatusChange(taskId: string, status: TaskStatus) {
    const now = Math.floor(Date.now() / 1000);
    await dispatch({
      type: "task.status_changed",
      taskId,
      status,
      updatedAt: now,
      updatedBy: currentUserPubkey ?? "unknown",
    });
    announceStatusChange(status);
  }

  async function handleAssign(taskId: string, assignee: string | null) {
    const now = Math.floor(Date.now() / 1000);
    await dispatch({
      type: "task.assigned",
      taskId,
      assignee,
      updatedAt: now,
      updatedBy: currentUserPubkey ?? "unknown",
    });
  }

  if (loading) {
    return (
      <div role="region" aria-label="Task board" aria-busy="true" className="flex h-full flex-col">
        <div className="mb-4 flex items-center justify-between">
          <div className="h-7 w-16 animate-pulse rounded bg-muted" />
          <div className="h-9 w-24 animate-pulse rounded bg-muted" />
        </div>
        <div className="hidden md:grid md:flex-1 md:grid-cols-2 md:gap-4 lg:grid-cols-3">
          {(["open", "in_progress", "done"] as TaskStatus[]).map((status) => (
            <div key={status} className="flex min-h-[300px] flex-col rounded-lg border bg-card p-3">
              <div className="mb-3 flex items-center justify-between border-b pb-2">
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                <div className="h-5 w-6 animate-pulse rounded bg-muted" />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="animate-pulse rounded-lg border bg-muted/50 p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="h-4 flex-1 rounded bg-muted" />
                      <div className="h-5 w-16 shrink-0 rounded bg-muted" />
                    </div>
                    <div className="mb-2 h-3 w-3/4 rounded bg-muted" />
                    <div className="h-3 w-1/2 rounded bg-muted" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex-1 md:hidden">
          <div className="flex min-h-[300px] flex-col rounded-lg border bg-card p-3">
            <div className="mb-3 flex items-center justify-between border-b pb-2">
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              <div className="h-5 w-6 animate-pulse rounded bg-muted" />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse rounded-lg border bg-muted/50 p-3">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="h-4 flex-1 rounded bg-muted" />
                    <div className="h-5 w-16 shrink-0 rounded bg-muted" />
                  </div>
                  <div className="mb-2 h-3 w-3/4 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div role="region" aria-label="Task board" className="flex h-full flex-col">
      {/* Visually hidden live region for status change announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveMessage}
      </div>

      {/* Header row with title and Add Task button */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Tasks</h2>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="size-4" />
          Add Task
        </Button>
      </div>

      {/* Mobile tab bar — hidden on tablet/desktop */}
      <div className="mb-4 flex border-b md:hidden" role="tablist" aria-label="Task columns">
        {COLUMNS.map(({ status, label }) => {
          const count = tasks.filter((t) => t.status === status).length;
          return (
            <button
              key={status}
              role="tab"
              aria-selected={activeTab === status}
              onClick={() => setActiveTab(status)}
              className={[
                "flex flex-1 items-center justify-center gap-1.5 border-b-2 pb-2 pt-1 text-sm font-medium transition-colors",
                activeTab === status
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {label}
              <Badge variant="outline" className="text-xs px-1.5 py-0">
                {count}
              </Badge>
            </button>
          );
        })}
      </div>

      {/* Mobile single-column panel */}
      <div className="flex-1 md:hidden" role="tabpanel">
        {COLUMNS.filter(({ status }) => status === activeTab).map(({ status, label }) => {
          const columnTasks = tasks.filter((t) => t.status === status);
          return (
            <div
              key={status}
              role="region"
              aria-label={label}
              data-column={status}
              className="flex min-h-[300px] flex-col rounded-lg border bg-card p-3"
            >
              <div className="mb-3 flex items-center justify-between border-b pb-2">
                <h3 className="text-sm font-semibold">{label}</h3>
                <Badge variant="outline" className="text-xs">
                  {columnTasks.length}
                </Badge>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                {columnTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onStatusChange={handleStatusChange}
                    onAssign={handleAssign}
                    currentUserPubkey={currentUserPubkey}
                  />
                ))}
                {columnTasks.length === 0 && (
                  <p className="py-6 text-center text-sm italic text-muted-foreground">
                    No tasks
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tablet: 2-column grid with horizontal scroll; Desktop: 3-column grid */}
      <div className="hidden md:grid md:flex-1 md:grid-cols-2 md:gap-4 lg:grid-cols-3">
        {COLUMNS.map(({ status, label }) => {
          const columnTasks = tasks.filter((t) => t.status === status);
          return (
            <div
              key={status}
              role="region"
              aria-label={label}
              data-column={status}
              className="flex min-h-[300px] flex-col rounded-lg border bg-card p-3"
            >
              <div className="mb-3 flex items-center justify-between border-b pb-2">
                <h3 className="text-sm font-semibold">{label}</h3>
                <Badge variant="outline" className="text-xs">
                  {columnTasks.length}
                </Badge>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
                {columnTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onStatusChange={handleStatusChange}
                    onAssign={handleAssign}
                    currentUserPubkey={currentUserPubkey}
                  />
                ))}
                {columnTasks.length === 0 && (
                  <p className="py-6 text-center text-sm italic text-muted-foreground">
                    No tasks
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <CreateTaskModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
