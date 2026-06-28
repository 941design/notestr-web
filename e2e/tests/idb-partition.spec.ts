/**
 * Per-pubkey IndexedDB partitioning — wiring proof (epic-multi-user-idb-scoping).
 *
 * The isolation *property* (writing under pubkey A is unreadable after binding
 * pubkey B) is proven exhaustively at the unit level in
 * `src/marmot/storage.test.ts` (AC-PART-4). What a unit test cannot prove is
 * that the real auth flow actually calls `bindStores(pubkey)` before any store
 * I/O. This e2e closes that gap end-to-end: after a real bunker sign-in and a
 * group creation, every marmot IndexedDB database MUST carry the signed-in
 * pubkey in its name, and NO origin-only `notestr-${name}` database may exist
 * (AC-PART-1, AC-PART-2, AC-LIFE-1).
 *
 * Single context, single identity — no sign-out/auth-race, so this is robust
 * against the documented multi-context NIP-46 connect flakiness.
 *
 * Relay-state-independent: asserts only on the browser's own IndexedDB, never
 * on relay state, and never starts/stops/wipes the relay.
 */
import { test, expect } from "@playwright/test";
import { authenticateViaBunker } from "../fixtures/auth-helper.js";
import { clearAppState } from "../fixtures/cleanup.js";
import { createGroup } from "../fixtures/two-party.js";

// A partitioned marmot database is `notestr-${64-hex-pubkey}-${store}`.
const PARTITIONED_DB_RE = /^notestr-[0-9a-f]{64}-.+/;
// The origin-level migration marker is intentionally un-partitioned.
const MIGRATION_MARKER_DB = "notestr-partition-migration";

test("marmot IndexedDB is partitioned by pubkey, never origin-only (AC-PART-1, AC-LIFE-1)", async ({
  page,
}) => {
  await page.goto("/");
  await clearAppState(page);
  await authenticateViaBunker(page);

  await createGroup(page, `IdbPartition ${Date.now()}`);

  // Let the group-state / key-package writes settle.
  await page.waitForTimeout(2000);

  const dbNames = await page.evaluate(async () => {
    const fn = (
      indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
    ).databases;
    if (typeof fn !== "function") return null; // enumeration unsupported
    const infos = await fn.call(indexedDB);
    return infos.map((d) => d.name).filter((n): n is string => !!n);
  });

  expect(dbNames, "indexedDB.databases() must be enumerable on the e2e browser").not.toBeNull();
  const names = dbNames!;

  const marmotDbs = names.filter(
    (n) => n.startsWith("notestr-") && n !== MIGRATION_MARKER_DB,
  );
  expect(
    marmotDbs.length,
    `expected partitioned marmot DBs, saw: ${names.join(", ")}`,
  ).toBeGreaterThan(0);

  // AC-PART-1/AC-PART-2/AC-LIFE-1: every marmot store database is partitioned
  // as notestr-${64-hex-pubkey}-${store}; none is a bare origin-only name.
  const unpartitioned = marmotDbs.filter((n) => !PARTITIONED_DB_RE.test(n));
  expect(
    unpartitioned,
    `these marmot DBs are NOT pubkey-partitioned (origin-only leak): ${unpartitioned.join(", ")}`,
  ).toEqual([]);
});
