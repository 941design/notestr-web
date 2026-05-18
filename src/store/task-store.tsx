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
import {
  deserializeApplicationData,
  getNostrGroupIdHex,
} from "@internet-privacy/marmot-ts";
import { getEventHash } from "nostr-tools/pure";
import { useGroup, useMarmot } from "../marmot/client";
import {
  beginDispatchPublishWindow,
  endDispatchPublishWindow,
  enqueueExpectedPublish,
  removeExpectedPublishByRumorId,
} from "../marmot/device-sync";
import { mlsTrace } from "../marmot/mls-trace";
import { TASK_EVENT_KIND, type Task, type TaskEvent } from "./task-events";
import { applyEvent, replayEvents, type TaskState } from "./task-reducer";
import { appendEvent, loadEvents } from "./persistence";

function isTestRuntime(): boolean {
  return process.env.NEXT_PUBLIC_E2E === "1" || process.env.NODE_ENV === "test";
}

/**
 * Per-group dispatch mutex. Two `dispatch()` invocations on the same
 * group serialize through this map so that the
 * `enqueueExpectedPublish → sendApplicationRumor → consume` window for
 * dispatch1 fully completes before dispatch2's enqueue runs. Without
 * this, two parallel dispatches (e.g. user double-click, or two test
 * fixtures racing) would interleave their enqueues with marmot-ts's
 * `this.state` mutation in `sendApplicationRumor` and the trace
 * bridge's FIFO would correlate the wrong rumor.id ↔ kind-445 eventId.
 *
 * The mutex is module-scoped and per-groupId. It does NOT affect
 * non-publish work (the local `setState`/`appendEvent` calls run before
 * the lock is acquired) — the lock only brackets the `if (group)`
 * publish block.
 */
const dispatchPublishLock = new Map<string, Promise<void>>();

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
  const { pubkey } = useMarmot();
  const [state, setState] = useState<TaskState>(new Map());
  const [loading, setLoading] = useState(true);
  const stateRef = useRef<TaskState>(state);

  // Keep the ref in sync with the latest state
  stateRef.current = state;

  // Load persisted events on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      mlsTrace.record({
        kind: "task-store-load-start",
        t: Date.now(),
        groupId,
      });
      const events = await loadEvents(groupId);
      if (!cancelled) {
        const restored = replayEvents(events);
        mlsTrace.record({
          kind: "task-store-load-complete",
          t: Date.now(),
          groupId,
          restoredCount: restored.size,
        });
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
      let rumor: Rumor;
      try {
        rumor = deserializeApplicationData(data);
      } catch (err) {
        // F3b: deserializeApplicationData threw — rumorId unknown.
        mlsTrace.record({
          kind: "task-store-error",
          t: Date.now(),
          groupId,
          rumorId: null,
          reason: "deserialize-throw",
          message: err instanceof Error ? err.message : String(err),
        });
        console.error("Failed to process application message:", err);
        return;
      }

      mlsTrace.record({
        kind: "task-store-recv",
        t: Date.now(),
        groupId,
        rumorId: rumor.id,
      });
      if (rumor.kind !== TASK_EVENT_KIND) {
        // F3c: kind mismatch.
        mlsTrace.record({
          kind: "task-store-rejected",
          t: Date.now(),
          groupId,
          rumorId: rumor.id,
          reason: "wrong-kind",
        });
        return;
      }

      try {
        const taskEvent: TaskEvent = JSON.parse(rumor.content);
        const nextState = applyEvent(stateRef.current, taskEvent);
        // Per GAP-1: rumor.id is the canonical correlator. The trace
        // event's `taskEventId` slot is populated from rumor.id (no
        // TaskEvent.id field exists).
        mlsTrace.record({
          kind: "task-store-accepted",
          t: Date.now(),
          groupId,
          rumorId: rumor.id,
          taskEventId: rumor.id,
        });
        setState(nextState);

        // Persistence is handled by device-sync's applicationMessage listener
        // which runs even when this provider isn't mounted.
      } catch (err) {
        // F3b: applyEvent or JSON.parse threw after a successful deserialize.
        mlsTrace.record({
          kind: "task-store-error",
          t: Date.now(),
          groupId,
          rumorId: rumor.id,
          reason: "apply-throw",
          message: err instanceof Error ? err.message : String(err),
        });
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
        // Acquire the per-group dispatch publish mutex. Two concurrent
        // dispatches on the same group serialize through this so the
        // enqueue → sendApplicationRumor → consume window of dispatch1
        // fully completes before dispatch2's enqueue runs. Without this
        // mutex, the GAP-2 publish-path FIFO would correlate the wrong
        // rumor.id ↔ kind-445 eventId under a double-click race.
        // Same chain-promise pattern as device-sync.ts:ingestLock.
        const prevLock = dispatchPublishLock.get(groupId) ?? Promise.resolve();
        const myTurn = prevLock.catch(() => undefined);
        let release!: () => void;
        const released = new Promise<void>((r) => {
          release = r;
        });
        dispatchPublishLock.set(groupId, myTurn.then(() => released));
        await myTurn;
        try {
          // marmot-ts's deserializeApplicationData rejects rumors with empty
          // `id` or `pubkey`, which breaks both the web's own receive path
          // (handleApplicationMessage) and the e2e publish-contract round-trip
          // decode. Follow the same pattern as `MarmotGroup.sendChatMessage`:
          // set pubkey to the user's identity pubkey and compute the event
          // hash before handing the rumor to sendApplicationRumor.
          const draft = {
            id: "",
            kind: TASK_EVENT_KIND,
            content: JSON.stringify(taskEvent),
            tags: [["t", "task"]],
            created_at: Math.floor(Date.now() / 1000),
            pubkey,
          };
          const rumor: Rumor = { ...draft, id: getEventHash(draft) };

          // GAP-2 sender-side own-publish bridge: register this rumor in
          // a per-hTag FIFO BEFORE sendApplicationRumor so that when
          // marmot-ts asks the network adapter to publish the kind-445,
          // `consumeExpectedPublishForKind445` can dequeue the front of
          // that hTag's queue and emit `publish-task` joining
          // rumor.id ↔ kind-445 eventId. The receive-side approach (via
          // applicationMessage) cannot fire for own messages because
          // marmot-ts intentionally suppresses self-echo.
          // Per GAP-1, taskEventId slot is populated from rumor.id.
          const hTag = getNostrGroupIdHex(group.state);
          enqueueExpectedPublish(hTag, rumor.id, groupId, rumor.id);
          beginDispatchPublishWindow(hTag);

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
            // Drop the parked expectation so the next successful publish
            // on this hTag doesn't emit a `publish-task` with a stale
            // rumorId paired to the new kind-445 eventId.
            removeExpectedPublishByRumorId(hTag, rumor.id);
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
          } finally {
            endDispatchPublishWindow(hTag);
          }
        } finally {
          release();
          // If our chain entry is still the tail, drop it so the Map
          // doesn't grow unboundedly under churn. Mirrors the cleanup
          // pattern in device-sync.ts:ingestLock.
          const currentTail = dispatchPublishLock.get(groupId);
          if (currentTail) {
            currentTail.then(() => {
              if (dispatchPublishLock.get(groupId) === currentTail) {
                dispatchPublishLock.delete(groupId);
              }
            });
          }
        }
      }
    },
    [group, groupId, pubkey],
  );

  // Keep the latest dispatch and groupId reachable via refs so the test
  // hooks installed below can be registered ONCE per provider mount and
  // stay registered across re-renders. Earlier wiring re-ran the effect
  // whenever `dispatch` or `groupId` changed (which happens whenever a
  // relay echo advances the group's MLS epoch and rebuilds the `group`
  // reference under `useCallback`'s deps), so the cleanup briefly deleted
  // `window.__notestrTestDispatchTaskEvent` between renders. A test that
  // fired a `dispatchTaskEvent` during that window saw the hook missing.
  const dispatchRef = useRef(dispatch);
  const groupIdRef = useRef(groupId);
  dispatchRef.current = dispatch;
  groupIdRef.current = groupId;

  useEffect(() => {
    if (!isTestRuntime()) return;

    window.__notestrTestDispatchTaskEvent = (taskEvent) =>
      dispatchRef.current(taskEvent);
    window.__notestrTestTasks = () => Array.from(stateRef.current.values());
    window.__notestrTestPersistedTaskEvents = () =>
      loadEvents(groupIdRef.current);
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
  }, []);

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
