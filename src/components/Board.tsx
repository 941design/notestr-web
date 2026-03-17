import React, { useState } from "react";
import { useTaskStore } from "../store/task-store";
import { createTask, type TaskStatus } from "../store/task-events";
import { TaskCard } from "./TaskCard";
import { CreateTaskModal } from "./CreateTaskModal";

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
    const task = createTask(title, description, currentUserPubkey ?? "unknown");
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
    return <div className="board-loading">Loading tasks...</div>;
  }

  return (
    <div className="board">
      <div className="board-header">
        <h2 className="board-title">Tasks</h2>
        <button
          className="btn btn-primary"
          onClick={() => setModalOpen(true)}
        >
          + Add Task
        </button>
      </div>

      <div className="board-columns">
        {COLUMNS.map(({ status, label }) => {
          const columnTasks = tasks.filter((t) => t.status === status);
          return (
            <div key={status} className="board-column">
              <div className="column-header">
                <h3 className="column-title">{label}</h3>
                <span className="column-count">{columnTasks.length}</span>
              </div>
              <div className="column-cards">
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
                  <p className="column-empty">No tasks</p>
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
