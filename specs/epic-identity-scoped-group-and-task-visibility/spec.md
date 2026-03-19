# Identity-Scoped Group and Task Visibility

## Problem

Groups and tasks are stored globally in IndexedDB without association to a specific Nostr identity. When a user logs in with a different keypair, they can see groups and tasks from the previous identity's session. These groups are "detached" — the new identity is not a member, cannot decrypt MLS messages, and cannot interact meaningfully with the data.

## Solution

Visually indicate when groups and tasks belong to a different identity by:

1. **Disabling** group sidebar items and board components for groups the current pubkey is not a member of
2. **Showing an overlay** when the user attempts to interact with a disabled/detached element, explaining the data belongs to a different identity

## Scope

### In Scope

- Detect whether the current pubkey is a member of each loaded group (using `getGroupMembers()`)
- Mark groups as "detached" when current pubkey is not in the member list
- Visually disable detached group items in the sidebar (grayed out, reduced opacity)
- The "Leave group" button remains functional on detached groups (for cleanup of orphaned data)
- Clicking a detached group's name shows an inline overlay instead of selecting it
- When a detached group is auto-selected (e.g. via `lastGroup` restore), show a disabled board with an inline overlay instead of interactive task columns
- The overlay explains: "This group belongs to a different identity. Switch to the original identity to interact with it."
- Prevent task creation, status changes, assignment, and deletion for detached groups
- When a detached group is selected, hide the invite form but keep the member list visible (read-only)
- Add `data-detached="true"` attribute on detached group list items for E2E testability
- Add `data-testid="detached-overlay"` on the board overlay

### Out of Scope

- Migrating or separating IndexedDB storage per identity (future work)
- Deleting or cleaning up other identities' data (except leave-group for cleanup)
- Multi-identity switching UI
- Changing how groups or tasks are persisted

## Design Decisions

These were clarified during spec review:

1. **Sidebar interaction**: Clicking a detached group's name shows the overlay. The "Leave group" button stays functional — it's cleanup, not a group task action.
2. **Sidebar panel for detached groups**: Hide the invite form (can't invite from wrong identity). Member list stays visible as read-only info.
3. **Overlay type**: Non-blocking inline overlay covering only the board/task area. Sidebar remains interactive so the user can switch groups or leave detached ones.
4. **AC-5 testing**: Add a second keypair to E2E fixtures and write a multi-identity E2E test to verify identity switching restores interactivity.

## Technical Approach

### Membership Check

Use the existing `getGroupMembers(group.state)` function (already used in GroupManager.tsx) to get the list of member pubkeys for each group. Compare against the current `pubkey` from the auth state. The existing `groupHasMember()` helper in `device-sync.ts` provides the boolean check pattern.

`getGroupMembers(group.state)` reads in-memory MLS state and is synchronous — safe to call for all groups.

### State Model

Compute `isDetached` per group, ideally in a `useMemo` derived from `groups` and `pubkey`:

```typescript
const detachedGroupIds = useMemo(() => {
  const set = new Set<string>();
  for (const group of groups) {
    if (!group.state) continue;
    const members = getGroupMembers(group.state);
    if (!members.includes(pubkey)) {
      set.add(group.idStr);
    }
  }
  return set;
}, [groups, pubkey]);
```

### Visual Treatment

- **Sidebar (GroupManager.tsx)**: Detached groups render with `opacity-50`, `data-detached="true"`. The group name click handler shows the overlay instead of selecting. The leave button remains functional.
- **Board (Board.tsx)**: If the selected group is detached, render an inline overlay over the board area with the informational message. The overlay covers task columns but the sidebar remains usable.
- **TaskCard (TaskCard.tsx)**: When the parent group is detached, all interactive elements (buttons, status changes) are hidden or disabled.
- **Invite form**: Hidden when the selected group is detached. Member list remains visible.

### Overlay Component

A non-blocking inline overlay covering the board area:

```
┌─────────────────────────────────────────┐
│                                         │
│    This group belongs to another        │
│    Nostr identity. Connect with the     │
│    original identity to interact        │
│    with this group.                     │
│                                         │
└─────────────────────────────────────────┘
```

Uses `data-testid="detached-overlay"` for E2E targeting. Positioned over the board content area using relative/absolute positioning or a conditional render that replaces the board columns.

## Acceptance Criteria

1. When logged in, groups where the current pubkey is NOT a member appear visually disabled (`opacity-50`, `data-detached="true"`) in the sidebar
2. Clicking a detached group's name in the sidebar shows an informational overlay instead of selecting it; the leave button still works
3. If a detached group is auto-selected (e.g. from localStorage `lastGroup`), the board shows a disabled overlay (`data-testid="detached-overlay"`) instead of interactive columns
4. Task creation, status changes, assignment, and deletion are prevented for detached groups
5. When the user switches to an identity that IS a member, the group becomes fully interactive again (verified via E2E with second keypair)
6. No changes to data persistence or storage structure
7. When a detached group is selected, the invite form is hidden but the member list remains visible
