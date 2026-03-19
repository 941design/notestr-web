# notestr Task Protocol Specification

Version: 1.0 (draft)

This document specifies the application-level task protocol used by notestr. It describes the data types, event formats, conflict resolution rules, and transport mechanism so that any compatible client can participate in shared task boards.

## Overview

notestr tasks live inside MLS groups managed by [marmot-ts](https://github.com/nicobao/marmot-ts). Each group has its own independent task board. Tasks are exchanged as **application messages** within the MLS group, meaning they are end-to-end encrypted for group members only.

The protocol is event-sourced: clients exchange immutable task events, and each client independently reduces those events into the current task state.

## Nostr Event Envelope

Task events are wrapped in a Nostr **Rumor** (unsigned event) and sent via the MLS group's `sendApplicationRumor()` method.

| Field        | Value                                  |
|--------------|----------------------------------------|
| `kind`       | **31337**                              |
| `content`    | JSON-serialized `TaskEvent` (see below)|
| `tags`       | `[["t", "task"]]`                      |
| `created_at` | Unix timestamp (seconds)               |
| `pubkey`     | `""` (populated by MLS layer)          |
| `id`         | `""` (populated by MLS layer)          |

The `pubkey` and `id` fields are left empty by the application; the MLS library fills them during serialization. The `["t", "task"]` tag acts as a semantic marker for filtering non-task application messages on the same group.

### Transport

The MLS library serializes the Rumor into a `Uint8Array`, encrypts it for the group, and publishes it as a **kind 445** Nostr event to the group's relay set. On the receiving side, the MLS library decrypts the kind-445 event and emits a `Uint8Array` via the `applicationMessage` event. The application then calls `deserializeApplicationData()` to recover the original Rumor and checks `rumor.kind === 31337` before parsing the content.

## Task Object

```typescript
interface Task {
  id: string;              // UUIDv4
  title: string;           // required
  description: string;     // may be empty string
  status: TaskStatus;      // see below
  assignee: string | null; // hex pubkey, or null if unassigned
  createdBy: string;       // hex pubkey of creator
  createdAt: number;       // unix timestamp (seconds)
  updatedAt: number;       // unix timestamp (seconds)
}

type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
```

### Field Details

- **id** — Generated with `crypto.randomUUID()` at creation time. Must be globally unique. Used as the primary key in all subsequent events.
- **title** — Human-readable task title. Must be non-empty.
- **description** — Free-text description. Empty string `""` when not provided.
- **status** — One of four values. New tasks always start as `"open"`.
- **assignee** — Hex-encoded Nostr public key of the assigned user, or `null` for unassigned.
- **createdBy** — Hex-encoded Nostr public key of the user who created the task.
- **createdAt** — Unix timestamp in seconds. Set once at creation, never changes.
- **updatedAt** — Unix timestamp in seconds. Updated on every mutation. Used for conflict resolution (see below).

## Task Events

All mutations are expressed as a discriminated union on the `type` field. The `content` field of the Nostr Rumor is `JSON.stringify(taskEvent)` where `taskEvent` is one of the following:

### `task.created`

Creates a new task.

```json
{
  "type": "task.created",
  "task": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Fix relay reconnection",
    "description": "Relay drops after 30s idle",
    "status": "open",
    "assignee": null,
    "createdBy": "ab12cd34...",
    "createdAt": 1710850000,
    "updatedAt": 1710850000
  }
}
```

If a task with the same `id` already exists, the event is ignored.

### `task.updated`

Updates the title and/or description of an existing task.

```json
{
  "type": "task.updated",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "changes": {
    "title": "Fix relay reconnection on mobile"
  },
  "updatedAt": 1710850100,
  "updatedBy": "ab12cd34..."
}
```

- **`changes`** — Partial object containing `title` and/or `description`. Only the fields present are updated; omitted fields are left unchanged.
- **`updatedBy`** — Hex pubkey of the user making the change.
- Rejected if `updatedAt < existing.updatedAt` (see Conflict Resolution).

### `task.status_changed`

Changes the status of a task.

```json
{
  "type": "task.status_changed",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "in_progress",
  "updatedAt": 1710850200,
  "updatedBy": "ab12cd34..."
}
```

- The protocol does not enforce a specific state machine at the data layer — any status value is accepted. UI implementations may choose to restrict transitions (e.g. `open` → `in_progress` → `done`).
- Rejected if stale.

### `task.assigned`

Assigns or unassigns a task.

```json
{
  "type": "task.assigned",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "assignee": "ef56ab78...",
  "updatedAt": 1710850300,
  "updatedBy": "ab12cd34..."
}
```

- Set `assignee` to `null` to unassign.
- Rejected if stale.

### `task.deleted`

Deletes a task.

```json
{
  "type": "task.deleted",
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "updatedAt": 1710850400,
  "updatedBy": "ab12cd34..."
}
```

- The task is removed from state entirely (hard delete from the materialized view).
- The event itself remains in the persisted event log.
- Rejected if stale.

### `task.snapshot`

Replaces all task state wholesale. **Local-only — not sent over the network.**

```json
{
  "type": "task.snapshot",
  "tasks": [ /* array of Task objects */ ]
}
```

Used for bulk state initialization or recovery. Clears the current state and populates it with the provided tasks. Clients must not transmit this event type over MLS.

## Conflict Resolution

The protocol uses **last-write-wins (LWW)** semantics based on the `updatedAt` timestamp.

For `task.updated`, `task.status_changed`, `task.assigned`, and `task.deleted`:

1. Look up the existing task by `taskId`.
2. If no task exists with that ID, the event is **silently ignored**.
3. If `event.updatedAt >= existing.updatedAt`, apply the change.
4. If `event.updatedAt < existing.updatedAt`, the event is **silently ignored** (stale).

For `task.created`:

- The task is inserted into state by its `id`. If a task with that ID already exists, the create is a no-op (first-write-wins for creation).

There is no vector clock or causal ordering. Ties (`event.updatedAt === existing.updatedAt`) are resolved in favor of the incoming event (the `>=` comparison means the later-arriving event wins on ties).

## State Reconstruction

Clients persist the full event log (an ordered array of `TaskEvent` objects) per group. On startup, the state is reconstructed by replaying all events in order:

```
state = empty Map<string, Task>
for each event in log:
  state = applyEvent(state, event)
```

This deterministic replay produces the same state regardless of when events were received, as long as the event log contains the same events (order matters only for tie-breaking on equal timestamps).

## Persistence

Events are stored in IndexedDB (via the `idb-keyval` library) under the key:

```
notestr:events:{groupId}
```

Where `groupId` is the MLS group identifier string. The value is a JSON array of `TaskEvent` objects.

Operations:
- **Load**: Read the array, replay into state.
- **Append**: Push a new event to the end of the array.
- **Clear**: Replace with an empty array (used when leaving a group).

## Scoping

- Each MLS group has an independent task board.
- Task IDs are scoped to the group — there is no cross-group task reference.
- A user may be a member of multiple groups, each with its own task state.

## Event Flow

### Sending (local user creates/modifies a task)

1. User action triggers a `TaskEvent`.
2. Event is applied optimistically to local state (immediate UI update).
3. Event is appended to the local IndexedDB event log.
4. Event is wrapped in a Rumor (kind 31337, tag `["t", "task"]`) and sent via `group.sendApplicationRumor()`.
5. MLS encrypts and publishes as a kind-445 Nostr event to group relays.

### Receiving (remote user's event arrives)

1. MLS layer receives a kind-445 event from relay subscription.
2. MLS decrypts and emits `applicationMessage` with the raw `Uint8Array`.
3. Application deserializes the data into a Rumor.
4. If `rumor.kind !== 31337`, the message is ignored (not a task event).
5. `rumor.content` is parsed as a `TaskEvent`.
6. Event is appended to the local IndexedDB event log (persistence layer).
7. Event is applied to the in-memory state via `applyEvent()`.
8. UI re-renders with updated task list.

## NIP-46 Permission Requirements

When using a NIP-46 remote signer (bunker), the following permissions are required:

- `sign_event:31337` — sign task events
- `nip44_encrypt` — encrypt MLS messages
- `nip44_decrypt` — decrypt MLS messages

## Considerations for Implementers

### No Priority Field
The current protocol has no priority or ordering field. Tasks appear in insertion order within each status column. Implementers who need ordering should consider adding an `order` or `priority` field to future event types.

### No Edit History
The event log preserves the full history of changes, but there is no dedicated "history" event type. Edit history can be reconstructed by replaying the event log and tracking intermediate states.

### Idempotency
`task.created` is naturally idempotent (duplicate UUIDs are ignored). Mutation events are idempotent within the LWW model — replaying the same event twice produces the same result as replaying it once.

### Deletion Semantics
Deletion removes the task from the materialized state but not from the event log. If a `task.created` event is replayed after a `task.deleted` event with an older timestamp, the task will reappear. Clients should be aware of this when compacting event logs.
