# Epic Architecture: auto-invite-freshness

## Paradigm

Targeted patch to a single closure function inside `useDeviceSync` hook.  
No new modules, no new abstractions, no interface changes.

## Module Map

| Module | Purpose | Location |
|--------|---------|----------|
| `device-sync.ts` | Multi-device sync hook — KP subscription, auto-invite, welcome-join | `src/marmot/device-sync.ts` |
| `device-sync.test.ts` | Unit tests for exported pure helpers | `src/marmot/device-sync.test.ts` |
| `sibling-auto-invite-rotation-race.spec.ts` | New e2e regression test | `e2e/tests/` |

The fix is entirely within `runKeyPackageSync` → `syncKnownKeyPackages` (inner closure, not exported).  
The new test is a new file in `e2e/tests/`.

## Boundary Rules

- No direct imports across module boundaries.
- `syncKnownKeyPackages` is a closure-scoped inner function; it must not be extracted or exported.
- Any slot-collapsing logic must operate on the existing `knownEvents` Map before the `inviteToAllGroups` loop — do not touch `inviteToAllGroups` internals.
- E2E test must use `authenticate()` from `e2e/fixtures/two-party.ts`, not an inline auth function. Slot parameter is mandatory when two contexts share a bunker URL.

## Seams

None — single-story fix with no cross-story dependencies.

## Implementation Constraints

1. **Freshness collapse in `syncKnownKeyPackages`**: Build a `Map<slot, NostrEvent>` from `knownEvents.values()` keeping only the event with the highest `created_at` per slot, then iterate that collapsed map. Mirrors `GroupManager.tsx:165-170`.

2. **Slot key**: `getKeyPackageIdentifier(event) ?? event.id` — same fallback used by `inviteToAllGroups`'s dedup key (line 1223). Kind-443 events with no `d` tag keep their event.id as the grouping key.

3. **Comment required**: The collapse block must include a comment explaining the rotation-race root cause and the marmot-ts grace-window relationship (per AC-4 in the spec).

4. **No write-time refactor**: Do NOT change `knownEvents` from `Map<eventId, NostrEvent>` to `Map<slot, NostrEvent>` — that is listed in the spec as the riskier variant. The read-time collapse is the minimum-blast-radius fix.

5. **E2E test slot discipline**: Must call `authenticate(page1, E2E_BUNKER_URL, 'sibling-fresh-1')` and `authenticate(page2, E2E_BUNKER_URL, 'sibling-fresh-2')` (or any pair of distinct slot strings). Do not use the spec draft's inline `signInSameBunker()` which omits the slot.

6. **No retry in the test**: The test's `expect(page2.locator('aside').getByText('Group B')).toBeVisible({ timeout: 60_000 })` assertion is sufficient — no need for IDB introspection (though the spec draft includes it as belt-and-braces; it is optional).
