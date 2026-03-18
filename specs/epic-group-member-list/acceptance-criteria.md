# Acceptance Criteria: Group Member List

Generated: 2026-03-18
Source: spec.md

## Criteria

### AC-001: Members section visible when group selected
- **Description**: When a group is selected in the sidebar, a "Members" section appears below the invite form showing all group members.
- **Verification**: Select a group → "Members" heading is visible in sidebar with member count.
- **Type**: e2e

### AC-002: Member count matches group roster
- **Description**: The number of members displayed matches `getGroupMembers(group.state).length`.
- **Verification**: Create a group → member list shows 1 (the creator). Invite a second user → member list shows 2.
- **Type**: e2e

### AC-003: Profile name displayed when available
- **Description**: For members with a kind:0 metadata event containing a `name` or `displayName` field, the profile name is shown.
- **Verification**: A user with a published kind:0 profile appears by name in the member list.
- **Type**: e2e

### AC-004: Abbreviated pubkey fallback
- **Description**: For members without a kind:0 profile (or without a name field), the abbreviated pubkey is shown using the same format as ConnectionStatus.
- **Verification**: A user without published metadata appears as abbreviated hex in the member list.
- **Type**: e2e

### AC-005: Members section hidden when no group selected
- **Description**: When no group is selected, the members section is not rendered.
- **Verification**: Deselect group → no "Members" heading in sidebar.
- **Type**: e2e

### AC-006: Member list updates reactively
- **Description**: After inviting a new member, the member list updates to include them without manual refresh.
- **Verification**: Invite a user → new member appears in the list.
- **Type**: e2e

## Verification Plan

E2E tests in Playwright:
1. Create a group, verify member list shows 1 member (creator)
2. Verify the creator's entry shows either profile name or abbreviated pubkey
3. Invite a second user, verify member count increases to 2
4. Verify members section is not visible when no group is selected
