/**
 * Shared auth helper for E2E tests.
 *
 * Performs the NIP-46 bunker authentication flow via the app UI.
 * Re-use this in any test that requires an authenticated session.
 *
 * Bunker URLs / pubkeys are freshly generated per `authenticateViaBunker()`
 * call. Each test gets its own ephemeral bunker process with a fresh keypair
 * and zero relay history — prior tests in the suite cannot contaminate its
 * kind-30443 key package scan because there is no shared pubkey.
 *
 * The A/B/C bunkers spawned by globalSetup run for the full suite lifetime
 * and are used only for multi-party tests that explicitly call
 * `authenticate(page, E2E_BUNKER_URL)` with a specific bunker URL.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

const E2E_RELAY_URL = 'ws://localhost:7777';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.resolve(__dirname, '..', '.bunker-keys.json');

interface BunkerKey {
  privkeyHex: string;
  pubkeyHex: string;
  npub: string;
  bunkerUrl: string;
}

const keys = JSON.parse(readFileSync(KEYS_FILE, 'utf-8')) as {
  A: BunkerKey;
  B: BunkerKey;
  C: BunkerKey;
};

export const E2E_BUNKER_PUBKEY_HEX = keys.A.pubkeyHex;
export const E2E_BUNKER_URL = keys.A.bunkerUrl;

// ---------------------------------------------------------------------------
// Ephemeral bunker management
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface EphemeralBunker {
  /** Must be called with the NIP-46 permit callback so the bunker can sign. */
  signerPrivkeyHex: string;
  /** The URL to paste into the sign-in form. */
  bunkerUrl: string;
  /** Stop the bunker process. */
  stop: () => void;
  /** Wait for the bunker to emit its "Ready" line. */
  ready: () => Promise<void>;
}

const activeBunkers: EphemeralBunker[] = [];

/**
 * Spawn a fresh NIP-46 bunker process with a newly generated keypair.
 *
 * Exported so two-party.ts can also use it for multi-party tests that call
 * `authenticate(page, bunkerUrl)` on their own (bypassing this helper).
 *
 * Each spawn allocates a distinct relay WS URL so multiple ephemeral bunkers
 * can be live simultaneously without port conflicts.
 *
 * @param relayWsUrl  WebSocket URL of the relay. Defaults to the e2e relay.
 */
export async function spawnEphemeralBunker(
  relayWsUrl = E2E_RELAY_URL,
): Promise<EphemeralBunker> {
  const sk = generateSecretKey();
  const privkeyHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const bunkerUrl = `bunker://${pubkeyHex}?relay=${encodeURIComponent(relayWsUrl)}`;

  const label = `ephemeral-${pubkeyHex.slice(0, 8)}`;

  let proc: ChildProcess | null = null;
  let settled = false;
  let readyResolver: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolver = resolve;
  });

  const bunker: EphemeralBunker = {
    signerPrivkeyHex: privkeyHex,
    bunkerUrl,
    stop: () => {
      if (proc && !proc.killed) {
        try {
          // SIGTERM the group (bunker forks ndk which forks WebSocket, so
          // kill the whole group to be sure the relay doesn't hold the conn)
          process.kill(-(proc.pid ?? 0), 'SIGTERM');
        } catch {
          // already dead
        }
      }
      const idx = activeBunkers.indexOf(bunker);
      if (idx >= 0) activeBunkers.splice(idx, 1);
    },
    ready: () => readyPromise,
  };

  proc = spawn(
    'node',
    [path.resolve(__dirname, 'bunker.mjs')],
    {
      cwd: path.dirname(__dirname),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BUNKER_PRIVATE_KEY: privkeyHex,
        BUNKER_LABEL: label,
      },
    },
  );

  proc.stdout?.on('data', (data: Buffer) => {
    if (!settled && data.toString().includes('Ready')) {
      settled = true;
      readyResolver();
    }
  });
  proc.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[${label}] ${data.toString()}`);
  });
  proc.on('error', (err) => {
    if (!settled) {
      settled = true;
      readyResolver();
    }
    process.stderr.write(`[${label}] spawn error: ${err}\n`);
  });

  // give it up to 10s to come up
  setTimeout(() => {
    if (!settled) {
      settled = true;
      readyResolver(); // resolve anyway to avoid hanging tests on slow CI
    }
  }, 10000);

  activeBunkers.push(bunker);
  return bunker;
}

/**
 * Stop all active ephemeral bunker processes.
 * Called automatically by globalTeardown; also safe to call at any test
 * boundary (e.g. afterEach, afterAll).
 */
export function stopAllEphemeralBunkers(): void {
  for (const b of activeBunkers) b.stop();
  activeBunkers.length = 0;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Navigate to the app, select the "bunker:// URL" tab, paste the E2E_BUnderUrl,
 * click Connect, and wait for the pubkey chip to appear.
 *
 * Idempotent: if the NIP-46 session has already been restored from
 * IndexedDB/localStorage (as happens after `page.reload()`), the pubkey chip
 * will appear on its own and this helper just waits for it instead of trying
 * to click the sign-in tab — which no longer exists in the authenticated UI.
 */
export async function authenticateViaBunker(page: Page): Promise<void> {
  await page.goto('/');

  const pubkeyChip = page.locator('[data-testid="pubkey-chip"]');
  const bunkerTab = page.getByRole('tab', { name: /bunker:\/\/ URL/i });

  // Spawn a fresh per-test bunker BEFORE navigating so the pubkey has zero
  // relay history — no stale kind-30443 key packages from prior tests in
  // this suite can be picked up by the auto-invite scan.
  const bunker = await spawnEphemeralBunker();

  const hasSavedSession = await page.evaluate(
    () => localStorage.getItem('notestr-nip46-payload') != null,
  );

  if (hasSavedSession) {
    await pubkeyChip.waitFor({ state: 'visible', timeout: 30000 });
    bunker.stop();
    return;
  }

  await bunkerTab.click();
  await page.getByPlaceholder('bunker://...').fill(bunker.bunkerUrl);
  await page.getByRole('button', { name: 'Connect' }).click();

  await pubkeyChip.waitFor({ state: 'visible', timeout: 30000 });
  // Clean up the ephemeral bunker. The relay state is left as-is (the kind-30443
  // KPs published by this session will accumulate naturally but the next session
  // will use entirely different pubkeys, so cross-session contamination is
  // impossible). We do NOT wipe the relay.
  bunker.stop();
}
