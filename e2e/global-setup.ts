import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { writeFileSync } from 'fs';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Store child process PIDs so teardown can kill them
const STATE_FILE = path.join(PROJECT_ROOT, 'e2e', '.state.json');
// Per-session bunker keys (regenerated every globalSetup run so the relay's
// historical kind-30443 KPs for prior pubkeys cannot contaminate this run).
const KEYS_FILE = path.join(PROJECT_ROOT, 'e2e', '.bunker-keys.json');

interface BunkerKey {
  privkeyHex: string;
  pubkeyHex: string;
  npub: string;
  bunkerUrl: string;
}

function generateBunkerKey(relayUrl: string): BunkerKey {
  const sk = generateSecretKey();
  const privkeyHex = bytesToHex(sk);
  const pubkeyHex = getPublicKey(sk);
  const npub = nip19.npubEncode(pubkeyHex);
  return {
    privkeyHex,
    pubkeyHex,
    npub,
    bunkerUrl: `bunker://${pubkeyHex}?relay=${encodeURIComponent(relayUrl)}`,
  };
}

async function spawnAndWaitForOutput(
  cmd: string,
  args: string[],
  waitFor: string,
  timeoutMs: number,
  cwd: string,
  env?: Record<string, string>,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      detached: false,
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Timed out waiting for "${waitFor}" from ${cmd} ${args.join(' ')}`));
      }
    }, timeoutMs);

    function onData(data: Buffer) {
      const text = data.toString();
      process.stdout.write(`[${cmd}] ${text}`);
      if (!settled && text.includes(waitFor)) {
        settled = true;
        clearTimeout(timer);
        // Stop forwarding stdout/stderr once the process is ready, but keep
        // no-op drains attached so the subprocess's stdout/stderr pipe
        // buffers never fill up. If we just removed the listeners the stream
        // would pause and the kernel-side pipe would block the child on
        // write — which is how `serve` silently dies partway through a
        // Playwright run once its per-request access log overflows the pipe.
        child.stdout?.removeListener('data', onData);
        child.stderr?.removeListener('data', onStderr);
        child.stdout?.on('data', () => {});
        child.stderr?.on('data', () => {});
        resolve(child);
      }
    }

    const onStderr = (data: Buffer) => {
      process.stderr.write(`[${cmd}:err] ${data.toString()}`);
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onStderr);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${cmd} exited with code ${code} before outputting "${waitFor}"`));
      }
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // serve returns 404 for unknown routes, that's fine
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url} to respond`);
}

// Refuse to start if `port` is already held. We deliberately do NOT kill the
// owning process — that's the user's problem to resolve. The previous version
// of this helper SIGKILLed any PID lsof returned for the port, which on a VM
// where the port happened to be held by something else (a system service, an
// unrelated dev process) would tear that down without warning. Fail loud
// instead so the human can pick what to do.
async function assertPortFree(port: number): Promise<void> {
  try {
    const { execSync } = await import('child_process');
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
    if (pids) {
      throw new Error(
        `[setup] Port ${port} is already in use (PID(s): ${pids.replace(/\n/g, ', ')}). ` +
        `The e2e harness will NOT kill processes it discovers — free the port manually ` +
        `(e.g. \`kill <pid>\` after confirming what it is) and re-run.`,
      );
    }
  } catch (err) {
    // lsof exits non-zero when no process found — that's the happy path.
    // Re-throw our own error; swallow lsof's exit-code error.
    if (err instanceof Error && err.message.startsWith('[setup]')) throw err;
  }
}

export default async function globalSetup() {
  // 1. Build the app with E2E environment
  console.log('[setup] Building app with NODE_ENV=test...');
  await new Promise<void>((resolve, reject) => {
    const build = spawn('npx', ['next', 'build'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NEXT_PUBLIC_E2E: '1',
        NEXT_PUBLIC_RELAYS: 'ws://localhost:7777',
        // Explicit pass-through of the MLS trace flag so the build-time
        // gate in src/marmot/mls-trace.ts and the install-block in
        // MarmotProvider see the shell-set value clearly. The implicit
        // `...process.env` spread above would also work, but explicit
        // is the project convention (see exploration §
        // next_public_env_propagation).
        NEXT_PUBLIC_E2E_TRACE_MLS: process.env.NEXT_PUBLIC_E2E_TRACE_MLS ?? '',
      },
    });
    build.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`next build exited with code ${code}`));
    });
    build.on('error', reject);
  });
  console.log('[setup] Build complete.');

  // 2. Generate fresh per-session bunker keypairs. Writing them to KEYS_FILE
  //    BEFORE spawning bunkers (and before any test file is imported) means the
  //    auth-helper modules can synchronously load this file at import time and
  //    expose the per-session bunker URLs / npubs as ordinary constants.
  //    Rationale: prior sessions accumulate kind-30443 key packages on the
  //    relay under whatever pubkey they used; using fresh pubkeys per session
  //    structurally isolates this run from that historical state, so the
  //    auto-invite scan never picks up phantom "sibling" devices belonging to
  //    a defunct browser. See docs commit message accompanying this change.
  const RELAY_URL = 'ws://localhost:7777';
  const bunkerAKey = generateBunkerKey(RELAY_URL);
  const bunkerBKey = generateBunkerKey(RELAY_URL);
  const bunkerCKey = generateBunkerKey(RELAY_URL);
  writeFileSync(
    KEYS_FILE,
    JSON.stringify({ A: bunkerAKey, B: bunkerBKey, C: bunkerCKey }, null, 2),
  );

  console.log('[setup] Starting bunker A...');
  const bunkerProc = await spawnAndWaitForOutput(
    'node',
    [path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'bunker.mjs')],
    'Ready',
    10000,
    PROJECT_ROOT,
    {
      BUNKER_PRIVATE_KEY: bunkerAKey.privkeyHex,
      BUNKER_LABEL: 'bunker-A',
    },
  );
  console.log('[setup] Bunker A ready.');

  console.log('[setup] Starting bunker B...');
  const bunkerBProc = await spawnAndWaitForOutput(
    'node',
    [path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'bunker.mjs')],
    'Ready',
    10000,
    PROJECT_ROOT,
    {
      BUNKER_PRIVATE_KEY: bunkerBKey.privkeyHex,
      BUNKER_LABEL: 'bunker-B',
    },
  );
  console.log('[setup] Bunker B ready.');

  console.log('[setup] Starting bunker C...');
  const bunkerCProc = await spawnAndWaitForOutput(
    'node',
    [path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'bunker.mjs')],
    'Ready',
    10000,
    PROJECT_ROOT,
    {
      BUNKER_PRIVATE_KEY: bunkerCKey.privkeyHex,
      BUNKER_LABEL: 'bunker-C',
    },
  );
  console.log('[setup] Bunker C ready.');

  // 3. Refuse to start if port 3100 is already held by something. We do not
  //    kill discovered processes — see assertPortFree for rationale.
  await assertPortFree(3100);

  // 4. Start the static file server. Two structural rules:
  //
  // a) `stdio: 'ignore'` — do NOT pipe `serve`'s stdout/stderr into this
  //    process. `serve` logs one line per HTTP request and a full Playwright
  //    run makes hundreds. If the pipes aren't drained faster than they're
  //    written (or any listener pauses the stream), the ~64KB kernel pipe
  //    buffer fills, `serve` blocks forever on `process.stdout.write`, and
  //    every subsequent test fails with `ERR_CONNECTION_REFUSED`. Readiness
  //    is detected via the HTTP health-check below instead of stdout scraping.
  //
  // b) Spawn the serve binary DIRECTLY from `node_modules/.bin`, not via
  //    `npx`. `npx serve` produces a 3-process chain (npx → `sh -c serve` →
  //    `node serve`), and SIGTERM on the recorded npx PID does not propagate
  //    to the actual port-holding node listener — it gets reparented to init
  //    and keeps holding port 3100 across runs. Spawning the bin directly
  //    means the recorded PID IS the listener. `detached: true` puts it in
  //    its own process group so teardown can SIGTERM the group as a belt-and-
  //    suspenders against future binaries that fork helpers of their own.
  console.log('[setup] Starting serve on port 3100...');
  const serveProc = spawn(
    path.join(PROJECT_ROOT, 'node_modules', '.bin', 'serve'),
    ['out', '-l', '3100', '--no-clipboard'],
    {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
      env: process.env,
      detached: true,
    },
  );
  // Allow the parent (this Node process) to exit without waiting on serve.
  // We still control its lifetime explicitly via the teardown SIGTERM.
  serveProc.unref();
  serveProc.on('error', (err) => {
    console.error('[setup] serve spawn error:', err);
  });
  serveProc.on('exit', (code, signal) => {
    console.error(`[setup] serve exited unexpectedly (code=${code}, signal=${signal})`);
  });

  // 5. Wait for the HTTP endpoint to become reachable — that's the real
  // readiness signal now that stdout is no longer available.
  await waitForHttp('http://localhost:3100', 20000);
  console.log('[setup] HTTP health check passed.');

  // 5. Save PIDs for teardown
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      bunkerPid: bunkerProc.pid,
      bunkerBPid: bunkerBProc.pid,
      bunkerCPid: bunkerCProc.pid,
      servePid: serveProc.pid,
    }),
  );
}
