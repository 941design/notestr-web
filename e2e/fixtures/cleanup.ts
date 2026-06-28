/**
 * Shared cleanup helper for E2E tests.
 *
 * Clears localStorage and deletes all notestr IndexedDB databases,
 * properly awaiting each deletion before resolving.
 */

import type { Page } from '@playwright/test';

/**
 * Fallback list of IndexedDB databases the app is known to create. Used when
 * `indexedDB.databases()` is unavailable. Keep in sync with `notestr-` stores
 * created in src/marmot/storage.ts so a stale name here can never silently
 * leave state behind across runs.
 */
const KNOWN_IDB_NAMES = [
  'notestr-identity',
  'notestr-device-names',
  'notestr-group-state',
  'notestr-key-packages',
  'notestr-invite-store',
  'notestr-invited-keys',
  'notestr-group-sync',
  'notestr-joined-groups',
  // S5: forgotten-slots store — must be cleared between runs so prior test
  // runs do not leave slots marked forgotten for subsequent test runs.
  'notestr-forgotten-slots',
  // S1: failed-welcomes store — must be cleared between runs so join-failure
  // records from one test run do not surface in subsequent runs.
  'notestr-failed-welcomes',
  // bootstrap-completed flag store (was missing from this fallback list).
  'notestr-bootstrap-completed',
  // Per-pubkey IDB partitioning: pubkey-suffixed databases
  // (notestr-${pubkey}-${name}) are caught by the prefix enumeration above on
  // Chromium; the origin-level migration marker and the legacy default
  // task-event store have fixed names listed here so they are always wiped.
  'notestr-partition-migration',
  'keyval-store',
];

/**
 * Clears localStorage and all notestr IndexedDB databases.
 * Enumerates live databases via `indexedDB.databases()` (Chromium/Firefox/
 * Safari 16.4+) so newly added stores are dropped without touching this list.
 * Falls back to the known-name list if enumeration is unavailable.
 */
export async function clearAppState(page: Page): Promise<void> {
  await page.evaluate((knownNames) => {
    localStorage.clear();

    const enumerate = async (): Promise<string[]> => {
      // `indexedDB.databases` is non-standard on older Safari; guard it.
      const fn = (indexedDB as IDBFactory & {
        databases?: () => Promise<{ name?: string }[]>;
      }).databases;
      if (typeof fn !== 'function') return knownNames;
      const infos = await fn.call(indexedDB);
      const live = infos
        .map((db) => db.name)
        .filter((n): n is string => !!n && n.startsWith('notestr-'));
      // Union with knownNames so a brand-new DB created mid-test still
      // gets cleared on the next run even if enumeration races the open.
      return Array.from(new Set([...live, ...knownNames]));
    };

    return enumerate().then((names) =>
      Promise.all(
        names.map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            }),
        ),
      ),
    );
  }, KNOWN_IDB_NAMES);
}
