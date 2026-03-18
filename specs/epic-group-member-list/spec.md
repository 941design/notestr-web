# Group Member List in Sidebar

## Summary

Display the list of all members for the currently selected group in a "Members" section in the sidebar. Show each member's Nostr profile name (from kind:0 metadata) when available, otherwise show the abbreviated pubkey in the same format used by ConnectionStatus.

## Context

The sidebar (GroupManager component) currently shows groups, a create-group form, and an invite-member form. There is no visibility into who is in a group. Users need to see the current group roster.

## Requirements

1. **Members section**: When a group is selected, show a "Members" section in the sidebar below the invite form.
2. **Member data source**: Use `getGroupMembers(group.state)` from `@internet-privacy/marmot-ts` to get the hex pubkeys of all group members.
3. **Profile name resolution**: For each member pubkey, fetch the Nostr kind:0 metadata event from the configured relays. Parse the `name` or `displayName` field from the event content JSON.
4. **Fallback display**: If no profile name is available (fetch failed, no kind:0 event, or no name field), show the abbreviated pubkey using `shortenPubkey()` — the same format currently used in ConnectionStatus.
5. **Visual style**: Match existing sidebar styling. Use a compact list with small text. Show a section header ("Members") with a count badge.
6. **Reactivity**: The member list should update when group state changes (e.g., after inviting a new member).
7. **Performance**: Profile lookups should not block the member list from rendering. Show abbreviated pubkeys immediately, then swap in profile names as they resolve. Cache profile results for the session.

## Non-goals

- Clicking on a member (no action needed)
- Showing member avatars/images
- Showing online/offline status
- Removing members from the list UI

## Technical Notes

- `getGroupMembers(state: ClientState): string[]` returns hex pubkeys
- `client.network.request(relays, [{ kinds: [0], authors: [hex], limit: 1 }])` fetches profiles
- Kind:0 event content is JSON with optional `name`, `displayName` fields
- `shortenPubkey(hex)` returns `hex.slice(0, 8) + "..." + hex.slice(-4)`
