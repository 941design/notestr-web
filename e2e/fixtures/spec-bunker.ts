/**
 * Per-spec NIP-46 bunker fixture.
 *
 * Spawns a fresh `bunker.mjs` process with a freshly-generated keypair so
 * the resulting Nostr pubkey has no historical KeyPackages on the ephemeral
 * relay. Use this when a spec needs to assert exactly which KeyPackages
 * exist for a given pubkey — the global bunkers (`auth-helper{,-b,-c}.ts`)
 * are shared across all 384 tests and accumulate KPs under their pubkeys
 * for the lifetime of one Playwright run, so any test that asserts "pubkeyA
 * has exactly N leaves" is sensitive to whatever earlier specs did.
 *
 * Each call to `spawnSpecBunker` returns a handle with the bunker URL, npub,
 * pubkey hex, and a `dispose()` method. Always call `dispose()` in
 * `test.afterAll` — the bunker process is otherwise reparented to init when
 * the test runner exits.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RELAY_URL = 'ws://localhost:7777';

export interface SpecBunkerHandle {
  /** `bunker://<pubkeyHex>?relay=<encoded-relay>` for sign-in flows. */
  bunkerUrl: string;
  /** npub-encoded form of the public key, for invite-by-npub inputs. */
  npub: string;
  /** Raw hex pubkey. */
  pubkeyHex: string;
  /** Tear down the bunker process. Always call this in afterAll. */
  dispose(): Promise<void>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Spawn a fresh bunker process with a brand-new keypair.
 *
 * The returned handle exposes the bunker:// URL the test should paste into
 * the sign-in flow. The bunker process is detached + given its own process
 * group so `dispose()` can SIGTERM the group cleanly — the same pattern the
 * Playwright global teardown uses for the static-server child.
 */
export async function spawnSpecBunker(label: string): Promise<SpecBunkerHandle> {
  const sk = generateSecretKey();
  const privkeyHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const npub = nip19.npubEncode(pubkeyHex);
  const bunkerUrl = `bunker://${pubkeyHex}?relay=${encodeURIComponent(RELAY_URL)}`;

  const child = await new Promise<ChildProcess>((resolve, reject) => {
    const proc = spawn(
      'node',
      [path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'bunker.mjs')],
      {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BUNKER_PRIVATE_KEY: privkeyHex,
          BUNKER_LABEL: `spec-bunker-${label}`,
        },
        detached: true,
      },
    );

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { process.kill(-(proc.pid ?? 0), 'SIGTERM'); } catch { /* ignore */ }
        reject(new Error(`spec-bunker-${label} timed out waiting for Ready`));
      }
    }, 15000);

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      if (!settled && text.includes('Ready')) {
        settled = true;
        clearTimeout(timer);
        // Drain stdout going forward so the kernel pipe buffer never fills.
        proc.stdout?.on('data', () => {});
        proc.stderr?.on('data', () => {});
        resolve(proc);
      }
    });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`spec-bunker-${label} exited with code ${code} before Ready`));
      }
    });
  });

  return {
    bunkerUrl,
    npub,
    pubkeyHex,
    async dispose() {
      const pid = child.pid;
      if (!pid) return;
      try {
        // Kill the process group, not just the PID, in case the bunker forks
        // helpers we don't know about.
        process.kill(-pid, 'SIGTERM');
      } catch {
        // ESRCH = already dead. Fine.
      }
    },
  };
}
