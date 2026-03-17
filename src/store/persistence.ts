import { get, set } from "idb-keyval";
import type { TaskEvent } from "./task-events";

const EVENT_LOG_KEY = "notetastr:events";

function storageKey(groupId: string): string {
  return `${EVENT_LOG_KEY}:${groupId}`;
}

export async function loadEvents(groupId: string): Promise<TaskEvent[]> {
  const events = await get<TaskEvent[]>(storageKey(groupId));
  return events ?? [];
}

export async function saveEvents(
  groupId: string,
  events: TaskEvent[],
): Promise<void> {
  await set(storageKey(groupId), events);
}

export async function appendEvent(
  groupId: string,
  event: TaskEvent,
): Promise<void> {
  const events = await loadEvents(groupId);
  events.push(event);
  await set(storageKey(groupId), events);
}

export async function clearEvents(groupId: string): Promise<void> {
  await set(storageKey(groupId), []);
}
