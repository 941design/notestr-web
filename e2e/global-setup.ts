import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Store child process PIDs so teardown can kill them
const STATE_FILE = path.join(PROJECT_ROOT, 'e2e', '.state.json');

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

async function killProcessOnPort(port: number): Promise<void> {
  try {
    const { execSync } = await import('child_process');
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        try {
          process.kill(Number(pid), 'SIGKILL');
          console.log(`[setup] Killed stale process on port ${port} (PID ${pid})`);
        } catch { /* already dead */ }
      }
      // Give OS time to release the port
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {
    // lsof exits non-zero when no process found — port is free
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
      },
    });
    build.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`next build exited with code ${code}`));
    });
    build.on('error', reject);
  });
  console.log('[setup] Build complete.');

  // 2. Start the NIP-46 bunkers (User A + User B)
  console.log('[setup] Starting bunker A...');
  const bunkerProc = await spawnAndWaitForOutput(
    'node',
    [path.join(PROJECT_ROOT, 'e2e', 'fixtures', 'bunker.mjs')],
    'Ready',
    10000,
    PROJECT_ROOT,
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
      BUNKER_PRIVATE_KEY: '3ad635dc380ed603e85842e163bb6a0f6af83110cf61c78785fab7bce173c105',
      BUNKER_LABEL: 'bunker-B',
    },
  );
  console.log('[setup] Bunker B ready.');

  // 3. Kill any stale serve process on port 3100 before starting
  await killProcessOnPort(3100);

  // 4. Start the static file server. IMPORTANT: `stdio: 'ignore'` — do NOT
  // pipe `serve`'s stdout/stderr into this process. `serve` logs one line
  // per HTTP request and a full Playwright run makes hundreds of requests.
  // If the pipes aren't drained faster than they're written (or any listener
  // pauses the stream), the ~64KB kernel pipe buffer fills, `serve` blocks
  // forever on `process.stdout.write`, and every subsequent test fails with
  // `ERR_CONNECTION_REFUSED`. Redirecting to /dev/null at spawn time makes
  // the problem structurally impossible. Readiness is detected via the HTTP
  // health-check below instead of stdout scraping.
  console.log('[setup] Starting serve on port 3100...');
  const serveProc = spawn(
    'npx',
    ['serve', 'out', '-l', '3100', '--no-clipboard'],
    {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
      env: process.env,
      detached: false,
    },
  );
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
  const { writeFileSync } = await import('fs');
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      bunkerPid: bunkerProc.pid,
      bunkerBPid: bunkerBProc.pid,
      servePid: serveProc.pid,
    }),
  );
}
