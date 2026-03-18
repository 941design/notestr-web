import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(PROJECT_ROOT, 'e2e', '.state.json');

function killPid(pid: number | undefined, name: string) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[teardown] Killed ${name} (PID ${pid})`);
  } catch (err) {
    console.warn(`[teardown] Could not kill ${name} (PID ${pid}):`, err);
  }
}

export default async function globalTeardown() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const { bunkerPid, bunkerBPid, servePid } = JSON.parse(raw) as {
      bunkerPid?: number;
      bunkerBPid?: number;
      servePid?: number;
    };
    killPid(bunkerPid, 'bunker-A');
    killPid(bunkerBPid, 'bunker-B');
    killPid(servePid, 'serve');
  } catch (err) {
    console.warn('[teardown] Could not read state file (already cleaned up?):', err);
  }
}
