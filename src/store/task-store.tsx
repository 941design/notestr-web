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

        appendEvent(groupId, taskEvent).catch((err) => {
          console.error("Failed to persist incoming task event:", err);
        });
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

        await group.sendApplicationRumor(rumor);
      }
    },
    [group, groupId],
  );

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
