/**
 * Shared cleanup helper for E2E tests.
 *
 * Clears localStorage and deletes all notestr IndexedDB databases,
 * properly awaiting each deletion before resolving.
 */

import type { Page } from '@playwright/test';

/** All IndexedDB database names used by the app (must match notestr- prefix in storage.ts). */
const IDB_NAMES = [
  'notestr-identity',
  'notestr-device-names',
  'notestr-group-state',
  'notestr-key-packages',
  'notestr-invite-received',
  'notestr-invite-unread',
  'notestr-invite-seen',
  'notestr-invited-keys',
  'notestr-group-sync',
];

/**
 * Clears localStorage and all notestr IndexedDB databases.
 * Awaits each IDB deletion to ensure the browser fully removes
 * the databases before the test continues.
 */
export async function clearAppState(page: Page): Promise<void> {
  await page.evaluate((dbNames) => {
    localStorage.clear();
    return Promise.all(
      dbNames.map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }),
      ),
    );
  }, IDB_NAMES);
}
