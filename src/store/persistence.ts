import { createKVStore } from "@/marmot/storage";
import type { TaskEvent } from "./task-events";

/**
 * DEPRECATED (Phase 8 / S12 legacy->engine cutover) — the receive-pipeline
 * read/write round-trip this module used to provide (`loadEvents`/
 * `saveEvents`/`appendEvent`) is retired: task-store.tsx now reads
 * exclusively from the engine's durable accepted-event log
 * (`src/persistence/raw-event-log-store.ts`), and device-sync.ts's
 * `publishTaskStateSync` was moved onto the same source (see
 * architecture.md module map: "persistence — DEPRECATED — removed Phase
 * 8"). `clearEvents` is KEPT — `GroupManager.tsx`'s leave-group flow still
 * calls it to purge this legacy `notestr:events:${groupId}` IDB namespace
 * on explicit leave. Any legacy entries for a group the user never
 * explicitly leaves are accepted-abandoned-in-place (VQ-S12-006): never
 * read again, only removed via the leave path above.
 */
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

export async function clearEvents(groupId: string): Promise<void> {
  await taskEventStore.setItem(storageKey(groupId), []);
}
