import React, { useState } from "react";
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

export function Board({ currentUserPubkey }: BoardProps) {
  const { tasks, dispatch, loading } = useTaskStore();
  const [modalOpen, setModalOpen] = useState(false);

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
      <div className="flex h-[200px] items-center justify-center text-muted-foreground">
        Loading tasks...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Tasks</h2>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="size-4" />
          Add Task
        </Button>
      </div>

      <div className="grid flex-1 grid-cols-3 gap-4">
        {COLUMNS.map(({ status, label }) => {
          const columnTasks = tasks.filter((t) => t.status === status);
          return (
            <div
              key={status}
              className="flex min-h-[300px] flex-col rounded-lg border bg-card p-3"
            >
              <div className="mb-3 flex items-center justify-between border-b pb-2">
                <h3 className="text-sm font-semibold">{label}</h3>
                <Badge variant="outline" className="text-xs">
                  {columnTasks.length}
                </Badge>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
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
