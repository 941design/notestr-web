# Feature request: sibling auto-invite must pick the freshest KeyPackage per slot

**Repository:** `941design/notestr-web`
**Affected file:** `src/marmot/device-sync.ts`
**Verified against:** `master` HEAD (commit `efd2b08`, "MLS Leaf Identity UX")
**Reporter:** triage from interactive debug session, 2026-05-19
**Severity:** Latent correctness bug — silently fails sibling joins on the
**second** group (and every subsequent group) an admin creates after a
sibling device first joins, in the multi-device sync scenario.
**Type:** Bug fix
**Companion:** `docs/feature-requests/marmot-ts-welcome-grace-window.md` —
this fix on its own narrows the window; the marmot-ts fix closes it.

---

## 1. Summary

Sibling auto-invite iterates a long-lived `Map<eventId, NostrEvent>` of
observed KeyPackage events **in insertion order**, with deduplication
keyed by `${groupId}:${slot}`. After a sibling rotates a KP, the
admin's cache retains **both** the old and the new KP event for the same
slot. Insertion order favors the **older** event, slot dedup blocks the
newer event from ever being attempted, and the auto-invite sends a
Welcome built from a stale KeyPackage. The invitee — having rotated — can
no longer decrypt that Welcome locally (its private init_key has been
deprecated by marmot-ts's `rotate()`).

The manual invite path at `src/components/GroupManager.tsx:166-170` does
**not** have this bug — it explicitly sorts by `created_at` DESC and
picks the freshest event. The auto-invite path must do the same.

---

## 2. Background — sibling auto-invite

Documented in `README.md:7` and implemented in
`src/marmot/device-sync.ts`. When two clients sign in to the same Nostr
identity (same bunker pubkey), each publishes its own MLS KeyPackage. The
auto-invite scan adds every other-device KeyPackage as a leaf in every
group this device admins, so all of the user's devices can decrypt and
contribute to all of the user's groups without manual coordination. See
the commit message `84df1f2` ("feat: add multi-device sync support") for
the design rationale.

The rotation discipline is in `src/marmot/client.tsx:314-322` — after
**every** successful join, all `used` KPs are rotated:

```ts
client.groups.on("joined", async () => {
  const packages = await client.keyPackages.list();
  for (const pkg of packages.filter((p) => p.used)) {
    await client.keyPackages.rotate(pkg.keyPackageRef, { relays });
  }
});
```

This is what makes the bug deterministic in the multi-device flow: every
sibling join produces a rotation, which produces a stale entry in the
admin's `knownEvents` cache.

---

## 3. Code references — current (buggy) behavior

`src/marmot/device-sync.ts:1115` — the cache is a `Map` keyed by event id:

```ts
const knownEvents = new Map<string, NostrEvent>();
```

`src/marmot/device-sync.ts:1243-1258` — `syncKnownKeyPackages` iterates the
map in insertion order:

```ts
const syncKnownKeyPackages = async () => {
  if (joinBarrier) await joinBarrier;
  const local = await getLocalKnownIds();
  for (const event of knownEvents.values()) {       // ← Map iter = insertion order
    if (!mountedRef.current) return;
    if (isLocalDevice(event, local)) continue;
    if (getKeyPackageNostrPubkey(event) !== pubkey) continue;
    if (isSlotForgotten(event, forgottenSlots)) continue;
    await inviteToAllGroups(event);
  }
};
```

`src/marmot/device-sync.ts:1191-1241` — `inviteToAllGroups` does slot-keyed
dedup:

```ts
const inviteToAllGroups = async (kpEvent: NostrEvent) => {
  const inviteeSlot = getKeyPackageIdentifier(kpEvent);
  const inviteePubkey = getKeyPackageNostrPubkey(kpEvent);
  // …
  for (const group of client.groups.loaded) {
    // …
    const dedupKey = `${group.idStr}:${inviteeSlot ?? kpEvent.id}`;
    if (invited.has(dedupKey) || pendingInvites.has(dedupKey)) continue;
    pendingInvites.add(dedupKey);
    try {
      await group.inviteByKeyPackageEvent(kpEvent);   // ← uses kpEvent, not "freshest event for this slot"
      invited.add(dedupKey);
      await persistInvitedKey(dedupKey);
    } catch (err) { /* … */ }
  }
};
```

`src/marmot/device-sync.ts:1261-1275` — `handleKeyPackageEvent` adds every
incoming event to `knownEvents`, regardless of whether a previous event
for the same slot was already received:

```ts
const handleKeyPackageEvent = async (event: NostrEvent) => {
  knownEvents.set(event.id, event);   // ← keyed by event.id, so old + new coexist
  // …
};
```

For comparison — the **correct** logic in the manual invite path at
`src/components/GroupManager.tsx:166-170`:

```ts
// Prefer the most recently published key package.
const freshestKeyPackage = keyPackageEvents
  .slice()
  .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
await group.inviteByKeyPackageEvent(freshestKeyPackage);
```

---

## 4. Reproduction

### Hand reproduction (10 minutes)

1. Sign in to notestr-web with bunker URL `bunker://X?relay=…` in
   **Browser 1**.
2. Sign in to notestr-web with the **same** bunker URL in **Browser 2**.
3. In Browser 1: create **Group A** (e.g. via the sidebar). Wait for
   the sibling auto-invite to complete — observable as Browser 2
   eventually showing Group A in its sidebar.
4. In Browser 1: create **Group B** (a *second* group, right after
   Group A).
5. Open Browser 2 → Settings → **Pending Invitations** panel. **Expect**:
   empty. **Actual**: a `FailedWelcomeRecord` with `failureReason:
   "no_matching_kp"` for Group B.

### E2E reproduction (Playwright)

A failing test capturing the bug:

```ts
// e2e/tests/sibling-auto-invite-rotation-race.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { E2E_BUNKER_URL } from '../fixtures/auth-helper.js';
import { clearAppState } from '../fixtures/cleanup.js';

async function signInSameBunker(page: Page) {
  await page.goto('/');
  await clearAppState(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /bunker:\/\/ URL/i }).click();
  await page.getByPlaceholder('bunker://...').fill(E2E_BUNKER_URL);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('[data-testid="pubkey-chip"]').waitFor({ state: 'visible', timeout: 30000 });
}

test('sibling auto-invite uses freshest KP for second group', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  try {
    // Both browsers use the same bunker → same Nostr pubkey, sibling devices.
    await signInSameBunker(page1);
    await signInSameBunker(page2);

    // page2 publishes its KP — page1 will auto-invite it.
    await page2.waitForTimeout(3000);

    // page1 creates Group A. Sibling auto-invite fires.
    await page1.getByPlaceholder('Group name').first().fill('Group A');
    await page1.getByRole('button', { name: 'Create', exact: true }).first().click();
    await expect(page2.locator('aside').getByText('Group A'))
      .toBeVisible({ timeout: 60_000 });

    // page2 joining Group A rotates its KP (via the `on("joined")` handler).
    // Now page1's knownEvents has both the old and new KP for page2's slot.

    // page1 creates Group B. Auto-invite should pick the *newer* KP.
    await page1.getByPlaceholder('Group name').first().fill('Group B');
    await page1.getByRole('button', { name: 'Create', exact: true }).first().click();
    await expect(page2.locator('aside').getByText('Group B'))
      .toBeVisible({ timeout: 60_000 });

    // No FailedWelcomeRecord must appear in Pending Invitations.
    const failedCount = await page2.evaluate(async () => {
      const dbs = await indexedDB.databases();
      const has = dbs.some((d) => d.name === 'notestr-failed-welcomes');
      if (!has) return 0;
      return new Promise<number>((resolve) => {
        const req = indexedDB.open('notestr-failed-welcomes');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(db.objectStoreNames, 'readonly');
          const store = tx.objectStore(db.objectStoreNames[0]);
          const count = store.count();
          count.onsuccess = () => resolve(count.result);
        };
      });
    });
    expect(failedCount).toBe(0);
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
```

This test uses the **same** bunker URL twice (the existing fixtures use
different bunker keys for User A / B / C; sibling auto-invite requires
same-pubkey, so a new shared-bunker fixture or in-test reuse is needed).

---

## 5. Failure mechanism — step by step

1. **Browser 1** subscribes to `keyPackageFilters([pubkey])` on
   relays. `knownEvents` populates with **Browser 2**'s KP-B1
   (event id `e1`).
2. **Browser 1** creates **Group A**. `groups.on("updated")` fires
   `syncKnownKeyPackages`. Iteration finds KP-B1; sends Welcome
   targeting KP-B1's `keyPackageRef`. `invited.add("groupA:slotB")`.
3. **Browser 2** receives the gift-wrapped Welcome, decrypts it
   against KP-B1's private init_key (still active locally), joins
   Group A.
4. **Browser 2**'s `client.groups.on("joined")` handler runs. KP-B1 is
   marked `used` → rotated. `marmot-ts` `rotate()` calls
   `markDeprecated(KP-B1.ref, now)` locally and publishes KP-B2 at
   the same `d` slot (replacing the addressable kind-30443 event on
   relays).
5. **Browser 1**'s subscription delivers KP-B2 (event id `e2`).
   `handleKeyPackageEvent` calls `knownEvents.set("e2", KP-B2)`. The
   cache now contains BOTH KP-B1 (under `"e1"`) and KP-B2 (under
   `"e2"`).
6. **Browser 1** creates **Group B**. `groups.on("updated")` fires
   `syncKnownKeyPackages`. Map iteration order = insertion order →
   KP-B1 is iterated first. Dedup key `"groupB:slotB"` is not in
   `invited` (different group). `inviteToAllGroups(KP-B1)` runs;
   sends Welcome targeting **KP-B1**. `invited.add("groupB:slotB")`.
   Then KP-B2 is iterated; dedup hit; **skip**.
7. **Browser 2** receives the Welcome for Group B. Tries to decrypt
   via `joinGroupFromWelcome`. The marmot-ts code path (see
   companion spec) enumerates `keyPackages.list()` which **excludes
   deprecated** entries → KP-B1 is invisible → throws
   `"No matching KeyPackage found in local store"`.
8. notestr-web's `joinFromWelcomeInvite`
   (`src/marmot/device-sync.ts:411-468`) catches the throw, classifies
   it as `failureReason: "no_matching_kp"`, and writes a
   `FailedWelcomeRecord` to `notestr-failed-welcomes`. The user sees
   Group B *not appear* in Browser 2's sidebar and (eventually,
   if they look) a Pending Invitations panel entry.

---

## 6. Proposed fix

Collapse `knownEvents` to **one event per slot, latest by
`created_at`**, before iterating in `syncKnownKeyPackages`. Mirrors the
manual invite policy at `GroupManager.tsx:166-170`.

```diff
--- a/src/marmot/device-sync.ts
+++ b/src/marmot/device-sync.ts
@@
       const syncKnownKeyPackages = async () => {
         if (joinBarrier) await joinBarrier;
         const local = await getLocalKnownIds();
-        for (const event of knownEvents.values()) {
+        // Collapse to one event per slot, preferring the freshest. The
+        // raw `knownEvents` Map keys by event id, so rotated-away events
+        // for the same `d` slot coexist with their replacements. Slot-keyed
+        // dedup in inviteToAllGroups picks whichever event we iterate
+        // first — Map iteration is insertion order, so the OLDEST wins
+        // without this collapse, and the resulting Welcome targets a KP
+        // the invitee has since rotated and (per marmot-ts list() semantics)
+        // can no longer enumerate during decrypt.
+        //
+        // Mirrors the freshness sort at GroupManager.tsx:166-170 (manual
+        // invite path).
+        const latestBySlot = new Map<string, NostrEvent>();
+        for (const event of knownEvents.values()) {
+          const slot = getKeyPackageIdentifier(event) ?? event.id;
+          const prev = latestBySlot.get(slot);
+          if (!prev || (event.created_at ?? 0) > (prev.created_at ?? 0)) {
+            latestBySlot.set(slot, event);
+          }
+        }
+        for (const event of latestBySlot.values()) {
           if (!mountedRef.current) return;
           if (isLocalDevice(event, local)) continue;
           if (getKeyPackageNostrPubkey(event) !== pubkey) continue;
           if (isSlotForgotten(event, forgottenSlots)) continue;
           await inviteToAllGroups(event);
         }
       };
```

### Variant: collapse at write time

Alternative: change `knownEvents` from `Map<eventId, NostrEvent>` to
`Map<slot, NostrEvent>` and overwrite-with-newer in
`handleKeyPackageEvent`. This is cleaner but changes a load-bearing
data structure used by multiple call sites — riskier diff. The
read-time collapse above is the minimum-blast-radius fix.

### Belt-and-braces: also handle the live event path

`handleKeyPackageEvent` (`device-sync.ts:1261-1275`) calls
`inviteToAllGroups(event)` directly on every incoming event, with no
freshness comparison against `knownEvents`. If a stale KP-B1 arrives
in the same subscription burst as KP-B2 but in the wrong order (relay
sort isn't strict per-spec), the older one could still slip through.
Defensive variant:

```ts
const handleKeyPackageEvent = async (event: NostrEvent) => {
  const slot = getKeyPackageIdentifier(event) ?? event.id;
  const prev = knownEvents.get(/* …find existing for slot… */);
  if (prev && (prev.created_at ?? 0) >= (event.created_at ?? 0)) {
    // older or equal event — ignore for invite purposes.
    knownEvents.set(event.id, event);
    return;
  }
  knownEvents.set(event.id, event);
  // …rest unchanged…
};
```

In practice the relay sort is reliable enough that the read-time
collapse alone is sufficient. We recommend landing the read-time fix
first and adding the write-time guard only if telemetry shows
ordering issues.

---

## 7. Test plan

1. **New e2e test** as in §4 (`sibling-auto-invite-rotation-race.spec.ts`).
   Must fail on `master` HEAD and pass after the fix.
2. **Update existing test**:
   `e2e/tests/forget-device-sibling.spec.ts` already exercises sibling
   devices; confirm no regression in forget-sibling flow under the
   collapsed iteration order.
3. **Manual smoke**: hand reproduction from §4 must produce an empty
   Pending Invitations panel after the fix.
4. **Property test (optional but strong)**: add a property in
   `src/store/multi-client.property.test.ts` or a new sibling that
   randomly orders sibling KP arrivals + rotations and asserts every
   auto-invite uses the latest `created_at` event per slot.

---

## 8. Backward compatibility

- **No protocol-level change.** Only changes which already-published
  KeyPackage event the inviter selects when there are multiple cached
  for the same slot.
- **No IDB schema change.**
- **Forgotten-slots semantics unchanged.** The slot-forgotten filter
  still runs on whichever event we end up iterating.
- **No new dependencies.**

---

## 9. Relation to the marmot-ts spec

This fix and the marmot-ts grace-window fix are **complementary, not
duplicative**:

| Layer | What it does | What it doesn't cover |
|-------|--------------|------------------------|
| **notestr-web (this spec)** | Always invites with the freshest cached KP per slot. | Doesn't help when the relay itself serves stale events to the inviter, or when an admin's app is restarted between rotations and only re-fetches the latest. (Both rare; both still covered by failed-welcomes log.) |
| **marmot-ts (companion spec)** | Lets the invitee decrypt Welcomes that target deprecated KPs within the 24h grace window. | Doesn't fix consumers that send Welcomes targeting KPs that are already rotated and **outside** the grace window. |

Together they close the rotation-race silently-dropped-Welcome failure mode
that the `notestr-failed-welcomes` IDB log + Pending Invitations panel
currently exists to surface as recovery UX.

### 9.1 Upstream status (as of 2026-05-19)

A source-level sweep of both marmot-ts forks confirms:

- `941design/marmot-ts#addressable-key-packages` HEAD: the grace-window
  storage feature is **present** (commits `ec0cb32` and `cdfe094`,
  2026-05-18), but `joinGroupFromWelcome` is **not yet wired** to it.
- `marmot-protocol/marmot-ts` HEAD: the grace-window feature is **not
  present at all** — `rotate()` immediately deletes the private
  material via `storeRemove(ref)`.
- **No prior issue or PR** on either fork covers this bug.

This means landing only the notestr-web fix in this spec is a real
improvement in isolation — even consumers on `marmot-protocol/marmot-ts`
HEAD (no grace window) benefit, because the inviter no longer sends
Welcomes for KeyPackages the invitee has already destroyed. The
marmot-ts fix is necessary only to absorb the residual window where the
relay itself is stale on the inviter side.

---

## 10. Acceptance criteria

1. `syncKnownKeyPackages` (or equivalent path) selects, for each `d`
   slot, the cached event with the highest `created_at` before calling
   `inviteToAllGroups`.
2. A new e2e test (sketched in §4) reproduces the failure on `master`
   prior to the fix and passes after.
3. No regression in the existing `members.spec.ts`, `groups.spec.ts`,
   `forget-device-sibling.spec.ts`, or `multi-user.spec.ts`.
4. The fix is wrapped in a code comment that explains *why* (rotation
   race, link to marmot-ts grace window contract) so a future reader
   doesn't innocently revert it.

---

## 11. Open questions for review

1. Should we also `cleanupDeprecated()` on this device's own KPs on
   startup? Currently nothing does. (Out of scope for this spec but
   worth tracking — likely a one-liner in
   `src/marmot/client.tsx`'s init.)
2. Should the failed-welcomes recovery prompt include a one-click
   "Ask inviter to re-invite" action? Today's text in
   `src/components/pending-invitations-helpers.ts:43-56` is good copy
   but requires the inviter to be reachable out-of-band. A
   protocol-level "please re-invite slot X" message would be a more
   ambitious follow-up (likely a marmot-ts protocol-level addition).
