import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(PROJECT_ROOT, 'e2e', '.state.json');

function killPid(pid: number | undefined, name: string, opts?: { group?: boolean }) {
  if (!pid) return;
  // When `group: true`, sending the signal to -pid hits the entire process
  // group (any helper children the binary forked). Serve is spawned with
  // `detached: true` for exactly this reason — see global-setup.ts.
  const target = opts?.group ? -pid : pid;
  try {
    process.kill(target, 'SIGTERM');
    console.log(`[teardown] Killed ${name} (${opts?.group ? 'group ' : 'PID '}${pid})`);
  } catch (err) {
    // ESRCH = no such process — the PID file is stale (e.g. previous run
    // was Ctrl+C'd). That's the desired outcome anyway, so don't warn.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    console.warn(`[teardown] Could not kill ${name} (PID ${pid}):`, err);
  }
}

export default async function globalTeardown() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const { bunkerPid, bunkerBPid, bunkerCPid, servePid } = JSON.parse(raw) as {
      bunkerPid?: number;
      bunkerBPid?: number;
      bunkerCPid?: number;
      servePid?: number;
    };
    killPid(bunkerPid, 'bunker-A');
    killPid(bunkerBPid, 'bunker-B');
    killPid(bunkerCPid, 'bunker-C');
    // Serve is detached → kill the whole group so no listener can survive.
    killPid(servePid, 'serve', { group: true });
  } catch (err) {
    console.warn('[teardown] Could not read state file (already cleaned up?):', err);
  }
}
