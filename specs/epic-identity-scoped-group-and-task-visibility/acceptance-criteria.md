# Acceptance Criteria: Identity-Scoped Group and Task Visibility

Generated: 2026-03-19
Source: spec.md

## Overview

These criteria verify that when a user is authenticated with a Nostr identity that is not a member of a stored group, the group and its tasks are visually disabled and all interactive task actions are blocked. They also verify that switching to an identity that IS a member restores full interactivity.

## Criteria

### AC-001: detachedGroupIds computed from membership check

- **Description**: `GroupManager` (or its parent) computes a `detachedGroupIds` Set by calling `getGroupMembers(group.state)` for each group with a non-null `state` and adding the group's `idStr` when the current `pubkey` is not in the returned member list. Groups with no `state` are not marked detached.
- **Verification**: Unit test: given a mocked `groups` array containing one group whose `getGroupMembers()` does not include the current pubkey, `detachedGroupIds` contains that group's `idStr`. A second group whose members do include the pubkey is absent from the set.
- **Type**: unit
- **Source**: Spec — "Detect whether the current pubkey is a member of each loaded group"

### AC-002: Detached group list item carries opacity-50 and data-detached="true"

- **Description**: For every group in `detachedGroupIds`, the rendered `<li>` element in the sidebar group list has both the Tailwind class `opacity-50` applied (visually grayed out) and the HTML attribute `data-detached="true"`.
- **Verification**: In a Playwright E2E test: after User A creates a group and User B authenticates, the `<li>` for that group has `data-detached="true"` and a computed opacity of 0.5 (or the element's class list includes `opacity-50`).
- **Type**: e2e
- **Source**: Spec AC-1 — "opacity-50, data-detached='true' in the sidebar"

### AC-003: Clicking detached group name does not call onGroupSelect

- **Description**: When a user clicks the group name `<span>` inside a detached group list item, `onGroupSelect` is NOT called. Instead, the inline sidebar overlay is shown (or a no-op occurs with the overlay rendered). The group is not selected (selected state does not change to that group).
- **Verification**: Unit test: render `GroupManager` with one detached group; simulate click on the name span; assert `onGroupSelect` mock was not called. E2E: after User B is authenticated, clicking the group name does not cause the board to render task columns.
- **Type**: unit
- **Source**: Spec AC-2 — "Clicking a detached group's name shows an informational overlay instead of selecting it"

### AC-004: Leave button on detached group remains functional

- **Description**: The `group-leave-btn` button inside a detached group list item is not disabled. Clicking it opens the leave confirmation dialog, and confirming calls `client.leaveGroup()` and removes the group from the sidebar.
- **Verification**: E2E test: User B authenticates, clicks `[data-testid="group-leave-btn"]` on the detached group, confirms in the alert dialog, and the group disappears from the sidebar list within 15 seconds.
- **Type**: e2e
- **Source**: Spec AC-2 — "the leave button still works"

### AC-005: Board shows detached-overlay when detached group is selected

- **Description**: When `selectedGroupId` corresponds to a group in `detachedGroupIds`, `Board` renders an element with `data-testid="detached-overlay"` in place of (or covering) the interactive task columns. The overlay contains text explaining that the group belongs to a different identity.
- **Verification**: E2E test: User B authenticates while `localStorage` `lastGroup` is set to a group owned by User A; the page loads and `[data-testid="detached-overlay"]` is visible. Unit test: render `Board` with `isDetached=true`; assert `data-testid="detached-overlay"` element is present and the "Add Task" button is absent.
- **Type**: e2e
- **Source**: Spec AC-3 — "board shows a disabled overlay (data-testid='detached-overlay')"

### AC-006: Overlay message text is correct

- **Description**: The element with `data-testid="detached-overlay"` contains text matching "This group belongs to a different identity" (or the exact phrase from spec: "This group belongs to another Nostr identity. Connect with the original identity to interact with this group.").
- **Verification**: Unit test: render the overlay component; assert the text content includes the specified phrase. Playwright `toContainText` assertion on the overlay element.
- **Type**: unit
- **Source**: Spec — overlay message wording

### AC-007: Board "Add Task" button is absent when group is detached

- **Description**: When `isDetached` is true for the selected group, `Board` does not render the "Add Task" button (i.e., no element with role "button" and name "Add Task" is present in the DOM).
- **Verification**: Unit test: render `Board` with `isDetached=true`; assert no element matching `role=button, name="Add Task"` exists.
- **Type**: unit
- **Source**: Spec AC-4 — "Prevent task creation ... for detached groups"

### AC-008: TaskCard delete button absent when group is detached

- **Description**: When `isDetached` is passed as `true` to `TaskCard`, the `[data-testid="task-delete-btn"]` button is not rendered.
- **Verification**: Unit test: render `TaskCard` with `isDetached=true`; assert `data-testid="task-delete-btn"` is absent.
- **Type**: unit
- **Source**: Spec AC-4 — "Prevent ... deletion for detached groups"

### AC-009: TaskCard status change button absent when group is detached

- **Description**: When `isDetached` is `true`, `TaskCard` does not render the "Move to ..." button (the forward-status action button).
- **Verification**: Unit test: render `TaskCard` with a task in "open" status and `isDetached=true`; assert no button with label matching "Move to In Progress" is present.
- **Type**: unit
- **Source**: Spec AC-4 — "Prevent ... status changes ... for detached groups"

### AC-010: TaskCard assign/unassign buttons absent when group is detached

- **Description**: When `isDetached` is `true`, `TaskCard` does not render the "Assign to me" or "Unassign" buttons regardless of the current `currentUserPubkey` or task assignee.
- **Verification**: Unit test: render `TaskCard` with `isDetached=true` and `currentUserPubkey` set to a non-null value; assert neither "Assign to me" nor "Unassign" buttons are present.
- **Type**: unit
- **Source**: Spec AC-4 — "Prevent ... assignment ... for detached groups"

### AC-011: Board dispatch is not called for task actions when detached

- **Description**: When `isDetached` is `true`, the `Board`'s `handleCreate`, `handleStatusChange`, `handleDelete`, and `handleAssign` functions are never invoked (or if the buttons are absent the dispatch path is unreachable). No call to `useTaskStore().dispatch` is made for a detached group's board.
- **Verification**: Integration test: render `Board` inside a `TaskStoreProvider` with `isDetached=true`; confirm `dispatch` is never called. (This is guaranteed if AC-007 through AC-010 pass and the buttons are absent, but verify independently.)
- **Type**: integration
- **Source**: Spec AC-4 — "Prevent task creation, status changes, assignment, and deletion"

### AC-012: Invite form hidden for detached selected group

- **Description**: When the selected group is detached, the invite form (the "Invite Member" section containing the `npub1...` input and the Invite button) is not rendered in the sidebar panel.
- **Verification**: Unit test: render `GroupManager` with the selected group being detached; assert no input with placeholder "npub1..." and no button "Invite" are present. E2E: select a detached group; assert the invite section is not visible.
- **Type**: unit
- **Source**: Spec AC-7 — "hide the invite form"

### AC-013: Member list visible for detached selected group

- **Description**: When the selected group is detached, the `[data-testid="members-section"]` element remains rendered and lists the group's members (read-only).
- **Verification**: Unit test: render `GroupManager` with the selected group being detached and non-empty members; assert `data-testid="members-section"` is present and `data-testid="member-item"` elements are visible.
- **Type**: unit
- **Source**: Spec AC-7 — "keep the member list visible (read-only)"

### AC-014: Switching to member identity restores interactivity

- **Description**: After User B authenticates (where User B is a member of a group created by User A), clicking the group name calls `onGroupSelect`, the board renders task columns (no detached-overlay), and "Add Task" button is visible.
- **Verification**: E2E test: User A creates a group and invites User B; User A disconnects; User B authenticates; the group list item does NOT have `data-detached="true"`; clicking the group name shows the board with `data-column="open"` visible and no `[data-testid="detached-overlay"]`.
- **Type**: e2e
- **Source**: Spec AC-5 — "When the user switches to an identity that IS a member, the group becomes fully interactive again"

### AC-015: No IndexedDB schema or persistence changes

- **Description**: The `notestr-group-state`, `notestr-key-packages`, and all other IndexedDB stores retain exactly their current key/value structure. No new stores are created, no existing keys are modified. The `lastGroup` localStorage key schema is unchanged.
- **Verification**: Manual review of the implementation diff: no changes to `src/marmot/storage.ts`, `src/store/persistence.ts`, or IndexedDB store definitions. The `clearAppState` E2E helper continues to work without modification.
- **Type**: manual
- **Source**: Spec AC-6 and Out of Scope — "No changes to data persistence"

---

## E2E Test Plan

### Infrastructure Requirements

- **Docker Compose**: `docker-compose.e2e.yml` — strfry relay with tmpfs volume at `ws://localhost:7777`
- **Playwright**: browser automation against `http://localhost:3100` (static export)
- **Bunker A**: `e2e/fixtures/bunker.mjs` (default keypair, User A pubkey `3e0057f0...`)
- **Bunker B**: `e2e/fixtures/bunker.mjs` with `BUNKER_PRIVATE_KEY=3ad635dc...`, label `bunker-B` (User B pubkey `d2f8e20d...`) — already spawned in `global-setup.ts`
- **Auth helpers**: `e2e/fixtures/auth-helper.ts` (User A), `e2e/fixtures/auth-helper-b.ts` (User B)
- **Cleanup**: `e2e/fixtures/cleanup.ts` `clearAppState()` in `beforeEach`

### E2E Scenarios

| Scenario | User Steps (Browser) | Expected Outcome | ACs Validated |
|----------|---------------------|------------------|---------------|
| detached-sidebar-styling | 1. Authenticate as User A, create group "Alpha". 2. Disconnect (click disconnect button). 3. Reload page, authenticate as User B. 4. Inspect group list. | `<li>` for "Alpha" has `data-detached="true"` and class `opacity-50`. Board does not show task columns. | AC-002, AC-003 |
| detached-leave-works | 1. Authenticate as User B (group "Alpha" from prior state). 2. Click `[data-testid="group-leave-btn"]` on "Alpha". 3. Confirm in the alert dialog. | "Alpha" disappears from sidebar. | AC-004 |
| detached-board-overlay | 1. Authenticate as User A, create group "Beta", reload page (to persist `lastGroup`). 2. Disconnect. 3. Authenticate as User B. | `[data-testid="detached-overlay"]` is visible. "Add Task" button is absent. | AC-005, AC-006, AC-007 |
| identity-switch-restores | 1. Authenticate as User A, create group "Gamma", invite User B (paste `USER_B_NPUB`). 2. Wait for invite to complete. 3. Disconnect. 4. Authenticate as User B. 5. Click group "Gamma" in sidebar. | `<li>` for "Gamma" does NOT have `data-detached="true"`. Board shows `[data-column="open"]`. No `[data-testid="detached-overlay"]` present. | AC-014 |

### Test Flow Per Scenario

#### detached-sidebar-styling

1. **Docker Compose setup**: `docker-compose.e2e.yml` (relay at ws://localhost:7777)
2. **Preconditions**: `clearAppState()`, Bunker A and Bunker B both running
3. **User steps**:
   - `authenticateViaBunker(page)` (User A)
   - Create group "Alpha" via sidebar form
   - Wait for "Alpha" to appear in sidebar
   - Click `[data-testid="disconnect-button"]`
   - Wait for connect screen
   - `authenticateAsBunkerB(page)` (User B)
4. **Assertions**:
   - `expect(page.locator('[data-detached="true"]').first()).toBeVisible()`
   - `expect(page.locator('[data-detached="true"]').first()).toHaveClass(/opacity-50/)`
   - `expect(page.locator('[data-testid="detached-overlay"]')).not.toBeVisible()` (not auto-selected)
5. **Teardown**: `clearAppState()` handled by `beforeEach` of next test

#### detached-board-overlay

1. **Docker Compose setup**: relay running
2. **Preconditions**: `clearAppState()`, Bunker A running
3. **User steps**:
   - `authenticateViaBunker(page)` (User A)
   - Create group "Beta"
   - Click on "Beta" in sidebar to select it (stores `lastGroup`)
   - Click disconnect
   - `authenticateAsBunkerB(page)` (User B)
4. **Assertions**:
   - `expect(page.locator('[data-testid="detached-overlay"]')).toBeVisible()`
   - `expect(page.locator('button', { hasText: 'Add Task' })).not.toBeVisible()`
   - `expect(page.locator('[data-testid="detached-overlay"]')).toContainText("different identity")`
5. **Teardown**: `clearAppState()`

#### identity-switch-restores

1. **Docker Compose setup**: relay running
2. **Preconditions**: `clearAppState()`, Bunker A and Bunker B running
3. **User steps**:
   - `authenticateViaBunker(page)` (User A)
   - Create group "Gamma"
   - Invite User B via invite form (paste `USER_B_NPUB` from `auth-helper-b.ts`)
   - Wait for invite to succeed (no error shown)
   - Click disconnect
   - `authenticateAsBunkerB(page)` (User B) — may need to wait for welcome message processing
4. **Assertions**:
   - `expect(page.locator('[data-detached="true"]')).not.toBeVisible()` (Gamma is not detached)
   - Click on "Gamma" group name
   - `expect(page.locator('[data-column="open"]').first()).toBeVisible()`
   - `expect(page.locator('[data-testid="detached-overlay"]')).not.toBeVisible()`
5. **Teardown**: `clearAppState()`

### E2E Coverage Rule

All ACs of type `e2e` are covered:
- AC-002: detached-sidebar-styling
- AC-003: detached-sidebar-styling (board columns absent on click)
- AC-004: detached-leave-works
- AC-005: detached-board-overlay
- AC-006: detached-board-overlay (text assertion)
- AC-007: detached-board-overlay (Add Task absent)
- AC-014: identity-switch-restores

---

## Verification Plan

### Automated Tests

- **Unit tests**: AC-001, AC-003, AC-006, AC-007, AC-008, AC-009, AC-010, AC-011, AC-012, AC-013
- **Integration tests**: AC-011
- **E2E tests**: AC-002, AC-003, AC-004, AC-005, AC-006, AC-007, AC-014

### Manual Verification

- **AC-015**: Code review of implementation diff — confirm no changes to `src/marmot/storage.ts`, `src/store/persistence.ts`, or IndexedDB store definitions

---

## Coverage Matrix

| Spec Requirement | Acceptance Criteria |
|------------------|---------------------|
| Detect membership via getGroupMembers(); compute isDetached per group | AC-001 |
| Sidebar: opacity-50, data-detached="true" on detached items | AC-002 |
| Clicking detached group name shows overlay instead of selecting | AC-003 |
| Leave button stays functional on detached groups | AC-004 |
| Auto-selected detached group shows board overlay (data-testid="detached-overlay") | AC-005, AC-006 |
| Overlay message text | AC-006 |
| Prevent task creation for detached groups | AC-007, AC-011 |
| Prevent task status changes for detached groups | AC-009, AC-011 |
| Prevent task assignment for detached groups | AC-010, AC-011 |
| Prevent task deletion for detached groups | AC-008, AC-011 |
| Switching to member identity restores interactivity | AC-014 |
| No changes to data persistence or storage structure | AC-015 |
| Hide invite form for detached selected group | AC-012 |
| Member list visible (read-only) for detached selected group | AC-013 |
