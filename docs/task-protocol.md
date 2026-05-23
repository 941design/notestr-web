# Task Management Protocol over Nostr MLS

This document describes the wire-format and runtime contract that notestr-web
implements when publishing and consuming task events over
[MLS](https://www.rfc-editor.org/rfc/rfc9420)-encrypted Nostr groups.

---

## Event kinds

| Kind | Role |
|------|------|
| 30443 | Key-package announcement (NIP-104 / MIP-01). Identifies a device's MLS key package. |
| 1059 | Gift-wrap envelope (NIP-59). Used for welcome messages and direct invitations. |
| 445 | MLS group message. Encrypted payload carrying either an MLS commit/proposal or an application rumor. |

All application data — task events — rides inside kind-445 ciphertext. The
outer event is a sealed NIP-44 envelope whose plaintext is an MLS record that
`ts-mls` (via `marmot-ts`) can decrypt and apply to the group state.

---

## Task event shape (application rumor)

Once decrypted, a kind-445 application message yields a Nostr rumor of kind
`31337` (constant `TASK_EVENT_KIND`). The rumor's `content` field carries a
JSON-encoded `TaskEvent` discriminated union:

```ts
type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  createdBy: string;   // hex pubkey of creator
  createdAt: number;   // unix seconds
  updatedAt: number;   // unix seconds of last mutation
  updatedBy: string;   // hex pubkey of last mutator
}

type TaskEvent =
  | { type: "task.created";        task: Task }
  | { type: "task.updated";        taskId: string; changes: Partial<Pick<Task, "title" | "description">>; updatedAt: number; updatedBy: string }
  | { type: "task.status_changed"; taskId: string; status: TaskStatus; updatedAt: number; updatedBy: string }
  | { type: "task.assigned";       taskId: string; assignee: string | null; updatedAt: number; updatedBy: string }
  | { type: "task.deleted";        taskId: string; updatedAt: number; updatedBy: string };
```

The rumor also carries `tags: [["t", "task"]]`, which the `task-store` uses to
distinguish application messages from MLS administrative events.

**Correlator.** The application-layer identifier for a task rumor is
`rumor.id` (the Nostr event id of the inner rumor, after NIP-44 unsealing).
There is no separate `TaskEvent.id` field on the rumor envelope itself.
`rumor.id` is the stable correlator used by the MLS trace system and by the
F-class classifier to join sender-side publish events to receiver-side ingest
events.

---

## Kind-445 wire format

```
{
  "kind": 445,
  "pubkey": <ephemeral-per-event-keypair>,
  "tags": [["h", <nostr_group_id_hex>]],
  "content": <base64(nonce || ciphertext || poly1305-tag)>,
  "sig": <sig over ephemeral pubkey>
}
```

- `#h` tag: hex-encoded nostr group id. Used by relay-side filters (`{ kinds:
  [445], "#h": [<groupIdHex>] }`) to scope subscriptions to a single group.
- `content`: ChaCha20-Poly1305 ciphertext. Minimum decoded length is 28 bytes
  (12-byte nonce + 16-byte Poly1305 tag + 0 bytes of plaintext). In practice
  the length is substantially larger because it carries a full MLS record.
- `pubkey`: ephemeral per-event keypair, never the user's identity pubkey.

---

## MLS receive pipeline (consumer-side)

This section describes the receive-side runtime contract for the MLS pipeline
in `src/marmot/device-sync.ts`. The ordering guarantees and retry semantics
documented here are the deliverable of `specs/epic-mls-live-delivery-race/`
(the "MLS Live-Delivery Race — kind-445 Subscription Gap" epic).

### Overview

When a group is loaded (`syncGroup` is called), the pipeline:

1. Opens a **persistent NDK subscription** first, buffering incoming events.
2. Fetches all **historical kind-445 events** via a one-shot request.
3. Drains the buffer in `created_at` order to ingest live events that arrived
   while the historical fetch was in flight.
4. From that point on, live events flow directly into the ingest path.

This subscribe-first ordering (Solution A) eliminates the "fetch-then-subscribe
gap" (F1 failure mode) where events published during the time between the
one-shot request closing and the persistent subscription opening could be
silently lost.

### Subscribe-first ordering (Solution A)

**Why this ordering matters.** The naive approach — fetch historical events
first, then open the subscription — creates a gap window. Any kind-445 event
that lands at the relay during that gap is neither in the historical fetch
(which has already closed) nor in the new subscription (which has not yet
registered its filter). The relay has the event; the consumer just never asks
for it at the right time.

The subscribe-first approach closes that gap by establishing a live subscription
**before** the historical fetch starts. Events that arrive during the fetch are
collected in a closure-scoped buffer and drained afterward.

**Implementation contract** (`device-sync.ts:syncGroup`):

```ts
const t0 = Math.floor(Date.now() / 1000);
const OVERLAP_SECONDS = 60; // sized for end-user clock skew, see Design Decision 3

// Step 1: open the persistent subscription FIRST with since = t0 - OVERLAP_SECONDS.
// Events delivered while the historical fetch is in flight go into liveBuffer.
const liveBuffer: NostrEvent[] = [];
let cutoverComplete = false;

const groupSub = client.network
  .subscription(relaysForGroup, [filter(t0 - OVERLAP_SECONDS)])
  .subscribe({
    next: async (event: NostrEvent) => {
      if (!cutoverComplete) {
        liveBuffer.push(event);
        return;
      }
      await ingestGroupEvents(group, [event]);
    },
  });
groupSubs.set(group.idStr, groupSub);
subs.push(groupSub);

// Step 2: fetch the historical one-shot request and ingest results.
const initialEvents = await client.network.request(relaysForGroup, [filter()]);
await ingestGroupEvents(group, initialEvents);

// Step 3: drain the buffer in created_at order, then flip cutoverComplete.
// Events already processed in Step 2 are filtered by syncedEventIds.
const buffered = liveBuffer.splice(0).sort((a, b) => a.created_at - b.created_at);
cutoverComplete = true;
if (buffered.length > 0) {
  await ingestGroupEvents(group, buffered);
}
```

**Overlap window.** The persistent subscription's `since` filter is set to
`t0 - OVERLAP_SECONDS` where `OVERLAP_SECONDS = 60`. This 60-second window
accommodates end-user clock skew between the local client clock and the relay's
`created_at` stamps. Mobile and desktop clocks routinely drift by tens of
seconds without active NTP sync; 60 seconds gives generous headroom at
negligible cost. Overlap is handled by the `syncedEventIds` deduplication set
inside `ingestGroupEventsRaw` — each event id is processed at most once.

**Per-call isolation.** `liveBuffer` and `cutoverComplete` are
closure-scoped to each `syncGroup` call. Concurrent syncs for different groups
have fully independent buffers; there is no shared module-level state for these
variables.

**`created_at` sort.** The buffer drain sorts by `created_at` (second
granularity) rather than by relay delivery order. This provides a reasonable
best-effort ordering but is not a hard guarantee: two events with the same
`created_at` value can sort in either order. The Solution B retry mechanism
(described below) handles same-second ordering ambiguities where an application
message arrives before the commit it depends on.

### Retry-trigger contract (Solution B)

**Why epoch-advance alone is not sufficient.** When B's MLS state is at epoch
N and B receives an application message encrypted at epoch N+1 (because a
commit was published between the welcome and the app message), `ts-mls` cannot
decrypt it — the message is parked in the `PendingRetryQueue`. The queue
drains when the group's epoch advances. But if the only "next" event is that
same application message (i.e., no further commit is coming), the epoch never
advances and the queue never drains.

**Drain on ingest activity.** Solution B extends the drain trigger to fire on
**any** successful ingest activity, not only on epoch transitions. After
`ingestGroupEventsRaw` persists a non-empty set of newly processed events
(`processed.size > 0`), it attempts a single drain pass of the parked queue.

```ts
// After addSyncedGroupEventIds(...) has persisted the processed set:
if (processed.size === 0) return;

const retryQueue = getPendingRetryQueue(group.idStr);
const parked = retryQueue.snapshot();
if (parked.length === 0) return;

const groupAttempts = retryAttempts.get(group.idStr) ?? new Map<string, number>();
retryAttempts.set(group.idStr, groupAttempts);

const fresh = parked.filter((e) => (groupAttempts.get(e.id) ?? 0) < MAX_RETRIES);
if (fresh.length === 0) return;

for (const e of fresh) {
  groupAttempts.set(e.id, (groupAttempts.get(e.id) ?? 0) + 1);
}
mlsTrace.record({ kind: "queue-drain", t: Date.now(), groupId: group.idStr,
                  trigger: "ingest-activity", entries: fresh.length });
void ingestGroupEvents(group, fresh).catch((err) => { /* logged */ });
```

**Per-epoch retry cap.** A module-scoped `retryAttempts: Map<string,
Map<string, number>>` tracks how many times each parked event has been retried
within the current epoch (outer key: `groupId`, inner key: kind-445 `eventId`).
The constant `MAX_RETRIES = 3` caps retries per-event-per-epoch.

The cap protects against retry storms on events that are permanently
undecryptable (e.g. a malformed kind-445 that is signed but will never decrypt
regardless of epoch). Such an event parks once, exhausts its three retries
within an epoch, and sits in the queue until the 24-hour TTL prune evicts it.
The per-call cost of the early-exit check is negligible (one Map lookup).

**Counter reset on epoch advance.** When `attachRetryOnEpochAdvance`'s
`stateChanged` listener fires with `newEpoch > prev`, the inner map for that
`groupId` is cleared **before** the existing epoch-advance queue drain:

```ts
// Inside attachRetryOnEpochAdvance, stateChanged handler:
if (newEpoch > prev) {
  retryAttempts.get(group.idStr)?.clear(); // reset per-epoch budget
  // ... existing epoch-advance queue drain ...
}
```

This reset is essential for recovery: a transient race that takes more than
`MAX_RETRIES` attempts to resolve within epoch N becomes permanently stuck
without the reset. A fresh commit at epoch N+1 brings genuinely new MLS state;
the previously-unreadable event may now be decryptable, so the retry budget
should be fresh. Without the reset, `MAX_RETRIES` exhaustion in epoch N would
permanently block recovery even when a legitimate decrypting commit arrives.

**Drain trigger values.** The `queue-drain` trace event's `trigger` field
distinguishes the two drain paths:

| `trigger` value | Fired by |
|-----------------|----------|
| `"epoch-advance"` | `attachRetryOnEpochAdvance` — existing path |
| `"ingest-activity"` | `ingestGroupEventsRaw` — Solution B extension |

**Serialisation.** Both drain paths re-enter via `ingestGroupEvents` (the
lock-protected wrapper around `ingestGroupEventsRaw`). The pre-existing
`ingestLock` mutex (`device-sync.ts:413–430`) serialises concurrent ingest
calls per group, preventing data races between the live subscription delivery
and the drain pass.

**Teardown.** `refreshGroupSync` calls `retryAttempts.delete(groupId)` when
removing a group's other per-group state. This drops the entire inner counter
map for the group atomically.

### Combined guarantee

Solutions A and B are complementary and both ship together:

- **A** closes the subscription gap: no event published after `t0 - 60s` can
  be silently missed due to the fetch→subscribe ordering race.
- **B** closes the epoch ordering gap: an application message that arrives
  before its prerequisite commit will be retried when that commit (or any other
  ingest activity) advances the group's readability.

A single kind-445 that falls into the overlap window AND requires an epoch
advance to decrypt is handled by both mechanisms acting in sequence: A ensures
it is delivered to the ingest path; B ensures that when the commit that
decrypts it arrives, the parked app message is retried.

---

## Trace hook and build flag

The MLS receive pipeline emits structured trace events when built with
`NEXT_PUBLIC_E2E_TRACE_MLS=1`. This flag is build-time only — it is evaluated
at module load in `src/marmot/mls-trace.ts` and inlined by the Next.js bundler.
Production builds (where the env var is unset) compile out the entire recording
branch via dead-code elimination. The per-call overhead in production is one
empty no-op function invocation per trace site.

### Enabling the trace

Set the flag at build time when starting the Next.js dev server or running the
Playwright e2e suite:

```sh
NEXT_PUBLIC_E2E_TRACE_MLS=1 make e2e
```

The `e2e/global-setup.ts` file explicitly passes `NEXT_PUBLIC_E2E_TRACE_MLS`
through to the Next.js build environment so the bundler sees it.

### Trace window hook

When the flag is set, `MarmotProvider` installs a test hook on `window`:

```ts
window.__notestrTestMlsTrace = () => mlsTrace.dump();
```

This hook returns a snapshot of all recorded `TraceEvent` objects for the
current page context. Playwright tests can call it via:

```ts
const trace = await page.evaluate(() => window.__notestrTestMlsTrace?.() ?? []);
```

Each browser context (page) has an independent trace; two-party tests collect
one trace per context.

### TraceEvent union

The full event union is defined in `src/marmot/mls-trace.ts`. The key event
kinds for diagnosing MLS receive failures are:

| `kind` | Emitted by | Purpose |
|--------|-----------|---------|
| `req-start` / `req-eose` / `req-close` | `network.ts:request` | Historical one-shot REQ lifecycle |
| `req-event` | `network.ts:request` | Each event delivered before EOSE |
| `sub-start` / `sub-close` | `network.ts:subscription` | Persistent subscription open/close |
| `sub-event` | `device-sync.ts` subscription callback | Each live event delivered to device-sync |
| `ingest-call` | `ingestGroupEventsRaw` | Entry into ingest with event id list |
| `ingest-result` | `ingestGroupEventsRaw` | Per-event outcome: `processed` / `skipped` / `rejected` / `unreadable` |
| `queue-drain` | epoch-advance or ingest-activity trigger | Parked queue drain attempt with trigger and entry count |
| `epoch-change` | `attachRetryOnEpochAdvance` | MLS epoch advance (old → new) |
| `publish-task` | `task-store.tsx:dispatch` | Sender-side identity bridge joining `rumorId` to kind-445 `eventId` |
| `task-store-recv` | `task-store.tsx:handleApplicationMessage` | Receiver received and started processing a rumor |
| `task-store-accepted` | `task-store.tsx:handleApplicationMessage` | `setState` called with the new task |
| `task-store-rejected` | `task-store.tsx:handleApplicationMessage` | Rumor discarded (wrong kind) |
| `task-store-error` | `task-store.tsx:handleApplicationMessage` | Handler threw before `setState` |
| `task-store-load-start` / `task-store-load-complete` | `task-store.tsx` load effect | IndexedDB load lifecycle, including `restoredCount` |

### Identity bridge — `publish-task`

The `publish-task` trace event is the only place in the trace that links the
application-layer `rumorId` to the transport-layer kind-445 `eventId`:

```ts
{ kind: "publish-task", t, groupId, taskEventId, rumorId, eventId, createdAt }
```

- `rumorId` and `taskEventId` are both `rumor.id` (the application-payload
  identifier; there is no distinct `TaskEvent.id` field in this codebase).
- `eventId` is the outer kind-445 relay event id (`NostrEvent.id`).

This bridge is emitted on the **sender side** at the moment a task rumor is
delivered back to the sender's own subscription (sender-side own-replay
pattern). The lag is one relay round-trip from publish; the bridge is reliable
because `rumor.id` is stable once the rumor is sealed.

Without this event, the F-class classifier in
`e2e/fixtures/mls-trace-classify.ts` cannot determine which relay event a
failing UI assertion was waiting for.

### F-class failure modes

The trace system is designed to distinguish the four known failure modes (F1–F4)
in the MLS receive pipeline. Brief definitions for reference:

- **F1** — Fetch-then-subscribe gap. The kind-445 never arrives at the
  receiver's subscription. Closed by Solution A.
- **F2** — Welcome-epoch lag with no draining commit. The kind-445 arrives but
  `ts-mls` cannot decrypt it (wrong epoch); the parked event is never retried.
  Closed by Solution B.
- **F3** — Application message decrypted by `ts-mls` but React UI state not
  updated. Subclasses: F3a (listener not yet attached), F3b (handler threw on
  deserialization), F3c (wrong rumor kind), F3d (load-after-live overwrite).
  Out of scope for this epic; each subclass has its own follow-up spec.
- **F4** — Multi-relay EOSE-cliff in the one-shot request. First relay to send
  EOSE closes the Promise; events still in-flight from slower relays are
  dropped. Not triggered in single-relay test environments.

F1 and F2 are addressed by the pipeline changes described above. Traces for F3
subclasses use the `task-store-*` events; F4 is visible from `req-event` counts
across relays.

---

## Retry config (`playwright.config.ts`)

The e2e suite's retry count is gated on the trace flag:

```ts
retries: process.env.NEXT_PUBLIC_E2E_TRACE_MLS === "1" ? 0 : 1,
```

- **When the trace flag is set:** retries are 0. A test failure pins the trace
  to the first run without consuming it in a retry, making post-mortem
  diagnosis reliable.
- **When the trace flag is unset (normal local and CI runs):** retries are 1.
  This covers residual unrelated flake during the rollout window of Solutions A
  and B.

After Solutions A and B ship and a 50-run consecutive clean baseline is
established, retries can be dropped to 0 unconditionally. That cleanup is
tracked as a follow-up (see `BACKLOG.json`, slug
`playwright-retries-zero-after-baseline`).

---

## Relationship to related epics

- **`specs/epic-mls-live-delivery-race/`** — The pipeline ordering and retry
  contracts documented in the "MLS receive pipeline (consumer-side)" section
  above are the primary deliverable of this epic. The spec, acceptance criteria,
  and stories for Solutions A and B live there.
- **`specs/epic-task-sync-publish-contract/`** — Covers the publish-side
  contract: what the web guarantees to the relay when dispatching a task event.
  Independent of the receive-side pipeline.
- **`specs/epic-property-tests-l3-completion/`** and
  **`specs/epic-property-tests-l3-multi-device/`** — Property tests that
  exercise the MLS receive pipeline in multi-context scenarios. F1/F2 fixes
  improve their reliability; `awaitDeviceJoin` polling in the multi-device spec
  benefits from Solution A's gap closure.

---

## Task reducer semantics

The `applyEvent` function in `src/store/task-reducer.ts` implements CRDT-safe
task state. The rules below are invariants that hold across all devices and
event orderings:

### task.created — first-write-wins (FWW)

A `task.created` event is a **no-op** if the task id already exists in state.
The first observed `task.created` event for a given id is canonical; subsequent
duplicates are silently discarded. This makes task creation idempotent and
ensures that replaying the event log produces the same state regardless of how
many times creation events appear.

```
if (!state.has(event.task.id)) {
  state.set(event.task.id, event.task);
}
```

### task.updated / task.status_changed / task.assigned / task.deleted — LWW with deterministic tie-breaker

The four mutation event types use **Last-Write-Wins (LWW)** on `updatedAt`,
with a deterministic tie-breaker for equal timestamps:

```
event wins iff:
  event.updatedAt > existing.updatedAt
  || (event.updatedAt === existing.updatedAt && event.updatedBy < existing.updatedBy)
```

When two events share the same `updatedAt`, the one with the **lexicographically
lower `updatedBy` pubkey** (hex string) wins. This ensures that applying
`[eventA, eventB]` and `[eventB, eventA]` produces identical state, making
the reducer commutative and convergent under any delivery order.

Every accepted mutation event writes `updatedBy: event.updatedBy` into the
stored `Task` record so that future tie-breaking has access to the last winner's
pubkey.

### Legacy Task records

`Task` records stored before the `updatedBy` field was introduced will have
`undefined` for that field. All reducer code reads `existing.updatedBy ?? ""`
(nullish coalescing to empty string) to treat legacy records as if they were
last updated by the lowest possible pubkey value — ensuring they always lose
tie-breakers to any real pubkey and thus always accept incoming updates for
equal timestamps. No IDB migration is required.

### No task.snapshot event type

This implementation does **not** have a `task.snapshot` event type. All task
state flows through the MLS kind-445 application message pipeline using the
event types listed above.

Pre-join state bootstrapping for new members is handled by the separate
kind-30078 state sync mechanism described in the "New Member Task State Sync"
section below — this is a NIP-44 encrypted Nostr event, not an MLS application
message, and it is subject to a CRDT merge gate rather than a fan-out write.

---

## State Bootstrap

### Pre-join task visibility — accepted trade-off

A member who joins a group at epoch N **cannot decrypt** kind-445 application
messages that were published at epochs < N. This is a fundamental property of
MLS forward secrecy: keys for earlier epochs are not included in the Welcome
message. As a result, tasks created and mutated before the invite are invisible
to the new joiner; their initial board is empty.

The earlier `task.snapshot` side-channel (a kind-30078 NIP-44 event published
by the inviting device) was removed when it was found to cause CRDT divergence:
the fan-out of empty snapshots wiped task state on all connected devices.

**Current design:** The new member task state sync mechanism (kind-30078, see
below) replaces it with a CRDT-safe approach. The inviter publishes a snapshot
of non-deleted tasks immediately after the Welcome, and the new member applies
each received payload through the same FWW/LWW merge gate as the task reducer.
This makes concurrent invites from multiple members safe and prevents empty
payloads from wiping existing state.

A member who joins at epoch N will accumulate all task state from the sync
payload plus any kind-445 events published at epoch N onward. If no sync
payload is available (publish failed or inviter was offline), the new member
gracefully starts from an empty board and accumulates state as new events arrive.

### What this means for E2E tests

Tests that cover the join flow (TP-30, TP-31, TP-32) verify the absence of
pre-join tasks on B's board, not their presence. The epoch boundary is the
correct behavior: B sees an empty board immediately after joining and accumulates
state from new events as they arrive.

---

## New Member Task State Sync (kind 30078)

### Purpose

When a new member is invited via MLS Welcome, their client cannot decrypt
pre-join kind-445 task events because MLS forward secrecy does not include keys
for earlier epochs in the Welcome message. To bridge this gap, the inviter
publishes a snapshot of the current merged task state as a NIP-44 encrypted
kind-30078 event addressed to the new member's Nostr pubkey.

This mechanism replaces the earlier `task.snapshot` approach that caused CRDT
divergence. The new design applies a CRDT merge gate on the receiver side (see
below), making concurrent invites from multiple inviters safe.

### Event format

- **Kind:** 30078 (parameterized replaceable event)
- **d-tag:** `notestr:task-sync:{groupId}:{inviteePubkey}` where `groupId` is
  the MLS group ID hex (`group.idStr`) — this is distinct from the Nostr `#h`
  group ID used on kind-445 events
- **Encryption:** NIP-44 v2, sender = inviter's Nostr keypair, recipient =
  invitee's Nostr pubkey
- **Content:** NIP-44 encrypted JSON payload (see schema below)

### Payload schema (TaskStateSyncPayload v1)

```json
{
  "version": 1,
  "type": "task.state_sync",
  "groupId": "<MLS group ID hex (group.idStr)>",
  "tasks": [<Task objects — non-deleted tasks only>],
  "syncedAt": 1716000000,
  "inviterPubkey": "<inviter hex pubkey>"
}
```

`tasks` contains full `Task` objects with fields: `id`, `title`, `description`,
`status`, `assignee`, `createdBy`, `createdAt`, `updatedAt`, `updatedBy`.

All six payload fields (`version`, `type`, `groupId`, `tasks`, `syncedAt`,
`inviterPubkey`) are required. An empty `tasks` array is valid and has zero
effect on the receiver's existing state.

### Publish lifecycle (inviter)

1. **Trigger:** the inviter's client calls `publishTaskStateSync` immediately
   after `group.inviteByKeyPackageEvent(kpEvent)` succeeds.
2. **Fire-and-forget:** publish failure is non-fatal. If the relay rejects the
   event or the network is unavailable, the new member gracefully degrades to
   an empty initial state and accumulates tasks from epoch N onward via
   kind-445 events.
3. **Multiple inviters:** safe by design. If two members simultaneously invite
   the same pubkey, both publish a kind-30078 state sync event. The new member
   fetches all matching events and applies the CRDT merge gate to each one
   independently, converging to the same final state regardless of delivery
   order.

### Fetch lifecycle (new member)

**Trigger.** `task-store.tsx:load()` detects that both conditions hold:
- `events.length === 0` (IndexedDB is empty for this group)
- `isGroupJoinedFromWelcome(groupId) === true` (the member joined via a Welcome,
  not as a creator)

**Relay query.** A one-shot request is issued with the filter:

```json
{ "kinds": [30078], "#d": ["notestr:task-sync:{groupId}:{ownPubkey}"], "limit": 10 }
```

**Per-event processing.** For each event returned:

1. NIP-44 decrypt the content using `signer.nip44.decrypt` with `event.pubkey`
   as the sender.
2. Parse and validate the `TaskStateSyncPayload` (check `version === 1`,
   `type === "task.state_sync"`, presence of all six fields).
3. Apply the CRDT merge gate for each task in `payload.tasks`.

**CRDT merge gate.** Each task in the payload is merged into the local store
using the same FWW/LWW rules as the task reducer:

| Condition | Action |
|-----------|--------|
| Task not in store | Insert (first-write-wins) |
| Task in store, `payload.updatedAt > existing.updatedAt` | Accept (LWW win) |
| Task in store, `payload.updatedAt === existing.updatedAt` AND `payload.updatedBy < existing.updatedBy` | Accept (tie-breaker: lower pubkey wins) |
| Otherwise | Skip |

**Persistence.** Bootstrap tasks accepted by the merge gate are stored as
synthetic `task.created` events in IndexedDB, making them durable across page
reloads. They are indistinguishable from tasks learned via kind-445 once stored.

**Safety invariant.** An empty `tasks` array in any payload has zero effect on
existing store state. The fetch path cannot wipe tasks that are already present.
