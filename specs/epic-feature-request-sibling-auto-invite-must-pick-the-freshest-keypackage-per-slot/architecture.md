# Architecture: Sibling Auto-Invite KP Freshness Fix

**Paradigm:** Modular monolith at top level; package-by-feature for modules; hook-based React integration.

## Module Map

| Module | Purpose | Location | Owned Data |
|--------|---------|----------|------------|
| `device-sync` | Sibling auto-invite + group ingest lifecycle | `src/marmot/device-sync.ts` | `knownEvents`, `invited`, `pendingInvites`, `forgottenSlots` (closure-scoped per mount) |
| `GroupManager` | Manual group invite UI | `src/components/GroupManager.tsx` | None (calls network + marmot-ts directly) |
| `device-store` | IDB persistence for invited keys | `src/marmot/device-store.ts` | `notestr-invited-keys` IDB store |
| `forgotten-slots` | IDB persistence for forgotten device slots | `src/marmot/forgotten-slots.ts` | `notestr-forgotten-slots` IDB store |

## Boundary Rules

No direct imports across module boundaries. Cross-module access only through declared seam contracts.

- `device-sync.ts` reads `device-store.ts` through `loadInvitedKeys` / `persistInvitedKey`.
- `device-sync.ts` reads `forgotten-slots.ts` through `loadForgottenSlots`.
- `device-sync.ts` imports `getKeyPackageIdentifier`, `getKeyPackageNostrPubkey` from `@internet-privacy/marmot-ts`.

## Seams

None — this is a single-story fix with no cross-story dependencies.

## Implementation Constraints

1. **The fix is already implemented** — `syncKnownKeyPackages` at `device-sync.ts:1252-1281` already has the `latestBySlot` collapse. This epic exists to document and verify the implementation.
2. **`knownEvents` is keyed by event id** — multiple events for the same `d`-tag slot coexist. The collapse is read-time; the Map structure is unchanged.
3. **Dedup key is slot-based** — `${group.idStr}:${slot}` in `inviteToAllGroups` (line 1223) ensures a slot rotation doesn't re-invite a known device.
4. **`handleKeyPackageEvent` live path** — invites directly with the incoming event; does not re-call `syncKnownKeyPackages`. On next `"groups.updated"` event, `syncKnownKeyPackages` will have the new event in `knownEvents` and the collapse will pick the freshest naturally.
5. **e2e test is committed** — `e2e/tests/sibling-auto-invite-rotation-race.spec.ts` exists in commit `9ddf32e`, covering the two-group sibling scenario from the spec.
