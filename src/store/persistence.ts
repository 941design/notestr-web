import { createKVStore } from "@/marmot/storage";
import type { TaskEvent } from "./task-events";

const EVENT_LOG_KEY = "notestr:events";

// Pubkey-partitioned task event log. Routing through createKVStore (rather than
// the bare idb-keyval default store) gives the log a `notestr-${pubkey}-task-events`
// database, so a prior user's task history is isolated per identity and wiped by
// the `notestr-`-prefixed clearAppState fixture. The store is bound lazily to the
// active pubkey by storage.ts::bindStores — accessing it before sign-in throws.
const taskEventStore = createKVStore<TaskEvent[]>("task-events");

function storageKey(groupId: string): string {
  return `${EVENT_LOG_KEY}:${groupId}`;
}

export async function loadEvents(groupId: string): Promise<TaskEvent[]> {
  const events = await taskEventStore.getItem(storageKey(groupId));
  return events ?? [];
}

export async function saveEvents(
  groupId: string,
  events: TaskEvent[],
): Promise<void> {
  await taskEventStore.setItem(storageKey(groupId), events);
}

export async function appendEvent(
  groupId: string,
  event: TaskEvent,
): Promise<void> {
  const events = await loadEvents(groupId);
  events.push(event);
  await taskEventStore.setItem(storageKey(groupId), events);
}

export async function clearEvents(groupId: string): Promise<void> {
  await taskEventStore.setItem(storageKey(groupId), []);
}
