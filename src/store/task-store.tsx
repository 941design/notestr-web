import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";
import { useGroup } from "../marmot/client";
import { TASK_EVENT_KIND, type Task, type TaskEvent } from "./task-events";
import { applyEvent, replayEvents, type TaskState } from "./task-reducer";
import { appendEvent, loadEvents } from "./persistence";

function isTestRuntime(): boolean {
  return process.env.NEXT_PUBLIC_E2E === "1" || process.env.NODE_ENV === "test";
}

interface TaskStoreContextValue {
  tasks: Task[];
  dispatch: (event: TaskEvent) => Promise<void>;
  loading: boolean;
}

const TaskStoreContext = createContext<TaskStoreContextValue | null>(null);

interface TaskStoreProviderProps {
  groupId: string;
  children: ReactNode;
}

export const TaskStoreProvider: React.FC<TaskStoreProviderProps> = ({
  groupId,
  children,
}) => {
  const group = useGroup(groupId);
  const [state, setState] = useState<TaskState>(new Map());
  const [loading, setLoading] = useState(true);
  const stateRef = useRef<TaskState>(state);

  // Keep the ref in sync with the latest state
  stateRef.current = state;

  // Load persisted events on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const events = await loadEvents(groupId);
      if (!cancelled) {
        const restored = replayEvents(events);
        setState(restored);
        setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [groupId]);

  // Subscribe to incoming application messages from the MLS group
  useEffect(() => {
    if (!group) return;

    function handleApplicationMessage(data: Uint8Array) {
      try {
        const rumor: Rumor = deserializeApplicationData(data);

        if (rumor.kind !== TASK_EVENT_KIND) return;

        const taskEvent: TaskEvent = JSON.parse(rumor.content);
        const nextState = applyEvent(stateRef.current, taskEvent);
        setState(nextState);

        // Persistence is handled by device-sync's applicationMessage listener
        // which runs even when this provider isn't mounted.
      } catch (err) {
        console.error("Failed to process application message:", err);
      }
    }

    group.on("applicationMessage", handleApplicationMessage);

    return () => {
      group.off("applicationMessage", handleApplicationMessage);
    };
  }, [group, groupId]);

  // Dispatch a task event: apply locally, persist, and send to group
  const dispatch = useCallback(
    async (taskEvent: TaskEvent) => {
      // Apply optimistically
      const nextState = applyEvent(stateRef.current, taskEvent);
      setState(nextState);

      // Persist to IndexedDB
      await appendEvent(groupId, taskEvent);

      // Send to the MLS group
      if (group) {
        const rumor: Rumor = {
          id: "",
          kind: TASK_EVENT_KIND,
          content: JSON.stringify(taskEvent),
          tags: [["t", "task"]],
          created_at: Math.floor(Date.now() / 1000),
          pubkey: "",
        };

        try {
          const forcedError = isTestRuntime()
            ? window.__notestrTestPublishFailureOnce
            : null;
          if (forcedError) {
            window.__notestrTestPublishFailureOnce = null;
            throw new Error(forcedError);
          }

          await group.sendApplicationRumor(rumor);
        } catch (err) {
          console.error("[task-store] sendApplicationRumor failed:", err);
          window.dispatchEvent(
            new CustomEvent("notestr:taskPublishFailed", {
              detail: {
                groupId,
                taskEvent,
                error: err instanceof Error ? err.message : String(err),
              },
            }),
          );
        }
      }
    },
    [group, groupId],
  );

  useEffect(() => {
    if (!isTestRuntime()) return;

    window.__notestrTestDispatchTaskEvent = (taskEvent) => dispatch(taskEvent);
    window.__notestrTestTasks = () => Array.from(stateRef.current.values());
    window.__notestrTestPersistedTaskEvents = () => loadEvents(groupId);
    window.__notestrTestArmPublishFailure = (message = "forced publish failure") => {
      window.__notestrTestPublishFailureOnce = message;
    };

    return () => {
      delete window.__notestrTestDispatchTaskEvent;
      delete window.__notestrTestTasks;
      delete window.__notestrTestPersistedTaskEvents;
      delete window.__notestrTestArmPublishFailure;
      delete window.__notestrTestPublishFailureOnce;
    };
  }, [dispatch, groupId]);

  const tasks = Array.from(state.values());

  return (
    <TaskStoreContext.Provider value={{ tasks, dispatch, loading }}>
      {children}
    </TaskStoreContext.Provider>
  );
};

export function useTaskStore(): TaskStoreContextValue {
  const context = useContext(TaskStoreContext);
  if (!context) {
    throw new Error("useTaskStore must be used within a TaskStoreProvider");
  }
  return context;
}
